/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/resources.js';

import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { ILogger, ILoggerService } from '../../../../../platform/log/common/log.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService, IFileStat } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { ChatAgentLocation, ChatModeKind } from '../../common/constants.js';
import { IChatAgentData, IChatAgentHistoryEntry, IChatAgentImplementation, IChatAgentRequest, IChatAgentResult, IChatAgentService } from '../../common/participants/chatAgents.js';
import { IChatFollowup, IChatProgress } from '../../common/chatService/chatService.js';
import { OllamaChatMessage, OllamaLanguageModelProvider } from './ollamaLanguageModel.js';
import { IChatRequestVariableEntry, isImplicitVariableEntry } from '../../common/attachments/chatVariableEntries.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IEditor } from '../../../../../editor/common/editorCommon.js';
import { isLocation } from '../../../../../editor/common/languages.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';

import { ILanguageModelToolsService, CountTokensCallback } from '../../common/tools/languageModelToolsService.js';
import { OllamaCreateFileToolId, OllamaDeleteFileToolId, OllamaRunCommandToolId } from './ollamaTools.js';
import { WorkspaceChunkIndex, RelevanceContext } from './workspaceChunkIndex.js';
import { AgentMemory } from './agentMemory.js';
import { ConversationCompactor } from './conversationCompactor.js';
import { hasKey } from '../../../../../base/common/types.js';

const OLLAMA_AGENT_ID = 'ollama.local';
const OLLAMA_AGENT_NAME = 'ollama';
const OLLAMA_EXTENSION_ID = new ExtensionIdentifier('darkmatter.ollama');

/** Directories to skip during workspace scanning */
const IGNORED_DIRS = new Set([
	'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
	'.next', '.nuxt', '__pycache__', '.pytest_cache', '.mypy_cache',
	'target', 'bin', 'obj', '.gradle', '.idea', '.vscode',
	'vendor', 'coverage', '.cache', '.turbo', '.parcel-cache',
]);

/** File extensions to skip (binary/large) */
const IGNORED_EXTENSIONS = new Set([
	'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
	'.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac',
	'.zip', '.tar', '.gz', '.rar', '.7z',
	'.exe', '.dll', '.so', '.dylib', '.bin',
	'.woff', '.woff2', '.ttf', '.eot',
	'.pdf', '.doc', '.docx', '.xls', '.xlsx',
	'.lock', '.map', '.class', '.o', '.pyc',
]);

/** Source code extensions we want to READ contents of */
const SOURCE_EXTENSIONS = new Set([
	'.java', '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.c', '.cpp',
	'.h', '.hpp', '.cs', '.rb', '.php', '.swift', '.kt', '.kts', '.scala',
	'.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
	'.sql', '.graphql', '.gql', '.proto',
	'.html', '.htm', '.css', '.scss', '.less', '.sass',
	'.xml', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
	'.md', '.txt', '.rst', '.adoc',
	'.gradle', '.properties', '.env',
	'.dockerfile',
]);

/** Max depth for recursive scanning */
const MAX_SCAN_DEPTH = 16;
/** Max individual file size to read (500KB) */
const MAX_FILE_SIZE = 500 * 1024;
/** Max total source content to collect (1.5MB) — matches 265k token context window */
const MAX_TOTAL_SOURCE_SIZE = 1.5 * 1024 * 1024;

export class OllamaChatAgent extends Disposable {
	private readonly _logService: ILogger;

	/** Cached workspace data (legacy fallback when smart context is disabled) */
	private _cachedTree: string | undefined;
	private _cachedSourceFiles: string | undefined;
	private _lastScanTime = 0;
	private readonly SCAN_INTERVAL_MS = 120_000; // rescan every 2 minutes

	/** Max iterations for the agentic follow-up loop */
	private static readonly MAX_AGENT_LOOP_DEPTH = 3;

	/** Strip <file_action> and <thought> tags (and their full content) from text */
	private static stripFileActionTags(text: string): string {
		// Remove self-closing: <file_action ... />
		let cleaned = text.replace(/<file_action\b[^>]*\/>/gi, '');
		// Remove paired tags WITH content: <file_action ...>...</file_action>
		// Must use greedy [\s\S]* to reliably match large multi-line file content
		cleaned = cleaned.replace(/<file_action\b[^>]*>[\s\S]*?<\/file_action>/gi, '');
		// Remove any stray opening/closing tags that lost their pair
		cleaned = cleaned.replace(/<\/?file_action[^>]*>/gi, '');
		// Remove thought blocks: <thought>...</thought>
		cleaned = cleaned.replace(/<thought>[\s\S]*?<\/thought>/gi, '');
		// Remove stray thought tags
		cleaned = cleaned.replace(/<\/?thought>/gi, '');
		// Clean up excessive blank lines left behind
		cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
		return cleaned;
	}

	/**
	 * Produce a compact summary of an agent response suitable for memory storage.
	 * File action blocks are replaced with one-line descriptions so the model
	 * never sees file contents re-injected into its context on future turns.
	 */
	private static summarizeResponseForMemory(text: string): string {
		// Replace self-closing actions: <file_action type="delete" path="..." />
		let summary = text.replace(
			/<file_action\b([^>]*)\/>/gi,
			(_match, attrs: string) => {
				const type = (attrs.match(/type="([^"]*)"/) ?? [])[1] ?? 'action';
				const path = (attrs.match(/path="([^"]*)"/) ?? [])[1];
				const cmd = (attrs.match(/command="([^"]*)"/) ?? [])[1];
				if (cmd) { return `[Ran command: ${cmd}]`; }
				if (path) { return `[${OllamaChatAgent.actionLabel(type)}: ${path}]`; }
				return `[${type} action]`;
			}
		);
		// Replace paired actions (with file content): <file_action ...>...</file_action>
		summary = summary.replace(
			/<file_action\b([^>]*)>[\s\S]*?<\/file_action>/gi,
			(_match, attrs: string) => {
				const type = (attrs.match(/type="([^"]*)"/) ?? [])[1] ?? 'action';
				const path = (attrs.match(/path="([^"]*)"/) ?? [])[1];
				if (path) { return `[${OllamaChatAgent.actionLabel(type)}: ${path}]`; }
				return `[${type} action]`;
			}
		);
		// Strip stray tags, thought blocks, and collapse whitespace
		summary = summary
			.replace(/<\/?file_action[^>]*>/gi, '')
			.replace(/<thought>[\s\S]*?<\/thought>/gi, '')
			.replace(/<\/?thought>/gi, '')
			.replace(/\s+/g, ' ')
			.trim();
		return summary.substring(0, 1000);
	}

	private static actionLabel(type: string): string {
		switch (type.toLowerCase()) {
			case 'create': return 'Created file';
			case 'overwrite': return 'Overwrote file';
			case 'delete': return 'Deleted file';
			case 'runcommand': return 'Ran command';
			default: return `${type} action`;
		}
	}

	constructor(
		private readonly ollamaProvider: OllamaLanguageModelProvider,
		private readonly _chunkIndex: WorkspaceChunkIndex,
		private readonly _agentMemory: AgentMemory,
		private readonly _conversationCompactor: ConversationCompactor,
		@IChatAgentService private readonly chatAgentService: IChatAgentService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
		@ILoggerService private readonly loggerService: ILoggerService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@ILanguageModelToolsService private readonly toolsService: ILanguageModelToolsService,
	) {
		super();

		this._logService = this._register(this.loggerService.createLogger('ollama', { name: 'Dark Matter' }));

		// Purge GPU memory when workspace/window closes
		this._register(this.lifecycleService.onWillShutdown(e => {
			e.join(this.ollamaProvider.unloadModel(this.ollamaProvider.model), { id: 'darkmatter.unloadOllama', label: 'Purging AI Model from VRAM' });
		}));

		// Load persistent memory
		this._agentMemory.load().catch(err => {
			this._logService.warn(`[Ollama] Failed to load agent memory: ${err}`);
		});

		this.registerAgent();

		// Kick off initial workspace scan asynchronously (legacy fallback)
		this.scanWorkspace().catch(err => {
			this._logService.warn(`[Ollama] Initial workspace scan failed: ${err}`);
		});
	}

	private registerAgent(): void {
		const disposables = this._register(new DisposableStore());

		const locations: ChatAgentLocation[] = [
			ChatAgentLocation.Chat,
			ChatAgentLocation.Terminal,
			ChatAgentLocation.Notebook,
			ChatAgentLocation.EditorInline,
		];

		const modes: ChatModeKind[] = [
			ChatModeKind.Ask,
			ChatModeKind.Edit,
			ChatModeKind.Agent,
		];

		for (const location of locations) {
			const agentId = location === ChatAgentLocation.Chat
				? OLLAMA_AGENT_ID
				: `${OLLAMA_AGENT_ID}.${location}`;

			const agentData: IChatAgentData = {
				id: agentId,
				name: OLLAMA_AGENT_NAME,
				fullName: 'Ollama Local AI',
				description: 'AI assistant powered by your local Ollama server',
				extensionId: OLLAMA_EXTENSION_ID,
				extensionVersion: '0.1.0',
				extensionPublisherId: 'darkmatter',
				extensionDisplayName: 'Dark Matter Ollama',
				publisherDisplayName: 'Dark Matter',
				isDefault: true,
				isCore: false,
				isDynamic: true,
				metadata: {
					sampleRequest: 'Explain this code',
				},
				slashCommands: [],
				locations: [location],
				modes: location === ChatAgentLocation.Chat ? modes : [ChatModeKind.Ask],
				disambiguation: [],
			};

			disposables.add(this.chatAgentService.registerDynamicAgent(agentData, this.createImplementation()));
		}

		this._logService.info('[Dark Matter] Ollama chat agents registered for all locations');
	}

	private createImplementation(): IChatAgentImplementation {
		return {
			invoke: async (
				request: IChatAgentRequest,
				progress: (parts: IChatProgress[]) => void,
				history: IChatAgentHistoryEntry[],
				token: CancellationToken
			): Promise<IChatAgentResult> => {
				return this.handleRequest(request, progress, history, token);
			},
			provideFollowups: async (): Promise<IChatFollowup[]> => [],
			provideChatTitle: async (
				history: IChatAgentHistoryEntry[],
			): Promise<string | undefined> => {
				if (history.length > 0) {
					const firstMsg = history[0].request.message;
					return firstMsg.length > 50 ? firstMsg.substring(0, 50) + '...' : firstMsg;
				}
				return undefined;
			},
		};
	}

	// ========================================================================
	// Workspace Scanning — reads ALL source files + builds tree
	// ========================================================================

	private async scanWorkspace(): Promise<void> {
		const now = Date.now();
		if (this._cachedTree && (now - this._lastScanTime) < this.SCAN_INTERVAL_MS) {
			return;
		}

		const workspace = this.workspaceService.getWorkspace();
		if (workspace.folders.length === 0) {
			this._cachedTree = '(No workspace folder open)';
			this._cachedSourceFiles = '';
			this._lastScanTime = now;
			return;
		}

		this._logService.info('[Ollama] Scanning workspace and reading source files...');

		const treeLines: string[] = [];
		const sourceFiles: { path: string; content: string }[] = [];
		let totalSourceSize = 0;

		for (const folder of workspace.folders) {
			treeLines.push(`[Dir] ${folder.name}/  (${folder.uri.fsPath})`);
			try {
				const stat = await this.fileService.resolve(folder.uri, { resolveMetadata: false });
				if (stat.children) {
					const result = await this.scanDirectory(
						stat.children, folder.uri, treeLines, '  ', 1, totalSourceSize, sourceFiles
					);
					totalSourceSize = result;
				}
			} catch (err) {
				treeLines.push(`  ⚠️ Could not scan: ${err}`);
				this._logService.error(`[Ollama] Workspace scan error: ${err}`);
			}
		}

		this._cachedTree = treeLines.join('\n');

		// Build the full source content block
		if (sourceFiles.length > 0) {
			const parts: string[] = [];
			for (const sf of sourceFiles) {
				parts.push(`\n========== FILE: ${sf.path} ==========\n${sf.content}`);
			}
			this._cachedSourceFiles = parts.join('\n');
		} else {
			this._cachedSourceFiles = '(No source files found or all files too large)';
		}

		this._lastScanTime = now;
		this._logService.info(
			`[Ollama] Scan complete: ${treeLines.length} tree entries, ` +
			`${sourceFiles.length} source files read (${Math.round(totalSourceSize / 1024)}KB total)`
		);
	}

	/**
	 * Recursively scan a directory: build the tree AND read source file contents.
	 * Returns the updated totalSourceSize.
	 */
	private async scanDirectory(
		children: IFileStat[],
		_parentUri: URI,
		treeLines: string[],
		indent: string,
		depth: number,
		totalSourceSize: number,
		sourceFiles: { path: string; content: string }[],
	): Promise<number> {
		if (depth > MAX_SCAN_DEPTH) {
			if (children.length > 0) {
				treeLines.push(`${indent}... (max depth reached)`);
			}
			return totalSourceSize;
		}

		// Sort: directories first, then files
		const sorted = [...children].sort((a, b) => {
			if (a.isDirectory !== b.isDirectory) {
				return a.isDirectory ? -1 : 1;
			}
			return a.name.localeCompare(b.name);
		});

		for (const child of sorted) {
			if (child.isDirectory) {
				if (IGNORED_DIRS.has(child.name)) {
					treeLines.push(`${indent}[Dir] ${child.name}/  (skipped)`);
					continue;
				}

				treeLines.push(`${indent}[Dir] ${child.name}/`);

				try {
					const subStat = await this.fileService.resolve(child.resource, { resolveMetadata: false });
					if (subStat.children) {
						totalSourceSize = await this.scanDirectory(
							subStat.children, child.resource, treeLines,
							indent + '  ', depth + 1, totalSourceSize, sourceFiles
						);
					}
				} catch {
					treeLines.push(`${indent}  ⚠️ Could not read`);
				}
			} else {
				// File
				const ext = child.name.includes('.')
					? '.' + child.name.split('.').pop()!.toLowerCase()
					: '';

				if (IGNORED_EXTENSIONS.has(ext)) {
					continue;
				}

				treeLines.push(`${indent}[File] ${child.name}`);

				// Read source files if under limits
				const isSource = SOURCE_EXTENSIONS.has(ext)
					|| child.name === 'Makefile'
					|| child.name === 'Dockerfile'
					|| child.name === 'Jenkinsfile'
					|| child.name === '.gitignore'
					|| child.name === '.editorconfig';

				if (isSource && totalSourceSize < MAX_TOTAL_SOURCE_SIZE) {
					try {
						const fileStat = await this.fileService.stat(child.resource);
						if (fileStat.size <= MAX_FILE_SIZE && (totalSourceSize + fileStat.size) <= MAX_TOTAL_SOURCE_SIZE) {
							const content = await this.fileService.readFile(child.resource);
							const text = content.value.toString();
							const relativePath = child.resource.fsPath;
							sourceFiles.push({ path: relativePath, content: text });
							totalSourceSize += text.length;
						}
					} catch {
						// skip unreadable files
					}
				}
			}
		}

		return totalSourceSize;
	}

	// ========================================================================
	// System Prompt
	// ========================================================================

	private async buildSystemPrompt(userMessage: string): Promise<string> {
		const smartEnabled = this.configurationService.getValue<boolean>('ollamaAgent.smartContext.enabled') !== false;

		const parts: string[] = [
			'You are a helpful AI coding assistant integrated directly into the Dark Matter IDE.',
			'You have FULL ACCESS to the user\'s entire workspace.',
			'Help with code, debugging, architecture, and general programming questions.',
			'Format your responses with markdown when appropriate.',
			'',
		];

		if (smartEnabled && this._chunkIndex.isReady) {
			// === SMART CONTEXT MODE ===
			// Build relevance context
			const activeEditor = this.editorService.activeEditor;
			const openEditorPaths: string[] = [];
			for (const editor of this.editorService.editors) {
				if (editor.resource) { openEditorPaths.push(editor.resource.fsPath); }
			}

			const relevanceCtx: RelevanceContext = {
				activeFilePath: activeEditor?.resource?.fsPath,
				userMessage,
				openEditorPaths,
			};

			const { overview, relevantFiles } = this._chunkIndex.getRelevantContext(relevanceCtx);

			// Workspace overview
			if (overview) {
				parts.push(overview);
				parts.push('');
			}

			// Relevant file summaries
			if (relevantFiles.length > 0) {
				parts.push(`=== RELEVANT FILES (${relevantFiles.length} most relevant) ===`);
				for (const file of relevantFiles) {
					parts.push(`**${file.relativePath}**: ${file.summary}`);
					if (file.keyExports.length > 0) {
						parts.push(`  Exports: ${file.keyExports.join(', ')}`);
					}
				}
				parts.push('');
			}
		} else {
			// === LEGACY MODE (fallback) ===
			await this.scanWorkspace();
			parts.push('=== PROJECT DIRECTORY TREE ===');
			parts.push(this._cachedTree || '(scanning...)');

			if (this._cachedSourceFiles) {
				parts.push('');
				parts.push('=== FULL SOURCE CODE OF ALL PROJECT FILES ===');
				parts.push(this._cachedSourceFiles);
			}
		}

		// Persistent memory
		const memorySection = this._agentMemory.buildPromptSection();
		if (memorySection) {
			parts.push('');
			parts.push(memorySection);
		}

		// Active editor
		const activeEditor = this.editorService.activeEditor;
		if (activeEditor?.resource) {
			parts.push('');
			parts.push(`=== CURRENTLY ACTIVE FILE IN EDITOR ===`);
			parts.push(`Path: ${activeEditor.resource.fsPath}`);
		}

		return parts.join('\n');
	}

	// ========================================================================
	// Active editor context
	// ========================================================================

	private getActiveEditorContext(): string | undefined {
		const control = this.editorService.activeTextEditorControl;
		if (!control) {
			return undefined;
		}

		let model: ITextModel | null = null;
		if (control && typeof control === 'object' && hasKey(control, { getModel: true })) {
			model = (control as IEditor).getModel?.() as ITextModel | null;
		}

		if (!model || typeof model.getValue !== 'function') {
			return undefined;
		}

		const uri = model.uri;
		const content = model.getValue();
		if (!content) {
			return undefined;
		}

		const selection = control && typeof control === 'object' && hasKey(control, { getSelection: true }) ? (control as IEditor).getSelection?.() : undefined;
		let selectedText: string | undefined;
		if (selection && !selection.isEmpty()) {
			selectedText = model.getValueInRange(selection);
		}

		const parts: string[] = [];
		parts.push(`--- Active File: ${uri.fsPath} ---`);
		parts.push(content);

		if (selectedText) {
			parts.push(`\n--- Selected Text (lines ${selection!.startLineNumber}-${selection!.endLineNumber}) ---`);
			parts.push(selectedText);
		}

		return parts.join('\n');
	}

	// ========================================================================
	// Main request handler
	// ========================================================================

	private async handleRequest(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		history: IChatAgentHistoryEntry[],
		token: CancellationToken
	): Promise<IChatAgentResult> {
		// Determine which model to use: picker selection > settings default
		const selectedModel = request.userSelectedModelId || undefined;
		const activeModelName = selectedModel
			? (selectedModel.startsWith('ollama:') ? selectedModel.substring('ollama:'.length) : selectedModel)
			: this.ollamaProvider.model;
		this._logService.info(`[Ollama] Handling request with model "${activeModelName}": "${request.message.substring(0, 100)}"`);

		const messages: OllamaChatMessage[] = [];

		// System prompt — uses smart context (chunk index + memory) or legacy fallback
		const systemPrompt = await this.buildSystemPrompt(request.message);
		this._logService.info(`[Ollama] System prompt size: ${Math.round(systemPrompt.length / 1024)}KB`);
		messages.push({ role: 'system', content: systemPrompt });

		// Conversation history — use compactor if enabled
		const maxContextWindow = this.configurationService.getValue<number>('ollamaAgent.maxContextWindow') || 131072;
		const systemPromptTokens = Math.ceil(systemPrompt.length / 4);
		const remainingAfterSystem = maxContextWindow - systemPromptTokens;
		const responseBudget = Math.floor(maxContextWindow * 0.25); // 25% reserved for response generation
		const historyBudget = Math.max(remainingAfterSystem - responseBudget, 2000);

		this._logService.info(`[Ollama] Token budget: ctx=${maxContextWindow}, system=~${systemPromptTokens}, historyBudget=~${historyBudget}, responseBudget=~${responseBudget}`);

		const compacted = await this._conversationCompactor.compactHistory(history, Math.max(historyBudget, 2000), token);

		// Inject conversation recap if compacted
		if (compacted.recap) {
			messages.push({
				role: 'user',
				content: `[Conversation Recap - ${compacted.compactedTurnCount} earlier turns summarized]\n${compacted.recap}`,
			});
			messages.push({
				role: 'assistant',
				content: 'Understood. I have the context from our earlier conversation.',
			});
			this._logService.info(`[Ollama] Compacted ${compacted.compactedTurnCount} turns into recap`);
		}

		// Add recent messages (verbatim)
		for (const msg of compacted.recentMessages) {
			messages.push(msg);
		}

		// Log the user's request to activity log
		const userMessageForLog = request.message.substring(0, 150);
		this._agentMemory.logActivity(`[User] ${userMessageForLog}`).catch(() => { });

		// Resolve explicitly attached context
		const contextParts: string[] = [];
		if (request.variables && request.variables.variables.length > 0) {
			for (const variable of request.variables.variables) {
				try {
					const content = await this.resolveVariableContent(variable);
					if (content) {
						contextParts.push(content);
					}
				} catch (err) {
					this._logService.warn(`[Ollama] Failed to resolve variable ${variable.name}: ${err}`);
				}
			}
		}

		// If no explicit context, include active editor
		if (contextParts.length === 0) {
			const activeContext = this.getActiveEditorContext();
			if (activeContext) {
				contextParts.push(activeContext);
			}
		}

		// User message
		let userMessage = request.message;
		if (contextParts.length > 0) {
			userMessage = `<attached_context>\n${contextParts.join('\n\n')}\n</attached_context>\n\n${request.message}`;
		}
		messages.push({ role: 'user', content: userMessage });

		// Progress
		progress([{
			kind: 'progressMessage',
			content: new MarkdownString(`Thinking with **${activeModelName}**...`),
		}]);

		try {
			let totalLength = 0;
			let inThought = false;
			let currentBuffer = '';
			let fullResponse = '';

			// Helper reference for file action stripping
			const stripFileActionTags = OllamaChatAgent.stripFileActionTags;

			// Stream the response in real-time, suppressing <thought> and <file_action> tags
			for await (const chunk of this.ollamaProvider.sendChatRequest(messages, token, selectedModel)) {
				if (token.isCancellationRequested) {
					break;
				}
				totalLength += chunk.length;
				currentBuffer += chunk;
				fullResponse += chunk;

				this._logService.trace(`[Ollama Agent] Received chunk: ${JSON.stringify(chunk)}`);

				// Process currentBuffer for <thought> and <file_action> tags
				while (currentBuffer.length > 0) {
					const lowerBuffer = currentBuffer.toLowerCase();

					if (!inThought) {
						const startIdx = lowerBuffer.indexOf('<thought>');
						const fileActionIdx = lowerBuffer.indexOf('<file_action');

						if (startIdx !== -1 && (fileActionIdx === -1 || startIdx <= fileActionIdx)) {
							if (startIdx > 0) {
								const beforeThought = stripFileActionTags(currentBuffer.substring(0, startIdx));
								if (beforeThought.length > 0) {
									progress([{ kind: 'markdownContent', content: new MarkdownString(beforeThought) }]);
								}
							}
							inThought = true;
							currentBuffer = currentBuffer.substring(startIdx + '<thought>'.length);
						} else if (fileActionIdx !== -1) {
							if (fileActionIdx > 0) {
								const beforeAction = currentBuffer.substring(0, fileActionIdx);
								if (beforeAction.trim().length > 0) {
									progress([{ kind: 'markdownContent', content: new MarkdownString(beforeAction) }]);
								}
								currentBuffer = currentBuffer.substring(fileActionIdx);
								continue;
							}
							const selfCloseIdx = currentBuffer.indexOf('/>', fileActionIdx);
							const pairedCloseIdx = lowerBuffer.indexOf('</file_action>', fileActionIdx);
							if (selfCloseIdx !== -1 && (pairedCloseIdx === -1 || selfCloseIdx < pairedCloseIdx)) {
								currentBuffer = currentBuffer.substring(selfCloseIdx + 2);
							} else if (pairedCloseIdx !== -1) {
								currentBuffer = currentBuffer.substring(pairedCloseIdx + '</file_action>'.length);
							} else {
								break; // Tag incomplete, wait for more data
							}
						} else {
							const safeLength = Math.max(0, currentBuffer.length - 15);
							if (safeLength > 0) {
								const safeText = stripFileActionTags(currentBuffer.substring(0, safeLength));
								if (safeText.length > 0) {
									progress([{ kind: 'markdownContent', content: new MarkdownString(safeText) }]);
								}
								currentBuffer = currentBuffer.substring(safeLength);
							}
							break;
						}
					} else {
						const endIdx = lowerBuffer.indexOf('</thought>');
						if (endIdx !== -1) {
							if (endIdx > 0) {
								this._logService.debug(`[Ollama Thought] ${currentBuffer.substring(0, endIdx)}`);
							}
							inThought = false;
							currentBuffer = currentBuffer.substring(endIdx + '</thought>'.length);
						} else {
							const safeLength = Math.max(0, currentBuffer.length - 11);
							if (safeLength > 0) {
								this._logService.debug(`[Ollama Thought] ${currentBuffer.substring(0, safeLength)}`);
								currentBuffer = currentBuffer.substring(safeLength);
							}
							break;
						}
					}
				}
			}

			// Flush remaining buffer
			if (currentBuffer.length > 0) {
				if (inThought) {
					this._logService.debug(`[Ollama Thought] ${currentBuffer}`);
				} else {
					const cleaned = stripFileActionTags(currentBuffer);
					if (cleaned.length > 0) {
						progress([{ kind: 'markdownContent', content: new MarkdownString(cleaned) }]);
					}
				}
			}

			this._logService.info(`[Ollama] Request completed, response length: ${totalLength}`);

			// Parse model-initiated memory updates (explicit code blocks in response)
			const taskMatch = fullResponse.match(/```task\n([\s\S]*?)```/);
			if (taskMatch) {
				this._agentMemory.updateFile('task', taskMatch[1].trim()).catch(() => { });
			}
			const planMatch = fullResponse.match(/```plan\n([\s\S]*?)```/);
			if (planMatch) {
				this._agentMemory.updateFile('plan', planMatch[1].trim()).catch(() => { });
			}
			const summaryMatch = fullResponse.match(/```summary\n([\s\S]*?)```/);
			if (summaryMatch) {
				this._agentMemory.updateFile('summary', summaryMatch[1].trim()).catch(() => { });
			}

			// Auto-log the AI response and auto-update summary — no special code blocks needed.
			// Use summarizeResponseForMemory so file contents are replaced with compact
			// descriptions (e.g. "[Created file: path]") rather than raw code that would
			// confuse the model into thinking files are already in context.
			const responseSummary = OllamaChatAgent.summarizeResponseForMemory(fullResponse);
			this._agentMemory.logActivity(`[Agent] ${responseSummary}`).catch(() => { });

			// Build a lightweight summarizer callback backed by the current Ollama model.
			// Used by AgentMemory when the summary file exceeds the size limit.
			const summarizer = async (prompt: string): Promise<string> => {
				const chunks: string[] = [];
				const summaryMessages = [
					{ role: 'system' as const, content: 'You are a concise summarizer. Respond with plain prose only — no markdown, no headings, no bullet points.' },
					{ role: 'user' as const, content: prompt },
				];
				for await (const chunk of this.ollamaProvider.sendChatRequest(summaryMessages, token, selectedModel)) {
					chunks.push(chunk);
				}
				return chunks.join('');
			};

			this._agentMemory.appendSummaryEntry(userMessageForLog, responseSummary, summarizer).catch(() => { });

			// Execute agent actions via the tool invocation pipeline
			// Each action is dispatched as a proper tool invocation with native confirmation UI
			let depth = 0;
			let responseToProcess = fullResponse;

			while (depth < OllamaChatAgent.MAX_AGENT_LOOP_DEPTH) {
				const terminalOutputs = await this.executeAgentActions(responseToProcess, request, progress, token);

				if (terminalOutputs.length === 0) {
					break;
				}

				depth++;
				this._logService.info(`[Ollama] Agentic follow-up loop iteration ${depth}`);

				const outputContext = terminalOutputs.map(t =>
					`Command: \`${t.command}\`\n<terminal_output>\n${t.output}\n</terminal_output>`
				).join('\n\n');

				const followUpMessage = `Terminal output from the commands you just ran:\n\n${outputContext}\n\nNow provide a brief, fresh summary of the results for the user. Do NOT repeat or echo anything from before. Start your response with the findings.`;

				const commandList = terminalOutputs.map(t => t.command).join(', ');
				messages.push({ role: 'assistant', content: `[Executed: ${commandList}]` });
				messages.push({ role: 'user', content: followUpMessage });

				progress([{ kind: 'progressMessage', content: new MarkdownString('Analyzing terminal output...') }]);

				let followUpResponse = '';
				for await (const chunk of this.ollamaProvider.sendChatRequest(messages, token, selectedModel)) {
					if (token.isCancellationRequested) { break; }
					followUpResponse += chunk;
					const cleaned = stripFileActionTags(chunk);
					if (cleaned.length > 0) {
						progress([{ kind: 'markdownContent', content: new MarkdownString(cleaned) }]);
					}
				}

				responseToProcess = followUpResponse;
				if (!/<file_action\s+/i.test(followUpResponse)) { break; }
			}

			return {};

		} catch (error: unknown) {
			if (error instanceof Error && error.name === 'AbortError') {
				return {}; // Standard cancellation, no error message needed
			}
			const errorMessage = error instanceof Error ? error.message : String(error);
			this._logService.error(`[Ollama] Request failed: ${errorMessage}`);

			return {
				errorDetails: {
					message: `Ollama error: ${errorMessage}. Make sure Ollama is running at ${this.ollamaProvider.baseUrl}`,
				},
			};
		}
	}

	// ========================================================================
	// Autonomous Actions (via Tool Invocation Pipeline)
	// ========================================================================

	/**
	 * Parse <file_action> tags from the AI response and dispatch each
	 * as a tool invocation through ILanguageModelToolsService.
	 *
	 * This gives us the Copilot-style confirmation UI:
	 *   Streaming → WaitingForConfirmation → Executing → Completed
	 */
	private async executeAgentActions(
		fullResponse: string,
		request: IChatAgentRequest,
		progress: (progress: IChatProgress[]) => void,
		token: CancellationToken,
	): Promise<{ command: string; output: string }[]> {
		const regex = /<file_action\s+type="([^"]+)"(?:\s+path="([^"]+)")?(?:\s+command="([^"]+)")?\s*(?:>([\s\S]*?)<\/file_action>|\/\>)/g;
		let match;
		const terminalOutputs: { command: string; output: string }[] = [];

		const workspace = this.workspaceService.getWorkspace();
		if (workspace.folders.length === 0) {
			return [];
		}
		const rootUri = workspace.folders[0].uri;

		// Simple token counter for the tool API
		const countTokens: CountTokensCallback = async (input: string) => Math.ceil(input.length / 4);

		while ((match = regex.exec(fullResponse)) !== null) {
			const type = match[1];
			const filePath = match[2];
			const command = match[3];
			const content = match[4] || '';

			try {
				const toolCallId = `ollama-${type}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

				if (type === 'runCommand' && command) {
					// Emit tool invocation progress to the chat UI
					progress([{
						kind: 'externalToolInvocationUpdate',
						toolCallId,
						toolName: 'Run Command',
						isComplete: false,
						invocationMessage: `Running command: ${command}`
					}]);

					// Dispatch as a terminal command tool invocation
					const result = await this.toolsService.invokeTool(
						{
							callId: toolCallId,
							toolId: OllamaRunCommandToolId,
							parameters: { command },
							context: { sessionResource: request.sessionResource },
						},
						countTokens,
						token,
					);

					// Signal completion to the UI
					progress([{
						kind: 'externalToolInvocationUpdate',
						toolCallId,
						toolName: 'Run Command',
						isComplete: true
					}]);

					// Extract terminal output from the tool result
					const outputText = result.content
						.filter((p): p is { kind: 'text'; value: string } => p.kind === 'text')
						.map(p => p.value)
						.join('\n');

					if (outputText.length > 0 && !outputText.includes('(no output)')) {
						terminalOutputs.push({ command, output: outputText });
					}
				} else if (filePath && (type === 'create' || type === 'overwrite')) {
					const parameters = { filePath, content, actionType: type, rootUri: rootUri.toJSON() };
					const verb = type === 'overwrite' ? 'Overwriting' : 'Creating';

					// Emit tool invocation progress to the chat UI
					progress([{
						kind: 'externalToolInvocationUpdate',
						toolCallId,
						toolName: `${verb} file`,
						isComplete: false,
						invocationMessage: `${verb} ${filePath}...`
					}]);

					// Dispatch as a create/overwrite file tool invocation
					await this.toolsService.invokeTool(
						{
							callId: toolCallId,
							toolId: OllamaCreateFileToolId,
							parameters,
							context: { sessionResource: request.sessionResource },
						},
						countTokens,
						token,
					);

					// Signal completion to the UI
					progress([{
						kind: 'externalToolInvocationUpdate',
						toolCallId,
						toolName: `${verb} file`,
						isComplete: true
					}]);
				} else if (filePath && type === 'delete') {
					const parameters = { filePath, rootUri: rootUri.toJSON() };

					// Emit tool invocation progress to the chat UI
					progress([{
						kind: 'externalToolInvocationUpdate',
						toolCallId,
						toolName: 'Delete file',
						isComplete: false,
						invocationMessage: `Deleting ${filePath}...`
					}]);

					// Dispatch as a delete file tool invocation
					await this.toolsService.invokeTool(
						{
							callId: toolCallId,
							toolId: OllamaDeleteFileToolId,
							parameters,
							context: { sessionResource: request.sessionResource },
						},
						countTokens,
						token,
					);

					// Signal completion to the UI
					progress([{
						kind: 'externalToolInvocationUpdate',
						toolCallId,
						toolName: 'Delete file',
						isComplete: true
					}]);
				}
			} catch (err) {
				this._logService.error(`[Ollama] Tool invocation failed for action ${type}: ${err}`);
			}
		}

		return terminalOutputs;
	}

	// ========================================================================
	// Variable Resolution
	// ========================================================================

	private async resolveVariableContent(variable: IChatRequestVariableEntry): Promise<string | undefined> {
		switch (variable.kind) {
			case 'file':
				return this.resolveFileVariable(variable);
			case 'directory':
				return this.resolveDirectoryVariable(variable);
			case 'implicit':
				if (isImplicitVariableEntry(variable)) {
					return this.resolveImplicitVariable(variable);
				}
				return undefined;
			case 'symbol':
				return this.resolveSymbolVariable(variable);
			case 'paste':
				return `--- Pasted Code (${variable.language}) ---\n${variable.code}`;
			case 'workspace':
				return typeof variable.value === 'string' ? `--- Workspace ---\n${variable.value}` : undefined;
			case 'string':
				return typeof variable.value === 'string' ? `--- ${variable.name} ---\n${variable.value}` : undefined;
			case 'terminalCommand': {
				const parts = [`--- Terminal ---\n$ ${variable.command}`];
				if (variable.output) { parts.push(`Output:\n${variable.output}`); }
				if (variable.exitCode !== undefined) { parts.push(`Exit code: ${variable.exitCode}`); }
				return parts.join('\n');
			}
			case 'promptFile':
			case 'promptText':
				if (typeof variable.value === 'string') {
					return `--- Instructions: ${variable.name} ---\n${variable.value}`;
				}
				if (URI.isUri(variable.value)) {
					return this.readFileContent(variable.value, variable.name);
				}
				return undefined;
			default:
				return undefined;
		}
	}

	private async resolveFileVariable(variable: IChatRequestVariableEntry): Promise<string | undefined> {
		const value = variable.value;
		if (isLocation(value)) {
			try {
				const content = await this.fileService.readFile(value.uri);
				const allLines = content.value.toString().split('\n');
				if (value.range) {
					const rangeLines = allLines.slice(
						Math.max(0, value.range.startLineNumber - 1),
						value.range.endLineNumber
					);
					return `--- ${basename(value.uri)} (L${value.range.startLineNumber}-${value.range.endLineNumber}) ---\n${rangeLines.join('\n')}`;
				}
				return `--- ${basename(value.uri)} ---\n${allLines.join('\n')}`;
			} catch { /* skip */ }
			return undefined;
		}
		if (URI.isUri(value)) {
			return this.readFileContent(value, variable.name);
		}
		return undefined;
	}

	private async resolveDirectoryVariable(variable: IChatRequestVariableEntry): Promise<string | undefined> {
		if (!URI.isUri(variable.value)) { return undefined; }
		try {
			const stat = await this.fileService.resolve(variable.value);
			if (stat.children) {
				const listing = stat.children
					.map(c => `  ${c.isDirectory ? '[Dir]' : '[File]'} ${c.name}`)
					.join('\n');
				return `--- Directory: ${variable.value.fsPath} ---\n${listing}`;
			}
		} catch { /* skip */ }
		return undefined;
	}

	private resolveImplicitVariable(variable: IChatRequestVariableEntry): string | undefined {
		if (!isImplicitVariableEntry(variable)) { return undefined; }
		const value = variable.value;
		if (URI.isUri(value)) {
			return `--- ${variable.isSelection ? 'Selection from' : 'File'}: ${value.fsPath} ---`;
		}
		if (isLocation(value)) {
			return `--- ${basename(value.uri)} (L${value.range.startLineNumber}-${value.range.endLineNumber}) ---`;
		}
		if (value && typeof value === 'object' && hasKey(value, { value: true }) && typeof (value as Record<string, unknown>).value === 'string') {
			return `--- ${variable.isSelection ? 'Selection' : variable.name} ---\n${(value as Record<string, string>).value}`;
		}
		return undefined;
	}

	private async resolveSymbolVariable(variable: IChatRequestVariableEntry): Promise<string | undefined> {
		if (!isLocation(variable.value)) { return undefined; }
		try {
			const content = await this.fileService.readFile(variable.value.uri);
			const lines = content.value.toString().split('\n');
			const range = lines.slice(
				Math.max(0, variable.value.range.startLineNumber - 1),
				variable.value.range.endLineNumber
			);
			return `--- Symbol: ${variable.name} (${basename(variable.value.uri)}:${variable.value.range.startLineNumber}) ---\n${range.join('\n')}`;
		} catch { return undefined; }
	}

	private async readFileContent(uri: URI, label?: string): Promise<string | undefined> {
		try {
			const content = await this.fileService.readFile(uri);
			return `--- ${label || basename(uri)} (${uri.fsPath}) ---\n${content.value.toString()}`;
		} catch { return undefined; }
	}
}
