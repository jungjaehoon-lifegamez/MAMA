# Architecture Overview

**MAMA system architecture and design principles**

---

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    MAMA Plugin Ecosystem                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  OpenClaw         Claude Code      Claude Desktop   Others  │
│  ┌────────────┐   ┌────────────┐   ┌────────────┐          │
│  │ Native     │   │ Commands   │   │            │          │
│  │ Plugin     │   │ Skills     │   │ MCP Client │  (Cursor,│
│  │ (auto-     │   │ Hooks      │   │            │   Aider) │
│  │  recall)   │   └────────────┘   └────────────┘          │
│  └──────┬─────┘         │                │                  │
│         │               │                │                  │
│         │       ┌───────▼────────────────▼──────────┐      │
│         │       │  HTTP Embedding Server (3847)     │      │
│         │       │  Model stays in memory            │      │
│         │       └───────────────────────────────────┘      │
│         │                       │                           │
│         │       ┌───────────────▼───────────────┐          │
│  Direct │       │   MCP Server (stdio)          │          │
│  module ├──────▶│   4 Tools: save/search/       │          │
│  import │       │   update/load_checkpoint      │          │
│         │       └───────────────────────────────┘          │
│         │                       │                           │
│         │       ┌───────────────▼───────────────┐          │
│         └──────▶│  SQLite + sqlite-vec          │          │
│                 │  ~/.claude/mama-memory.db     │          │
│                 └───────────────────────────────┘          │
│                                                              │
└─────────────────────────────────────────────────────────────┘
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

### OpenClaw Plugin

- **Integration:** Direct module import (no HTTP)
- **Tools:** 4 (mama_search, mama_save, mama_update, mama_load_checkpoint)
- **Auto-recall:** Semantic search on `before_agent_start` event

### Database (SQLite + sqlite-vec)

- **Decisions table:** topic, decision, reasoning, confidence, outcome
- **Embeddings:** 384-dimensional vectors (all-MiniLM-L6-v2)
- **Graph:** supersedes/builds_on/debates/synthesizes edges

### Embeddings

- **Model:** Xenova/all-MiniLM-L6-v2 (~30MB)
- **Tier 1:** Transformers.js (ONNX runtime)
- **Tier 2:** Disabled (fallback to exact match)

### HTTP Embedding Server

- **Port:** 3847 (localhost only)
- **Purpose:** Keep embedding model in memory for fast access
- **Endpoints:** `/health`, `/embed`, `/embed/batch`
- **Benefit:** ~50ms embedding requests (vs 2-9s model load)
- **Clients:** Any local LLM tool can use this shared service

### Hooks

- **UserPromptSubmit:** Automatic semantic search via HTTP embedding server
- **PreToolUse:** File-specific context (planned)
- **PostToolUse:** Auto-save suggestions (planned)

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
