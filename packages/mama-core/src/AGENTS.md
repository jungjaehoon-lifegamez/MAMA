# MAMA CORE KNOWLEDGE BASE

**Package:** `@jungjaehoon/mama-core`  
**Language:** JavaScript (pure .js, no TypeScript)  
**Role:** Shared foundation for all MAMA packages (MCP server, Claude plugin, standalone agent)

---

## OVERVIEW

32 modules providing embeddings, database, memory storage, and decision tracking. All packages depend on this core. Pure JavaScript for maximum compatibility.

---

## KEY MODULES

| Module                  | Lines | Purpose                                     | Notes                                   |
| ----------------------- | ----- | ------------------------------------------- | --------------------------------------- |
| `mama-api.js`           | 2,615 | High-level memory API (save/search/update)  | **SPLIT CANDIDATE** (CC=175, too large) |
| `embeddings.js`         | 450   | HTTP client + Transformers.js fallback      | Connects to localhost:3847 server       |
| `db-manager.js`         | 380   | SQLite + sqlite-vec initialization          | Handles migrations, tier degradation    |
| `memory-store.js`       | 520   | CRUD + vector search for decisions          | Tier 1: vector, Tier 2: exact match     |
| `decision-tracker.js`   | 410   | Graph management (builds_on, debates, etc.) | Tracks decision evolution chains        |
| `relevance-scorer.js`   | 290   | Scoring algorithm for search results        | Combines similarity + recency + graph   |
| `checkpoint-manager.js` | 340   | Session state persistence                   | Stores summary, next_steps, open_files  |

---

## SUBDIRECTORIES

```
src/
├── db-adapter/          # Adapter pattern for SQLite (PostgreSQL class exists but unused)
├── embedding-server/    # HTTP server on port 3847 (shared across all clients)
├── db/migrations/       # SQLite schema migrations (versioned)
└── mama/                # Legacy namespace (hook metrics, utilities)
```

---

## HTTP EMBEDDING SERVER ARCHITECTURE

```
127.0.0.1:3847 (configurable via MAMA_EMBEDDING_PORT)
- Model stays loaded in memory (Xenova/all-MiniLM-L6-v2)
- ~50ms embedding requests (vs 2-9s cold start)
- Shared by Claude Code, Desktop, Cursor, Aider, etc.
- Port discovery via ~/.mama-embedding-port
- Fallback: Local Transformers.js if server unavailable
```

**Why:** Enables fast hook execution (<1200ms target for UserPromptSubmit).

---

## TIER SYSTEM (AUTOMATIC DEGRADATION)

- **Tier 1:** Vector search + Graph + Recency (80% accuracy) — Requires sqlite-vec extension
- **Tier 2:** Exact match only (40% accuracy) — Automatic fallback when sqlite-vec fails
- **Tier 3:** Skip embeddings entirely — Testing mode (`MAMA_FORCE_TIER_3=true`)

Tier degradation happens at runtime (not user-configurable). Check `db-manager.js` for logic.

---

## REFACTORING NEEDED

**mama-api.js (2,615 lines, CC=175):**

- Split into: `save-api.js`, `recall-api.js`, `suggest-api.js`, `update-api.js`, `checkpoint-api.js`
- See `docs/development/refactoring-roadmap.md` for plan
- **CRITICAL:** All packages depend on this file; changes require coordination

---

## CONVENTIONS

- **Language:** Pure JavaScript (no TypeScript, no build step)
- **Entry Point:** `src/index.js` (exports all public APIs)
- **Error Handling:** Throw explicit errors (no silent fallbacks)
- **Database:** SQLite only (PostgreSQL adapter exists but incomplete)
- **Embeddings:** 384-dimensional vectors (Xenova/all-MiniLM-L6-v2) — **NEVER change model**

---

## RELATED DOCS

- [Developer Playbook](../../docs/development/developer-playbook.md) — Architecture
- [Refactoring Roadmap](../../docs/development/refactoring-roadmap.md) — mama-api.js split plan
- [Testing Guide](../../docs/development/testing.md) — Test suite details
