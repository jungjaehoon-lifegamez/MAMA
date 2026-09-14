# MAMA CORE KNOWLEDGE BASE

**Package:** `@jungjaehoon/mama-core`  
**Language:** JavaScript (pure .js, no TypeScript)  
**Role:** Shared foundation for all MAMA packages (MCP server, Claude plugin, standalone agent)

---

## OVERVIEW

32 modules providing embeddings, database, memory storage, and decision tracking. All packages depend on this core. Pure JavaScript for maximum compatibility.

---

## KEY MODULES

| Module                  | Lines | Purpose                                           | Notes                                   |
| ----------------------- | ----- | ------------------------------------------------- | --------------------------------------- |
| `mama-api.js`           | 2,615 | High-level memory API (save/search/update)        | **SPLIT CANDIDATE** (CC=175, too large) |
| `embeddings.js`         | 450   | In-process Transformers.js embeddings             | Local model and cache                   |
| `db-manager.js`         | 380   | SQLite + pure-TS cosine similarity initialization | Handles migrations, tier degradation    |
| `decision-tracker.js`   | 410   | Graph management (builds_on, debates, etc.)       | Tracks decision evolution chains        |
| `relevance-scorer.js`   | 290   | Scoring algorithm for search results              | Combines similarity + recency + graph   |
| `checkpoint-manager.js` | 340   | Session state persistence                         | Stores summary, next_steps, open_files  |

---

## SUBDIRECTORIES

```
src/
├── db-adapter/          # Adapter pattern for SQLite (PostgreSQL class exists but unused)
├── db/migrations/       # SQLite schema migrations (versioned)
└── mama/                # Legacy namespace (hook metrics, utilities)
```

---

## EMBEDDING ARCHITECTURE

Embeddings run in process through `embeddings.ts` using
Xenova/multilingual-e5-large. There is no embedding HTTP listener or client fallback.

---

## EMBEDDINGS OFF-SWITCH (`MAMA_FORCE_TIER_3`)

Search is vector search (pure-TS cosine similarity) with FTS5 alongside it. Setting
`MAMA_FORCE_TIER_3=true` makes `assertEmbeddingsEnabled()` in `embeddings.ts` throw before the
model loads, so embedding work is skipped entirely - a test switch, not a degraded search mode.
Nothing degrades automatically; there is no exact-match path to fall back to.

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
- **Embeddings:** In-process 1024-dimensional vectors (Xenova/multilingual-e5-large, q8 default) — **dimension MUST stay 1024**

---

## RELATED DOCS

- [Developer Playbook](../../docs/development/developer-playbook.md) — Architecture
- [Refactoring Roadmap](../../docs/development/refactoring-roadmap.md) — mama-api.js split plan
- [Testing Guide](../../docs/development/testing.md) — Test suite details
