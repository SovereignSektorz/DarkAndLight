# Walkthrough: Smart Context, Persistent Memory & Conversation Compaction

## Summary

Implemented three interconnected systems to allow Dark Matter IDE to handle large projects without blowing up VRAM:

1. **WorkspaceChunkIndex** — Replaces dumping all source files into the prompt with per-file AI-generated summaries and a relevance scorer
2. **AgentMemory** — Persistent task/plan/summary/activity files in `.darkmatter/` for cross-session and cross-machine continuity
3. **ConversationCompactor** — Automatic summarization of older conversation turns when history exceeds the token budget

## New Files

### [workspaceChunkIndex.ts](file:///home/abdallah/.gemini/antigravity/scratch/dark-matter-ide/src/vs/workbench/contrib/chat/browser/ollama/workspaceChunkIndex.ts)
- Per-file summaries stored in `.darkmatter/index/file_index.json`
- Delta indexing: only re-summarizes files that changed since last index
- Two reindex strategies: `fileWatcher` (on file change) or `interval` (timed)
- Relevance scorer considers: active file, open editors, message keyword matches, dependency chains, export names, recency
- Workspace overview generated from all file summaries
- Progress notification shown during indexing

### [agentMemory.ts](file:///home/abdallah/.gemini/antigravity/scratch/dark-matter-ide/src/vs/workbench/contrib/chat/browser/ollama/agentMemory.ts)
- Manages `task.md`, `plan.md`, `summary.md`, `activity.log` in `.darkmatter/`
- Creates template files on first use
- Injects memory into system prompt with instructions for the AI to maintain these files
- Activity logging with timestamps

### [conversationCompactor.ts](file:///home/abdallah/.gemini/antigravity/scratch/dark-matter-ide/src/vs/workbench/contrib/chat/browser/ollama/conversationCompactor.ts)
- Estimates token usage of conversation history
- When over budget: keeps last N turns verbatim, summarizes older turns into a recap
- Cached recap avoids re-summarization on every request
- Incremental recap extension when new turns are compacted

## Modified Files

### [ollamaChatAgent.ts](file:///home/abdallah/.gemini/antigravity/scratch/dark-matter-ide/src/vs/workbench/contrib/chat/browser/ollama/ollamaChatAgent.ts)
- Constructor now instantiates all three new services
- `buildSystemPrompt()` now takes `userMessage` param and uses smart context mode (chunk index + memory) with legacy fallback
- `handleRequest()` uses ConversationCompactor instead of raw history loop, with token budgeting

### [ollamaConfiguration.ts](file:///home/abdallah/.gemini/antigravity/scratch/dark-matter-ide/src/vs/workbench/contrib/chat/browser/ollama/ollamaConfiguration.ts)
- 8 new settings added: smart context (enabled, maxRelevantFiles, workspaceBudgetPercent, reindexStrategy, reindexIntervalSeconds), conversation compaction (enabled, recentTurns), persistent memory (enabled)

### [ollamaStatusBar.ts](file:///home/abdallah/.gemini/antigravity/scratch/dark-matter-ide/src/vs/workbench/contrib/chat/browser/ollama/ollamaStatusBar.ts)
- Quick-pick menu now includes "Smart Context: ON/OFF" toggle and "Rebuild Workspace Index" option

## New Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `smartContext.enabled` | `true` | Toggle smart chunked context |
| `smartContext.maxRelevantFiles` | `15` | Max relevant files per request |
| `smartContext.workspaceBudgetPercent` | `30` | % of context window for workspace (10-60) |
| `smartContext.reindexStrategy` | `fileWatcher` | `fileWatcher` or `interval` |
| `smartContext.reindexIntervalSeconds` | `120` | Interval for timed re-scan |
| `conversationCompaction.enabled` | `true` | Auto-compact long conversations |
| `conversationCompaction.recentTurns` | `6` | Verbatim recent turns to keep |
| `persistentMemory.enabled` | `true` | Persistent task/plan/summary files |
