/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Dark Matter IDE Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { dirname } from '../../../../../base/common/resources.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ITerminalService } from '../../../../contrib/terminal/browser/terminal.js';
import { IChatTerminalToolInvocationData } from '../../common/chatService/chatService.js';
import {
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

export const OllamaCreateFileToolId = 'ollama_createFile';
export const OllamaDeleteFileToolId = 'ollama_deleteFile';
export const OllamaRunCommandToolId = 'ollama_runCommand';

// ============================================================================
// Tool Data (metadata for the tool registry)
// ============================================================================

export const OllamaCreateFileToolData: IToolData = {
	id: OllamaCreateFileToolId,
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

export const OllamaDeleteFileToolData: IToolData = {
	id: OllamaDeleteFileToolId,
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

export const OllamaRunCommandToolData: IToolData = {
	id: OllamaRunCommandToolId,
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

// ============================================================================
// Create/Overwrite File Tool
// ============================================================================

export class OllamaCreateFileTool implements IToolImpl {

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IEditorService private readonly editorService: IEditorService,
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = context.parameters as ICreateFileToolParams;
		const verb = params.actionType === 'overwrite' ? 'Overwrite' : 'Create';

		return {
			invocationMessage: new MarkdownString(`${verb}ing \`${params.filePath}\`...`),
			pastTenseMessage: new MarkdownString(`${verb}d \`${params.filePath}\``),
			confirmationMessages: {
				title: `${verb} File`,
				message: new MarkdownString(`The AI wants to **${params.actionType}** the file:\n\n\`${params.filePath}\``),
				allowAutoConfirm: true,
			},
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as ICreateFileToolParams;
		const rootUri = URI.revive(params.rootUri);
		const fileUri = URI.joinPath(rootUri, params.filePath);

		// Ensure parent directory exists
		const dirUri = dirname(fileUri);
		try { await this.fileService.createFolder(dirUri); } catch { }

		await this.fileService.writeFile(fileUri, VSBuffer.fromString(params.content));
		await this.editorService.openEditor({ resource: fileUri });

		return {
			content: [{ kind: 'text', value: `File ${params.actionType}d: ${params.filePath}` }],
		};
	}
}

// ============================================================================
// Delete File Tool
// ============================================================================

export class OllamaDeleteFileTool implements IToolImpl {

	constructor(
		@IFileService private readonly fileService: IFileService,
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = context.parameters as IDeleteFileToolParams;

		return {
			invocationMessage: new MarkdownString(`Deleting \`${params.filePath}\`...`),
			pastTenseMessage: new MarkdownString(`Deleted \`${params.filePath}\``),
			confirmationMessages: {
				title: 'Delete File',
				message: new MarkdownString(`The AI wants to **delete** the file:\n\n\`${params.filePath}\``),
				allowAutoConfirm: true,
			},
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IDeleteFileToolParams;
		const rootUri = URI.revive(params.rootUri);
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

export class OllamaRunCommandTool implements IToolImpl {

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
			// Use the terminal-specific UI for command confirmation
			toolSpecificData: {
				kind: 'terminal',
				commandLine: { original: params.command },
				language: 'bash',
			} satisfies IChatTerminalToolInvocationData,
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IRunCommandToolParams;

		// Find or create the Dark Matter Agent terminal
		const existing = this.terminalService.instances.find(
			i => i.title === 'Dark Matter Agent' || i.shellLaunchConfig?.name === 'Dark Matter Agent'
		);
		const terminal = existing || await this.terminalService.createTerminal({ config: { name: 'Dark Matter Agent' } });

		await terminal.sendText(params.command, true);

		progress.report({ message: new MarkdownString(`Running: \`${params.command}\``) });

		// Capture terminal output with silence-based detection
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
