/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Dark Matter IDE Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILogger, ILoggerService } from '../../../../../platform/log/common/log.js';
import { LLMChatMessage, LocalLLMProvider } from './localLLMProvider.js';
import { IChatAgentHistoryEntry } from '../../common/participants/chatAgents.js';

export interface CompactedHistory {
	/** Compacted recap of older conversation turns */
	recap: string | undefined;
	/** Number of turns that were compacted into the recap */
	compactedTurnCount: number;
	/** Recent turns kept verbatim as message pairs */
	recentMessages: LLMChatMessage[];
}

export class ConversationCompactor extends Disposable {

	private readonly _logService: ILogger;

	/** Cached recap from previous compaction, keyed by turn count */
	private _cachedRecap: string | undefined;
	private _cachedRecapTurnCount: number = 0;

	constructor(
		private readonly llmProvider: LocalLLMProvider,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILoggerService private readonly loggerService: ILoggerService,
	) {
		super();
		this._logService = this._register(this.loggerService.createLogger('localLLM-compactor', { name: 'Dark Matter Compactor' }));
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
		const enabled = this.configurationService.getValue<boolean>('localLLM.conversationCompaction.enabled');
		if (enabled === false) {
			return {
				recap: undefined,
				compactedTurnCount: 0,
				recentMessages: this.historyToMessages(history),
			};
		}

		const recentTurnCount = this.configurationService.getValue<number>('localLLM.conversationCompaction.recentTurns') || 6;

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
	 * Convert history entries to LLMChatMessage pairs.
	 */
	private historyToMessages(history: IChatAgentHistoryEntry[]): LLMChatMessage[] {
		const messages: LLMChatMessage[] = [];
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

		const prompt: LLMChatMessage[] = [
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

		const prompt: LLMChatMessage[] = [
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
	 * Call the local LLM model and collect the full response.
	 */
	private async callModel(prompt: LLMChatMessage[], token: CancellationToken, selectedModel?: string): Promise<string | undefined> {
		let result = '';
		try {
			for await (const chunk of this.llmProvider.sendChatRequest(prompt, token, selectedModel)) {
				if (typeof chunk === 'string') {
					result += chunk;
				}
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
	public estimateTokens(messages: LLMChatMessage[]): number {
		let totalChars = 0;
		for (const msg of messages) {
			if (msg.content) {
				totalChars += msg.content.length;
			}
		}
		return Math.ceil(totalChars / 4);
	}

	/**
	 * Mid-loop compactor that squashes old tool calls/assistant turns during a long autonomous loop.
	 */
	public async compactMidLoop(messages: LLMChatMessage[], maxHistoryTokens: number, token: CancellationToken, fastModel?: string): Promise<LLMChatMessage[]> {
		const totalTokens = this.estimateTokens(messages);
		if (totalTokens <= maxHistoryTokens) {
			return messages;
		}

		this._logService.info(`[Compactor] Mid-loop budget exceeded: ~${totalTokens} tokens > budget: ${maxHistoryTokens}. Compacting...`);

		// We want to keep the first 2 messages (system prompt, original user message + context)
		// We want to keep the last 4 messages (the most recent tool calls/results)
		if (messages.length <= 6) {
			return messages; // Too few messages to compact effectively
		}

		const keepStart = 2; // Keep index 0 and 1
		const keepEndCount = 4; // Keep last 4 messages
		const splitEnd = messages.length - keepEndCount;

		if (splitEnd <= keepStart) {
			return messages;
		}

		const oldMessages = messages.slice(keepStart, splitEnd);
		
		// Create a text summary of the old tool calls
		let turnTexts = '';
		for (const msg of oldMessages) {
			if (msg.role === 'assistant') {
				const hasTools = msg.tool_calls && msg.tool_calls.length > 0;
				if (msg.content) {
					turnTexts += `\nAssistant: ${this.truncate(msg.content, 400)}`;
				}
				if (hasTools) {
					turnTexts += `\nAssistant called tools: ${msg.tool_calls!.map(t => t.function.name).join(', ')}`;
				}
			} else if (msg.role === 'tool') {
				turnTexts += `\nTool result (${msg.name}): ${this.truncate(msg.content || '', 800)}`;
			}
		}

		const prompt: LLMChatMessage[] = [
			{
				role: 'system',
				content: 'You are summarizing the output of command-line and filesystem tools used by an AI agent. ' +
					'Create a concise bullet-point recap of what tools were run and their most important findings or results. ' +
					'Be highly technical and preserve critical data like file paths, exact error messages, or found patterns.',
			},
			{
				role: 'user',
				content: `Summarize the following tool execution history:\n${turnTexts}`,
			}
		];

		const recap = await this.callModel(prompt, token, fastModel);
		if (!recap) {
			return messages; // Fallback if summarization fails
		}

		this._logService.info(`[Compactor] Successfully compacted mid-loop history`);

		const newMessages: LLMChatMessage[] = [
			...messages.slice(0, keepStart),
			{ role: 'user', content: `[Mid-Loop Compaction Recap - Older tool executions summarized below]\n${recap}` },
			...messages.slice(splitEnd)
		];

		return newMessages;
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
