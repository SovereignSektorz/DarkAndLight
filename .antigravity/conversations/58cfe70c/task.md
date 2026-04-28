# Implementation Tasks

## 1. Configuration Updates
- [x] Add new settings to `ollamaConfiguration.ts` (smart context, compaction, memory, reindex strategy)
- [x] Add new quick-pick options to `ollamaStatusBar.ts` (Rebuild Index, Smart Context toggle)

## 2. Workspace Chunk Index
- [x] Create `workspaceChunkIndex.ts` with:
  - [x] Per-file summary generation (using Ollama model)
  - [x] Delta indexing (only re-summarize changed files)
  - [x] File watcher mode for re-indexing
  - [x] Interval mode for re-indexing
  - [x] Relevance scorer (open files, mentioned files, dependencies, recency)
  - [x] Workspace overview generation
  - [x] Progress notification during indexing
  - [x] Persistent storage in `.darkmatter/index/`

## 3. Agent Memory
- [x] Create `agentMemory.ts` with:
  - [x] Read/write for task.md, plan.md, summary.md, activity.log
  - [x] Template creation on first use
  - [x] System prompt injection of persistent memory

## 4. Conversation Compactor
- [x] Create `conversationCompactor.ts` with:
  - [x] Token estimation for conversation history
  - [x] Threshold-based compaction trigger
  - [x] Summarization of older turns via Ollama
  - [x] Caching of recap to avoid re-summarization
  - [x] Incremental recap updates

## 5. Modify Ollama Chat Agent
- [x] Refactor `ollamaChatAgent.ts`:
  - [x] Replace monolithic scan with `WorkspaceChunkIndex` calls
  - [x] Inject `AgentMemory` into system prompt
  - [x] Replace raw history loop with `ConversationCompactor`
  - [x] Token-budgeted `buildSystemPrompt()` 
  - [x] Wire up all new services in constructor

## 6. Verification
- [x] Code review: fixed DI pattern (services created via instantiationService.createInstance)
- [x] Code review: fixed FileChangesEvent API (rawAdded/rawUpdated/rawDeleted instead of rawChanges)
- [x] Code review: removed unused imports (ILogService, IFileStat, CancellationTokenSource)
- [x] Code review: fixed token budget calculation to use configurable workspaceBudgetPct
- [ ] Run `npm run compile` — requires Node.js installation on this machine
