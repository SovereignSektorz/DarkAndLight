/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Dark Matter IDE Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { streamToBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { dirname } from '../../../../../base/common/resources.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { ITerminalService } from '../../../../contrib/terminal/browser/terminal.js';
import { IChatTerminalToolInvocationData } from '../../common/chatService/chatService.js';
import { ISearchService, QueryType, ITextQuery, IFileQuery, resultIsMatch } from '../../../../services/search/common/search.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import {
	ILanguageModelToolsService,
	CountTokensCallback,
	IPreparedToolInvocation,
	IToolData,
	IToolImpl,
	IToolInvocation,
	IToolInvocationPreparationContext,
	IToolResult,
	ToolDataSource,
	ToolProgress,
} from '../../common/tools/languageModelToolsService.js';

// ============================================================================
// Tool IDs
// ============================================================================

export const LocalLLMCreateFileToolId = 'localLLM_createFile';
export const LocalLLMDeleteFileToolId = 'localLLM_deleteFile';
export const LocalLLMRunCommandToolId = 'localLLM_runCommand';
export const LocalLLMViewFileToolId = 'localLLM_viewFile';
export const LocalLLMGrepToolId = 'localLLM_grep';
export const LocalLLMGlobToolId = 'localLLM_glob';
export const LocalLLMWebFetchToolId = 'localLLM_webFetch';

// ============================================================================
// Tool Data (metadata for the tool registry)
// ============================================================================

export const LocalLLMCreateFileToolData: IToolData = {
	id: LocalLLMCreateFileToolId,
	displayName: 'Create/Overwrite File',
	modelDescription: 'Creates or overwrites a file in the workspace.',
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: false,
	canRequestPreApproval: true,
	canRequestPostApproval: false,
	inputSchema: {
		type: 'object',
		properties: {
			filePath: { type: 'string', description: 'Workspace-relative file path' },
			content: { type: 'string', description: 'File content to write' },
			actionType: { type: 'string', enum: ['create', 'overwrite'], description: 'Whether to create or overwrite' },
		},
		required: ['filePath', 'content', 'actionType'],
	},
};

export const LocalLLMDeleteFileToolData: IToolData = {
	id: LocalLLMDeleteFileToolId,
	displayName: 'Delete File',
	modelDescription: 'Deletes a file or directory from the workspace.',
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: false,
	canRequestPreApproval: true,
	canRequestPostApproval: false,
	inputSchema: {
		type: 'object',
		properties: {
			filePath: { type: 'string', description: 'Workspace-relative file path to delete' },
		},
		required: ['filePath'],
	},
};

export const LocalLLMRunCommandToolData: IToolData = {
	id: LocalLLMRunCommandToolId,
	displayName: 'Run Terminal Command',
	modelDescription: 'Runs a terminal command in the workspace.',
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: false,
	canRequestPreApproval: true,
	canRequestPostApproval: false,
	inputSchema: {
		type: 'object',
		properties: {
			command: { type: 'string', description: 'The shell command to execute' },
		},
		required: ['command'],
	},
};

export const LocalLLMViewFileToolData: IToolData = {
	id: LocalLLMViewFileToolId,
	displayName: 'View File',
	modelDescription: 'Reads the contents of a file in the workspace. Optionally reads only a range of lines.',
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: false,
	canRequestPreApproval: false,
	canRequestPostApproval: false,
	inputSchema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Workspace-relative file path to read' },
			startLine: { type: 'number', description: 'Starting line number (1-indexed, optional)' },
			endLine: { type: 'number', description: 'Ending line number (1-indexed, inclusive, optional)' },
		},
		required: ['path'],
	},
};

export const LocalLLMGrepToolData: IToolData = {
	id: LocalLLMGrepToolId,
	displayName: 'Search',
	modelDescription: 'Searches file contents in the workspace for a text pattern. Returns matching lines with file paths and line numbers.',
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: false,
	canRequestPreApproval: false,
	canRequestPostApproval: false,
	inputSchema: {
		type: 'object',
		properties: {
			pattern: { type: 'string', description: 'The text pattern to search for' },
			path: { type: 'string', description: 'Workspace-relative directory to search in (optional, defaults to workspace root)' },
			include: { type: 'string', description: 'Glob pattern to filter files (e.g. "*.ts", optional)' },
		},
		required: ['pattern'],
	},
};

export const LocalLLMGlobToolData: IToolData = {
	id: LocalLLMGlobToolId,
	displayName: 'Find Files',
	modelDescription: 'Finds files in the workspace matching a glob pattern.',
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: false,
	canRequestPreApproval: false,
	canRequestPostApproval: false,
	inputSchema: {
		type: 'object',
		properties: {
			pattern: { type: 'string', description: 'Glob pattern to match files (e.g. "**/*.test.ts")' },
			path: { type: 'string', description: 'Workspace-relative directory to search in (optional)' },
		},
		required: ['pattern'],
	},
};

export const LocalLLMWebFetchToolData: IToolData = {
	id: LocalLLMWebFetchToolId,
	displayName: 'Fetch Web Page',
	modelDescription: 'Fetches the content of a web page and returns it as text.',
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: false,
	canRequestPreApproval: true,
	canRequestPostApproval: false,
	inputSchema: {
		type: 'object',
		properties: {
			url: { type: 'string', description: 'The URL to fetch' },
		},
		required: ['url'],
	},
};

// ============================================================================
// Tool Params interfaces
// ============================================================================

export interface ICreateFileToolParams {
	filePath: string;
	content: string;
	actionType: 'create' | 'overwrite';
	rootUri: URI;
}

export interface IDeleteFileToolParams {
	filePath: string;
	rootUri: URI;
}

export interface IRunCommandToolParams {
	command: string;
}

export interface IViewFileToolParams {
	path: string;
	startLine?: number;
	endLine?: number;
	rootUri: URI;
}

export interface IGrepToolParams {
	pattern: string;
	path?: string;
	include?: string;
}

export interface IGlobToolParams {
	pattern: string;
	path?: string;
}

export interface IWebFetchToolParams {
	url: string;
}

// ============================================================================
// Create/Overwrite File Tool
// ============================================================================

export class LocalLLMCreateFileTool implements IToolImpl {

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
	) { }

	private getRootUri(params: ICreateFileToolParams): URI {
		if (params.rootUri) { return URI.revive(params.rootUri); }
		const workspace = this.workspaceService.getWorkspace();
		return workspace.folders.length > 0 ? workspace.folders[0].uri : URI.file('/');
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = context.parameters as ICreateFileToolParams;
		const verb = params.actionType === 'overwrite' ? 'Overwrite' : 'Create';
		const rootUri = this.getRootUri(params);
		const fileUri = URI.joinPath(rootUri, params.filePath);
		const fileLink = `[](${fileUri.toString()})`;

		return {
			invocationMessage: new MarkdownString(`${verb}ing ${fileLink}...`),
			pastTenseMessage: new MarkdownString(`${verb}d ${fileLink}`),
			confirmationMessages: {
				title: `${verb} File`,
				message: new MarkdownString(`The AI wants to **${params.actionType}** the file:\n\n\`${params.filePath}\``),
				allowAutoConfirm: true,
			},
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as ICreateFileToolParams;
		const rootUri = this.getRootUri(params);
		const fileUri = URI.joinPath(rootUri, params.filePath);

		const dirUri = dirname(fileUri);
		try { await this.fileService.createFolder(dirUri); } catch { }

		await this.textFileService.write(fileUri, params.content);
		await this.editorService.openEditor({ resource: fileUri });

		return {
			content: [{ kind: 'text', value: `File ${params.actionType}d: ${params.filePath}` }],
		};
	}
}

// ============================================================================
// Delete File Tool
// ============================================================================

export class LocalLLMDeleteFileTool implements IToolImpl {

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
	) { }

	private getRootUri(params: IDeleteFileToolParams): URI {
		if (params.rootUri) { return URI.revive(params.rootUri); }
		const workspace = this.workspaceService.getWorkspace();
		return workspace.folders.length > 0 ? workspace.folders[0].uri : URI.file('/');
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = context.parameters as IDeleteFileToolParams;
		const rootUri = this.getRootUri(params);
		const fileUri = URI.joinPath(rootUri, params.filePath);
		const fileLink = `[](${fileUri.toString()})`;

		return {
			invocationMessage: new MarkdownString(`Deleting ${fileLink}...`),
			pastTenseMessage: new MarkdownString(`Deleted ${fileLink}`),
			confirmationMessages: {
				title: 'Delete File',
				message: new MarkdownString(`The AI wants to **delete** the file:\n\n\`${params.filePath}\``),
				allowAutoConfirm: true,
			},
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IDeleteFileToolParams;
		const rootUri = this.getRootUri(params);
		const fileUri = URI.joinPath(rootUri, params.filePath);

		await this.fileService.del(fileUri, { recursive: true });

		return {
			content: [{ kind: 'text', value: `Deleted: ${params.filePath}` }],
		};
	}
}

// ============================================================================
// Run Terminal Command Tool
// ============================================================================

export class LocalLLMRunCommandTool implements IToolImpl {

	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = context.parameters as IRunCommandToolParams;

		return {
			invocationMessage: new MarkdownString(`Running \`${params.command}\``),
			pastTenseMessage: new MarkdownString(`Ran \`${params.command}\``),
			confirmationMessages: {
				title: 'Run Terminal Command',
				message: new MarkdownString(`The AI wants to run a terminal command:\n\n\`${params.command}\``),
				allowAutoConfirm: true,
			},
			toolSpecificData: {
				kind: 'terminal',
				commandLine: { original: params.command },
				language: 'bash',
			} satisfies IChatTerminalToolInvocationData,
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IRunCommandToolParams;

		const existing = this.terminalService.instances.find(
			i => i.title === 'Dark Matter Agent' || i.shellLaunchConfig?.name === 'Dark Matter Agent'
		);
		const terminal = existing || await this.terminalService.createTerminal({ config: { name: 'Dark Matter Agent' } });

		await terminal.sendText(params.command, true);
		progress.report({ message: new MarkdownString(`Running: \`${params.command}\``) });

		const output = await this.captureTerminalOutput(terminal);

		return {
			content: [{ kind: 'text', value: output.length > 0 ? `Command output:\n${output}` : 'Command executed (no output)' }],
		};
	}

	private captureTerminalOutput(terminal: import('../../../../contrib/terminal/browser/terminal.js').ITerminalInstance): Promise<string> {
		const MAX_OUTPUT = 4000;
		const SILENCE_TIMEOUT = 5000;
		const ABSOLUTE_TIMEOUT = 30000;

		return new Promise<string>(resolve => {
			let output = '';
			let silenceTimer: ReturnType<typeof setTimeout> | undefined;
			const disposables: { dispose(): void }[] = [];

			const finish = () => {
				if (silenceTimer) { clearTimeout(silenceTimer); }
				for (const d of disposables) { d.dispose(); }
				const truncated = output.length > MAX_OUTPUT
					? output.substring(output.length - MAX_OUTPUT)
					: output;
				resolve(truncated.trim());
			};

			const sub = this.terminalService.onAnyInstanceData(e => {
				if (e.instance !== terminal) { return; }
				output += e.data;
				if (silenceTimer) { clearTimeout(silenceTimer); }
				silenceTimer = setTimeout(finish, SILENCE_TIMEOUT);
			});
			disposables.push(sub);

			const absoluteTimer = setTimeout(finish, ABSOLUTE_TIMEOUT);
			disposables.push({ dispose: () => clearTimeout(absoluteTimer) });

			silenceTimer = setTimeout(finish, SILENCE_TIMEOUT);
		});
	}
}

// ============================================================================
// View File Tool (Copilot equivalent: "view")
// ============================================================================

export class LocalLLMViewFileTool implements IToolImpl {

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
	) { }

	private getRootUri(params: IViewFileToolParams): URI {
		if (params.rootUri) { return URI.revive(params.rootUri); }
		const workspace = this.workspaceService.getWorkspace();
		return workspace.folders.length > 0 ? workspace.folders[0].uri : URI.file('/');
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = context.parameters as IViewFileToolParams;
		const rootUri = this.getRootUri(params);
		const fileUri = URI.joinPath(rootUri, params.path);
		const fileLink = `[](${fileUri.toString()})`;

		return {
			invocationMessage: new MarkdownString(`Reading ${fileLink}`),
			pastTenseMessage: new MarkdownString(`Read ${fileLink}`),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IViewFileToolParams;
		const rootUri = this.getRootUri(params);
		const fileUri = URI.joinPath(rootUri, params.path);

		try {
			const content = await this.fileService.readFile(fileUri);
			const text = content.value.toString();
			const lines = text.split('\n');

			let result: string;
			if (params.startLine !== undefined && params.endLine !== undefined) {
				const start = Math.max(0, params.startLine - 1);
				const end = Math.min(lines.length, params.endLine);
				const selectedLines = lines.slice(start, end);
				result = `File: ${params.path} (lines ${params.startLine}-${end})\n\n${selectedLines.map((l, i) => `${start + i + 1}: ${l}`).join('\n')}`;
			} else if (params.startLine !== undefined) {
				const start = Math.max(0, params.startLine - 1);
				const selectedLines = lines.slice(start);
				result = `File: ${params.path} (from line ${params.startLine})\n\n${selectedLines.map((l, i) => `${start + i + 1}: ${l}`).join('\n')}`;
			} else {
				// Truncate if too large
				const MAX_FILE_SIZE = 100_000;
				if (text.length > MAX_FILE_SIZE) {
					result = `File: ${params.path} (${lines.length} lines, truncated to first ${MAX_FILE_SIZE} chars)\n\n${text.substring(0, MAX_FILE_SIZE)}\n\n... (truncated)`;
				} else {
					result = `File: ${params.path} (${lines.length} lines)\n\n${text}`;
				}
			}

			return {
				content: [{ kind: 'text', value: result }],
			};
		} catch {
			return {
				content: [{ kind: 'text', value: `Error: Could not read file '${params.path}'. File may not exist.` }],
			};
		}
	}
}

// ============================================================================
// Grep Tool (Copilot equivalent: "grep")
// ============================================================================

export class LocalLLMGrepTool implements IToolImpl {

	constructor(
		@ISearchService private readonly searchService: ISearchService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = context.parameters as IGrepToolParams;

		return {
			invocationMessage: new MarkdownString(`Searching for \`${params.pattern}\``),
			pastTenseMessage: new MarkdownString(`Searched for \`${params.pattern}\``),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IGrepToolParams;

		const workspace = this.workspaceService.getWorkspace();
		if (workspace.folders.length === 0) {
			return { content: [{ kind: 'text', value: 'Error: No workspace folder open.' }] };
		}

		const folderUri = workspace.folders[0].uri;
		const searchFolder = params.path ? URI.joinPath(folderUri, params.path) : folderUri;

		const query: ITextQuery = {
			type: QueryType.Text,
			contentPattern: { pattern: params.pattern },
			folderQueries: [{ folder: searchFolder }],
			maxResults: 50,
		};

		if (params.include) {
			query.includePattern = { [params.include]: true };
		}

		try {
			const results = await this.searchService.textSearch(query, token);
			const matches: string[] = [];

			for (const result of results.results) {
				const relativePath = this.workspaceService.getWorkspaceFolder(result.resource)
					? result.resource.path.substring(folderUri.path.length + 1)
					: result.resource.fsPath;

			for (const match of result.results || []) {
					if (resultIsMatch(match)) {
						const lineNum = match.rangeLocations[0]?.source.startLineNumber ?? 0;
						matches.push(`${relativePath}:${lineNum + 1}: ${match.previewText.trim()}`);
					} else {
						matches.push(`${relativePath}:${match.lineNumber + 1}: ${match.text.trim()}`);
					}
				}
			}

			if (matches.length === 0) {
				return { content: [{ kind: 'text', value: `No matches found for pattern: ${params.pattern}` }] };
			}

			const header = `Found ${matches.length} match${matches.length === 1 ? '' : 'es'} for "${params.pattern}":\n\n`;
			return {
				content: [{ kind: 'text', value: header + matches.join('\n') }],
			};
		} catch (err) {
			return {
				content: [{ kind: 'text', value: `Search error: ${err instanceof Error ? err.message : String(err)}` }],
			};
		}
	}
}

// ============================================================================
// Glob Tool (Copilot equivalent: "glob")
// ============================================================================

export class LocalLLMGlobTool implements IToolImpl {

	constructor(
		@ISearchService private readonly searchService: ISearchService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = context.parameters as IGlobToolParams;

		return {
			invocationMessage: new MarkdownString(`Finding files matching \`${params.pattern}\``),
			pastTenseMessage: new MarkdownString(`Found files matching \`${params.pattern}\``),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IGlobToolParams;

		const workspace = this.workspaceService.getWorkspace();
		if (workspace.folders.length === 0) {
			return { content: [{ kind: 'text', value: 'Error: No workspace folder open.' }] };
		}

		const folderUri = workspace.folders[0].uri;
		const searchFolder = params.path ? URI.joinPath(folderUri, params.path) : folderUri;

		const query: IFileQuery = {
			type: QueryType.File,
			folderQueries: [{ folder: searchFolder }],
			includePattern: { [params.pattern]: true },
			maxResults: 100,
		};

		try {
			const results = await this.searchService.fileSearch(query, token);
			const files = results.results.map(r => {
				return r.resource.path.substring(folderUri.path.length + 1);
			});

			if (files.length === 0) {
				return { content: [{ kind: 'text', value: `No files found matching pattern: ${params.pattern}` }] };
			}

			const header = `Found ${files.length} file${files.length === 1 ? '' : 's'} matching "${params.pattern}":\n\n`;
			return {
				content: [{ kind: 'text', value: header + files.join('\n') }],
			};
		} catch (err) {
			return {
				content: [{ kind: 'text', value: `File search error: ${err instanceof Error ? err.message : String(err)}` }],
			};
		}
	}
}

// ============================================================================
// Web Fetch Tool (Copilot equivalent: "web_search")
// ============================================================================

export class LocalLLMWebFetchTool implements IToolImpl {

	constructor(
		@IRequestService private readonly requestService: IRequestService,
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = context.parameters as IWebFetchToolParams;

		return {
			invocationMessage: new MarkdownString(`Fetching \`${params.url}\``),
			pastTenseMessage: new MarkdownString(`Fetched \`${params.url}\``),
			confirmationMessages: {
				title: 'Fetch Web Page',
				message: new MarkdownString(`The AI wants to fetch a web page:\n\n\`${params.url}\``),
				allowAutoConfirm: true,
			},
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IWebFetchToolParams;
		const MAX_RESPONSE_SIZE = 50_000;

		try {
			const response = await this.requestService.request({
				callSite: 'LocalLLMWebFetchTool',
				url: params.url,
				type: 'GET',
				headers: {
					'User-Agent': 'DarkMatter-IDE/1.0',
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
				},
			}, token);

			const buffer = await streamToBuffer(response.stream);
			let text = buffer.toString();

			// Basic HTML-to-text: strip tags, decode common entities
			text = text
				.replace(/<script[\s\S]*?<\/script>/gi, '')
				.replace(/<style[\s\S]*?<\/style>/gi, '')
				.replace(/<[^>]+>/g, ' ')
				.replace(/&amp;/g, '&')
				.replace(/&lt;/g, '<')
				.replace(/&gt;/g, '>')
				.replace(/&quot;/g, '"')
				.replace(/&#39;/g, '\'')
				.replace(/&nbsp;/g, ' ')
				.replace(/\s+/g, ' ')
				.trim();

			if (text.length > MAX_RESPONSE_SIZE) {
				text = text.substring(0, MAX_RESPONSE_SIZE) + '\n\n... (truncated)';
			}

			return {
				content: [{ kind: 'text', value: `Content from ${params.url}:\n\n${text}` }],
			};
		} catch (err) {
			return {
				content: [{ kind: 'text', value: `Fetch error for ${params.url}: ${err instanceof Error ? err.message : String(err)}` }],
			};
		}
	}
}

export function registerLocalLLMTools(toolsService: ILanguageModelToolsService, instantiationService: IInstantiationService): void {
	toolsService.registerToolData(LocalLLMViewFileToolData);
	toolsService.registerToolImplementation(LocalLLMViewFileToolId, instantiationService.createInstance(LocalLLMViewFileTool));

	toolsService.registerToolData(LocalLLMGrepToolData);
	toolsService.registerToolImplementation(LocalLLMGrepToolId, instantiationService.createInstance(LocalLLMGrepTool));

	toolsService.registerToolData(LocalLLMGlobToolData);
	toolsService.registerToolImplementation(LocalLLMGlobToolId, instantiationService.createInstance(LocalLLMGlobTool));

	toolsService.registerToolData(LocalLLMCreateFileToolData);
	toolsService.registerToolImplementation(LocalLLMCreateFileToolId, instantiationService.createInstance(LocalLLMCreateFileTool));

	toolsService.registerToolData(LocalLLMDeleteFileToolData);
	toolsService.registerToolImplementation(LocalLLMDeleteFileToolId, instantiationService.createInstance(LocalLLMDeleteFileTool));

	toolsService.registerToolData(LocalLLMRunCommandToolData);
	toolsService.registerToolImplementation(LocalLLMRunCommandToolId, instantiationService.createInstance(LocalLLMRunCommandTool));

	toolsService.registerToolData(LocalLLMWebFetchToolData);
	toolsService.registerToolImplementation(LocalLLMWebFetchToolId, instantiationService.createInstance(LocalLLMWebFetchTool));
}
