/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Dark Matter IDE Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILogger, ILoggerService } from '../../../../../platform/log/common/log.js';
import { OllamaChatMessage, OllamaLanguageModelProvider } from './ollamaLanguageModel.js';
import { IChatAgentHistoryEntry } from '../../common/participants/chatAgents.js';

export interface CompactedHistory {
	/** Compacted recap of older conversation turns */
	recap: string | undefined;
	/** Number of turns that were compacted into the recap */
	compactedTurnCount: number;
	/** Recent turns kept verbatim as message pairs */
	recentMessages: OllamaChatMessage[];
}

export class ConversationCompactor extends Disposable {

	private readonly _logService: ILogger;

	/** Cached recap from previous compaction, keyed by turn count */
	private _cachedRecap: string | undefined;
	private _cachedRecapTurnCount: number = 0;

	constructor(
		private readonly ollamaProvider: OllamaLanguageModelProvider,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILoggerService private readonly loggerService: ILoggerService,
	) {
		super();
		this._logService = this._register(this.loggerService.createLogger('ollama-compactor', { name: 'Dark Matter Compactor' }));
	}

	/**
	 * Process conversation history and return either full history or compacted history
	 * depending on token budget.
	 *
	 * @param history Raw conversation history entries
	 * @param maxHistoryTokens Maximum tokens available for conversation history
	 * @param token Cancellation token
	 */
	public async compactHistory(
		history: IChatAgentHistoryEntry[],
		maxHistoryTokens: number,
		token: CancellationToken
	): Promise<CompactedHistory> {
		const enabled = this.configurationService.getValue<boolean>('ollamaAgent.conversationCompaction.enabled');
		if (enabled === false) {
			return {
				recap: undefined,
				compactedTurnCount: 0,
				recentMessages: this.historyToMessages(history),
			};
		}

		const recentTurnCount = this.configurationService.getValue<number>('ollamaAgent.conversationCompaction.recentTurns') || 6;

		// Estimate total token count of full history
		const allMessages = this.historyToMessages(history);
		const totalTokens = this.estimateTokens(allMessages);

		this._logService.info(`[Compactor] History: ${history.length} turns, ~${totalTokens} tokens, budget: ${maxHistoryTokens}`);

		// If within budget, return full history
		if (totalTokens <= maxHistoryTokens) {
			return {
				recap: undefined,
				compactedTurnCount: 0,
				recentMessages: allMessages,
			};
		}

		// Need to compact. Split into old turns (to compact) and recent turns (keep verbatim)
		const splitIndex = Math.max(0, history.length - recentTurnCount);
		const oldTurns = history.slice(0, splitIndex);
		const recentTurns = history.slice(splitIndex);

		this._logService.info(`[Compactor] Compacting ${oldTurns.length} old turns, keeping ${recentTurns.length} recent turns verbatim`);

		// Check if we can reuse cached recap (only if no new old turns were added)
		let recap: string | undefined;
		if (this._cachedRecap && this._cachedRecapTurnCount === oldTurns.length) {
			recap = this._cachedRecap;
			this._logService.info('[Compactor] Reusing cached recap');
		} else if (oldTurns.length > 0) {
			// Need to generate or extend recap
			if (this._cachedRecap && this._cachedRecapTurnCount < oldTurns.length) {
				// Incremental update: summarize only the new turns and append to existing recap
				const newTurns = oldTurns.slice(this._cachedRecapTurnCount);
				recap = await this.extendRecap(this._cachedRecap, newTurns, token);
			} else {
				// Full summarization of all old turns
				recap = await this.summarizeTurns(oldTurns, token);
			}

			if (recap) {
				this._cachedRecap = recap;
				this._cachedRecapTurnCount = oldTurns.length;
			}
		}

		const recentMessages = this.historyToMessages(recentTurns);

		return {
			recap,
			compactedTurnCount: oldTurns.length,
			recentMessages,
		};
	}

	/**
	 * Convert history entries to OllamaChatMessage pairs.
	 */
	private historyToMessages(history: IChatAgentHistoryEntry[]): OllamaChatMessage[] {
		const messages: OllamaChatMessage[] = [];
		for (const entry of history) {
			messages.push({ role: 'user', content: entry.request.message });
			if (entry.response) {
				const responseTexts: string[] = [];
				for (const part of entry.response) {
					if (part.kind === 'markdownContent') {
						responseTexts.push(part.content.value);
					}
				}
				if (responseTexts.length > 0) {
					messages.push({ role: 'assistant', content: responseTexts.join('\n') });
				}
			}
		}
		return messages;
	}

	/**
	 * Summarize a set of conversation turns into a compact recap.
	 */
	private async summarizeTurns(turns: IChatAgentHistoryEntry[], token: CancellationToken): Promise<string | undefined> {
		const turnTexts: string[] = [];
		for (let i = 0; i < turns.length; i++) {
			const entry = turns[i];
			let turnText = `Turn ${i + 1}:\n  User: ${this.truncate(entry.request.message, 500)}`;
			if (entry.response) {
				const responseTexts: string[] = [];
				for (const part of entry.response) {
					if (part.kind === 'markdownContent') {
						responseTexts.push(part.content.value);
					}
				}
				if (responseTexts.length > 0) {
					turnText += `\n  Assistant: ${this.truncate(responseTexts.join('\n'), 500)}`;
				}
			}
			turnTexts.push(turnText);
		}

		const prompt: OllamaChatMessage[] = [
			{
				role: 'system',
				content: 'You are summarizing a conversation between a user and an AI coding assistant. ' +
					'Create a concise bullet-point recap that captures: key topics discussed, decisions made, ' +
					'code changes requested/completed, problems identified, and any pending tasks. ' +
					'Be specific about file names, function names, and technical details. ' +
					'Format as a bullet list. Be concise but preserve important context.',
			},
			{
				role: 'user',
				content: `Summarize these ${turns.length} conversation turns:\n\n${turnTexts.join('\n\n')}`,
			}
		];

		return this.callModel(prompt, token);
	}

	/**
	 * Extend an existing recap with newly compacted turns.
	 */
	private async extendRecap(
		existingRecap: string,
		newTurns: IChatAgentHistoryEntry[],
		token: CancellationToken
	): Promise<string | undefined> {
		const turnTexts: string[] = [];
		for (const entry of newTurns) {
			let turnText = `User: ${this.truncate(entry.request.message, 400)}`;
			if (entry.response) {
				const responseTexts: string[] = [];
				for (const part of entry.response) {
					if (part.kind === 'markdownContent') {
						responseTexts.push(part.content.value);
					}
				}
				if (responseTexts.length > 0) {
					turnText += `\nAssistant: ${this.truncate(responseTexts.join('\n'), 400)}`;
				}
			}
			turnTexts.push(turnText);
		}

		const prompt: OllamaChatMessage[] = [
			{
				role: 'system',
				content: 'You are updating a conversation recap. Given an existing recap and new conversation turns, ' +
					'produce an updated bullet-point recap that incorporates the new information. ' +
					'Be concise but preserve important technical context.',
			},
			{
				role: 'user',
				content: `Existing recap:\n${existingRecap}\n\nNew turns to incorporate:\n${turnTexts.join('\n\n')}`,
			}
		];

		return this.callModel(prompt, token);
	}

	/**
	 * Call the Ollama model and collect the full response.
	 */
	private async callModel(prompt: OllamaChatMessage[], token: CancellationToken): Promise<string | undefined> {
		let result = '';
		try {
			for await (const chunk of this.ollamaProvider.sendChatRequest(prompt, token)) {
				result += chunk;
				if (token.isCancellationRequested) { return undefined; }
			}
			return result.trim();
		} catch (err) {
			this._logService.error(`[Compactor] Model call failed: ${err}`);
			return undefined;
		}
	}

	/**
	 * Rough token estimation (chars / 4).
	 */
	private estimateTokens(messages: OllamaChatMessage[]): number {
		let totalChars = 0;
		for (const msg of messages) {
			totalChars += msg.content.length;
		}
		return Math.ceil(totalChars / 4);
	}

	/**
	 * Truncate a string to maxLen characters.
	 */
	private truncate(text: string, maxLen: number): string {
		if (text.length <= maxLen) { return text; }
		return text.substring(0, maxLen) + '...';
	}

	/**
	 * Reset cached recap (e.g., when starting a new conversation).
	 */
	public resetCache(): void {
		this._cachedRecap = undefined;
		this._cachedRecapTurnCount = 0;
	}
}
