# MCP SERVER PACKAGE

**Package:** `@jungjaehoon/mama-server` v1.7.2  
**Purpose:** MCP transport layer for Claude Desktop/Code  
**Entry:** `src/server.js` (bin: `mama-server`)

---

## OVERVIEW

Stdio-based MCP server exposing 4 core tools (save/search/update/load_checkpoint). All business logic delegated to `@jungjaehoon/mama-core`. This package is a thin protocol adapter—no embeddings, no database logic, just MCP tool definitions and stdio transport.

**Architecture:** Server class wraps mama-core API → MCP SDK → stdio transport

---

## STRUCTURE

```
src/
├── server.js                    # Entry point (MAMAServer class, stdio transport)
├── tools/                       # MCP tool handlers (10 files)
│   ├── checkpoint-tools.js      # load_checkpoint handler
│   ├── save-decision.js         # save (decision) handler
│   ├── search-narrative.js      # search handler
│   ├── update-outcome.js        # update handler
│   ├── suggest-decision.js      # suggest (semantic search)
│   ├── recall-decision.js       # recall (by topic)
│   ├── list-decisions.js        # list (recent)
│   ├── link-tools.js            # link management
│   └── quality-metrics-tools.js # quality scoring
├── mama/                        # Support modules (6 files)
│   ├── hook-metrics.js          # Hook execution timing
│   ├── search-engine.js         # Search orchestration
│   ├── transparency-banner.js   # User-facing output formatting
│   ├── response-formatter.js    # MCP response formatting
│   ├── link-expander.js         # Decision graph link expansion
│   └── restart-metrics.js       # Session restart tracking
└── db/migrations/               # SQLite schema migrations (inherited from mama-core)
```

---

## MCP TOOLS (4 CORE)

| Tool              | Handler              | Description                              |
| ----------------- | -------------------- | ---------------------------------------- |
| `save`            | `handleSave()`       | Unified save (decision or checkpoint)    |
| `search`          | `handleSearch()`     | Semantic search or list recent           |
| `update`          | `handleUpdate()`     | Update decision outcome (success/failed) |
| `load_checkpoint` | `loadCheckpointTool` | Resume previous session                  |

**Additional tools (legacy):** suggest-decision, recall-decision, list-decisions, link-tools, quality-metrics-tools (all delegate to mama-core)

---

## PROTOCOL

**Transport:** stdio (standard MCP pattern)  
**Format:** JSON-RPC 2.0  
**Handlers:** `ListToolsRequestSchema`, `CallToolRequestSchema`  
**No HTTP:** MCP uses stdin/stdout only (HTTP embedding server runs separately on port 3847)

---

## DEPENDENCIES

**Critical:** All functionality imported from `@jungjaehoon/mama-core`:

- `mama-api.js` — High-level API (save/search/update/checkpoint)
- `db-manager.js` — Database initialization
- `embeddings.js` — Embedding generation
- `memory-store.js` — Vector search
- `embedding-server.js` — HTTP embedding API (port 3847)

**MCP SDK:** `@modelcontextprotocol/sdk` v1.0.1

---

## NOTES

- **No business logic here:** All save/search/update logic in mama-core
- **Hook metrics:** `mama/hook-metrics.js` tracks PreToolUse/PostToolUse timing (Claude Code plugin only)
- **HTTP server:** Embedding server runs on port 3847 (shared across all MCP clients)
- **Database:** `~/.claude/mama-memory.db` (configurable via `MAMA_DB_PATH`)
- **Node.js:** >= 18.0.0 required
