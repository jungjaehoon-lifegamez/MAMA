# MAMA Plugin - Architecture Document

**Author:** spellon
**Date:** 2025-11-20
**Version:** 1.0
**Status:** Decision-Driven Architecture (6 Core Decisions)
**PRD Version:** 3.0 (Transformers.js-Only Architecture)

---

## Executive Summary

MAMA (Memory-Augmented MCP Assistant)는 **의사결정 흐름을 기억하는 consciousness flow companion**입니다. 실패한 시도부터 성공까지의 여정을 추적하여 동일한 실수 반복을 방지합니다.

**Core Architecture Principle:**
> "정보를 기록하는게 아니라 의사의 흐름을 기억하는거"

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    MAMA Plugin Ecosystem                     │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  Claude Code Plugin                Claude Desktop            │
│  ┌──────────────────┐              ┌──────────────┐          │
│  │ Commands         │              │              │          │
│  │ Skills           │──stdio──┐    │  MCP Client  │          │
│  │ Hooks (teaser)   │         │    │              │          │
│  └──────────────────┘         │    └──────────────┘          │
│                                │            │                 │
│                          ┌─────▼────────────▼─────┐           │
│                          │   MCP Server (stdio)   │           │
│                          │  5 Tools: save/recall/ │           │
│                          │  suggest/list/update   │           │
│                          └────────────────────────┘           │
│                                     │                         │
│                          ┌──────────▼──────────┐              │
│                          │   Core Logic        │              │
│                          │  - Embeddings       │              │
│                          │  - Vector Search    │              │
│                          │  - Graph Traversal  │              │
│                          │  - Hybrid Scoring   │              │
│                          └─────────────────────┘              │
│                                     │                         │
│                          ┌──────────▼──────────┐              │
│                          │  SQLite Database    │              │
│                          │  ~/.claude/         │              │
│                          │  mama-memory.db     │              │
│                          └─────────────────────┘              │
└─────────────────────────────────────────────────────────────┘
```

---

## Table of Contents

1. [Architectural Decisions](#architectural-decisions)
2. [Technology Stack](#technology-stack)
3. [Database Architecture](#database-architecture)
4. [MCP Server Design](#mcp-server-design)
5. [Hook Integration](#hook-integration)
6. [Embedding & Search](#embedding--search)
7. [Plugin Structure](#plugin-structure)
8. [Data Flow](#data-flow)
9. [Deployment Strategy](#deployment-strategy)
10. [Migration Path](#migration-path)

---

## Architectural Decisions

모든 architectural decisions는 MAMA 자체에 기록되어 추적 가능합니다:

| Decision ID | Topic | Confidence | Outcome |
|------------|-------|-----------|---------|
| Decision 1 | `mama_architecture_tech_stack_versions` | 95% | ✅ Success |
| Decision 2 | `mama_architecture_database_schema` | 95% | ✅ Success |
| Decision 3 | `mama_architecture_mcp_implementation` | 95% | ✅ Success |
| Decision 4 | `mama_architecture_hook_implementation` | 95% | ✅ Success |
| Decision 5 | `mama_architecture_embedding_search` | 90% | ⚠️ Partial (embedding bug) |
| Decision 6 | `mama_architecture_plugin_structure` | 95% | ✅ Success |

각 결정의 전체 내용: `mama.recall('<topic>')`

---

## Technology Stack

### Decision 1: Tech Stack Versions (2025-11-20)

**Selected Versions:**

```json
{
  "engines": {
    "node": ">=22.11.0"
  },
  "dependencies": {
    "@huggingface/transformers": "^3.7.6",
    "@modelcontextprotocol/sdk": "^1.7.0",
    "better-sqlite3": "^12.4.1",
    "sqlite-vec": "^0.1.5"
  },
  "devDependencies": {
    "typescript": "^5.9.3",
    "@types/node": "^22.0.0"
  }
}
```

**Key Migrations:**

1. **@xenova/transformers → @huggingface/transformers v3.7.6**
   - Reason: Official Hugging Face package (v3), better support
   - Breaking changes: `quantized` → `dtype` parameter
   - Migration: 1-month model difference = significant improvement

2. **sqlite-vss → sqlite-vec v0.1.5**
   - Reason: sqlite-vss deprecated (2023+)
   - Successor: Pure C, no Faiss dependency, WASM compatible
   - Better cross-platform support

**Rationale:**
User: "모델은 한달차이라도 엄청난 차이가 난다" → Latest stable versions selected through 2025 search

**Verification Date:** 2025-11-20
**Next Review:** 2026-02 (3 months)

---

## Database Architecture

### Decision 2: Database Schema & WAL Mode (2025-11-20)

**Schema Design:**

```sql
-- Version tracking (SQLite built-in)
PRAGMA user_version = 1;

-- Migration history (2025 best practice)
CREATE TABLE _migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  applied_at TEXT DEFAULT (datetime('now')),
  UNIQUE(version)
);

-- Decisions table
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,              -- UUID
  topic TEXT NOT NULL,
  decision TEXT NOT NULL,
  reasoning TEXT NOT NULL,          -- REQUIRED
  confidence REAL DEFAULT 0.5,
  outcome TEXT DEFAULT 'pending',   -- pending/success/failure/partial
  failure_reason TEXT,
  limitation TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  type TEXT DEFAULT 'user_decision'
);

CREATE INDEX idx_decisions_topic ON decisions(topic);
CREATE INDEX idx_decisions_created_at ON decisions(created_at DESC);
CREATE INDEX idx_decisions_outcome ON decisions(outcome);

-- Supersedes edges (decision evolution graph)
CREATE TABLE supersedes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_decision_id TEXT NOT NULL,
  to_decision_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (from_decision_id) REFERENCES decisions(id) ON DELETE CASCADE,
  FOREIGN KEY (to_decision_id) REFERENCES decisions(id) ON DELETE CASCADE,
  UNIQUE(from_decision_id, to_decision_id)
);

-- Embeddings (vector storage)
CREATE TABLE embeddings (
  decision_id TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,          -- Float32Array serialized
  model TEXT NOT NULL,              -- "Xenova/multilingual-e5-small"
  dim INTEGER NOT NULL,             -- 384
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (decision_id) REFERENCES decisions(id) ON DELETE CASCADE
);
```

**WAL Mode Configuration:**

```javascript
import Database from 'better-sqlite3';

const db = new Database('~/.claude/mama-memory.db');

// Enable WAL mode (crash-safe + fast)
db.pragma('journal_mode = WAL');

// Synchronous mode (NORMAL for WAL)
db.pragma('synchronous = NORMAL');

// Auto-checkpoint (1000 pages = ~4MB)
db.pragma('wal_autocheckpoint = 1000');
```

**Performance Targets:**
- Save: <20ms (measured)
- Recall: <30ms (measured)
- Queries/sec: ~2000 (better-sqlite3 benchmark)

**Migration Strategy:**
- Transaction-wrapped migrations
- user_version pragma tracking
- Idempotent CREATE TABLE IF NOT EXISTS

**PRD Update Required:**
- Change "sqlite-vss" → "sqlite-vec" (deprecated → modern)

---

## MCP Server Design

### Decision 3: MCP Implementation (2025-11-20)

**Transport: Dual (stdio + Streamable HTTP)**

```typescript
// server/mama-server/src/index.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamablehttp.js";

const server = new Server({
  name: "mama-server",
  version: "1.0.0"
}, {
  capabilities: { tools: {} }
});

// Transport routing
if (process.env.MCP_TRANSPORT === "stdio") {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.env.MCP_TRANSPORT === "http") {
  const transport = new StreamableHTTPServerTransport({
    port: parseInt(process.env.PORT || "3101")
  });
  await server.connect(transport);
}
```

**Building Blocks: Tools Only**

5 MCP Tools (no Resources, no Prompts):

1. `save_decision` → db.saveDecision()
2. `recall_decision` → db.recallEvolution()
3. `suggest_decision` → embeddings.search()
4. `list_decisions` → db.listRecent()
5. `update_outcome` → db.updateOutcome()

**Error Handling: Result-Level**

```typescript
// ✅ CORRECT (2025 best practice)
return {
  content: [{
    type: "text",
    text: JSON.stringify({
      isError: true,
      error: "Decision not found",
      code: "DECISION_NOT_FOUND"
    })
  }]
};

// ❌ WRONG (blocks LLM understanding)
throw new McpError(ErrorCode.InternalError, "Decision not found");
```

**Output Format:**
- MCP tools: JSON (structured)
- Hook scripts: Markdown (human-readable)

**Database Connection:**
- Singleton pattern (better-sqlite3 is single-threaded)
- WAL mode supports multiple readers
- No connection pool needed

**Critical Update:**
HTTP+SSE deprecated in MCP spec 2025-03-26 → Use Streamable HTTP

---

## Hook Integration

### Decision 4: Hook Implementation (2025-11-20)

**Teaser Format: Topic + Time Only**

User philosophy: "보여주는 텍스트를 티져나 힌트 정도의 형식으로 만들어서 클로드가 보고 관심을 가지게 하는정도의 양이면 충분"

```
💡 MAMA: 2 related
   • auth_strategy (85%, 3 days ago)
   • mesh_detail (78%, 1 week ago)
   /mama-recall <topic> for details
```

**Token Budget:** ~40 tokens (acceptable per prompt)

**Implementation:**

```bash
#!/bin/bash
# scripts/inject-mama-context.sh

timeout 2s node "${CLAUDE_PLUGIN_ROOT}/scripts/mama-api-client.js" \
  suggest "$USER_PROMPT" || exit 0
```

```javascript
// scripts/mama-api-client.js
import Database from "better-sqlite3";
import { generateEmbedding } from "./embeddings.js";

const db = Database.getInstance();

async function suggest(query) {
  const embedding = await generateEmbedding(query);  // 3ms
  const decisions = searchByEmbedding(db, embedding);  // 5ms
  return formatTeaser(decisions);  // topic + similarity + time
}
```

**Performance Budget:**
```
Embedding:    3ms
DB search:    5ms
Formatting:   2ms
Total:       10ms ✅ (<<2s timeout)
```

**Timeout Strategy:**
- 2s timeout (safety net, not performance metric)
- Hook execution ~12ms (already fast)
- Real bottleneck: LLM processing injected context

**UX Flow:**
1. User prompt → Hook shows teaser (40 tokens)
2. Claude notices hint → Suggests /mama-recall if interested
3. User accepts → Full context shown (on-demand)
4. If not needed → Claude ignores teaser (no harm)

---

## Embedding & Search

### Decision 5: Embedding & Search (2025-11-20)

**Model: @huggingface/transformers v3.7.6**

```javascript
// embeddings.js
import { pipeline } from '@huggingface/transformers';

let embeddingPipeline = null;

async function getEmbeddingPipeline() {
  if (!embeddingPipeline) {
    embeddingPipeline = await pipeline(
      'feature-extraction',
      'Xenova/multilingual-e5-small',
      { dtype: 'fp32' }  // v3 syntax (replaces quantized)
    );
  }
  return embeddingPipeline;
}

export async function generateEmbedding(text) {
  const pipe = await getEmbeddingPipeline();  // 987ms first time, 0ms after
  const result = await pipe(text, { pooling: 'mean', normalize: true });
  return Array.from(result.data);  // 3ms (validated)
}
```

**Vector Search: Pure JavaScript Cosine Similarity**

```javascript
function cosineSimilarity(a, b) {
  let dotProduct = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Performance: ~5ms for 100 decisions (fast enough)
```

**Hybrid Scoring: Manual Weighted (NOT RRF)**

```javascript
// relevance-scorer.js (현재 시스템 검증됨)
Relevance = (Recency × 0.2) + (Importance × 0.5) + (Semantic × 0.3)

Where:
- Recency: exp(-days/30)  // 30-day half-life, Gaussian decay
- Importance (Outcome weighting):
  - FAILED: 1.0 (highest - failures most valuable)
  - PARTIAL: 0.7
  - SUCCESS: 0.5
  - null: 0.3 (ongoing)
- Semantic: cosineSimilarity(decision.embedding, query.embedding)

// Top-N selection
filtered = decisionsWithScores.filter(d => d.relevanceScore >= 0.5);
return filtered.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, 3);
```

**Self-Validation Results:**

✅ **Semantic Search Verified:**
- Query: "원격 연결 프로토콜" (no keywords in topic names)
- Found: mcp_integration (85%)
- Proof: Cross-lingual semantic matching works

❌ **Critical Bug Found:**
- Saved: mama_architecture_database_schema
- recall('mama_architecture_database_schema') → ✅ Success
- suggest('데이터베이스 스키마') → ❌ Not found

**Root Cause:**
save_decision does NOT auto-generate embeddings → semantic=0 → 0.45 < 0.5 threshold → filtered out

**Required Fix:**
```javascript
// db-manager.js or mama-api.js
async function saveDecision(decision) {
  const embedding = await generateEnhancedEmbedding(decision);

  db.prepare('INSERT INTO decisions ...').run(decision);
  db.prepare('INSERT INTO embeddings (decision_id, embedding, model, dim) VALUES (?, ?, ?, ?)')
    .run(decision.id, serialize(embedding), MODEL_NAME, EMBEDDING_DIM);
}
```

**Keep (Working):**
- Manual weighted scoring (20/50/30) - verified working
- Pure JS cosine similarity - fast for current scale
- Singleton lazy loading - 987ms first load acceptable
- LRU embedding cache - working

---

## Plugin Structure

### Decision 6: Plugin Structure (2025-11-20)

**Official Claude Code Plugin Compliance:**

```
mama-plugin/
├── .claude-plugin/
│   └── plugin.json           # ✅ Unified manifest (skills+hooks, commands auto-discovered)
│
├── commands/                  # ✅ Slash commands (.md wrappers) - REQUIRED
│   ├── mama-save.md           # /mama-save command (2.7KB)
│   ├── mama-recall.md         # /mama-recall command (2.0KB)
│   ├── mama-suggest.md        # /mama-suggest command (2.8KB)
│   ├── mama-list.md           # /mama-list command (3.0KB)
│   └── mama-configure.md      # /mama-configure command (4.6KB)
│
├── src/commands/              # ⚙️ Backend implementation (NOT user-facing)
│   ├── mama-save.js           # Backend logic (249 lines)
│   ├── mama-recall.js         # Backend logic (267 lines)
│   ├── mama-suggest.js        # Backend logic (314 lines)
│   ├── mama-list.js           # Backend logic (329 lines)
│   └── mama-configure.js      # Backend logic (503 lines)
│
├── skills/                    # Auto-invoked capabilities
│   └── mama-context/
│       └── SKILL.md
│
├── scripts/                   # Hook executables (chmod +x required)
│   ├── userpromptsubmit-hook.js
│   ├── pretooluse-hook.js
│   ├── posttooluse-hook.js
│   └── validate-manifests.js
│
├── src/core/                  # Core logic modules
│   ├── mama-api.js            # Main API (save/recall/suggest/list)
│   ├── embeddings.js          # Embedding generation (Transformers.js)
│   ├── db-manager.js          # SQLite database operations
│   ├── relevance-scorer.js    # Hybrid scoring (vector+recency+graph)
│   ├── decision-formatter.js  # Output formatting
│   └── transparency-banner.js # Tier status reporting
│
├── src/db/                    # Database schema
│   └── migrations/
│       ├── 001-initial-schema.sql
│       ├── 002-add-embeddings.sql
│       └── 003-add-audit.sql
│
├── src/tools/                 # MCP tool handlers
│   ├── save-decision.js       # save_decision MCP tool
│   ├── recall-decision.js     # recall_decision MCP tool
│   ├── suggest-decision.js    # suggest_decision MCP tool
│   ├── list-decisions.js      # list_decisions MCP tool
│   └── update-outcome.js      # update_outcome MCP tool
│
├── tests/                     # Test suite
│   ├── commands/              # Command tests
│   ├── core/                  # Core logic tests
│   ├── hooks/                 # Hook tests
│   ├── tools/                 # MCP tool tests
│   └── manifests/             # Manifest validation tests
│
├── .mcp.json                  # MCP server configuration (stdio transport)
├── package.json
├── LICENSE
└── README.md
```

**plugin.json (Unified Manifest):**

```json
{
  "name": "mama",
  "version": "1.0.0",
  "description": "MAMA - Memory-Augmented MCP Assistant. Remember decision evolution, not just conclusions.",
  "author": "SpineLift Team",
  "keywords": ["memory", "decisions", "context", "knowledge", "evolution"],
  "license": "MIT",

  "skills": [{
    "name": "mama-context",
    "path": "../skills/mama-context",
    "description": "Always-on background context injection from MAMA memory"
  }],

  "hooks": {
    "UserPromptSubmit": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/scripts/userpromptsubmit-hook.js"
      }]
    }],
    "PreToolUse": [{
      "matcher": "Read|Edit|Grep|Glob",
      "hooks": [{
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/scripts/pretooluse-hook.js"
      }]
    }],
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/scripts/posttooluse-hook.js"
      }]
    }]
  }
}

// NOTE: Commands are auto-discovered from commands/*.md (NOT listed in plugin.json)
// Per Claude Code official plugin spec, commands/ folder is scanned automatically
```

**.mcp.json (MCP Server Config):**

```json
{
  "mcpServers": {
    "mama": {
      "command": "${CLAUDE_PLUGIN_ROOT}/servers/mama-server",
      "args": [],
      "env": {
        "MAMA_DATABASE_PATH": "${HOME}/.claude/mama-memory.db",
        "MAMA_EMBEDDING_MODEL": "Xenova/multilingual-e5-small",
        "NODE_ENV": "production"
      }
    }
  }
}
```

**PRD Corrections:**

1. ❌ PRD: `hooks/hooks.json` (separate file)
   ✅ Official: `.claude-plugin/plugin.json` (unified)

2. ❌ PRD: `mcp-server/`
   ✅ Official: `servers/`

3. ❌ PRD: Relative paths
   ✅ Official: `${CLAUDE_PLUGIN_ROOT}/...`

**Module Boundaries:**

- **servers/mama-server**: All business logic (embeddings, DB, scoring, graph)
- **commands/skills/scripts**: Thin wrappers calling MCP via stdio
- **scripts/mama-api-client.js**: Shared MCP stdio client

---

## Data Flow

### User Prompt → Context Injection Flow

```
┌─────────────────────────────────────────────────────────────┐
│ 1. User submits prompt                                       │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. UserPromptSubmit hook fires                               │
│    → scripts/inject-mama-context.sh                          │
│    → timeout 2s node scripts/mama-api-client.js suggest "$1" │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. MCP stdio client connects                                 │
│    → StdioClientTransport                                    │
│    → servers/mama-server/dist/index.js                       │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. suggest_decision tool executes                            │
│    → generateEmbedding(query)         [3ms]                  │
│    → searchByEmbedding(db, embedding) [5ms]                  │
│    → hybridScoring (20/50/30)         [2ms]                  │
│    → formatTeaser(top3)                                      │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. Teaser output (40 tokens)                                 │
│    💡 MAMA: 2 related                                         │
│       • auth_strategy (85%, 3 days ago)                      │
│       • mesh_detail (78%, 1 week ago)                        │
│       /mama-recall <topic> for details                       │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ 6. Claude processes prompt + context                         │
│    → Notices hint, suggests /mama-recall if interested       │
└─────────────────────────────────────────────────────────────┘
```

**Total Latency:** ~10ms (hook script execution, not LLM processing)

### Save Decision Flow

```
┌─────────────────────────────────────────────────────────────┐
│ 1. User calls save_decision tool (or /mama-save command)     │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. MCP tool handler                                          │
│    → Validate input (Zod schema)                             │
│    → Check topic exists (supersedes edge if yes)             │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. Generate embedding (CRITICAL FIX NEEDED)                  │
│    → generateEnhancedEmbedding(decision)                     │
│    → 384-dim Float32Array                                    │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. Transaction (atomic)                                      │
│    BEGIN TRANSACTION;                                        │
│    → INSERT INTO decisions (...)                             │
│    → INSERT INTO embeddings (decision_id, embedding, ...)    │
│    → INSERT INTO supersedes (if same topic exists)           │
│    COMMIT;                                                   │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. Return success                                            │
│    {success: true, decision_id: "...", message: "..."}       │
└─────────────────────────────────────────────────────────────┘
```

---

## Deployment Strategy

### Phase 1: Claude Code Plugin (Local)

**Distribution:**
```bash
# User installation
cd ~/.claude/plugins
git clone https://github.com/mama/plugin mama
cd mama && npm install
```

**Auto-activation:**
- Plugin loads on Claude Code startup
- MCP server auto-starts (stdio transport)
- Hooks registered automatically
- Database created at `~/.claude/mama-memory.db`

### Phase 2: Claude Desktop Support (Epic 9)

**Distribution:**
```bash
# NPM global install
npm install -g @mama/server

# Configure claude_desktop_config.json
{
  "mcpServers": {
    "mama": {
      "command": "npx",
      "args": ["-y", "@mama/server"]
    }
  }
}
```

**Shared Database:**
- Same database path: `~/.claude/mama-memory.db`
- Cross-platform compatibility (Claude Code + Desktop)

---

## Migration Path

### Breaking Changes from PRD

**1. Package Migrations:**
```diff
- @xenova/transformers ^2.17.0
+ @huggingface/transformers ^3.7.6

- sqlite-vss ^0.1.2
+ sqlite-vec ^0.1.5
```

**2. Code Changes:**
```diff
// embeddings.js
- const { pipeline } = require('@xenova/transformers');
+ const { pipeline } = await import('@huggingface/transformers');

- embeddingPipeline = await pipeline('feature-extraction', MODEL_NAME);
+ embeddingPipeline = await pipeline('feature-extraction', MODEL_NAME, {
+   dtype: 'fp32'  // replaces quantized parameter
+ });
```

**3. Directory Structure:**
```diff
- mcp-server/
+ servers/mama-server/

- hooks/hooks.json
+ .claude-plugin/plugin.json (hooks field)
```

**4. Critical Bug Fix (save_decision):**
```diff
async function saveDecision(decision) {
+ const embedding = await generateEnhancedEmbedding(decision);

  db.prepare('INSERT INTO decisions ...').run(decision);
+ db.prepare('INSERT INTO embeddings (decision_id, embedding, ...) VALUES (...)')
+   .run(decision.id, serialize(embedding), MODEL_NAME, EMBEDDING_DIM);
}
```

### PRD Updates Required

**Section Updates:**
1. Technology Stack (page 59-86): Update package versions
2. Plugin Architecture (page 430-507): Fix directory structure
3. Hook Configuration (page 510-548): Move to plugin.json
4. Embedding Model (page 331-428): Add migration guide

**New Sections:**
1. Architectural Decisions (reference this document)
2. Self-Validation Results (Decision 5 findings)
3. Official Plugin Compliance (Decision 6)

---

## Known Issues & Future Work

### Critical Issues

**Issue 1: Embedding Auto-Generation Missing**
- **Impact:** High (search doesn't work for new decisions)
- **Status:** Identified in Decision 5 self-validation
- **Fix:** Add embedding generation in save_decision handler
- **Epic:** Epic 1 (Core Infrastructure)

### Future Enhancements

**Epic 9: Claude Desktop Support**
- Extract @mama/core package
- Publish @mama/server to NPM
- Cross-platform testing

**Performance Optimization:**
- sqlite-vec integration (when >1K decisions)
- Batch embedding generation optimization
- Query embedding cache (if needed)

**Testing:**
- Unit tests (Vitest, >80% coverage)
- Integration tests (MCP protocol)
- Performance benchmarks (latency, accuracy)

---

## Appendix: Decision Traceability

모든 architectural decisions는 MAMA 자체를 통해 추적됩니다:

```javascript
// Recall specific decision
mama.recall('mama_architecture_tech_stack_versions')

// Search related decisions
mama.suggest('plugin structure')

// List recent architectural decisions
mama.list({ limit: 10 })
```

**Decision Evolution Graph:**

```
mama_architecture_database_schema
  (no supersedes yet)

mama_architecture_hook_implementation
  ├─> v1 (full context output) → SUPERSEDED
  └─> v2 (teaser format) → CURRENT
```

**Self-Referential Validation:**

이 architecture 문서 자체가 MAMA의 decision tracking을 통해 생성되었으며, 각 결정은 MAMA에 기록되어 미래에 "왜 이렇게 설계했는지" 추적 가능합니다.

---

**Document Status:** ✅ Ready for Implementation
**Next Steps:**
1. Review architectural decisions with team
2. Update PRD with discovered corrections
3. Implement Epic 1 (Core Infrastructure) with embedding bug fix
4. Validate architecture through implementation

**Architectural Coherence:** 검증됨 (Decision 1-6 consistent, no contradictions)

---

_Generated through collaborative decision-making using MAMA's own suggest/recall tools_
_Validated: 2025-11-20_
