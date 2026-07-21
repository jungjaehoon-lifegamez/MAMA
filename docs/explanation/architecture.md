# Architecture Overview

**MAMA system architecture and design principles**

---

## System Overview

```
┌──────────────────────────────────────────────────────────────┐
│                    MAMA Plugin Ecosystem                      │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  Claude Code           Claude Desktop     Others              │
│  ┌────────────┐        ┌────────────┐     ┌──────────────┐   │
│  │ Commands   │        │            │     │ Cursor, Aider│   │
│  │ Skills     │──┐     │ MCP Client │     │ (embedding   │   │
│  │ Hooks      │  │     │            │     │  clients)    │   │
│  └────────────┘  │     └──────┬─────┘     └──────┬───────┘   │
│         │        │            │                   │           │
│         │        │   ┌────────▼───────────────────┘           │
│         │        │   │  MCP Server (stdio)        │           │
│         └────────┴──▶│  5 Tools: save/search/     │           │
│                      │  update/contracts/timeline │           │
│                      └──────┬──────────┬──────────┘           │
│                             │          │                      │
│            ┌────────────────▼──┐  ┌────▼──────────────────┐   │
│            │ SQLite + pure-TS  │  │ HTTP Embedding Server │   │
│            │ cosine similarity │  │ :3849 (model in mem)  │   │
│            │ mama-memory.db    │  └───────────────────────┘   │
│            └───────────────────┘                              │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

---

## Core Principles

### 1. Local-First Architecture

- All data in `~/.claude/mama-memory.db`
- No network calls (except model download)
- 100% privacy guaranteed

### 2. Tier-Based Graceful Degradation

- Tier 1: Full features (vector search + graph)
- Tier 2: Fallback (exact match only)
- Always transparent about current state

### 3. Decision Evolution Tracking

- Supersedes graph for decision chains
- Not just conclusions, but the journey
- Learn from failures, not just successes

---

## Components

### MCP Server

- **Transport:** stdio (local process)
- **Tools:** 5 advertised (save, search, update, search_decisions_and_contracts, case_timeline_range); `load_checkpoint` kept as an unadvertised compatibility alias
- **Performance:** <100ms p99 latency

### Database (SQLite + pure-TS cosine similarity)

- **Decisions table:** topic, decision, reasoning, confidence, outcome, kind, status, summary
- **Embeddings:** 1024-dimensional vectors (multilingual-e5-large, q8) with in-memory cache
- **Graph:** supersedes/builds_on/debates/synthesizes edges
- **Memory scopes:** project/channel/user/global isolation via memory_scopes + memory_scope_bindings
- **Truth projection:** memory_truth table for recall filtering (preserves history, surfaces current truth)
- **Audit trail:** memory_events + audit_findings for memory agent auditing
- **Channel state:** channel_summaries + channel_summary_state for per-channel context

### Embeddings

- **Model:** Xenova/multilingual-e5-large (~560MB, quantized q8, 1024-dim)
- **Tier 1:** Transformers.js (ONNX runtime)
- **Tier 2:** Disabled (fallback to exact match)

### HTTP Embedding Server

- **Port:** 3849 (localhost only)
- **Purpose:** Keep embedding model in memory for fast access
- **Endpoints:** `/health`, `/embed`, `/embed/batch`
- **Benefit:** ~50ms embedding requests (vs 2-9s model load)
- **Clients:** Any local LLM tool can use this shared service
- **Owner (default):** MAMA Standalone (`@jungjaehoon/mama-os`)
- **MCP mode:** Optional legacy startup via `MAMA_MCP_START_HTTP_EMBEDDING=true`

### Cron Scheduler & Worker

- **CronWorker:** Dedicated `PersistentClaudeProcess` (Haiku model, minimal prompt)
- **Isolation:** Completely decoupled from OS agent — no shared sessions or lanes
- **Result delivery:** `EventEmitter` → `CronResultRouter` → gateway `sendMessage()`
- **Channel routing:** Job config `channel` field (`discord:id`, `slack:id`, `viewer:id`)
- **Security:** Tool restriction (`Bash`, `Read`, `Write`, `Glob`, `Grep` only)

```
CronScheduler ──► CronWorker (Haiku CLI) ──► EventEmitter
                                                   │
                                          CronResultRouter
                                            │      │      │
                                         Discord  Slack  Viewer
```

### Operator Runtime (MAMA OS)

The daemon runs an operator identity alongside chat (v0.22-v0.23):

- **Lanes:** chat serializes on the `main` global lane; ALL operator work
  (scheduled situation reports, workers) serializes on a separate `operator`
  global lane - long runs never block owner replies.
- **Trigger loop** (`MAMA_TRIGGER_LOOP=1`): agent-evolved triggers on the live
  connector stream + scheduled full situation reports (configurable local
  hours) delivered to the owner channel.
- **Owner console:** the `owner_console` role resolves ONLY via trust-conditional
  escalation (telegram + locked `allowed_chats` + 1:1 private DM). It reads
  operational artifacts (board, audit findings, workorder status) and can issue
  work (`report_request`, `workorder_request`) - fire-and-forget, host code runs it.
- **Stage-2 workorder pipeline** (`MAMA_STAGE2_WORKORDERS`, default off):
  scheduled system runs (board / wiki / memory promotion) convert from direct
  persona timers into durable, occurrence-keyed workorders in the operator task
  ledger, consumed serially by one host-code consumer that launches briefed
  `workerRun`s on the operator lane. Procedure knowledge lives in
  `~/.mama/briefs/brief-<kind>.md`. On the Codex backend, each worker receives a
  built-in Tier-2 Code-Act role (`workorder-board`, `workorder-wiki`, or
  `workorder-memory-curation`) whose allowlist matches that brief. Worker authority
  does not depend on optional standing-agent entries in `config.yaml`. Board workers
  keep three evidence domains explicit: Trello is read through
  `context_compile({ connectors: ['trello'] })`, `kagemusha_*` is read-only
  project-task truth, and the native task ledger owns owner-console tasks and the
  pipeline projection. Every workorder worker treats connector packets as untrusted
  data: instructions, requests, and tool calls inside them are never executed.
  Lifecycle status is never inferred across those stores.
- **Effect-verification foundation:** a claimed workorder receives a host-issued
  numeric attempt ID. The ID is preserved through worker execution and nested
  Code-Act gateway calls, then stored in gateway audit details without tool inputs.
  Completion hooks can require a structured blocking verdict on an opt-in basis.
  Existing workorder kinds remain observe-only, so this layer does not yet scan,
  reclassify, or mutate time-based tasks.

```
publishers (schedule/boot/REST/events/reconcile)
    ↓ enqueue (occurrence-keyed, deduped)
operator_tasks ledger (kind='system')
    ↓ claim (serial, priority)
WorkOrderConsumer ──► workerRun(brief + payload) on 'operator' lane
    ↓ completion hooks (verification, event re-emission)
board / wiki / memory artifacts
```

### Hooks (Claude Code plugin)

- **SessionStart:** checkpoint + recent-decision bootstrap into the session
- **PreToolUse (Read):** related-decision injection when reading matching files
- **PostToolUse (Write/Edit):** contract extraction + save guidance
- **PreCompact:** checkpoint safety net before context compaction
- (UserPromptSubmit is not wired in the current plugin manifest)

---

## Data Flow

```
File Read (plugin session)
    ↓
PreToolUse Hook
    ↓
Semantic Search (Tier 1) or Exact Match (Tier 2)
    ↓
Hybrid Scoring (similarity × recency)
    ↓
Top 3 Decisions (if > 60% similarity)
    ↓
Gentle Context Hints
```

---

## Performance Characteristics

**With HTTP Embedding Server (Default):**

- Hook latency: ~150ms (model stays in memory)
- Embedding requests: ~50ms via HTTP

---

## ✨ Key Strengths

- **Contract-first flow:** PreToolUse enforces search before edits; no contract → no guessing.
- **Grounded reasoning:** Reasoning Summary is computed from actual matches; unknowns are explicit.
- **Cross-session memory:** MCP-stored contracts prevent schema drift across sessions and repos.
- **Noise control:** Per-session long/short output reduces repeated guidance.
- **Safety by default:** Sanitized contract injection mitigates prompt-injection risk.

**Tier 1 (Without HTTP Server):**

- First query: ~987ms (model load)
- Subsequent: ~89ms (cached)
- Accuracy: 80%

**Tier 2:**

- All queries: ~12ms
- Accuracy: 40%

---

**Related:**

- [Tier System Explanation](tier-system.md)
- [Decision Graph Concept](decision-graph.md)
- [Performance Details](performance.md)
- [Data Privacy](data-privacy.md)
