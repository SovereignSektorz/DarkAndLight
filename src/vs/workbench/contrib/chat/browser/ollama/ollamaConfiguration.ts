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
import { OllamaLanguageModelProvider, OllamaModelInfo } from './ollamaLanguageModel.js';
import { OllamaChatAgent } from './ollamaChatAgent.js';
import { OllamaStatusBarEntry } from './ollamaStatusBar.js';
import { WorkspaceChunkIndex } from './workspaceChunkIndex.js';
import { AgentMemory } from './agentMemory.js';
import { ConversationCompactor } from './conversationCompactor.js';

const OLLAMA_EXTENSION_ID = new ExtensionIdentifier('vscode.chat');
const OLLAMA_VENDOR = 'ollama';

// Register settings
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'ollamaAgent',
	title: 'Ollama Agent',
	type: 'object',
	properties: {
		'ollamaAgent.baseUrl': {
			type: 'string',
			default: 'http://127.0.0.1:11434',
			description: 'The base URL for the local Ollama API server.',
		},
		'ollamaAgent.model': {
			type: 'string',
			default: 'llama3.1',
			description: 'The Ollama model to use for chat. Run "ollama list" to see available models.',
		},
		'ollamaAgent.maxContextWindow': {
			type: 'number',
			default: 131072,
			minimum: 2048,
			maximum: 262144,
			description: 'The maximum context window size (in tokens) to request from Ollama. Higher values allow the AI to remember more but consume significant GPU VRAM (e.g., 256k can require 16GB+ of VRAM).',
		},
		'ollamaAgent.smartContext.enabled': {
			type: 'boolean',
			default: true,
			description: 'Enable smart chunked context: instead of dumping all source files into the prompt, build per-file summaries and select only the most relevant files for each request.',
		},
		'ollamaAgent.smartContext.maxRelevantFiles': {
			type: 'number',
			default: 15,
			minimum: 1,
			maximum: 50,
			description: 'Maximum number of relevant file summaries to include in the AI context.',
		},
		'ollamaAgent.smartContext.workspaceBudgetPercent': {
			type: 'number',
			default: 30,
			minimum: 10,
			maximum: 60,
			description: 'Percentage of the context window reserved for workspace context (file summaries, project overview, active editor). The remaining budget is split between conversation history and response.',
		},
		'ollamaAgent.smartContext.reindexStrategy': {
			type: 'string',
			default: 'fileWatcher',
			enum: ['fileWatcher', 'interval'],
			enumDescriptions: [
				'Re-index files automatically when they change on disk (efficient, recommended).',
				'Re-scan the entire workspace at a fixed time interval.',
			],
			description: 'How to trigger workspace re-indexing for smart context.',
		},
		'ollamaAgent.smartContext.reindexIntervalSeconds': {
			type: 'number',
			default: 120,
			minimum: 30,
			maximum: 3600,
			description: 'Re-scan interval in seconds (only used when reindexStrategy is "interval").',
		},
		'ollamaAgent.conversationCompaction.enabled': {
			type: 'boolean',
			default: true,
			description: 'Enable automatic conversation history compaction. When the conversation grows large, older turns are summarized into a compact recap to save context space.',
		},
		'ollamaAgent.conversationCompaction.recentTurns': {
			type: 'number',
			default: 6,
			minimum: 2,
			maximum: 20,
			description: 'Number of recent conversation turns to keep verbatim (uncompacted). Older turns are summarized.',
		},
		'ollamaAgent.persistentMemory.enabled': {
			type: 'boolean',
			default: true,
			description: 'Enable persistent agent memory. The AI stores task lists, implementation plans, summaries, and activity logs in .darkmatter/ so it remembers across sessions and machines.',
		},
	},
});

/**
 * Registers Ollama models as language models in VS Code's model picker.
 */
class OllamaLanguageModelChatProvider implements ILanguageModelChatProvider {

	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(
		private readonly ollamaProvider: OllamaLanguageModelProvider,
		private readonly logService: ILogService,
	) { }

	async provideLanguageModelChatInfo(_options: ILanguageModelChatInfoOptions, _token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		try {
			const models = await this.ollamaProvider.listModels();
			this.logService.info(`[Dark Matter] Discovered ${models.length} Ollama models for picker`);

			return models.map((model: OllamaModelInfo) => {
				const modelName = model.name;
				const identifier = `${OLLAMA_VENDOR}:${modelName}`;
				const metadata: ILanguageModelChatMetadata = {
					extension: OLLAMA_EXTENSION_ID,
					name: modelName,
					id: identifier,
					vendor: OLLAMA_VENDOR,
					version: '1.0',
					family: modelName.split(':')[0],
					maxInputTokens: 128000,
					maxOutputTokens: 8192,
					isUserSelectable: true,
					isDefaultForLocation: {
						[ChatAgentLocation.Chat]: modelName === this.ollamaProvider.model,
						[ChatAgentLocation.Terminal]: modelName === this.ollamaProvider.model,
						[ChatAgentLocation.Notebook]: modelName === this.ollamaProvider.model,
						[ChatAgentLocation.EditorInline]: modelName === this.ollamaProvider.model,
					},
					modelPickerCategory: { label: 'Ollama', order: 0 },
					capabilities: {
						vision: false,
						toolCalling: true,
						agentMode: true,
					},
				};
				return { metadata, identifier };
			});
		} catch (err) {
			this.logService.warn(`[Dark Matter] Failed to list Ollama models: ${err}`);
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
		const ollamaMessages = messages.map(msg => ({
			role: msg.role === 0 ? 'system' as const :
				msg.role === 1 ? 'user' as const : 'assistant' as const,
			content: msg.content.map(part => 'value' in part ? part.value : '').join(''),
		}));

		const stream = this.ollamaProvider.sendChatRequest(ollamaMessages, token);

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
		const text = message.content.map(p => 'value' in p ? p.value : '').join('');
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
 * Workbench contribution that bootstraps the Ollama integration.
 */
export class OllamaContribution extends Disposable {

	static readonly ID = 'workbench.contrib.ollamaAgent';

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.initialize();
	}

	private initialize(): void {
		const baseUrl = this.configurationService.getValue<string>('ollamaAgent.baseUrl') || 'http://127.0.0.1:11434';
		const model = this.configurationService.getValue<string>('ollamaAgent.model') || 'llama3.1';

		this.logService.info(`[Dark Matter] Initializing Ollama agent: server=${baseUrl}, model=${model}`);

		// Create the language model provider
		const ollamaProvider = this._register(this.instantiationService.createInstance(OllamaLanguageModelProvider));

		// Create smart context services
		const chunkIndex = this._register(this.instantiationService.createInstance(WorkspaceChunkIndex, ollamaProvider));
		const agentMemory = this._register(this.instantiationService.createInstance(AgentMemory));
		const conversationCompactor = this._register(this.instantiationService.createInstance(ConversationCompactor, ollamaProvider));

		// Create and register the chat agent (with smart context services)
		this._register(this.instantiationService.createInstance(OllamaChatAgent, ollamaProvider, chunkIndex, agentMemory, conversationCompactor));

		// Create the status bar entry for quick AI settings access
		this._register(this.instantiationService.createInstance(OllamaStatusBarEntry, ollamaProvider));

		// Create the LM provider for the model picker
		const lmProvider = new OllamaLanguageModelChatProvider(ollamaProvider, this.logService);
		this._register(lmProvider);

		// === CRITICAL ORDER ===
		// Step 1: Register vendor FIRST (adds to _vendors map)
		this.languageModelsService.deltaLanguageModelChatProviderDescriptors(
			[{
				vendor: OLLAMA_VENDOR,
				displayName: 'Ollama',
				configuration: undefined,
				managementCommand: undefined,
				when: undefined
			}],
			[]
		);
		this.logService.info('[Dark Matter] Ollama vendor registered');

		// Step 2: Register the provider SECOND (adds to _providers map)
		this._register(this.languageModelsService.registerLanguageModelProvider(OLLAMA_VENDOR, lmProvider));
		this.logService.info('[Dark Matter] Ollama language model provider registered');

		// Step 3: Now trigger model resolution (both vendor + provider are in place)
		ollamaProvider.checkConnection().then(async connected => {
			if (connected) {
				this.logService.info(`[Dark Matter] Connected to Ollama at ${baseUrl}`);
				// Fire onDidChange to trigger _resolveAllLanguageModels
				lmProvider.refresh();
			} else {
				this.logService.warn(`[Dark Matter] Could not connect to Ollama at ${baseUrl}. Start Ollama or update the server URL in Settings.`);
			}
		});

		// Refresh models when settings change
		this._register(ollamaProvider.onDidChange(() => {
			lmProvider.refresh();
		}));
	}
}
