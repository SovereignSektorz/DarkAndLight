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
		this._logService = this._register(this.loggerService.createLogger('ollama-memory', { name: 'Dark Matter Memory' }));
	}

	// ========================================================================
	// Public API
	// ========================================================================

	/**
	 * Load all persistent memory files from .darkmatter/.
	 * Creates template files if they don't exist yet.
	 */
	public async load(): Promise<void> {
		const enabled = this.configurationService.getValue<boolean>('ollamaAgent.persistentMemory.enabled');
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
		const enabled = this.configurationService.getValue<boolean>('ollamaAgent.persistentMemory.enabled');
		if (enabled === false || !this._loaded) {
			return '';
		}

		const state = this.getState();
		const parts: string[] = [];

		parts.push('=== AUTONOMOUS ACTION FRAMEWORK ===');
		parts.push('You are an autonomous AI programming agent. You MUST proactively use your tools to solve the user\'s problems.');
		parts.push('Do NOT ask the user to run commands for you. Do NOT show commands in code blocks for the user to copy.');
		parts.push('If a command needs to be run, you MUST run it yourself using the XML tags described below.');
		parts.push('');
		parts.push('You have write access to the workspace and the terminal. Use these XML tags to perform actions:');
		parts.push('Create a file: <file_action type="create" path="relative/path">file content here</file_action>');
		parts.push('Overwrite a file: <file_action type="overwrite" path="relative/path">new content</file_action>');
		parts.push('Delete a file: <file_action type="delete" path="relative/path" />');
		parts.push('Run a terminal command: <file_action type="runCommand" command="your command here" />');
		parts.push('');
		parts.push('CRITICAL RULES:');
		parts.push('- You MUST output the <file_action> tags as raw XML in your response. They are NOT markdown. Do NOT wrap them in backticks or code blocks.');
		parts.push('- The IDE parser reads your raw output for these tags and executes them automatically.');
		parts.push('- You can run ANY terminal command (e.g. ping, java -version, git status, npm test, node, python, etc).');
		parts.push('- The IDE will prompt the user for permission before executing, so do not hesitate to use them.');
		parts.push('');
		parts.push('=== EXAMPLES ===');
		parts.push('User: "Check my Java version"');
		parts.push('You respond: Let me check your Java version.');
		parts.push('<file_action type="runCommand" command="java -version" />');
		parts.push('');
		parts.push('User: "Ping google.com"');
		parts.push('You respond: I\'ll ping google.com to check connectivity.');
		parts.push('<file_action type="runCommand" command="ping -n 4 google.com" />');
		parts.push('');
		parts.push('User: "Run the tests"');
		parts.push('You respond: Running the test suite now.');
		parts.push('<file_action type="runCommand" command="npm test" />');
		parts.push('');
		parts.push('=== TERMINAL OUTPUT AWARENESS ===');
		parts.push('After you run a terminal command, the IDE will capture its output and send it back to you.');
		parts.push('You can then analyze the output and take further actions if needed (e.g. fix errors, run more commands).');
		parts.push('You may perform up to 3 iterative cycles of: run command, read output, take action.');
		parts.push('Always tell the user in plain language what you are doing and what the results mean.');
		parts.push('');
		parts.push('=== OUTPUT FORMAT ===');
		parts.push('The <file_action> XML tags are automatically hidden from the user interface.');
		parts.push('Always include a plain-language explanation alongside your actions so the user knows what is happening.');
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
			parts.push(state.summary);
			parts.push('');
		}

		if (state.recentActivity) {
			parts.push('--- Recent Activity (.darkmatter/activity.log) ---');
			parts.push(state.recentActivity);
			parts.push('');
		}

		return parts.join('\n');
	}

	/**
	 * Log an activity entry with timestamp.
	 */
	public async logActivity(message: string): Promise<void> {
		const enabled = this.configurationService.getValue<boolean>('ollamaAgent.persistentMemory.enabled');
		if (enabled === false) { return; }

		const timestamp = new Date().toISOString();
		const line = `[${timestamp}] ${message}`;
		this._activityLines.push(line);

		// Keep only last 200 lines
		if (this._activityLines.length > 200) {
			this._activityLines = this._activityLines.slice(-200);
		}

		const folder = this.getDarkmatterFolder();
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
		const enabled = this.configurationService.getValue<boolean>('ollamaAgent.persistentMemory.enabled');
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
