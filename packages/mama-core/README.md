# mama-core

The shared engine for storage, records and revisions, evidence links, memory, search and native
runtime drivers. Consumers supply their own database, principals, source access and product
vocabulary through public exports. Core does not require the MAMA OS daemon.

Version **4.1.1**; Node.js 22.13+. This README describes the current rebuild checkout.
See [architecture](../../docs/explanation/architecture.md) and
[the shared-engine goal](../../INTENT.md).

## Public API

[package.json](package.json) defines supported import paths; [src/index.ts](src/index.ts)
defines root exports. Representative root exports:

| Area      | Root exports                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------- |
| Storage   | `createAdapter`, `SQLiteAdapter`, `initDB`, `getDB`, `getAdapter`, `closeDB`                      |
| Records   | `createKnowledge`, `appendJudgment`, `ingestSource`                                               |
| Memory    | `mama`, `createMamaApi`, `saveMemory`, `recallMemory`, `ingestConversation`, `MEMORY_KINDS`       |
| Search    | `generateEmbedding`, `generateEnhancedEmbedding`, `cosineSimilarity`, `EmbeddingCache`            |
| Evidence  | `getMemoryProvenance`, `resolveMemoryProvenance`, `insertTwinEdge`, `listVisibleTwinEdgesForRefs` |
| Execution | `createCatalog`, `createDispatcher`, `createClient`, `startRuntime`, `createActionIpcServer`      |
| Traces    | `beginModelRun`, `commitModelRun`, `appendToolTrace`, `listToolTracesForRun`                      |

Every public subpath below is relative to `@jungjaehoon/mama-core`:

| Area                  | Export paths                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Root                  | `.`                                                                                                                                |
| Memory and storage    | `./embeddings`, `./memory/types`, `./db-manager`, `./mama-api`                                                                     |
| Helpers               | `./relevance-scorer`, `./debug-logger`, `./decision-formatter`, `./errors`, `./canonicalize`                                       |
| Evidence and records  | `./connectors`, `./connectors/event-index`, `./connectors/raw-query`, `./provenance/source-ref`, `./registry/store`, `./knowledge` |
| Actions               | `./operations/owner-action-effects`, `./action-contracts`, `./api/catalog`, `./api/dispatch`                                       |
| Transport and runtime | `./client/client`, `./client/ipc`, `./runtime/*`                                                                                   |

The two event-index paths export the same module. Runtime subpaths map to compiled JavaScript
and declarations under `dist/runtime/`. Source files without an export path are internal.

After installing the package, a minimal CommonJS example is:

```javascript
process.env.MAMA_DB_PATH = '/path/to/consumer/memory.db';
const { initDB, getDB, closeDB } = require('@jungjaehoon/mama-core');

async function main() {
  await initDB();
  getDB(); // The initialized SQLite connection.
  closeDB();
}
main().catch(console.error);
```

Set the path before initialization: the default `~/.claude/mama-memory.db` is real development
memory, not a test database. Adapter-based APIs accept consumer-owned storage; consult the
exported types for input contracts.

Embeddings use `Xenova/multilingual-e5-large` (1024 dimensions), computed locally.
Core selects `HF_HOME`, then `TRANSFORMERS_CACHE`, then the directory declared by the consumer;
otherwise Transformers uses its own default. MAMA's OS, MCP and plugin consumers declare
`~/.cache/huggingface/transformers`. Other consumers can call `declareEmbeddingCacheDir()`
from `./embeddings` before the first embedding. Initial use can download model assets.

## Directory layout and migrations

```text
src/
  index.ts                  root exports
  db-manager.ts, mama-api.ts database and development-memory facade
  api/, client/             catalog, dispatch and transports
  db-adapter/, storage/     SQLite adapters and storage support
  embedding/                embeddings and model cache
  identity/, registry/      principals and record identity
  knowledge/, memory/       records, revisions, evidence, recall
  operations/, provenance/  effect contracts and source references
  runtime/                  sessions, mailbox, drivers, runs and traces
db/migrations/              numbered SQLite migrations
scripts/                    build support
tests/                      package tests
```

The highest migration is **096**, `096-drop-connector-event-index-fts.sql`.
Migration files cover **001–042** and **061–096**; there is no 043 file.
**044–060 are reserved** by the retired chain's `schema_version` entries and must never be
reused. Add schema changes after 096, not into a gap. See [migrations](db/migrations).

## Development

Build with `pnpm install` and `pnpm build` at the repository root.
Run `pnpm typecheck` or `pnpm test` inside this package; use a temporary home and explicit
database path as described in [testing](../../docs/development/testing.md).
The packed second-consumer check is tracked in [the rebuild plan](../../docs/rebuild/plan.md);
package tests alone do not establish that goal.

[Documentation](../../docs/index.md) · [MIT](../../LICENSE).
