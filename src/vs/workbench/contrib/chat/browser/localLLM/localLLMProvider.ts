/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Dark Matter IDE Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILogger, ILoggerService } from '../../../../../platform/log/common/log.js';
import { localize } from '../../../../../nls.js';

// --- Shared message type (OpenAI-compatible) ---------------------------------

export interface LLMChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}


// --- Model info returned by /v1/models ---------------------------------------

export interface LLMModelInfo {
	/** Model identifier as returned by the backend (e.g. "llama3.1", "mistral:7b") */
	name: string;
	/** Human-readable name if available */
	displayName?: string;
}


// --- Backend type -------------------------------------------------------------

export type LLMBackendType = 'ollama' | 'llamacpp' | 'generic';

// --- Provider ----------------------------------------------------------------

/**
 * Unified OpenAI-compatible local LLM provider.
 *
 * Works with any backend that implements the OpenAI REST API:
 *   - Ollama  (>= 0.1.24)      — default, http://127.0.0.1:11434
 *   - llama-server (llama.cpp) — http://127.0.0.1:8080
 *   - LM Studio                — http://127.0.0.1:1234
 *   - Jan, vLLM, OpenRouter, etc.
 *
 * All backends are accessed via:
 *   GET  /v1/models                — list available models
 *   POST /v1/chat/completions      — streaming chat (SSE)
 */
export class LocalLLMProvider extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _logService: ILogger;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILoggerService private readonly loggerService: ILoggerService,
	) {
		super();
		this._logService = this._register(this.loggerService.createLogger('local-llm', { name: 'Dark Matter LLM' }));

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (
				e.affectsConfiguration('localLLM.baseUrl') ||
				e.affectsConfiguration('localLLM.model') ||
				e.affectsConfiguration('localLLM.backendType')
			) {
				this._onDidChange.fire();
			}
		}));
	}

	// -- Config accessors ------------------------------------------------------

	get baseUrl(): string {
		return this.configurationService.getValue<string>('localLLM.baseUrl') || 'http://127.0.0.1:11434';
	}

	get model(): string {
		return this.configurationService.getValue<string>('localLLM.model') || 'llama3.1';
	}

	get backendType(): LLMBackendType {
		return this.configurationService.getValue<LLMBackendType>('localLLM.backendType') || 'ollama';
	}

	// -- Model discovery -------------------------------------------------------

	/**
	 * List available models via GET /v1/models.
	 * Falls back to the Ollama-native GET /api/tags endpoint when the backend
	 * is configured as 'ollama' and /v1/models returns an empty list (older Ollama builds).
	 */
	async listModels(): Promise<LLMModelInfo[]> {
		// Primary: OpenAI-compatible /v1/models
		try {
			const response = await fetch(`${this.baseUrl}/v1/models`);
			if (response.ok) {
				const data = await response.json();
				const models: LLMModelInfo[] = (data.data ?? []).map((m: { id: string; owned_by?: string }) => ({
					name: m.id,
					displayName: m.id,
				}));
				if (models.length > 0) {
					return models;
				}
			}
		} catch (err) {
			this._logService.warn(`[LocalLLM] /v1/models failed: ${err}`);
		}

		// Fallback for Ollama < 0.1.24 that doesn't expose /v1/models
		if (this.backendType === 'ollama') {
			return this._listOllamaModels();
		}

		return [];
	}

	private async _listOllamaModels(): Promise<LLMModelInfo[]> {
		try {
			const response = await fetch(`${this.baseUrl}/api/tags`);
			if (!response.ok) { return []; }
			const data = await response.json();
			return (data.models ?? []).map((m: { name: string }) => ({ name: m.name }));
		} catch (err) {
			this._logService.warn(`[LocalLLM] /api/tags fallback failed: ${err}`);
			return [];
		}
	}

	// -- Health check ----------------------------------------------------------

	async checkConnection(): Promise<boolean> {
		try {
			const response = await fetch(`${this.baseUrl}/v1/models`);
			if (response.ok) { return true; }
		} catch { /* fall through */ }

		// Ollama fallback
		if (this.backendType === 'ollama') {
			try {
				const r = await fetch(`${this.baseUrl}/api/tags`);
				return r.ok;
			} catch { /* fall through */ }
		}
		return false;
	}

	// -- Model management (Ollama-specific) ------------------------------------

	/**
	 * Unload a model from GPU memory. Only supported on Ollama backends.
	 * On llama.cpp and generic backends this is a no-op.
	 */
	async unloadModel(modelName: string): Promise<void> {
		if (this.backendType !== 'ollama') {
			return; // llama-server manages model lifecycle automatically
		}
		try {
			const response = await fetch(`${this.baseUrl}/api/chat`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ model: modelName, keep_alive: 0 }),
			});
			if (response.ok) {
				this._logService.info(`[LocalLLM] Unloaded ${modelName} from GPU memory`);
			} else {
				this._logService.warn(`[LocalLLM] Failed to unload ${modelName}: ${response.statusText}`);
			}
		} catch (err) {
			this._logService.warn(`[LocalLLM] unloadModel error: ${err}`);
		}
	}

	// -- Chat completions ------------------------------------------------------

	/**
	 * Send a streaming chat request via POST /v1/chat/completions.
	 * Yields text chunks as they arrive over SSE.
	 *
	 * Compatible with: Ollama, llama.cpp (llama-server), LM Studio, Jan, vLLM, OpenRouter.
	 */
	async *sendChatRequest(
		messages: LLMChatMessage[],
		token: CancellationToken,
		modelOverride?: string,
	): AsyncIterable<string> {
		let activeModel = modelOverride || this.model;
		// Strip legacy vendor prefix if still used anywhere (e.g. "ollama:llama3.1")
		if (activeModel.includes(':') && activeModel.indexOf(':') < 10) {
			activeModel = activeModel.split(':').slice(1).join(':');
		}

		const url = `${this.baseUrl}/v1/chat/completions`;
		const maxTokens = this.configurationService.getValue<number>('localLLM.maxContextWindow') || 131072;

		const body = {
			model: activeModel,
			messages,
			stream: true,
			max_tokens: maxTokens,
			temperature: 0.7,
			frequency_penalty: 0.1,   // mirrors old repeat_penalty: 1.2 behaviour
		};

		this._logService.info(localize(
			'localLLM.sendingRequest',
			'[LocalLLM] POST {0} model={1} max_tokens={2}',
			url, activeModel, maxTokens,
		));

		const abortController = new AbortController();
		token.onCancellationRequested(() => abortController.abort());

		let response: Response;
		try {
			response = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				signal: abortController.signal,
			});
		} catch (err) {
			if ((err as Error).name === 'AbortError') { throw err; }
			throw new Error(
				`Failed to connect to the LLM backend at ${this.baseUrl}. ` +
				`Make sure your backend is running. Error: ${err}`
			);
		}

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`LLM request failed (${response.status}): ${errorText}`);
		}

		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error('No response body from LLM backend');
		}

		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (true) {
				if (token.isCancellationRequested) { break; }

				const { done, value } = await reader.read();
				if (done || token.isCancellationRequested) {
					if (token.isCancellationRequested) { await reader.cancel(); }
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';

				for (const rawLine of lines) {
					const line = rawLine.trim();
					if (!line || line === 'data: [DONE]') { continue; }

					// OpenAI SSE format: "data: {...}"
					const jsonStr = line.startsWith('data: ') ? line.slice(6) : line;

					try {
						const chunk = JSON.parse(jsonStr);
						// Standard OpenAI chunk: choices[0].delta.content
						const content: string | undefined = chunk.choices?.[0]?.delta?.content;
						if (content) { yield content; }

						// Some backends (e.g. older llama.cpp) use top-level "content" field
						if (!content && typeof chunk.content === 'string' && chunk.content) {
							yield chunk.content;
						}

						// Signal end of stream
						if (chunk.choices?.[0]?.finish_reason === 'stop' || chunk.done === true) {
							return;
						}
					} catch {
						this._logService.warn(`[LocalLLM] Failed to parse SSE chunk: ${jsonStr}`);
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}
}

