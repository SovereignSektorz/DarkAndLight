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
import { ChatResponseReferencePartStatusKind, IChatFollowup, IChatProgress } from '../../common/chatService/chatService.js';
import { LLMChatMessage, LocalLLMProvider } from './localLLMProvider.js';
import { IChatRequestVariableEntry, isImplicitVariableEntry } from '../../common/attachments/chatVariableEntries.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IEditor } from '../../../../../editor/common/editorCommon.js';
import { isLocation } from '../../../../../editor/common/languages.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';

import { ILanguageModelToolsService, CountTokensCallback } from '../../common/tools/languageModelToolsService.js';
import { LocalLLMRunCommandToolId, LocalLLMCreateFileToolId, LocalLLMDeleteFileToolId, LocalLLMViewFileToolId, LocalLLMGrepToolId, LocalLLMGlobToolId, LocalLLMWebFetchToolId } from './localLLMTools.js';
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

	/** Max iterations for the agentic follow-up loop */
	private static readonly MAX_AGENT_LOOP_DEPTH = 3;

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
			'Format your responses with markdown when appropriate.',
			'',
			'=== YOUR TOOLS ===',
			'You MUST use these tools by embedding XML tags directly in your response:',
			'',
			'FILE WRITE OPERATIONS (these modify the workspace):',
			'  <file_action type="create" path="relative/path">file content here</file_action>',
			'  <file_action type="overwrite" path="relative/path">new full content</file_action>',
			'  <file_action type="delete" path="relative/path" />',
			'  <file_action type="runCommand" command="npm test" />',
			'',
			'READ/SEARCH OPERATIONS (results are fed back to you automatically):',
			'  <tool_call type="viewFile" path="relative/path" />',
			'  <tool_call type="viewFile" path="relative/path" startLine="10" endLine="50" />',
			'  <tool_call type="grep" pattern="searchPattern" />',
			'  <tool_call type="grep" pattern="TODO" include="*.ts" />',
			'  <tool_call type="glob" pattern="**/*.test.ts" />',
			'  <tool_call type="webFetch" url="https://example.com" />',
			'',
			'CRITICAL RULES:',
			'- When the user asks you to create a file, USE <file_action type="create"> — do NOT just show code.',
			'- When you need to read a file before editing it, USE <tool_call type="viewFile"> first.',
			'- When you need to find something in the codebase, USE <tool_call type="grep"> or <tool_call type="glob">.',
			'- Tool results are automatically provided back to you so you can continue working.',
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

		// Tool reminder at the end of the system prompt (combats "lost in the middle" problem
		// with local LLMs — they pay most attention to the start and end of long prompts)
		parts.push('');
		parts.push('=== REMINDER: YOU HAVE TOOLS — USE THEM ===');
		parts.push('Do NOT just describe what to do. Take action with your tools:');
		parts.push('- To create/edit files: <file_action type="create" path="...">content</file_action>');
		parts.push('- To read files: <tool_call type="viewFile" path="..." />');
		parts.push('- To search code: <tool_call type="grep" pattern="..." />');
		parts.push('- To run commands: <file_action type="runCommand" command="..." />');

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
		// Determine which model to use: picker selection > settings default
		const selectedModel = request.userSelectedModelId || undefined;
		const activeModelName = selectedModel
			? (selectedModel.startsWith('localLLM:') ? selectedModel.slice('localLLM:'.length)
				: selectedModel.startsWith('ollama:') ? selectedModel.slice('ollama:'.length)
				: selectedModel)
			: this.llmProvider.model;
		this._logService.info(`[LocalLLM] Handling request with model "${activeModelName}": "${request.message.substring(0, 100)}"`);

		const messages: LLMChatMessage[] = [];

		// System prompt — uses smart context (chunk index + memory) or legacy fallback
		const { prompt: systemPrompt, contextFileUris } = await this.buildSystemPrompt(request.message);
		this._logService.info(`[LocalLLM] System prompt size: ${Math.round(systemPrompt.length / 1024)}KB`);
		messages.push({ role: 'system', content: systemPrompt });

		// Emit file reference pills for files the agent analyzed
		for (const fileUri of contextFileUris) {
			progress([{ kind: 'reference', reference: fileUri }]);
		}

		// Conversation history — use compactor if enabled
		const maxContextWindow = this.configurationService.getValue<number>('localLLM.maxContextWindow') || 131072;
		const systemPromptTokens = Math.ceil(systemPrompt.length / 4);
		const remainingAfterSystem = maxContextWindow - systemPromptTokens;
		const responseBudget = Math.floor(maxContextWindow * 0.25); // 25% reserved for response generation
		const historyBudget = Math.max(remainingAfterSystem - responseBudget, 2000);

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


		try {
			const { totalLength, fullResponse } = await this.streamAndParseResponse(messages, token, selectedModel, progress);

			this._logService.info(`[LocalLLM] Request completed, response length: ${totalLength}\n\n=== UNFILTERED RAW RESPONSE ===\n${fullResponse}\n===============================`);

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

			// Build a lightweight summarizer callback
			const summarizer = async (prompt: string): Promise<string> => {
				const chunks: string[] = [];
				const summaryMessages = [
					{ role: 'system' as const, content: 'You are a concise summarizer. Respond with plain prose only — no markdown, no headings, no bullet points.' },
					{ role: 'user' as const, content: prompt },
				];
				for await (const chunk of this.llmProvider.sendChatRequest(summaryMessages, token, selectedModel)) {
					chunks.push(chunk);
				}
				return chunks.join('');
			};

			this._agentMemory.appendSummaryEntry(userMessageForLog, responseSummary, summarizer).catch(() => { });

			// Execute agent actions via the tool invocation pipeline
			let depth = 0;
			let responseToProcess = fullResponse;

			while (depth < LocalLLMChatAgent.MAX_AGENT_LOOP_DEPTH) {
				const actionResults = await this.executeAgentActions(responseToProcess, request, progress, token);

				if (actionResults.length === 0) {
					break;
				}

				depth++;
				this._logService.info(`[LocalLLM] Agentic follow-up loop iteration ${depth}`);

				const outputContext = actionResults.map(t => {
					if (t.type === 'terminal') {
						return `Command: \`${t.label}\`\n<terminal_output>\n${t.output}\n</terminal_output>`;
					} else {
						return `Tool: ${t.label}\n<tool_result>\n${t.output}\n</tool_result>`;
					}
				}).join('\n\n');

				const labelList = actionResults.map(t => t.label).join(', ');
				const followUpMessage = `Results from your tool calls:\n\n${outputContext}\n\nAnalyze the results and continue. You may use additional tools if needed, or provide your response to the user.`;

				messages.push({ role: 'assistant', content: `[Executed: ${labelList}]` });
				messages.push({ role: 'user', content: followUpMessage });

				progress([{ kind: 'progressMessage', content: new MarkdownString('Analyzing results...') }]);

				const { fullResponse: followUpResponse } = await this.streamAndParseResponse(messages, token, selectedModel, progress);

				responseToProcess = followUpResponse;
				if (!/(?:<file_action\s+|<tool_call\s+)/i.test(followUpResponse)) { break; }
			}

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
		}
	}

	// ========================================================================
	// Autonomous Actions (via Tool Invocation Pipeline)
	// ========================================================================

	/**
	 * Parse <file_action> and <tool_call> tags from the AI response and dispatch each
	 * as a tool invocation through ILanguageModelToolsService.
	 * Returns results that should be fed back to the LLM for follow-up processing.
	 */
	private async executeAgentActions(
		fullResponse: string,
		request: IChatAgentRequest,
		progress: (progress: IChatProgress[]) => void,
		token: CancellationToken,
	): Promise<{ type: 'terminal' | 'tool'; label: string; output: string }[]> {
		const actionResults: { type: 'terminal' | 'tool'; label: string; output: string }[] = [];

		const workspace = this.workspaceService.getWorkspace();
		if (workspace.folders.length === 0) {
			return [];
		}
		const rootUri = workspace.folders[0].uri;

		// Simple token counter for the tool API
		const countTokens: CountTokensCallback = async (input: string) => Math.ceil(input.length / 4);

		// Helper to extract text from tool results
		const extractToolText = (result: import('../../common/tools/languageModelToolsService.js').IToolResult): string => {
			return result.content
				.filter((p): p is { kind: 'text'; value: string } => p.kind === 'text')
				.map(p => p.value)
				.join('\n');
		};

		// --- Parse <file_action> tags ---
		const fileActionRegex = /<file_action\s+type="([^"]+)"(?:\s+path="([^"]+)")?(?:\s+command="([^"]+)")?\s*(?:>([\s\S]*?)<\/file_action>|\/\>)/g;
		let match;

		while ((match = fileActionRegex.exec(fullResponse)) !== null) {
			const type = match[1];
			const filePath = match[2];
			const command = match[3];
			const content = match[4] || '';

			try {
				const toolCallId = `localLLM-${type}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

				if (type === 'runCommand' && command) {
					progress([{
						kind: 'externalToolInvocationUpdate',
						toolCallId,
						toolName: 'Run Command',
						isComplete: false,
						invocationMessage: `Running command: ${command}`
					}]);

					const result = await this.toolsService.invokeTool(
						{
							callId: toolCallId,
							toolId: LocalLLMRunCommandToolId,
							parameters: { command },
							context: { sessionResource: request.sessionResource },
						},
						countTokens,
						token,
					);

					progress([{
						kind: 'externalToolInvocationUpdate',
						toolCallId,
						toolName: 'Run Command',
						isComplete: true
					}]);

					const outputText = extractToolText(result);
					if (outputText.length > 0 && !outputText.includes('(no output)')) {
						actionResults.push({ type: 'terminal', label: command, output: outputText });
					}
				} else if (filePath && (type === 'create' || type === 'overwrite')) {
					const fileUri = URI.joinPath(rootUri, filePath);

					// Emit file reference pill
					progress([{
						kind: 'reference',
						reference: fileUri,
						options: {
							status: {
								description: type === 'create' ? 'Created' : 'Modified',
								kind: ChatResponseReferencePartStatusKind.Complete,
							}
						}
					}]);

					// Dispatch through tool pipeline
					progress([{
						kind: 'externalToolInvocationUpdate',
						toolCallId,
						toolName: type === 'create' ? 'Create File' : 'Edit File',
						isComplete: false,
						invocationMessage: `${type === 'create' ? 'Creating' : 'Editing'} ${filePath}`
					}]);

					await this.toolsService.invokeTool(
						{
							callId: toolCallId,
							toolId: LocalLLMCreateFileToolId,
							parameters: { filePath, content, actionType: type, rootUri },
							context: { sessionResource: request.sessionResource },
						},
						countTokens,
						token,
					);

					progress([{
						kind: 'externalToolInvocationUpdate',
						toolCallId,
						toolName: type === 'create' ? 'Create File' : 'Edit File',
						isComplete: true
					}]);

					// Also emit textEdit for the editing session tracking
					progress([{
						kind: 'textEdit',
						uri: fileUri,
						edits: [{
							range: { startLineNumber: 1, startColumn: 1, endLineNumber: Number.MAX_SAFE_INTEGER, endColumn: 1 },
							text: content,
						}],
						done: true,
					}]);
				} else if (filePath && type === 'delete') {
					const fileUri = URI.joinPath(rootUri, filePath);

					progress([{
						kind: 'reference',
						reference: fileUri,
						options: {
							status: {
								description: 'Deleted',
								kind: ChatResponseReferencePartStatusKind.Omitted,
							},
							isDeletion: true,
						}
					}]);

					progress([{
						kind: 'externalToolInvocationUpdate',
						toolCallId,
						toolName: 'Delete File',
						isComplete: false,
						invocationMessage: `Deleting ${filePath}`
					}]);

					await this.toolsService.invokeTool(
						{
							callId: toolCallId,
							toolId: LocalLLMDeleteFileToolId,
							parameters: { filePath, rootUri },
							context: { sessionResource: request.sessionResource },
						},
						countTokens,
						token,
					);

					progress([{
						kind: 'externalToolInvocationUpdate',
						toolCallId,
						toolName: 'Delete File',
						isComplete: true
					}]);

					progress([{
						kind: 'workspaceEdit',
						edits: [{ oldResource: fileUri }],
					}]);
				}
			} catch (err) {
				this._logService.error(`[LocalLLM] Tool invocation failed for action ${type}: ${err}`);
			}
		}

		// --- Parse <tool_call> tags (read/search tools that return data) ---
		const toolCallRegex = /<tool_call\s+type="([^"]+)"([^>]*?)\s*\/>/g;
		while ((match = toolCallRegex.exec(fullResponse)) !== null) {
			const toolType = match[1];
			const attrsStr = match[2];

			// Parse attributes from the tag
			const attrs: Record<string, string> = {};
			const attrRegex = /(\w+)="([^"]*)"/g;
			let attrMatch;
			while ((attrMatch = attrRegex.exec(attrsStr)) !== null) {
				attrs[attrMatch[1]] = attrMatch[2];
			}

			try {
				const toolCallId = `localLLM-${toolType}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
				let toolId: string;
				let toolName: string;
				let parameters: Record<string, unknown>;

				switch (toolType) {
					case 'viewFile':
						toolId = LocalLLMViewFileToolId;
						toolName = 'View File';
						parameters = {
							path: attrs.path,
							startLine: attrs.startLine ? parseInt(attrs.startLine) : undefined,
							endLine: attrs.endLine ? parseInt(attrs.endLine) : undefined,
							rootUri,
						};
						break;
					case 'grep':
						toolId = LocalLLMGrepToolId;
						toolName = 'Search';
						parameters = {
							pattern: attrs.pattern,
							path: attrs.path,
							include: attrs.include,
						};
						break;
					case 'glob':
						toolId = LocalLLMGlobToolId;
						toolName = 'Find Files';
						parameters = {
							pattern: attrs.pattern,
							path: attrs.path,
						};
						break;
					case 'webFetch':
						toolId = LocalLLMWebFetchToolId;
						toolName = 'Fetch Web Page';
						parameters = {
							url: attrs.url,
						};
						break;
					default:
						this._logService.warn(`[LocalLLM] Unknown tool_call type: ${toolType}`);
						continue;
				}

				// Show invocation progress
				const invocationLabel = attrs.path || attrs.pattern || attrs.url || toolType;
				progress([{
					kind: 'externalToolInvocationUpdate',
					toolCallId,
					toolName,
					isComplete: false,
					invocationMessage: `${toolName}: ${invocationLabel}`
				}]);

				const result = await this.toolsService.invokeTool(
					{
						callId: toolCallId,
						toolId,
						parameters,
						context: { sessionResource: request.sessionResource },
					},
					countTokens,
					token,
				);

				progress([{
					kind: 'externalToolInvocationUpdate',
					toolCallId,
					toolName,
					isComplete: true
				}]);

				// Feed result back to the LLM
				const outputText = extractToolText(result);
				actionResults.push({ type: 'tool', label: `${toolName}: ${invocationLabel}`, output: outputText });
			} catch (err) {
				this._logService.error(`[LocalLLM] Tool call failed for ${toolType}: ${err}`);
			}
		}

		return actionResults;
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

	// ========================================================================
	// Stream Parser Helper
	// ========================================================================

	private async streamAndParseResponse(
		messages: LLMChatMessage[],
		token: CancellationToken,
		selectedModel: string | undefined,
		progress: (progress: IChatProgress[]) => void
	): Promise<{ totalLength: number; fullResponse: string }> {
		let totalLength = 0;
		let inThought = false;
		let currentBuffer = '';
		let fullResponse = '';

		const stripActionTags = LocalLLMChatAgent.stripActionTags;

		for await (const chunk of this.llmProvider.sendChatRequest(messages, token, selectedModel)) {
			if (token.isCancellationRequested) {
				break;
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

					const fileActionIdx = lowerBuffer.indexOf('<file_action');
					const toolCallIdx = lowerBuffer.indexOf('<tool_call');
					// Find the earliest action tag
					let actionIdx = -1;
					let isToolCall = false;
					if (fileActionIdx !== -1 && (toolCallIdx === -1 || fileActionIdx <= toolCallIdx)) {
						actionIdx = fileActionIdx;
					} else if (toolCallIdx !== -1) {
						actionIdx = toolCallIdx;
						isToolCall = true;
					}

					if (startIdx !== -1 && (actionIdx === -1 || startIdx <= actionIdx)) {
						if (startIdx > 0) {
							const beforeThought = stripActionTags(currentBuffer.substring(0, startIdx));
							if (beforeThought.length > 0) {
								progress([{ kind: 'markdownContent', content: new MarkdownString(beforeThought) }]);
							}
						}
						inThought = true;
						currentBuffer = currentBuffer.substring(startIdx + tagLength);
					} else if (actionIdx !== -1) {
						if (actionIdx > 0) {
							const beforeAction = currentBuffer.substring(0, actionIdx);
							if (beforeAction.trim().length > 0) {
								progress([{ kind: 'markdownContent', content: new MarkdownString(beforeAction) }]);
							}
							currentBuffer = currentBuffer.substring(actionIdx);
							continue;
						}
						if (isToolCall) {
							// tool_call is always self-closing: <tool_call ... />
							const closingIdx = currentBuffer.indexOf('/>', actionIdx);
							if (closingIdx !== -1) {
								currentBuffer = currentBuffer.substring(closingIdx + 2);
							} else {
								break;
							}
						} else {
							// file_action: check for self-closing or paired tags
							const openTagEndIdx = currentBuffer.indexOf('>', actionIdx);
							if (openTagEndIdx !== -1) {
								const isSelfClosing = currentBuffer.charAt(openTagEndIdx - 1) === '/';
								if (isSelfClosing) {
									currentBuffer = currentBuffer.substring(openTagEndIdx + 1);
								} else {
									const pairedCloseIdx = lowerBuffer.indexOf('</file_action>', openTagEndIdx);
									if (pairedCloseIdx !== -1) {
										currentBuffer = currentBuffer.substring(pairedCloseIdx + '</file_action>'.length);
									} else {
										break;
									}
								}
							} else {
								break;
							}
						}
					} else {
						const safeLength = Math.max(0, currentBuffer.length - 15);
						if (safeLength > 0) {
							const safeText = stripActionTags(currentBuffer.substring(0, safeLength));
							if (safeText.length > 0) {
								progress([{ kind: 'markdownContent', content: new MarkdownString(safeText) }]);
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
							progress([{ kind: 'thinking', value: thoughtText }]);
							this._logService.debug(`[LocalLLM Thought] ${thoughtText}`);
						}
						inThought = false;
						currentBuffer = currentBuffer.substring(endIdx + endTagLength);
					} else {
						const safeLength = Math.max(0, currentBuffer.length - 11);
						if (safeLength > 0) {
							const thoughtChunk = currentBuffer.substring(0, safeLength);
							progress([{ kind: 'thinking', value: thoughtChunk }]);
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
				progress([{ kind: 'thinking', value: currentBuffer }]);
				this._logService.debug(`[LocalLLM Thought] ${currentBuffer}`);
			} else {
				const cleaned = stripActionTags(currentBuffer);
				if (cleaned.length > 0) {
					progress([{ kind: 'markdownContent', content: new MarkdownString(cleaned) }]);
				}
			}
		}

		return { totalLength, fullResponse };
	}
}
