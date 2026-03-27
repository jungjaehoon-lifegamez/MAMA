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
│         └────────┴──▶│  4 Tools: save/search/     │           │
│                      │  update/load_checkpoint    │           │
│                      └──────┬──────────┬──────────┘           │
│                             │          │                      │
│            ┌────────────────▼──┐  ┌────▼──────────────────┐   │
│            │ SQLite + pure-TS  │  │ HTTP Embedding Server │   │
│            │ cosine similarity │  │ :3847 (model in mem)  │   │
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
- **Tools:** 4 (save, search, update, load_checkpoint)
- **Performance:** <100ms p99 latency

### Database (SQLite + pure-TS cosine similarity)

- **Decisions table:** topic, decision, reasoning, confidence, outcome, kind, status, summary
- **Embeddings:** 384-dimensional vectors (multilingual-e5-small, q8) with in-memory cache
- **Graph:** supersedes/builds_on/debates/synthesizes edges
- **Memory scopes:** project/channel/user/global isolation via memory_scopes + memory_scope_bindings
- **Truth projection:** memory_truth table for recall filtering (preserves history, surfaces current truth)
- **Audit trail:** memory_events + audit_findings for memory agent auditing
- **Channel state:** channel_summaries + channel_summary_state for per-channel context

### Embeddings

- **Model:** Xenova/multilingual-e5-small (~113MB, quantized q8)
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

### Hooks

- **UserPromptSubmit:** Automatic semantic search via HTTP embedding server
- **PreToolUse:** MCP search + contract-only injection + Reasoning Summary
- **PostToolUse:** Contract extraction + save guidance with structured reasoning

---

## Data Flow

```
User Prompt
    ↓
UserPromptSubmit Hook
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
