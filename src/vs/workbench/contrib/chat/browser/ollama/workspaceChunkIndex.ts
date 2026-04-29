/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Dark Matter IDE Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILogger, ILoggerService } from '../../../../../platform/log/common/log.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { OllamaChatMessage, OllamaLanguageModelProvider } from './ollamaLanguageModel.js';

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

/** Source code extensions we index */
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

const MAX_FILE_SIZE = 500 * 1024; // 500KB per file
const MAX_SCAN_DEPTH = 16;

export interface FileIndexEntry {
	path: string;
	relativePath: string;
	lastModified: number;
	size: number;
	summary: string;
	keyExports: string[];
	dependencies: string[];
}

export interface RelevanceContext {
	activeFilePath?: string;
	userMessage: string;
	openEditorPaths: string[];
}

export class WorkspaceChunkIndex extends Disposable {

	private readonly _logService: ILogger;
	private readonly _indexEntries = new Map<string, FileIndexEntry>();
	private _workspaceOverview: string = '';
	private _isIndexing = false;
	private _intervalHandle: ReturnType<typeof setInterval> | undefined;
	private readonly _fileWatcherDisposables = this._register(new DisposableStore());

	constructor(
		private readonly ollamaProvider: OllamaLanguageModelProvider,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILoggerService private readonly loggerService: ILoggerService,
		@IProgressService private readonly progressService: IProgressService,
	) {
		super();
		this._logService = this._register(this.loggerService.createLogger('ollama-index', { name: 'Dark Matter Index' }));

		// Load existing index from disk
		this.loadIndex().then(() => {
			// Initial indexing
			this.runFullIndex();
		}).catch(err => {
			this._logService.warn(`[ChunkIndex] Failed to load existing index: ${err}`);
			this.runFullIndex();
		});

		// Set up reindex strategy
		this.setupReindexStrategy();

		// React to strategy config changes
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('ollamaAgent.smartContext.reindexStrategy') ||
				e.affectsConfiguration('ollamaAgent.smartContext.reindexIntervalSeconds')) {
				this.setupReindexStrategy();
			}
		}));
	}

	// ========================================================================
	// Reindex Strategy Management
	// ========================================================================

	private setupReindexStrategy(): void {
		// Clean up previous strategy
		this._fileWatcherDisposables.clear();
		if (this._intervalHandle) {
			clearInterval(this._intervalHandle);
			this._intervalHandle = undefined;
		}

		const strategy = this.configurationService.getValue<string>('ollamaAgent.smartContext.reindexStrategy') || 'fileWatcher';

		if (strategy === 'fileWatcher') {
			this.setupFileWatcher();
		} else {
			this.setupIntervalReindex();
		}
	}

	private setupFileWatcher(): void {
		const workspace = this.workspaceService.getWorkspace();
		for (const folder of workspace.folders) {
			const watcher = this.fileService.watch(folder.uri);
			this._fileWatcherDisposables.add(watcher);
		}

		this._fileWatcherDisposables.add(
			this.fileService.onDidFilesChange(e => {
				// Check if any changed file is a source file we care about
				const allChangedUris = [...e.rawAdded, ...e.rawUpdated, ...e.rawDeleted];
				const hasRelevantChange = allChangedUris.some(uri => {
					const path = uri.fsPath;
					const ext = this.getExtension(path);
					return SOURCE_EXTENSIONS.has(ext) && !this.isIgnoredPath(path);
				});
				if (hasRelevantChange) {
					this._logService.info('[ChunkIndex] File change detected, scheduling re-index');
					this.scheduleReindex();
				}
			})
		);

		this._logService.info('[ChunkIndex] Using file watcher reindex strategy');
	}

	private _reindexTimeout: ReturnType<typeof setTimeout> | undefined;

	private scheduleReindex(): void {
		if (this._reindexTimeout) {
			clearTimeout(this._reindexTimeout);
		}
		this._reindexTimeout = setTimeout(() => {
			this.runFullIndex();
		}, 2000);
	}

	private setupIntervalReindex(): void {
		const intervalSec = this.configurationService.getValue<number>('ollamaAgent.smartContext.reindexIntervalSeconds') || 120;
		this._intervalHandle = setInterval(() => {
			this.runFullIndex();
		}, intervalSec * 1000);
		this._logService.info(`[ChunkIndex] Using interval reindex strategy (${intervalSec}s)`);
	}

	// ========================================================================
	// Full Index Build (with progress notification)
	// ========================================================================

	public async runFullIndex(): Promise<void> {
		if (this._isIndexing) {
			return;
		}

		const enabled = this.configurationService.getValue<boolean>('ollamaAgent.smartContext.enabled');
		if (enabled === false) {
			return;
		}

		const workspace = this.workspaceService.getWorkspace();
		if (workspace.folders.length === 0) {
			return; // Nothing to index
		}

		const cts = new CancellationTokenSource();
		this._isIndexing = true;

		try {
			await this.progressService.withProgress({
				location: ProgressLocation.Notification,
				title: 'Dark Matter: Indexing Workspace',
				cancellable: true,
			}, async (progress) => {
				await this.buildIndex(progress, cts.token);
			}, () => {
				cts.cancel();
			});
		} catch (err) {
			this._logService.error(`[ChunkIndex] Indexing failed: ${err}`);
		} finally {
			this._isIndexing = false;
			cts.dispose();
		}
	}

	private async buildIndex(
		progress: { report(value: { message?: string; increment?: number }): void },
		token: CancellationToken
	): Promise<void> {
		const workspace = this.workspaceService.getWorkspace();
		if (workspace.folders.length === 0) {
			return;
		}

		// Step 1: Gather all source files
		progress.report({ message: 'Scanning workspace files...' });
		const allFiles: { uri: URI; relativePath: string; size: number; mtime: number }[] = [];

		for (const folder of workspace.folders) {
			await this.gatherSourceFiles(folder.uri, folder.uri, allFiles, 1);
		}

		if (token.isCancellationRequested) { return; }

		this._logService.info(`[ChunkIndex] Found ${allFiles.length} source files`);

		// Step 2: Determine which files need (re-)summarization
		const filesToIndex: typeof allFiles = [];
		for (const file of allFiles) {
			const existing = this._indexEntries.get(file.relativePath);
			if (!existing || existing.lastModified < file.mtime) {
				filesToIndex.push(file);
			}
		}

		// Remove entries for files that no longer exist
		const currentPaths = new Set(allFiles.map(f => f.relativePath));
		for (const key of this._indexEntries.keys()) {
			if (!currentPaths.has(key)) {
				this._indexEntries.delete(key);
			}
		}

		this._logService.info(`[ChunkIndex] ${filesToIndex.length} files need (re-)indexing out of ${allFiles.length}`);

		if (filesToIndex.length === 0) {
			progress.report({ message: 'Index is up to date.' });
			return;
		}

		// Step 3: Summarize files that changed
		let completed = 0;
		for (const file of filesToIndex) {
			if (token.isCancellationRequested) { break; }

			progress.report({
				message: `Summarizing ${file.relativePath} (${completed + 1}/${filesToIndex.length})`,
				increment: (1 / filesToIndex.length) * 100,
			});

			try {
				const content = await this.fileService.readFile(file.uri);
				const text = content.value.toString();
				const summary = await this.summarizeFile(file.relativePath, text, token);

				if (summary) {
					const entry: FileIndexEntry = {
						path: file.uri.fsPath,
						relativePath: file.relativePath,
						lastModified: file.mtime,
						size: file.size,
						summary: summary.summary,
						keyExports: summary.keyExports,
						dependencies: summary.dependencies,
					};
					this._indexEntries.set(file.relativePath, entry);
				}
			} catch (err) {
				this._logService.warn(`[ChunkIndex] Failed to index ${file.relativePath}: ${err}`);
			}

			completed++;
		}

		// Step 4: Generate workspace overview
		if (!token.isCancellationRequested) {
			progress.report({ message: 'Generating workspace overview...' });
			await this.generateWorkspaceOverview(token);
		}

		// Step 5: Persist index to disk
		if (!token.isCancellationRequested) {
			progress.report({ message: 'Saving index...' });
			await this.saveIndex();
		}

		this._logService.info(`[ChunkIndex] Indexing complete: ${this._indexEntries.size} files indexed`);
	}

	// ========================================================================
	// File Gathering
	// ========================================================================

	private async gatherSourceFiles(
		rootUri: URI,
		dirUri: URI,
		files: { uri: URI; relativePath: string; size: number; mtime: number }[],
		depth: number,
	): Promise<void> {
		if (depth > MAX_SCAN_DEPTH) { return; }

		try {
			const stat = await this.fileService.resolve(dirUri, { resolveMetadata: true });
			if (!stat.children) { return; }

			for (const child of stat.children) {
				if (child.isDirectory) {
					if (!IGNORED_DIRS.has(child.name) && child.name !== '.darkmatter') {
						await this.gatherSourceFiles(rootUri, child.resource, files, depth + 1);
					}
				} else {
					const ext = this.getExtension(child.name);
					if (IGNORED_EXTENSIONS.has(ext)) { continue; }

					const isSource = SOURCE_EXTENSIONS.has(ext)
						|| child.name === 'Makefile'
						|| child.name === 'Dockerfile'
						|| child.name === 'Jenkinsfile';

					if (isSource && child.size !== undefined && child.size <= MAX_FILE_SIZE) {
						const relativePath = child.resource.fsPath.substring(rootUri.fsPath.length + 1);
						files.push({
							uri: child.resource,
							relativePath,
							size: child.size,
							mtime: child.mtime ?? 0,
						});
					}
				}
			}
		} catch {
			// skip unreadable directories
		}
	}

	// ========================================================================
	// Per-file Summarization
	// ========================================================================

	private async summarizeFile(
		relativePath: string,
		content: string,
		token: CancellationToken
	): Promise<{ summary: string; keyExports: string[]; dependencies: string[] } | undefined> {
		const prompt: OllamaChatMessage[] = [
			{
				role: 'system',
				content: 'You are a code indexer. Given a source file, respond with a JSON object containing: ' +
					'"summary" (2-3 sentence description of what this file does), ' +
					'"keyExports" (array of exported functions/classes/constants), ' +
					'"dependencies" (array of imported modules/files). ' +
					'Respond with ONLY the JSON object, no markdown formatting.',
			},
			{
				role: 'user',
				content: `File: ${relativePath}\n\n${content.substring(0, 8000)}`, // Cap at ~8k chars
			}
		];

		let result = '';
		try {
			for await (const chunk of this.ollamaProvider.sendChatRequest(prompt, token)) {
				result += chunk;
				if (token.isCancellationRequested) { return undefined; }
			}

			// Try to parse JSON response
			const jsonMatch = result.match(/\{[\s\S]*\}/);
			if (jsonMatch) {
				const parsed = JSON.parse(jsonMatch[0]);
				return {
					summary: parsed.summary || '',
					keyExports: Array.isArray(parsed.keyExports) ? parsed.keyExports : [],
					dependencies: Array.isArray(parsed.dependencies) ? parsed.dependencies : [],
				};
			}

			// Fallback: use the raw text as summary
			return { summary: result.trim(), keyExports: [], dependencies: [] };
		} catch (err) {
			this._logService.warn(`[ChunkIndex] Summarization failed for ${relativePath}: ${err}`);
			return undefined;
		}
	}

	// ========================================================================
	// Workspace Overview Generation
	// ========================================================================

	private async generateWorkspaceOverview(token: CancellationToken): Promise<void> {
		const summaries: string[] = [];
		for (const [path, entry] of this._indexEntries) {
			summaries.push(`- **${path}**: ${entry.summary}`);
		}

		if (summaries.length === 0) {
			this._workspaceOverview = '(No indexed files)';
			return;
		}

		// If few enough files, just use the list directly
		if (summaries.length <= 30) {
			this._workspaceOverview = `## Workspace Overview (${summaries.length} files)\n\n${summaries.join('\n')}`;
			return;
		}

		// For larger workspaces, ask the model to synthesize an overview
		const prompt: OllamaChatMessage[] = [
			{
				role: 'system',
				content: 'You are a technical architect. Given a list of file summaries from a project, write a concise project overview (5-10 sentences) covering: the project type, main technologies, architecture patterns, and key modules.',
			},
			{
				role: 'user',
				content: summaries.join('\n'),
			}
		];

		let result = '';
		try {
			for await (const chunk of this.ollamaProvider.sendChatRequest(prompt, token)) {
				result += chunk;
				if (token.isCancellationRequested) { return; }
			}
			this._workspaceOverview = `## Workspace Overview (${this._indexEntries.size} files)\n\n${result.trim()}`;
		} catch {
			this._workspaceOverview = `## Workspace Overview (${summaries.length} files)\n\n${summaries.slice(0, 30).join('\n')}\n... and ${summaries.length - 30} more files`;
		}
	}

	// ========================================================================
	// Relevance Scoring
	// ========================================================================

	public getRelevantContext(context: RelevanceContext): { overview: string; relevantFiles: FileIndexEntry[] } {
		const maxFiles = this.configurationService.getValue<number>('ollamaAgent.smartContext.maxRelevantFiles') || 15;

		const scored: { entry: FileIndexEntry; score: number }[] = [];

		for (const entry of this._indexEntries.values()) {
			let score = 0;

			// Active file gets highest priority
			if (context.activeFilePath && entry.path === context.activeFilePath) {
				score += 100;
			}

			// Open editors get high priority
			if (context.openEditorPaths.includes(entry.path)) {
				score += 50;
			}

			// File path mentioned in user message
			const fileName = entry.relativePath.split('/').pop() || '';
			if (context.userMessage.toLowerCase().includes(fileName.toLowerCase())) {
				score += 40;
			}

			// Path segments mentioned in user message
			const pathSegments = entry.relativePath.toLowerCase().split('/');
			for (const segment of pathSegments) {
				if (segment.length > 2 && context.userMessage.toLowerCase().includes(segment)) {
					score += 15;
				}
			}

			// Keywords from summary match user message
			const msgWords = context.userMessage.toLowerCase().split(/\s+/);
			const summaryLower = entry.summary.toLowerCase();
			for (const word of msgWords) {
				if (word.length > 3 && summaryLower.includes(word)) {
					score += 5;
				}
			}

			// Key exports mentioned in user message
			for (const exp of entry.keyExports) {
				if (context.userMessage.includes(exp)) {
					score += 30;
				}
			}

			// Dependencies on active file (if the active file is imported by this file)
			if (context.activeFilePath) {
				const activeFileName = context.activeFilePath.split('/').pop()?.replace(/\.\w+$/, '') || '';
				if (entry.dependencies.some(d => d.includes(activeFileName))) {
					score += 25;
				}
			}

			// Recency bonus (more recently modified = higher score)
			const ageHours = (Date.now() - entry.lastModified) / (1000 * 60 * 60);
			if (ageHours < 1) { score += 10; }
			else if (ageHours < 24) { score += 5; }

			if (score > 0) {
				scored.push({ entry, score });
			}
		}

		// Sort by score descending, take top N
		scored.sort((a, b) => b.score - a.score);
		const relevantFiles = scored.slice(0, maxFiles).map(s => s.entry);

		return {
			overview: this._workspaceOverview,
			relevantFiles,
		};
	}

	// ========================================================================
	// Index Persistence (.darkmatter/index/)
	// ========================================================================

	private getIndexFolder(): URI | undefined {
		const workspace = this.workspaceService.getWorkspace();
		if (workspace.folders.length === 0) { return undefined; }
		return URI.joinPath(workspace.folders[0].uri, '.darkmatter', 'index');
	}

	private getOverviewUri(): URI | undefined {
		const workspace = this.workspaceService.getWorkspace();
		if (workspace.folders.length === 0) { return undefined; }
		return URI.joinPath(workspace.folders[0].uri, '.darkmatter', 'workspace_overview.md');
	}

	private async saveIndex(): Promise<void> {
		const indexFolder = this.getIndexFolder();
		if (!indexFolder) { return; }

		try {
			await this.fileService.createFolder(indexFolder);

			// Save all entries as a single JSON file for simplicity
			const entries = Array.from(this._indexEntries.values());
			const data = JSON.stringify(entries, null, 2);
			const indexUri = URI.joinPath(indexFolder, 'file_index.json');
			await this.fileService.writeFile(indexUri, VSBuffer.fromString(data));

			// Save workspace overview
			const overviewUri = this.getOverviewUri();
			if (overviewUri && this._workspaceOverview) {
				await this.fileService.writeFile(overviewUri, VSBuffer.fromString(this._workspaceOverview));
			}

			this._logService.info(`[ChunkIndex] Index saved: ${entries.length} entries`);
		} catch (err) {
			this._logService.error(`[ChunkIndex] Failed to save index: ${err}`);
		}
	}

	private async loadIndex(): Promise<void> {
		const indexFolder = this.getIndexFolder();
		if (!indexFolder) { return; }

		try {
			const indexUri = URI.joinPath(indexFolder, 'file_index.json');
			const content = await this.fileService.readFile(indexUri);
			const entries: FileIndexEntry[] = JSON.parse(content.value.toString());

			this._indexEntries.clear();
			for (const entry of entries) {
				this._indexEntries.set(entry.relativePath, entry);
			}

			this._logService.info(`[ChunkIndex] Loaded existing index: ${entries.length} entries`);
		} catch {
			// No existing index, that's fine
		}

		// Load overview
		try {
			const overviewUri = this.getOverviewUri();
			if (overviewUri) {
				const content = await this.fileService.readFile(overviewUri);
				this._workspaceOverview = content.value.toString();
			}
		} catch {
			// No existing overview
		}
	}

	// ========================================================================
	// Utilities
	// ========================================================================

	private getExtension(nameOrPath: string): string {
		const name = nameOrPath.split('/').pop() || nameOrPath;
		if (!name.includes('.')) { return ''; }
		return '.' + name.split('.').pop()!.toLowerCase();
	}

	private isIgnoredPath(path: string): boolean {
		const parts = path.split('/');
		return parts.some(p => IGNORED_DIRS.has(p));
	}

	get isReady(): boolean {
		return this._indexEntries.size > 0 || this._workspaceOverview.length > 0;
	}

	get entryCount(): number {
		return this._indexEntries.size;
	}

	override dispose(): void {
		super.dispose();
		if (this._intervalHandle) {
			clearInterval(this._intervalHandle);
		}
		if (this._reindexTimeout) {
			clearTimeout(this._reindexTimeout);
		}
	}
}
