# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
