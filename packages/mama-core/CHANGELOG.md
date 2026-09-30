# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `appendLink` (`Knowledge.appendLink`): one edge appended between records that already exist,
  with a required reason and optional evidence, and no new record or revision. The row is its own
  receipt; a retried command id returns the same edge and a different payload under it is a
  conflict. A link to an edge takes `contradicts` and corrects it; graph pages return
  `corrected_by` on the corrected edge and, on every edge, the `evidence_refs` the reader can see
  (as do `getGraphNeighborhood`, `getGraphPaths` and `getGraphTimeline`).
- `mama.save` takes `links [{id, relation, reason}]` and `replaces [{id, reason}]`;
  `mama.link` links after saving; `mama.getDecision` reads one decision with every edge in and
  out, each with its reason and writer.
- An amendment keeps the values it replaced in its record's payload (`replacedValues`).

### Changed

- Search expansion (`suggest`, `memory.search`, recall's related records) follows only the edges
  an agent stated: links between memories and legacy rows parsed from an agent's reasoning. The
  host's similarity rows and revision chain are no longer followed. A record reached through a link
  says so in the default results: `graph_source` (relation), `related_to` (the hit it came from),
  `edge_reason`, and `edge_corrected_by` when a later link contradicts it and the reader may see
  the record that states the correction. Expanded rows rank below every direct hit and are cut at
  the usual limits, so each direct hit also lists the records its links reach in both directions,
  including another hit (`links`: id, topic, summary, status when not active, relation, reason,
  corrected_by). A hit that is one revision of a work item says which (`work_item`: commitment_id,
  revision, head_revision): an earlier revision can rank above the head that corrected it. Expansion errors are raised instead of logged and
  skipped. `STATED_DECISION_EDGES` is exported for readers of the same edges.
- `queryDecisionGraph` no longer attaches an `edges` list to each decision (nothing read it);
  `DecisionEdgeRow` is removed.

- **Breaking:** the host writes no edge the agent did not state. A work revision or withdrawal no
  longer links to the previous revision (added in 4.1.0); the revision order is in the
  commitment's assignments. Migration 099 now only stamps its version.
- The save hint no longer asks for "builds_on: id" in the reasoning, which nothing parses.
- `memory.read:graph` view `graph` returns links between memories from `twin_edges` beside the
  `decision_edges` rows written before links moved there.

### Removed

- **Breaking:** `evolveMemory`, `promoteMemoryStatus` and the evolution rules that linked memories
  by topic overlap or vector similarity; the public `insertTwinEdge`; the decision-edge mutators
  (`upsertDecisionEdge`, `proposeDecisionEdge`, `approveDecisionEdge`, `rejectDecisionEdge`,
  `deprecateAutoDecisionEdges`, `deleteDecisionEdgesWithAudit`); the legacy `relationships` save
  path and the `decisionEdges`/`supersedeTargets` projections; `memory.read:graph` view
  `similarity`.

## [4.1.0] - 2026-09-29

### Added

- Every work revision links to the revision it follows; migration 099 links revisions already
  stored.
- `reviseWork` and `withdrawWork` take `topic` as optional; without it a revision keeps the item's
  topic.
- The Claude driver passes `--effort` to Opus 4.7 and 4.8 and keeps `max` and `xhigh` on the models
  that support them.

## [4.0.0] - 2026-09-27

### Added

- Recall takes one memory kind or a non-empty list; native tool calls are traced; backend
  processes accept a consumer-supplied environment; migration 096 drops an unused full-text index.

### Removed

Breaking. The unified-core refactor removed published surface that no in-repo caller
uses. Callers outside this repository must move before upgrading.

- Subpaths `./memory-store`, `./outcome-tracker` and `./query-intent`. `./memory-store`
  held no implementation - twelve lines of `export const X = dbManager.X`, a duplicate
  `DatabaseAdapter` declaration, and four display constants nothing imported, one of
  which named a different database than the adapter it shadowed. Import
  `./db-manager` directly.
- `db-manager`: `vectorSearch`, `queryDecisionGraph`, `querySemanticEdges`, `fts5Search`
  and `ensureMemoryScope`. The four queries now live in `./knowledge` and take the
  adapter they read through as their first argument; `ensureMemoryScope` is replaced by
  `ensureMemoryScopeInAdapter`, which db-manager already exported. The package root no
  longer re-exports the four queries.
- `db-manager`: `queryVectorSearch` and `getPreparedStmt`, which had no callers.
  `getPreparedStmt` returned a silently non-functional statement when preparation
  failed.
- `registry/record-identity`: `setRecordIdentity`. Record identity is written only
  inside the transaction that appends the record it belongs to.

### Changed

- Breaking. `vectorSearch` and `fts5Search` no longer answer a failed read with an
  empty array. An empty result now means the corpus held no match, and a database or
  adapter failure reaches the caller. `queryDecisionGraph` reports an unreadable
  `refined_from` by naming the decision instead of returning it with empty ancestry.

## [3.2.0] - 2026-09-13

### Added

- Immutable connector and owner observation versions with exact current references and durable raw
  projection replay.
- Atomic scoped identity correction history and separate current graph identity projections.
- Observation references on raw, context, case timeline, and graph timeline results.

## [3.1.0] - 2026-09-13

### Added

- Registry node, alias, record-item, and record-actor storage with conservative normalization.
- Atomic record identity on the canonical save transaction.
- Operation-backed tool traces and shared owner-action effect policy/types/storage port.

## [3.0.0] - 2026-09-12

### Removed

- Removed the HTTP embedding client, server, mobile session runtime, and their public exports.
- Removed the direct `ws` runtime and type dependencies.

### Kept

- In-process embedding generation, caching, model configuration, dimensions, and vector search.

## [2.5.0] - 2026-09-12

### Added

- Public source archive and SQLite storage exports, including revision-preserving raw evidence
  persistence for reusable package consumers.

## [2.3.0] - 2026-09-04

- Migration 066: `awareness_operational_issues` (the installed shape plus `occurrences`) so the
  standalone runtime records its own failures as evidence (One MAMA Phase 3). Version numbers
  between 1.9.0 and 2.3.0 shipped through the root CHANGELOG.

## [1.9.0] - 2026-07-18

- `buildDecisionId` exported; Korean/non-ASCII topics now produce stable
  hashed slugs (`decision_t<hash>_...`) instead of bare underscore runs;
  existing decision ids are untouched.

## [1.8.1] - 2026-07-12

### Fixed

- **vectorSearch superseded pre-filter** — Superseded history rows are filtered out of the
  vector top-K before ranking, so current-truth results are no longer crowded out by their own
  replaced versions; the adapter status cache stays in sync on status transitions

## [1.8.0] - 2026-07-03

### Added

- **e5 query prefix scheme** — Search queries are embedded with the multilingual-e5 `query:`
  prefix (documents keep `passage:`), fixing the anisotropy that made all-pairs similarity
  cluster near 0.94; an embedding prefix-scheme guard plus migration 042 detect and mark legacy
  vector stores
- **Re-embed migration script** — CLI backfill re-embeds legacy vectors under the prefix scheme;
  refuses to run without an explicit `MAMA_DB_PATH` and fails loud on empty wiki page text
- **Embedding role threading** — The HTTP embedding server and client carry the query/passage
  role end to end

## [1.7.0] - 2026-05-04

### Added

- **Context Compile V0**: Added append-only `context_packets`, deterministic source readers,
  visibility policy, budget manifests, source ref normalization, and the
  `@jungjaehoon/mama-core/context-compile` package export

### Fixed

- **Context source trust boundaries**: Raw refs now canonicalize source metadata, memory/raw/graph
  readers reject invalid time filters early, missing schema paths fail explicitly, and exhausted
  read budgets report skipped operators instead of silently omitting work
- **Source reader consistency**: `readGraphCandidates` fails closed when `connectors` is an
  explicit empty array (mirroring the existing scope/project-window guards), both
  `readRawCandidates` and `readGraphCandidates` now run `normalizeTimeFilters` for parity with
  `readMemoryCandidates`, and `contextRefFromTwinRef` filters whitespace-only `source_id`
  values
- **Global scope id migration**: Memory and raw context readers now match legacy
  `('global', 'global')` bindings alongside the canonical `('global', 'system')` sentinel so
  records written before the alignment remain visible through `context_compile`

## [1.6.0] - 2026-05-01

### Added

- **Memory provenance substrate**: Added provenance columns, trusted provenance normalization,
  scoped provenance reads, backfill helpers, and audit coverage for source refs and scope bindings
- **Model run and tool trace stores**: Added adapter-scoped model run persistence, tool trace
  persistence, replay compatibility helpers, duplicate insert protection, and lifecycle tests
- **Twin edge ledger**: Added first-class twin edge storage, ref validation, visibility filtering,
  and graph provenance tests across memory/raw/entity/case references
- **Unified raw query APIs**: Added raw connector query helpers and provenance-aware raw index
  plumbing so raw evidence can be retrieved as a first-class context source
- **Agent situation packets**: Added the core packet builder, append-only packet store, ranking
  policy, cache key, singleflight behavior, and source readers for worker-ready situation context
- **Agent graph/entity APIs**: Added graph query, entity resolution, alias write, and visibility
  helpers used by worker graph/entity surfaces
- **Search quality options**: Added reusable strict search normalization for `threshold`,
  `strictness`, `disableRecency`, `includeRelated`, `topicPrefix`, `minLexicalSupport`, and
  diagnostics
- **Retrieval diagnostics**: `recallMemory()` and `mama.suggest()` can now return per-hit
  confirmation metadata plus candidate counts for vector, lexical, entity, graph-expanded,
  vector-only, and strictness-rejected candidates

### Changed

- **Memory writes are provenance-aware**: Trusted runtime provenance is compacted into
  `provenance_json` and `source_refs_json`, while public caller-supplied provenance stays outside
  the trusted path
- **Migration chain extended**: Migrations now cover memory provenance, model/tool traces,
  connector scope columns, twin edges, and agent situation packets
- **memory_v2 recall filtering**: Balanced and strict search modes now require lexical, entity,
  raw-id, or seed confirmation instead of accepting metadata-only signals such as scope support or
  graph position
- **Search rollup provenance**: Rolled-up results preserve primary and contributing-leaf retrieval
  diagnostics so downstream callers can audit why a case result matched

### Fixed

- **Replay and visibility hardening**: Model-run replay lifecycle, canonical replay refs, duplicate
  insert races, situation packet visibility, graph provenance visibility, and alias replay behavior
  now have regression coverage
- **Strict fallback bypass**: `mama.suggest()` no longer falls back to unfiltered legacy search when
  a strict or balanced memory_v2 search returns no confirmed rows
- **Wiki vector strictness**: Wiki vector hits now receive the same strictness and diagnostics
  treatment as decision hits

## [1.1.5] - 2026-02-22

### Added

- **`SemanticEdgeItem` interface**: Typed decision graph edges — `from_id`, `to_id`, `topic`, `decision`, `confidence`, `created_at`, `reason`
- **`DecisionEdgeRow` interface**: Typed `decision_edges` table rows for `DecisionRecord.edges`
- **`ConversationMessage` interface**: Typed checkpoint conversation history
- **`RecallGraphResult` interface**: Typed return for `recall()` function
- **`RecallEdgeRef` interface**: Typed edge references in recall results

### Changed

- **`SemanticEdges`**: All arrays changed from `unknown[]` to `SemanticEdgeItem[]`
- **`DecisionRecord.edges`**: Changed from `unknown[]` to `DecisionEdgeRow[]`
- **`CheckpointRow.recent_conversation`**: Changed from `unknown[]` to `ConversationMessage[]`
- **`recall()` return type**: Changed from `Promise<unknown>` to `Promise<string | RecallGraphResult>`
- **`querySemanticEdges` results**: Cast as `SemanticEdgeItem[]` instead of `{ relationship: string }[]`

### Fixed

- **vectorSearch feature detection**: `getPreparedStmt('vectorSearch')` passed non-SQL string to SQLite, causing syntax error warnings on every search. Replaced with `getAdapter().vectorSearchEnabled`
- **eslint-disable-next-line misplacement**: `addEdge` `any` suppression was on wrong line

### Removed

- **`RawSemanticEdge` interface**: Replaced by `SemanticEdgeItem` from `db-manager.ts`
- **`as unknown as` casts**: Removed in `querySemanticEdges` usage

## [1.0.0] - 2026-02-01

### Added

#### Core Modules

- **mama-api.js** - High-level API interface for MAMA operations
- **memory-store.js** - Decision CRUD operations with SQLite + sqlite-vec
- **db-manager.js** - Database initialization and migration management
- **embeddings.js** - Transformers.js embedding generation (Xenova/multilingual-e5-large)

#### Embedding Infrastructure

- **embedding-server** - HTTP server for embedding requests (port 3847)
- **embedding-client.js** - Client for embedding server communication
- **embedding-cache.js** - LRU cache for embedding vectors

#### Decision Graph

- **decision-tracker.js** - Decision evolution tracking with edge types
- **relevance-scorer.js** - Semantic similarity scoring
- **decision-formatter.js** - Decision output formatting

#### Utilities

- **config-loader.js** - Plugin configuration loading
- **debug-logger.js** - Debug logging utilities
- **memory-inject.js** - Context injection helpers

### Technical Details

- Pure JavaScript (no TypeScript compilation required)
- SQLite + sqlite-vec for vector operations
- 1024-dimensional embeddings (cross-lingual: English + Korean)
- All dependencies bundled for standalone operation
