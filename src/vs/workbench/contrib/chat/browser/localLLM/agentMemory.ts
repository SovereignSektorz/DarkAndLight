/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Dark Matter IDE Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILogger, ILoggerService } from '../../../../../platform/log/common/log.js';

const TASK_FILE = 'task.md';
const PLAN_FILE = 'plan.md';
const SUMMARY_FILE = 'summary.md';
const ACTIVITY_FILE = 'activity.log';

const TASK_TEMPLATE = `# Task List

_This file is managed by Dark Matter AI. It tracks the current task checklist._

## Current Tasks

- [ ] No tasks yet. Start a conversation and the AI will update this file.
`;

const PLAN_TEMPLATE = `# Implementation Plan

_This file is managed by Dark Matter AI. It stores the current implementation plan._

No plan defined yet. Ask the AI to create one.
`;

const SUMMARY_TEMPLATE = `# Session Summary

_This file is managed by Dark Matter AI. It records what has been accomplished._

No activity yet.
`;

export interface AgentMemoryState {
	task: string;
	plan: string;
	summary: string;
	recentActivity: string;
}

export class AgentMemory extends Disposable {

	private readonly _logService: ILogger;
	private _loaded = false;

	private _task: string = '';
	private _plan: string = '';
	private _summary: string = '';
	private _activityLines: string[] = [];

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILoggerService private readonly loggerService: ILoggerService,
	) {
		super();
		this._logService = this._register(this.loggerService.createLogger('localLLM-memory', { name: 'Dark Matter Memory' }));
	}

	// ========================================================================
	// Public API
	// ========================================================================

	/**
	 * Load all persistent memory files from .darkmatter/.
	 * Creates template files if they don't exist yet.
	 */
	public async load(): Promise<void> {
		const enabled = this.configurationService.getValue<boolean>('localLLM.persistentMemory.enabled');
		if (enabled === false) {
			this._loaded = true;
			return;
		}

		const folder = this.getDarkmatterFolder();
		if (!folder) {
			this._loaded = true;
			return;
		}

		try {
			await this.fileService.createFolder(folder);
		} catch {
			// folder may already exist
		}

		this._task = await this.readOrCreate(folder, TASK_FILE, TASK_TEMPLATE);
		this._plan = await this.readOrCreate(folder, PLAN_FILE, PLAN_TEMPLATE);
		this._summary = await this.readOrCreate(folder, SUMMARY_FILE, SUMMARY_TEMPLATE);

		// Load recent activity (last 50 lines)
		const activityContent = await this.readOrCreate(folder, ACTIVITY_FILE, '');
		this._activityLines = activityContent.split('\n').filter(l => l.trim().length > 0);
		if (this._activityLines.length > 50) {
			this._activityLines = this._activityLines.slice(-50);
		}

		this._loaded = true;
		this._logService.info('[AgentMemory] Persistent memory loaded');
	}

	/**
	 * Get the current memory state for injection into the system prompt.
	 */
	public getState(): AgentMemoryState {
		return {
			task: this._task,
			plan: this._plan,
			summary: this._summary,
			recentActivity: this._activityLines.slice(-20).join('\n'),
		};
	}

	/**
	 * Build the system prompt section for persistent memory.
	 */
	public buildPromptSection(): string {
		const enabled = this.configurationService.getValue<boolean>('localLLM.persistentMemory.enabled');
		if (enabled === false || !this._loaded) {
			return '';
		}

		const state = this.getState();
		const parts: string[] = [];

		parts.push('=== AUTONOMOUS ACTION FRAMEWORK ===');
		parts.push('You are an autonomous AI programming agent. You MUST proactively use your provided tools to solve the user\'s problems.');
		parts.push('Do NOT ask the user to run commands for you. Do NOT show commands in code blocks for the user to copy.');
		parts.push('If a command needs to be run, or a file needs to be created/edited/read, you MUST use the tools provided to you.');
		parts.push('');
		parts.push('CRITICAL RULES:');
		parts.push('- You have access to native tools for interacting with the workspace and terminal.');
		parts.push('- Use the `run_command` tool to execute terminal commands (e.g. ping, java -version, git status, npm test).');
		parts.push('- The IDE will prompt the user for permission before executing commands, so do not hesitate to use them.');
		parts.push('- When using tools, you may perform iterative cycles: use tool -> read result -> use another tool.');
		parts.push('');
		parts.push('=== TERMINAL OUTPUT AWARENESS ===');
		parts.push('After you run a terminal command, the IDE will capture its output and send it back to you.');
		parts.push('You can then analyze the output and take further actions if needed (e.g. fix errors, run more commands).');
		parts.push('Always tell the user in plain language what you are doing and what the results mean.');
		parts.push('');
		parts.push('=== PERSISTENT AGENT MEMORY ===');
		parts.push('You have persistent memory stored in .darkmatter/ in the workspace.');
		parts.push('To update these files, you MUST output a markdown code block with the language `task`, `plan`, or `summary`.');
		parts.push('Example:');
		parts.push('```task');
		parts.push('- [x] Did something');
		parts.push('- [ ] Next thing to do');
		parts.push('```');
		parts.push('');

		if (state.task && state.task !== TASK_TEMPLATE) {
			parts.push('--- Current Task List (.darkmatter/task.md) ---');
			parts.push(state.task);
			parts.push('');
		}

		if (state.plan && state.plan !== PLAN_TEMPLATE) {
			parts.push('--- Current Implementation Plan (.darkmatter/plan.md) ---');
			parts.push(state.plan);
			parts.push('');
		}

		if (state.summary && state.summary !== SUMMARY_TEMPLATE) {
			parts.push('--- Session Summary (.darkmatter/summary.md) ---');
			parts.push(AgentMemory.sanitizeForPrompt(state.summary));
			parts.push('');
		}

		if (state.recentActivity) {
			parts.push('--- Recent Activity (.darkmatter/activity.log) ---');
			parts.push(AgentMemory.sanitizeForPrompt(state.recentActivity));
			parts.push('');
		}

		return parts.join('\n');
	}

	/**
	 * Strip any <file_action> or <thought> XML that may have leaked into
	 * memory content before it is injected into the model's system prompt.
	 * Prevents the model from re-executing or skipping already-done actions.
	 */
	private static sanitizeForPrompt(text: string): string {
		return text
			.replace(/<file_action\b[^>]*>[\s\S]*?<\/file_action>/gi, '[file action executed]')
			.replace(/<file_action\b[^>]*\/>/gi, '[file action executed]')
			.replace(/<\/?file_action[^>]*>/gi, '')
			.replace(/<thought>[\s\S]*?<\/thought>/gi, '')
			.replace(/<\/?thought>/gi, '');
	}

	/**
	 * Log an activity entry with timestamp.
	 */
	public async logActivity(message: string): Promise<void> {
		const enabled = this.configurationService.getValue<boolean>('localLLM.persistentMemory.enabled');
		if (enabled === false) { return; }

		// If activity.log was deleted on disk while the IDE is running, reset the
		// in-memory cache so stale history is not written back.
		const folder = this.getDarkmatterFolder();
		if (folder) {
			try {
				await this.fileService.stat(URI.joinPath(folder, ACTIVITY_FILE));
			} catch {
				this._activityLines = [];
			}
		}

		const timestamp = new Date().toISOString();
		const line = `[${timestamp}] ${message}`;
		this._activityLines.push(line);

		// Keep only last 200 lines
		if (this._activityLines.length > 200) {
			this._activityLines = this._activityLines.slice(-200);
		}

		if (folder) {
			try {
				const uri = URI.joinPath(folder, ACTIVITY_FILE);
				await this.fileService.writeFile(uri, VSBuffer.fromString(this._activityLines.join('\n') + '\n'));
			} catch (err) {
				this._logService.warn(`[AgentMemory] Failed to write activity log: ${err}`);
			}
		}
	}

	/**
	 * Update a specific memory file.
	 */
	public async updateFile(file: 'task' | 'plan' | 'summary', content: string): Promise<void> {
		const enabled = this.configurationService.getValue<boolean>('localLLM.persistentMemory.enabled');
		if (enabled === false) { return; }

		switch (file) {
			case 'task': this._task = content; break;
			case 'plan': this._plan = content; break;
			case 'summary': this._summary = content; break;
		}

		const fileName = file === 'task' ? TASK_FILE : file === 'plan' ? PLAN_FILE : SUMMARY_FILE;
		const folder = this.getDarkmatterFolder();
		if (folder) {
			try {
				const uri = URI.joinPath(folder, fileName);
				await this.fileService.writeFile(uri, VSBuffer.fromString(content));
				this._logService.info(`[AgentMemory] Updated ${fileName}`);
			} catch (err) {
				this._logService.warn(`[AgentMemory] Failed to write ${fileName}: ${err}`);
			}
		}
	}

	/**
	 * Automatically append a timestamped conversation entry to summary.md.
	 * This runs after every turn so the file is always up to date,
	 * regardless of whether the model outputs a ```summary``` block.
	 *
	 * When the summary exceeds 10,000 characters, the oldest half of the
	 * conversation entries are condensed by the AI using the provided
	 * `summarizer` callback. If no summarizer is provided or if the AI
	 * call fails, falls back to simple truncation.
	 */
	public async appendSummaryEntry(
		userMessage: string,
		agentResponse: string,
		summarizer?: (text: string) => Promise<string>
	): Promise<void> {
		const enabled = this.configurationService.getValue<boolean>('localLLM.persistentMemory.enabled');
		if (enabled === false) { return; }

		const folder = this.getDarkmatterFolder();
		if (!folder) { return; }

		// If the file was deleted on disk while the IDE is running, reset the
		// in-memory cache so stale content is not written back.
		const summaryUri = URI.joinPath(folder, SUMMARY_FILE);
		try {
			await this.fileService.stat(summaryUri);
		} catch {
			// File doesn't exist — clear the cached state
			this._summary = '';
		}

		const timestamp = new Date().toLocaleString();
		const entry = `\n---\n**[${timestamp}]**\n\n**User:** ${userMessage}\n\n**Agent:** ${agentResponse}\n`;

		// If current summary is the placeholder template, replace it
		if (!this._summary || this._summary === SUMMARY_TEMPLATE) {
			this._summary = `# Session Summary\n\n_Automatically updated by Dark Matter AI after each conversation turn._\n${entry}`;
		} else {
			this._summary += entry;
		}

		// When summary grows too large, condense the oldest half using AI
		if (this._summary.length > 10000) {
			this._summary = await this.compressSummary(this._summary, summarizer);
		}

		try {
			const uri = URI.joinPath(folder, SUMMARY_FILE);
			await this.fileService.writeFile(uri, VSBuffer.fromString(this._summary));
		} catch (err) {
			this._logService.warn(`[AgentMemory] Failed to append summary entry: ${err}`);
		}
	}

	/**
	 * Compress summary.md when it exceeds the size limit.
	 * Splits the content into two halves. The older half is condensed by the AI
	 * summarizer (if available) or dropped with a note (fallback).
	 */
	private async compressSummary(
		current: string,
		summarizer?: (text: string) => Promise<string>
	): Promise<string> {
		// Find the header (everything before the first '---' separator)
		const firstSep = current.indexOf('\n---\n', 50);
		if (firstSep === -1) {
			// No separators found, just truncate to last 9000 chars
			return current.substring(current.length - 9000);
		}

		const header = current.substring(0, firstSep);
		const entriesBlock = current.substring(firstSep);

		// Split all entries by '---' separator
		const entries = entriesBlock.split('\n---\n').filter(e => e.trim().length > 0);

		if (entries.length <= 2) {
			// Too few entries to meaningfully compress, keep all
			return current;
		}

		// Compress the older half, keep the newer half verbatim
		const halfIdx = Math.floor(entries.length / 2);
		const oldEntries = entries.slice(0, halfIdx).join('\n---\n');
		const newEntries = entries.slice(halfIdx).join('\n---\n');

		let condensed: string;
		if (summarizer) {
			try {
				this._logService.info('[AgentMemory] Compressing summary using AI...');
				const prompt = `The following are older conversation log entries from a coding session. Condense them into a single concise paragraph (3-5 sentences max) that captures the key tasks accomplished, decisions made, and current state. Do not include timestamps or formatting — plain prose only.\n\n${oldEntries}`;
				condensed = `\n**[Condensed history]:** ${(await summarizer(prompt)).trim()}\n`;
			} catch (err) {
				this._logService.warn(`[AgentMemory] AI compression failed, falling back to truncation: ${err}`);
				condensed = `\n**[Older entries condensed — ${halfIdx} turns]**\n`;
			}
		} else {
			condensed = `\n**[Older entries condensed — ${halfIdx} turns]**\n`;
		}

		return `${header}\n---\n${condensed}\n---\n${newEntries}`;
	}

	// ========================================================================
	// Internals
	// ========================================================================

	private getDarkmatterFolder(): URI | undefined {
		const workspace = this.workspaceService.getWorkspace();
		if (workspace.folders.length === 0) { return undefined; }
		return URI.joinPath(workspace.folders[0].uri, '.darkmatter');
	}

	private async readOrCreate(folder: URI, fileName: string, template: string): Promise<string> {
		const uri = URI.joinPath(folder, fileName);
		try {
			const content = await this.fileService.readFile(uri);
			return content.value.toString();
		} catch {
			// File doesn't exist, create with template
			if (template) {
				try {
					await this.fileService.writeFile(uri, VSBuffer.fromString(template));
				} catch (err) {
					this._logService.warn(`[AgentMemory] Failed to create ${fileName}: ${err}`);
				}
			}
			return template;
		}
	}

	get isLoaded(): boolean {
		return this._loaded;
	}
}
