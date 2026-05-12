/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Dark Matter IDE Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { ChatAgentLocation } from '../../common/constants.js';
import {
	IChatMessage,
	IChatResponsePart,
	ILanguageModelChatMetadata,
	ILanguageModelChatMetadataAndIdentifier,
	ILanguageModelChatProvider,
	ILanguageModelChatRequestOptions,
	ILanguageModelChatResponse,
	ILanguageModelChatInfoOptions,
	ILanguageModelsService,
} from '../../common/languageModels.js';
import { LocalLLMProvider, LLMModelInfo } from './localLLMProvider.js';
import { LocalLLMChatAgent } from './localLLMChatAgent.js';
import { LocalLLMStatusBarEntry } from './localLLMStatusBar.js';
import { WorkspaceChunkIndex } from './workspaceChunkIndex.js';
import { AgentMemory } from './agentMemory.js';
import { ConversationCompactor } from './conversationCompactor.js';
import {
	LocalLLMCreateFileTool, LocalLLMCreateFileToolData,
	LocalLLMDeleteFileTool, LocalLLMDeleteFileToolData,
	LocalLLMRunCommandTool, LocalLLMRunCommandToolData,
} from './localLLMTools.js';
import { ILanguageModelToolsService } from '../../common/tools/languageModelToolsService.js';

const LOCAL_LLM_EXTENSION_ID = new ExtensionIdentifier('vscode.chat');
const LOCAL_LLM_VENDOR = 'localLLM';

// Register settings
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'localLLM',
	title: 'Local LLM',
	type: 'object',
	properties: {
		'localLLM.backendType': {
			type: 'string',
			default: 'ollama',
			enum: ['ollama', 'llamacpp', 'generic'],
			enumDescriptions: [
				'Ollama (http://127.0.0.1:11434). Supports model management and unloading.',
				'llama.cpp llama-server (http://127.0.0.1:8080). Supports dynamic model switching via --models-dir.',
				'Any OpenAI-compatible backend (LM Studio, Jan, vLLM, OpenRouter, etc.).',
			],
			description: 'The type of local LLM backend to connect to. All backends must expose the OpenAI-compatible /v1/chat/completions and /v1/models endpoints.',
		},
		'localLLM.baseUrl': {
			type: 'string',
			default: 'http://127.0.0.1:11434',
			description: 'Base URL for the local LLM backend. Default is Ollama (11434). For llama-server use http://127.0.0.1:8080. For LM Studio use http://127.0.0.1:1234.',
		},
		'localLLM.model': {
			type: 'string',
			default: 'llama3.1',
			description: 'The model to use for chat. For Ollama run "ollama list". For llama-server this is the filename (without .gguf) in your --models-dir.',
		},
		'localLLM.maxContextWindow': {
			type: 'number',
			default: 131072,
			minimum: 2048,
			maximum: 262144,
			description: 'Maximum number of tokens to send in a single request. Higher values allow more context but consume more VRAM.',
		},
		'localLLM.smartContext.enabled': {
			type: 'boolean',
			default: true,
			description: 'Enable smart chunked context: instead of dumping all source files into the prompt, build per-file summaries and select only the most relevant files for each request.',
		},
		'localLLM.smartContext.maxRelevantFiles': {
			type: 'number',
			default: 15,
			minimum: 1,
			maximum: 50,
			description: 'Maximum number of relevant file summaries to include in the AI context.',
		},
		'localLLM.smartContext.workspaceBudgetPercent': {
			type: 'number',
			default: 30,
			minimum: 10,
			maximum: 60,
			description: 'Percentage of the context window reserved for workspace context (file summaries, project overview, active editor). The remaining budget is split between conversation history and response.',
		},
		'localLLM.smartContext.reindexStrategy': {
			type: 'string',
			default: 'fileWatcher',
			enum: ['fileWatcher', 'interval'],
			enumDescriptions: [
				'Re-index files automatically when they change on disk (efficient, recommended).',
				'Re-scan the entire workspace at a fixed time interval.',
			],
			description: 'How to trigger workspace re-indexing for smart context.',
		},
		'localLLM.smartContext.reindexIntervalSeconds': {
			type: 'number',
			default: 120,
			minimum: 30,
			maximum: 3600,
			description: 'Re-scan interval in seconds (only used when reindexStrategy is "interval").',
		},
		'localLLM.conversationCompaction.enabled': {
			type: 'boolean',
			default: true,
			description: 'Enable automatic conversation history compaction. When the conversation grows large, older turns are summarized into a compact recap to save context space.',
		},
		'localLLM.conversationCompaction.recentTurns': {
			type: 'number',
			default: 6,
			minimum: 2,
			maximum: 20,
			description: 'Number of recent conversation turns to keep verbatim (uncompacted). Older turns are summarized.',
		},
		'localLLM.persistentMemory.enabled': {
			type: 'boolean',
			default: true,
			description: 'Enable persistent agent memory. The AI stores task lists, implementation plans, summaries, and activity logs in .darkmatter/ so it remembers across sessions and machines.',
		},
	},
});

/**
 * Registers Ollama models as language models in VS Code's model picker.
 */
class LocalLLMChatProvider implements ILanguageModelChatProvider {

	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(
		private readonly llmProvider: LocalLLMProvider,
		private readonly logService: ILogService,
	) { }

	async provideLanguageModelChatInfo(_options: ILanguageModelChatInfoOptions, _token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		try {
			const models = await this.llmProvider.listModels();
			this.logService.info(`[Dark Matter] Discovered ${models.length} models for picker`);

			return models.map((model: LLMModelInfo) => {
				const modelName = model.name;
				const identifier = `${LOCAL_LLM_VENDOR}:${modelName}`;
				const metadata: ILanguageModelChatMetadata = {
					extension: LOCAL_LLM_EXTENSION_ID,
					name: modelName,
					id: identifier,
					vendor: LOCAL_LLM_VENDOR,
					version: '1.0',
					family: modelName.split(':')[0],
					maxInputTokens: 128000,
					maxOutputTokens: 8192,
					isUserSelectable: true,
					isDefaultForLocation: {
						[ChatAgentLocation.Chat]: modelName === this.llmProvider.model,
						[ChatAgentLocation.Terminal]: modelName === this.llmProvider.model,
						[ChatAgentLocation.Notebook]: modelName === this.llmProvider.model,
						[ChatAgentLocation.EditorInline]: modelName === this.llmProvider.model,
					},
					modelPickerCategory: { label: this.llmProvider.backendType === 'llamacpp' ? 'llama.cpp' : this.llmProvider.backendType === 'generic' ? 'Local LLM' : 'Ollama', order: 0 },
					capabilities: {
						vision: false,
						toolCalling: true,
						agentMode: true,
					},
				};
				return { metadata, identifier };
			});
		} catch (err) {
			this.logService.warn(`[Dark Matter] Failed to list models: ${err}`);
			return [];
		}
	}

	async sendChatRequest(
		_modelId: string,
		messages: IChatMessage[],
		_from: ExtensionIdentifier | undefined,
		_options: ILanguageModelChatRequestOptions,
		token: CancellationToken,
	): Promise<ILanguageModelChatResponse> {
		const llmMessages = messages.map(msg => ({
			role: msg.role === 0 ? 'system' as const :
				msg.role === 1 ? 'user' as const : 'assistant' as const,
			content: msg.content.map(part => (typeof (part as { value?: unknown }).value !== 'undefined' ? (part as { value: string }).value : '')).join(''),
		}));

		const stream = this.llmProvider.sendChatRequest(llmMessages, token);

		const responseStream = (async function* () {
			for await (const chunk of stream) {
				yield { type: 'text' as const, value: chunk };
			}
		})();

		return {
			stream: responseStream as AsyncIterable<IChatResponsePart>,
			result: Promise.resolve({}),
		};
	}

	async provideTokenCount(_modelId: string, message: string | IChatMessage, _token: CancellationToken): Promise<number> {
		if (typeof message === 'string') {
			return Math.ceil(message.length / 4);
		}
		const text = message.content.map(p => (typeof (p as { value?: unknown }).value !== 'undefined' ? (p as { value: string }).value : '')).join('');
		return Math.ceil(text.length / 4);
	}

	refresh(): void {
		this._onDidChange.fire();
	}

	dispose(): void {
		this._onDidChange.dispose();
	}
}

/**
 * Workbench contribution that bootstraps the Local LLM integration.
 */
export class LocalLLMContribution extends Disposable {

	static readonly ID = 'workbench.contrib.localLLMAgent';

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@ILogService private readonly logService: ILogService,
		@ILanguageModelToolsService private readonly toolsService: ILanguageModelToolsService,
	) {
		super();
		this.initialize();
	}

	private initialize(): void {
		const backendType = this.configurationService.getValue<string>('localLLM.backendType') || 'ollama';
		const baseUrl = this.configurationService.getValue<string>('localLLM.baseUrl') || 'http://127.0.0.1:11434';
		const model = this.configurationService.getValue<string>('localLLM.model') || 'llama3.1';
		this.logService.info(`[Dark Matter] Initializing local LLM agent: server=${baseUrl}, model=${model}, backend=${backendType}`);

		// Create the unified OpenAI-compatible provider
		const llmProvider = this._register(this.instantiationService.createInstance(LocalLLMProvider));

		// Create smart context services
		const chunkIndex = this._register(this.instantiationService.createInstance(WorkspaceChunkIndex, llmProvider));
		const agentMemory = this._register(this.instantiationService.createInstance(AgentMemory));
		const conversationCompactor = this._register(this.instantiationService.createInstance(ConversationCompactor, llmProvider));

		// Create and register the chat agent (with smart context services)
		this._register(this.instantiationService.createInstance(LocalLLMChatAgent, llmProvider, chunkIndex, agentMemory, conversationCompactor));

		// Create the status bar entry for quick AI settings access
		this._register(this.instantiationService.createInstance(LocalLLMStatusBarEntry, llmProvider));

		// Register local LLM agent tools for the tool invocation pipeline
		const createFileTool = this.instantiationService.createInstance(LocalLLMCreateFileTool);
		this._register(this.toolsService.registerTool(LocalLLMCreateFileToolData, createFileTool));

		const deleteFileTool = this.instantiationService.createInstance(LocalLLMDeleteFileTool);
		this._register(this.toolsService.registerTool(LocalLLMDeleteFileToolData, deleteFileTool));

		const runCommandTool = this.instantiationService.createInstance(LocalLLMRunCommandTool);
		this._register(this.toolsService.registerTool(LocalLLMRunCommandToolData, runCommandTool));

		// Create the LM provider for the model picker
		const lmProvider = new LocalLLMChatProvider(llmProvider, this.logService);
		this._register(lmProvider);

		// === CRITICAL ORDER ===
		// Step 1: Register vendor FIRST (adds to _vendors map)
		this.languageModelsService.deltaLanguageModelChatProviderDescriptors(
			[{
				vendor: LOCAL_LLM_VENDOR,
				displayName: 'Local LLM',
				configuration: undefined,
				managementCommand: undefined,
				when: undefined
			}],
			[]
		);
		this.logService.info('[Dark Matter] Local LLM vendor registered');

		// Step 2: Register the provider SECOND (adds to _providers map)
		this._register(this.languageModelsService.registerLanguageModelProvider(LOCAL_LLM_VENDOR, lmProvider));
		this.logService.info('[Dark Matter] Local LLM language model provider registered');

		// Step 3: Now trigger model resolution (both vendor + provider are in place)
		llmProvider.checkConnection().then(async connected => {
			if (connected) {
				this.logService.info(`[Dark Matter] Connected to Ollama at ${baseUrl}`);
				// Fire onDidChange to trigger _resolveAllLanguageModels
				lmProvider.refresh();
			} else {
				this.logService.warn(`[Dark Matter] Could not connect to Ollama at ${baseUrl}. Start Ollama or update the server URL in Settings.`);
			}
		});

		// Refresh models when settings change
		this._register(llmProvider.onDidChange(() => {
			lmProvider.refresh();
		}));
	}
}
