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
import { LLMChatMessage, LocalLLMProvider, LLMToolCall } from './localLLMProvider.js';
import { IChatRequestVariableEntry, isImplicitVariableEntry } from '../../common/attachments/chatVariableEntries.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IEditor } from '../../../../../editor/common/editorCommon.js';
import { isLocation } from '../../../../../editor/common/languages.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';

import { ILanguageModelToolsService } from '../../common/tools/languageModelToolsService.js';
import { WorkspaceChunkIndex, RelevanceContext } from './workspaceChunkIndex.js';
import { AgentMemory } from './agentMemory.js';
import { ConversationCompactor } from './conversationCompactor.js';
import { hasKey } from '../../../../../base/common/types.js';

const LOCAL_LLM_AGENT_ID = 'localLLM.local';
const LOCAL_LLM_AGENT_NAME = 'localLLM';
const LOCAL_LLM_EXTENSION_ID = new ExtensionIdentifier('darkmatter.localllm');

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

export class LocalLLMChatAgent extends Disposable {
	private readonly _logService: ILogger;

	/** Cached workspace data (legacy fallback when smart context is disabled) */
	private _cachedTree: string | undefined;
	private _cachedSourceFiles: string | undefined;
	private _lastScanTime = 0;
	private readonly SCAN_INTERVAL_MS = 120_000; // rescan every 2 minutes

	/** Strip <file_action>, <tool_call>, and <thought> tags (and their full content) from text */
	private static stripActionTags(text: string): string {
		// Remove self-closing: <file_action ... /> and <tool_call ... />
		let cleaned = text.replace(/<file_action\b[^>]*\/>/gi, '');
		cleaned = cleaned.replace(/<tool_call\b[^>]*\/>/gi, '');
		// Remove paired tags WITH content: <file_action ...>...</file_action>
		cleaned = cleaned.replace(/<file_action\b[^>]*>[\s\S]*?<\/file_action>/gi, '');
		// Remove stray tags
		cleaned = cleaned.replace(/<\/?file_action[^>]*>/gi, '');
		cleaned = cleaned.replace(/<\/?tool_call[^>]*>/gi, '');
		// Remove thought/think blocks
		cleaned = cleaned.replace(/<thought>[\s\S]*?<\/thought>/gi, '');
		cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');
		// Remove stray thought tags
		cleaned = cleaned.replace(/<\/?thought>/gi, '');
		cleaned = cleaned.replace(/<\/?think>/gi, '');
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
				if (path) { return `[${LocalLLMChatAgent.actionLabel(type)}: ${path}]`; }
				return `[${type} action]`;
			}
		);
		// Replace paired actions (with file content): <file_action ...>...</file_action>
		summary = summary.replace(
			/<file_action\b([^>]*)>[\s\S]*?<\/file_action>/gi,
			(_match, attrs: string) => {
				const type = (attrs.match(/type="([^"]*)"/) ?? [])[1] ?? 'action';
				const path = (attrs.match(/path="([^"]*)"/) ?? [])[1];
				if (path) { return `[${LocalLLMChatAgent.actionLabel(type)}: ${path}]`; }
				return `[${type} action]`;
			}
		);
		// Replace tool_call tags: <tool_call type="viewFile" path="..." />
		summary = summary.replace(
			/<tool_call\b([^>]*)\/>/gi,
			(_match, attrs: string) => {
				const type = (attrs.match(/type="([^"]*)"/) ?? [])[1] ?? 'tool';
				const path = (attrs.match(/path="([^"]*)"/) ?? [])[1];
				const pattern = (attrs.match(/pattern="([^"]*)"/) ?? [])[1];
				const url = (attrs.match(/url="([^"]*)"/) ?? [])[1];
				const target = path || pattern || url || '';
				return `[${type}: ${target}]`;
			}
		);
		// Strip stray tags, thought blocks, and collapse whitespace
		summary = summary
			.replace(/<\/?file_action[^>]*>/gi, '')
			.replace(/<\/?tool_call[^>]*>/gi, '')
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
			case 'replace': return 'Edited file';
			case 'delete': return 'Deleted file';
			case 'runcommand': return 'Ran command';
			default: return `${type} action`;
		}
	}

	constructor(
		private readonly llmProvider: LocalLLMProvider,
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

		this._logService = this._register(this.loggerService.createLogger('local-llm', { name: 'Dark Matter' }));

		// Purge GPU memory when workspace/window closes
		this._register(this.lifecycleService.onWillShutdown(e => {
			e.join(this.llmProvider.unloadModel(this.llmProvider.model), { id: 'darkmatter.unloadLocalLLM', label: 'Purging AI Model from VRAM' });
		}));

		// Load persistent memory
		this._agentMemory.load().catch(err => {
			this._logService.warn(`[LocalLLM] Failed to load agent memory: ${err}`);
		});

		this.registerAgent();

		// Kick off initial workspace scan asynchronously (legacy fallback)
		this.scanWorkspace().catch(err => {
			this._logService.warn(`[LocalLLM] Initial workspace scan failed: ${err}`);
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
				? LOCAL_LLM_AGENT_ID
				: `${LOCAL_LLM_AGENT_ID}.${location}`;

			const agentData: IChatAgentData = {
				id: agentId,
				name: LOCAL_LLM_AGENT_NAME,
				fullName: 'Dark Matter Local AI',
				description: 'AI assistant powered by your local LLM backend',
				extensionId: LOCAL_LLM_EXTENSION_ID,
				extensionVersion: '0.1.0',
				extensionPublisherId: 'darkmatter',
				extensionDisplayName: 'Dark Matter Ollama',
				publisherDisplayName: 'Dark Matter',
				isDefault: true,
				isCore: true,
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

		this._logService.info('[Dark Matter] Local LLM chat agents registered for all locations');
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

		this._logService.info('[LocalLLM] Scanning workspace and reading source files...');

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
				this._logService.error(`[LocalLLM] Workspace scan error: ${err}`);
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
			`[LocalLLM] Scan complete: ${treeLines.length} tree entries, ` +
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

	private async buildSystemPrompt(userMessage: string): Promise<{ prompt: string; contextFileUris: URI[] }> {
		const smartEnabled = this.configurationService.getValue<boolean>('localLLM.smartContext.enabled') !== false;
		const contextFileUris: URI[] = [];

		const parts: string[] = [
			'You are a helpful AI coding assistant integrated directly into the Dark Matter IDE.',
			'You have FULL ACCESS to the user\'s entire workspace and a set of powerful tools.',
			'ALWAYS use your tools to take action — do NOT just describe steps or give instructions.',
			'When the user asks you to create, modify, or delete files, DO IT using your tools.',
			'When you need to understand code before making changes, READ the files first using your tools.',
			'CRITICAL: Your context window is limited. Prioritize using specific JSON tools (like localLLM_viewFile, localLLM_grep) over generic shell commands. DO NOT use "ls" for listing, "cat" for viewing, or "grep" for finding in the terminal. When using localLLM_viewFile, always use the startLine and endLine parameters to read small chunks instead of entire files.',
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

			// Relevant file summaries — also collect URIs for reference pills
			if (relevantFiles.length > 0) {
				const workspace = this.workspaceService.getWorkspace();
				const rootUri = workspace.folders.length > 0 ? workspace.folders[0].uri : undefined;

				parts.push(`=== RELEVANT FILES (${relevantFiles.length} most relevant) ===`);
				for (const file of relevantFiles) {
					parts.push(`**${file.relativePath}**: ${file.summary}`);
					if (file.keyExports.length > 0) {
						parts.push(`  Exports: ${file.keyExports.join(', ')}`);
					}
					if (rootUri) {
						contextFileUris.push(URI.joinPath(rootUri, file.relativePath));
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
			contextFileUris.push(activeEditor.resource);
		}

		return { prompt: parts.join('\n'), contextFileUris };
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
		try {
			// Determine which model to use: picker selection > settings default
			const selectedModel = request.userSelectedModelId || undefined;
			const activeModelName = selectedModel
				? (selectedModel.startsWith('localLLM:') ? selectedModel.slice('localLLM:'.length)
					: selectedModel.startsWith('ollama:') ? selectedModel.slice('ollama:'.length)
					: selectedModel)
				: this.llmProvider.model;
				
			let shouldPauseIndexer = true;
			const indexingModel = this.configurationService.getValue<string>('localLLM.smartContext.indexingModel');
			if (indexingModel && indexingModel !== activeModelName) {
				shouldPauseIndexer = false;
				this._logService.info(`[LocalLLM] Dedicated indexing model "${indexingModel}" is configured. Leaving background indexer active.`);
			}
			
			if (shouldPauseIndexer) {
				this._chunkIndex.pause();
			}
			
			this._logService.info(`[LocalLLM] Handling request with model "${activeModelName}": "${request.message.substring(0, 100)}"`);
			this._logService.info(`[LocalLLM] DEBUG: userSelectedModelId="${request.userSelectedModelId}", selectedModel="${selectedModel}", default="${this.llmProvider.model}"`);
			let messages: LLMChatMessage[] = [];
			let fullResponse = '';
			let depth = 0;
			let toolCalls: LLMToolCall[] = [];

			const vsTools = Array.from(this.toolsService.getTools(undefined)).filter(t => t.id.startsWith('localLLM_'));
			const openAiTools = vsTools.map(t => {
				let description = t.modelDescription || t.displayName;
				if (t.id === 'run_in_terminal' || t.id === 'localLLM_runCommand') {
					description += ' WARNING: DO NOT use this tool to read files (e.g. cat, head, tail) or search files (e.g. grep). ALWAYS use localLLM_viewFile or localLLM_grep instead to save context memory.';
				}
				return {
					type: 'function',
					function: {
						name: t.id,
						description: description,
						parameters: t.inputSchema || { type: 'object', properties: {} },
					}
				};
			});

			let historyBudget = 2000;
			const maxContextWindow = this.configurationService.getValue<number>('localLLM.maxContextWindow') || 131072;
			const responseBudget = Math.floor(maxContextWindow * 0.25);

			const continuationData = request.acceptedConfirmationData?.[0] as { type: string; messages: LLMChatMessage[]; responseToProcess: string; depth: number } | undefined;
			let resumeLoop = false;
			if (continuationData && continuationData.type === 'continue_loop') {
				this._logService.info(`[LocalLLM] Resuming agentic loop at iteration ${continuationData.depth}`);
				messages = continuationData.messages;
				fullResponse = continuationData.responseToProcess;
				depth = continuationData.depth;
				resumeLoop = true;
				
				// Re-estimate budget based on resumed messages
				const systemPromptTokens = messages.length > 0 ? this._conversationCompactor.estimateTokens([messages[0]]) : 0;
				const remainingAfterSystem = maxContextWindow - systemPromptTokens;
				historyBudget = Math.max(remainingAfterSystem - responseBudget, 2000);
			} else {
				// System prompt — uses smart context (chunk index + memory) or legacy fallback
				const { prompt: systemPrompt, contextFileUris } = await this.buildSystemPrompt(request.message);
				this._logService.info(`[LocalLLM] System prompt size: ${Math.round(systemPrompt.length / 1024)}KB`);
				messages.push({ role: 'system', content: systemPrompt });

				// Emit file reference pills for files the agent analyzed
				for (const fileUri of contextFileUris) {
					progress([{ kind: 'reference', reference: fileUri }]);
				}

				// Conversation history — use compactor if enabled
				const systemPromptTokens = Math.ceil(systemPrompt.length / 4);
				const remainingAfterSystem = maxContextWindow - systemPromptTokens;
				historyBudget = Math.max(remainingAfterSystem - responseBudget, 2000);

				this._logService.info(`[LocalLLM] Token budget: ctx=${maxContextWindow}, system=~${systemPromptTokens}, historyBudget=~${historyBudget}, responseBudget=~${responseBudget}`);

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
					this._logService.info(`[LocalLLM] Compacted ${compacted.compactedTurnCount} turns into recap`);
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
								// Emit a reference pill for attached file/directory variables
								if (variable.value && URI.isUri(variable.value)) {
									progress([{ kind: 'reference', reference: variable.value }]);
								} else if (isLocation(variable.value)) {
									progress([{ kind: 'reference', reference: variable.value }]);
								}
							}
						} catch (err) {
							this._logService.warn(`[LocalLLM] Failed to resolve variable ${variable.name}: ${err}`);
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

				const responseResult = await this.streamAndParseResponse(messages, token, selectedModel, progress, openAiTools);
				fullResponse = responseResult.fullResponse;
				toolCalls = responseResult.toolCalls || [];

				this._logService.info(`[LocalLLM] Request completed, response length: ${responseResult.totalLength}, toolCalls: ${toolCalls.length}`);
				if (toolCalls.length > 0) {
					this._logService.info(`[LocalLLM] Tool calls detected: ${toolCalls.map(tc => `${tc.function.name}(${tc.function.arguments.substring(0, 100)})`).join(', ')}`);
				}

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

				// Auto-log the AI response and auto-update summary
				const responseSummary = LocalLLMChatAgent.summarizeResponseForMemory(fullResponse);
				this._agentMemory.logActivity(`[Agent] ${responseSummary}`).catch(() => { });
			}

			// Execute agent actions via native JSON tool calls
			let responseToProcess = fullResponse;

			while (true) {
				const actionResults: { type: string; label: string; output: string; callId?: string }[] = [];
				
				if (!resumeLoop) {
					if (toolCalls && toolCalls.length > 0) {
					for (const tc of toolCalls) {
						let resultText = '';
						try {
							const args = JSON.parse(tc.function.arguments || '{}');
							
							// Intercept forbidden terminal commands and throw an explicit error to train the agent in-context
							if (tc.function.name === 'run_in_terminal' || tc.function.name === 'localLLM_runCommand') {
								const cmd = args.command || '';
								if (/^\s*(cat|tail|head|less|more|grep|egrep|fgrep)\b/i.test(cmd)) {
									throw new Error(`CRITICAL RULE VIOLATION: You attempted to use a forbidden bash command to read/search files. You MUST use 'localLLM_viewFile' or 'localLLM_grep' tools instead to save context memory!`);
								}
							}

							const toolData = Array.from(this.toolsService.getTools(undefined)).find(t => t.id === tc.function.name);
							if (!toolData) {
								throw new Error(`Tool ${tc.function.name} not found`);
							}
							
							progress([{
								kind: 'externalToolInvocationUpdate',
								toolCallId: tc.id,
								toolName: toolData.displayName,
								isComplete: false,
								invocationMessage: `Invoking ${toolData.displayName}`
							}]);

							const countTokens = async () => 0;
							
							const result = await this.toolsService.invokeTool(
								{
									callId: tc.id,
									toolId: tc.function.name,
									parameters: args,
									context: { sessionResource: request.sessionResource },
								},
								countTokens,
								token,
							);
							
							progress([{
								kind: 'externalToolInvocationUpdate',
								toolCallId: tc.id,
								toolName: toolData.displayName,
								isComplete: true
							}]);
							
							const contentParts = result.content.map(p => {
								if (p.kind === 'text') { return p.value; }
								if (p.kind === 'data') { return `[Binary Data ${p.value.mimeType}]`; }
								return '';
							});
							resultText = contentParts.join('\n');
							actionResults.push({ type: 'tool', label: tc.function.name, output: resultText, callId: tc.id });
							
						} catch(err) {
							const errorMessage = err instanceof Error ? err.message : String(err);
							resultText = `Action failed: ${errorMessage}`;
							actionResults.push({ type: 'tool', label: tc.function.name, output: resultText, callId: tc.id });
						}
					}
				}
			}

				if (!resumeLoop) {
					if (actionResults.length === 0) {
						this._logService.info(`[LocalLLM] No action results, exiting loop`);
						break;
					}
					
					// Strip thinking tags from content — they confuse the model on follow-up turns
					let assistantContent: string | null = responseToProcess
						? responseToProcess
							.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
							.replace(/<thought>[\s\S]*?(?:<\/thought>|$)/gi, '')
							.replace(/<\/?think>/gi, '')
							.replace(/<\/?thought>/gi, '')
							.trim()
						: null;
					if (assistantContent === '') { assistantContent = null; }

					// Ensure every tool call has a valid ID
					for (const tc of toolCalls) {
						if (!tc.id) {
							tc.id = 'call_' + Math.random().toString(36).substring(2, 9);
						}
					}

					messages.push({
						role: 'assistant',
						content: assistantContent,
						tool_calls: toolCalls,
					});

					// Push the results as tool messages
					for (const res of actionResults) {
						messages.push({
							role: 'tool',
							content: res.output,
							name: res.label,
							tool_call_id: res.callId || toolCalls.find(tc => tc.function.name === res.label)?.id || 'unknown'
						});
					}

					// Force the model to continue analyzing. Open-weights models (like Gemma)
					// often instantly EOS if the last message in the context is a tool result,
					// because they expect a 'user' prompt to trigger their next reasoning step.
					messages.push({
						role: 'user',
						content: 'Tool execution finished. Please analyze the result and take the next step. Do NOT ask for permission, just use your tools to proceed.'
					});

					depth++;
					this._logService.info(`[LocalLLM] Agentic follow-up loop iteration ${depth}`);

					// Ask for confirmation every 15 iterations to prevent infinite runaways
					if (depth % 15 === 0) {
						progress([{
							kind: 'confirmation',
							title: 'Continue operation?',
							message: `The agent has performed ${depth} autonomous actions. Would you like it to continue?`,
							data: { type: 'continue_loop', messages, responseToProcess, depth },
							buttons: ['Continue', 'Stop']
						}]);
						return {}; // Suspend the loop, wait for user confirmation
					}
				}

				// --- Mid-Loop Compactor ---
				const currentTokens = this._conversationCompactor.estimateTokens(messages);
				if (currentTokens > historyBudget) {
					progress([{ kind: 'progressMessage', content: new MarkdownString('Context window full. Summarizing older tool executions...') }]);
					const fastModel = this.configurationService.getValue<string>('localLLM.smartContext.indexingModel') || selectedModel;
					messages = await this._conversationCompactor.compactMidLoop(messages, historyBudget, token, fastModel);
				}

				// Reset resume flag so the next iteration processes normally
				resumeLoop = false;

				progress([{ kind: 'progressMessage', content: new MarkdownString('Analyzing results...') }]);

				this._logService.info(`[LocalLLM] DEBUG: Follow-up call using selectedModel="${selectedModel}" (depth=${depth})`);
				const followUpResult = await this.streamAndParseResponse(messages, token, selectedModel, progress, openAiTools);
				const followUpResponse = followUpResult.fullResponse;
				toolCalls = followUpResult.toolCalls || [];

				this._logService.info(`[LocalLLM] Follow-up response (iteration ${depth}), toolCalls: ${toolCalls.length}`);
				if (toolCalls.length > 0) {
					this._logService.info(`[LocalLLM] Follow-up tool calls: ${toolCalls.map(tc => `${tc.function.name}(${tc.function.arguments.substring(0, 100)})`).join(', ')}`);
				}
				responseToProcess = followUpResponse;
				fullResponse += '\n\n' + followUpResponse;

				if (!toolCalls || toolCalls.length === 0) {
					this._logService.info(`[LocalLLM] No more tool calls found in follow-up response, exiting loop`);
					break;
				}
			}

			// Run background summarizer AFTER the agentic loop completes
			// (running it during the loop would queue competing requests on Ollama)
			const userMessageForLog = request.message.substring(0, 150);
			const finalSummary = LocalLLMChatAgent.summarizeResponseForMemory(fullResponse);
			const summarizer = async (prompt: string): Promise<string> => {
				const chunks: string[] = [];
				const summaryMessages = [
					{ role: 'system' as const, content: 'You are a concise summarizer. Respond with plain prose only — no markdown, no headings, no bullet points.' },
					{ role: 'user' as const, content: prompt },
				];
				for await (const chunk of this.llmProvider.sendChatRequest(summaryMessages, token, selectedModel)) {
					if (typeof chunk === 'string') {
						chunks.push(chunk);
					}
				}
				return chunks.join('');
			};
			this._agentMemory.appendSummaryEntry(userMessageForLog, finalSummary, summarizer).catch(() => { });

			return {};

		} catch (error: unknown) {
			if (error instanceof Error && error.name === 'AbortError') {
				return {}; // Standard cancellation, no error message needed
			}
			const errorMessage = error instanceof Error ? error.message : String(error);
			this._logService.error(`[LocalLLM] Request failed: ${errorMessage}`);

			return {
				errorDetails: {
					message: `Local LLM error: ${errorMessage}. Make sure your local AI backend is running at ${this.llmProvider.baseUrl}`,
				},
			};
		} finally {
			this._chunkIndex.resume();
		}
	}

	// ========================================================================

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

	// ========================================================================
	// Stream Parser Helper
	// ========================================================================

	private async streamAndParseResponse(
		messages: LLMChatMessage[],
		token: CancellationToken,
		selectedModel: string | undefined,
		progress: (progress: IChatProgress[]) => void,
		tools?: Record<string, unknown>[]
	): Promise<{ totalLength: number; fullResponse: string; toolCalls: LLMToolCall[] }> {
		let totalLength = 0;
		let inThought = false;
		let currentBuffer = '';
		let fullResponse = '';
		let toolCalls: LLMToolCall[] = [];
		const thinkingId = `localLLM-thinking-${Date.now()}`;

		const stripActionTags = LocalLLMChatAgent.stripActionTags;

		// Resilient progress reporter — never lets a renderer exception kill the stream
		const safeProgress = (parts: IChatProgress[]) => {
			try {
				progress(parts);
			} catch (err) {
				this._logService.warn(`[LocalLLM] progress() threw during streaming — UI may be stale: ${err}`);
			}
		};

		for await (const chunk of this.llmProvider.sendChatRequest(messages, token, selectedModel, undefined, tools)) {
			if (token.isCancellationRequested) {
				break;
			}

			if (typeof chunk !== 'string') {
				if (chunk.type === 'tool_calls') {
					toolCalls = chunk.tool_calls;
				}
				continue;
			}

			totalLength += chunk.length;
			currentBuffer += chunk;
			fullResponse += chunk;

			this._logService.trace(`[LocalLLM Agent] Received chunk: ${JSON.stringify(chunk)}`);

			while (currentBuffer.length > 0) {
				const lowerBuffer = currentBuffer.toLowerCase();

				if (!inThought) {
					const thoughtIdx = lowerBuffer.indexOf('<thought>');
					const thinkIdx = lowerBuffer.indexOf('<think>');
					let startIdx = -1;
					let tagLength = 0;
					if (thoughtIdx !== -1 && (thinkIdx === -1 || thoughtIdx < thinkIdx)) {
						startIdx = thoughtIdx;
						tagLength = 9;
					} else if (thinkIdx !== -1) {
						startIdx = thinkIdx;
						tagLength = 7;
					}

					if (startIdx !== -1) {
						if (startIdx > 0) {
							const beforeThought = stripActionTags(currentBuffer.substring(0, startIdx));
							if (beforeThought.length > 0) {
								safeProgress([{ kind: 'markdownContent', content: new MarkdownString(beforeThought) }]);
							}
						}
						inThought = true;
						currentBuffer = currentBuffer.substring(startIdx + tagLength);
					} else {
						// No thinking tag found — flush safe portion as markdown
						const safeLength = Math.max(0, currentBuffer.length - 15);
						if (safeLength > 0) {
							let safeText = stripActionTags(currentBuffer.substring(0, safeLength));
							// Double-safety: remove any stray think/thought tags that slipped through
							safeText = safeText.replace(/<\/?think>/gi, '').replace(/<\/?thought>/gi, '');
							if (safeText.length > 0) {
								safeProgress([{ kind: 'markdownContent', content: new MarkdownString(safeText) }]);
							}
							currentBuffer = currentBuffer.substring(safeLength);
						}
						break;
					}
				} else {
					const endThoughtIdx = lowerBuffer.indexOf('</thought>');
					const endThinkIdx = lowerBuffer.indexOf('</think>');
					let endIdx = -1;
					let endTagLength = 0;

					if (endThoughtIdx !== -1 && (endThinkIdx === -1 || endThoughtIdx < endThinkIdx)) {
						endIdx = endThoughtIdx;
						endTagLength = 10;
					} else if (endThinkIdx !== -1) {
						endIdx = endThinkIdx;
						endTagLength = 8;
					}

					if (endIdx !== -1) {
						if (endIdx > 0) {
							const thoughtText = currentBuffer.substring(0, endIdx);
							safeProgress([{ kind: 'thinking', value: thoughtText, id: thinkingId }]);
							this._logService.debug(`[LocalLLM Thought] ${thoughtText}`);
						}
						inThought = false;
						currentBuffer = currentBuffer.substring(endIdx + endTagLength);
					} else {
						const safeLength = Math.max(0, currentBuffer.length - 11);
						if (safeLength > 0) {
							const thoughtChunk = currentBuffer.substring(0, safeLength);
							safeProgress([{ kind: 'thinking', value: thoughtChunk, id: thinkingId }]);
							this._logService.debug(`[LocalLLM Thought] ${thoughtChunk}`);
							currentBuffer = currentBuffer.substring(safeLength);
						}
						break;
					}
				}
			}
		}

		if (currentBuffer.length > 0) {
			if (inThought) {
				safeProgress([{ kind: 'thinking', value: currentBuffer, id: thinkingId }]);
				this._logService.debug(`[LocalLLM Thought] ${currentBuffer}`);
			} else {
				let cleaned = stripActionTags(currentBuffer);
				// Final cleanup: remove any stray think/thought tags
				cleaned = cleaned.replace(/<\/?think>/gi, '').replace(/<\/?thought>/gi, '');
				if (cleaned.length > 0) {
					safeProgress([{ kind: 'markdownContent', content: new MarkdownString(cleaned) }]);
				}
			}
		}

		return { totalLength, fullResponse, toolCalls };
	}
}
