# Canonical Entity Ontology Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

---

## Quick Navigation

| Section                                    | Purpose                                                              | When to read                                                |
| ------------------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------- |
| Decisions Resolved (CEO review)            | 9 load-bearing product decisions locked before implementation        | Read once, skim-forward when tagged `[Decision N]` in tasks |
| Codex Outside-Voice Corrections            | 8 corrections grounded in actual repo code; supersedes some Eng recs | Read once, skim-forward when tagged `[CT*]` in tasks        |
| File Map                                   | Every file to create/modify/reuse                                    | Reference while executing each task                         |
| Chunk 1 Prerequisites                      | Environment verification + test-command cheatsheet                   | Read BEFORE starting any work                               |
| Chunk 1: Establish The Entity Substrate    | Types, errors, migrations 026/027, store, normalization              | Tasks 1-3, sequential                                       |
| Chunk 2: Candidate Generation + Resolution | Blocking, scoring, auto-merge rules                                  | Tasks 4-5, sequential after Chunk 1                         |
| Chunk 3: Observation Ingest + Projection   | Slack re-plumb + recall-bridge                                       | Tasks 6-7, serialize after Chunk 2                          |
| Chunk 4: Review Workflow + Minimal UI      | `/api/entities/candidates*` + viewer module                          | Tasks 8-9                                                   |
| Chunk 5: Benchmark + Audit Loop            | Fixtures, migration 028, audit metrics, audit queue + UI             | Tasks 10-11                                                 |
| Chunk 6: End-To-End Verification           | Smoke, observability, rollback, merge summary                        | Task 12                                                     |
| Definition Of Done                         | 10-point checklist; gate for branch completion                       | Read at end                                                 |
| GSTACK REVIEW REPORT                       | CEO + Eng + Codex + DX review log                                    | Reference only                                              |

## How to Read This Plan

**First pass (≤ 15 min):** Read the intro + both Goal + Architecture paragraphs, skim "Decisions Resolved" and "Codex Outside-Voice Corrections" once so the tagged cross-references (`[CT3]`, `[A2]`, etc.) in task bodies make sense. Skim the File Map. Do NOT try to memorize.

**Execution pass (sequential):** Start at **Chunk 1 Prerequisites**. Verify your environment in 60 seconds. Then jump straight to **Chunk 1 Task 1** and execute top-to-bottom. Each task is self-contained, so you can run its commands without cross-referencing other tasks. If a step references a decision (e.g., "scope_kind per [Decision 1]"), that's a forward pointer — you do not need to re-read the decision to execute the step.

**When you get stuck:** Check `docs/operations/entity-substrate-runbook.md` (created in Task 12 Step 5) for the error code you're seeing. Every `EntityError` carries a `doc_section` field that matches a runbook heading.

**Tag legend:** `[A#]` = Eng review architecture fix. `[Q#]` = Eng review code-quality fix. `[T#]` = Eng review test fix. `[P#]` = Eng review perf fix. `[CT#]` = Codex cross-model correction. `[Decision N]` = CEO review decision. `[DX#]` = DX review fix.

---

## Autonomous Execution Gate

This branch is intended to run end-to-end without unnecessary human interrupts, but not without guardrails.

### Continue without asking

Proceed automatically when all of the following are true:

- the work stays inside this plan's scope
- the current task only touches files already named in the File Map or an obviously adjacent test/helper file
- failures are local implementation failures (lint, type, tests, wiring, migration path mismatch, fixture drift)
- hard quality guardrails remain intact

### Auto-fix then continue

Do not stop for:

- formatter drift
- lint/type errors introduced by the branch
- wrong test command path
- migration ordering mistakes caught before commit
- stale doc references inside this plan/spec/review set
- review comment misunderstandings that can be resolved by checking the code or docs

### Stop and ask

Stop execution immediately when any of these happens:

- architecture changes would contradict a locked CEO/Codex decision
- a new requirement expands scope beyond the canonical entity substrate
- `false_merge_rate` exceeds the hard ceiling
- ontology constraints need to be weakened to make progress
- `shadow` / `off` mode safety regresses legacy recall behavior
- provenance completeness cannot be preserved on the selected raw path
- implementing the plan would require writing real operational/PII data into repo fixtures

### Hard go/no-go gates for this branch

The branch cannot be considered PR-ready unless all of these are true:

- `false_merge_rate <= 0.02` on the gold canonical identity fixture set
- no unexpected ontology violations remain
- legacy recall remains stable in `off` and `shadow` projection modes
- provenance completeness is preserved on the first real raw ingest path

### Soft improvement gates

These do not block implementation, but they do affect the audit classification:

- `cross_language_candidate_recall@10`
- `projection_fragmentation_rate`
- `review_queue_size`
- `median_review_age`
- `candidate_precision@k`

### Branch-completion classification

Use these labels in the final audit summary:

- `improved`
- `stable`
- `regressed`
- `inconclusive`

Implementation may continue after `stable` or `inconclusive` intermediate runs.

Implementation must stop for reassessment if a run is `regressed` on a hard gate.

---

**Goal:** Build an ontology-guided canonical entity substrate for MAMA that starts from raw evidence, produces multilingual entity observations and reviewable resolution candidates, and projects canonical entities back into current memory/truth/retrieval surfaces.

**Architecture:** Add a first-class entity layer under the existing topic-centric memory system rather than stretching `topic` logic any further. The implementation should be relational-first and provenance-backed: raw evidence remains immutable, entity observations and aliases feed conservative candidate generation, narrow structural cases can auto-merge, ambiguous Korean/English/Japanese candidates land in review, and current memory/truth APIs gradually consume canonical projections.

**Tech Stack:** TypeScript/JavaScript, SQLite migrations in `packages/mama-core/db/migrations`, `mama-core` memory APIs, standalone raw/history ingestion, Vitest, existing embedding pipeline.

---

## Decisions Resolved (CEO review 2026-04-12)

The following load-bearing decisions were pre-resolved by `/plan-ceo-review` (see `docs/superpowers/reviews/2026-04-12-canonical-entity-ontology-ceo-review.md`). Mode: **HOLD SCOPE**.

1. **Scope binding on entities.** `entity_nodes` carries `scope_kind` + `scope_id` columns (nullable for `global`). `entity_aliases` and `entity_observations` inherit via FK. Enforced in migration 026.
2. **Task 6 source.** The first real ingest path is **Slack** (`packages/standalone/src/connectors/slack/` + `standalone/src/memory/history-extractor.ts`). Chosen for highest multilingual density and an existing raw/history path. No ambiguity at implementation time.
3. **Shadow mode switch.** `MAMA_ENTITY_PROJECTION_MODE` config key with values `off | shadow | dual-write`. Default in v1: `shadow`. Projection writes happen; `memory/api.ts` reads fall back to legacy topic path unless `dual-write` is set. Flag read from env and hot-reloadable.
4. **Fixture PII policy.** All benchmark fixtures use **synthetic multilingual data only**. No copy-paste from real connector records. Enforced in Task 10.
5. **`false_merge_rate` v1 target.** First audit run establishes baseline **and** `false_merge_rate ≤ 0.02` on the gold canonical identity set is a hard ceiling. Enforced in Task 10/11.
6. **Error map before implementation.** Chunk 1 Task 1 adds `packages/mama-core/src/entities/errors.ts` with named exception classes. Every subsequent module test file must include **at least one failure-path test** per module.
7. **Observability as scope.** Task 12 requires logs + counters + 1-paragraph runbook as deliverables, not post-launch cleanup.
8. **Candidate-generator top-N gate.** Task 4 embeds only the **top-50 survivors of blocking**, never unblocked alias-pair fanout.
9. **Embedding model version tracking.** Migrations 026/027 add `extractor_version` and `embedding_model_version` columns on `entity_observations` and `entity_resolution_candidates`.

---

## Codex Outside-Voice Corrections (2026-04-12)

The Codex review (`docs/superpowers/reviews/2026-04-12-canonical-entity-ontology-codex-review.md`) read the actual repo and corrected assumptions in both prior reviews. The following corrections are now part of the plan and **supersede the relevant Eng review recommendations**.

1. **CT1 — No empty migration 028 stub.** Eng Q3 was wrong. The `node-sqlite-adapter` migration runner marks a migration applied immediately after executing it. An empty stub in Chunk 1 would permanently block the real 028 from ever running on any user DB that boots between chunks. Migration 028 is created **in full** in Chunk 5 Task 10 only. Chunk 1 reserves the number conceptually but commits no file.
2. **CT2 — No reuse of `audit-task-queue.ts`.** Eng P6 was wrong. That queue is a 30s-timeout synchronous memory-agent conversation queue (`MemoryAuditJob` / `MemoryAuditAckLike`), not a detached audit-run worker. Task 11 creates a purpose-built `packages/standalone/src/api/entity-audit-queue.ts` instead, persisting `entity_audit_runs.status` with the A3 partial unique index.
3. **CT3 — Projection bridge targets the wrong seam.** `recallMemory()` in `memory/api.ts` does not read `memory_truth`. Only `bootstrap-builder.ts` reads it. Task 7 is redesigned: projection output lives in the entity tables themselves; a new `packages/mama-core/src/entities/recall-bridge.ts` exposes `queryCanonicalEntities(query, scope)` which `memory/api.ts recallMemory()` calls as an **additional recall source** under `MAMA_ENTITY_PROJECTION_MODE=dual-write`. No writes to `memory_truth` from the entity substrate in v1.
4. **CT5 — Shadow mode is now invisible by construction.** Because CT3 removes `memory_truth` writes entirely, `buildMemoryBootstrap()`'s `queryRelevantTruth({query: ''})` no longer contaminates with canonical rows. Shadow mode writes go to entity tables only; recall stays legacy unless `dual-write` is set.
5. **CT6 — Task 6 is re-plumbing, not refactor.** The current Slack save path (`connector-init.ts:165`) drops `sourceId`, channel ID, message `ts`, and raw-store identity before calling `saveMemory`. Task 6 now explicitly owns re-plumbing the Slack raw→LLM→save chain so that `source_ref = (connector_name, raw_db_ref, raw_record_id, ts)` survives all the way to `entity_observations`. This is a larger sub-task than the initial plan suggested.
6. **CT7 — Raw evidence boundary.** Connector raw records live in per-connector `RawStore` SQLite DBs under `~/.mama/connectors/<name>/raw.db`, not in mama-core's DB. Cross-DB FK is impossible. Migration 026 adds `source_connector TEXT NOT NULL`, `source_raw_db_ref TEXT`, `source_raw_record_id TEXT NOT NULL` columns to `entity_observations`. These are soft-references; audit replay must reach out to the per-connector RawStore to fetch raw evidence. Documented as an intentional cross-DB boundary, not a bug.
7. **CT8 — Entity audit events stay in `entity_merge_actions`, not `memory_events`.** Eng A1 proposed dual-writing merges into `memory_events` with `kind='entity_merge'`. Codex caught that `MemoryEventRecord.event_type` does not allow that value and extending it requires a type change + CHECK-constraint migration + keying convention. For v1, operators stitch timelines by joining `entity_merge_actions` with `memory_events` on timestamp if needed. Eng A1 is deferred to a TODO.
8. **CT4 (no change) — Scope binding stays denormalized.** `entity_nodes` carries `scope_kind` + `scope_id` columns as originally decided by CEO Decision 1. Codex suggested a FK to `memory_scopes` but for v1 the denormalized form is simpler, explicit, and avoids a join on every candidate list. May revisit in v2.

---

## File Map

### Create

- `docs/superpowers/specs/2026-04-12-canonical-entity-benchmark-audit-design.md`
  Improvement-oriented benchmark and audit design for the entity layer.
- `packages/mama-core/src/entities/types.ts`
  Canonical entity, alias, observation, candidate, link, timeline, and merge-action types.
- `packages/mama-core/src/entities/errors.ts`
  Named exception classes for the entity substrate (`InvalidEntityLabelError`, `EmbeddingUnavailableError`, `OntologyViolationError`, `MergeTargetStaleError`, `EntityLabelMissingError`, `CandidateStaleError`, `AuditRunInProgressError`).
- `packages/mama-core/src/entities/merge-evidence.ts`
  TypeScript codec with runtime validation for the `evidence_json` blob on `entity_merge_actions`. Prevents schema drift (A5 fix).
- `packages/mama-core/src/entities/table-repo.ts`
  Tiny typed repository helper (~30 LOC) that curries `better-sqlite3` prepared statements by column list. Used by `store.ts` to avoid ~70% CRUD boilerplate across 7 tables (Q1 fix). NOT a full ORM.
- `packages/mama-core/src/entities/score-calculator.ts`
  Score calculation extracted from candidate-generator for independent tuning/testing (Q2 fix).
- `packages/mama-core/tests/entities/merge-evidence.test.ts`
  Codec round-trip and drift coverage.
- `packages/mama-core/tests/entities/table-repo.test.ts`
  Repository helper coverage.
- `packages/mama-core/tests/entities/score-calculator.test.ts`
  Score calculator coverage (NaN, ties, dim mismatch).
- `packages/mama-core/src/entities/normalization.ts`
  Deterministic normalization for multilingual labels and structured identifiers.
- `packages/mama-core/src/entities/store.ts`
  CRUD for entity tables, aliases, observations, candidates, links, timelines, and merge actions.
- `packages/mama-core/src/entities/candidate-generator.ts`
  Blocking, structural similarity, context similarity, and embedding-backed candidate ranking.
- `packages/mama-core/src/entities/resolution-engine.ts`
  Conservative auto-merge rules and review-needed decisions.
- `packages/mama-core/src/entities/projection.ts`
  Projection helpers that shape canonical entities into recall-friendly rows (consumed by `recall-bridge.ts`; does NOT write to `memory_truth`).
- `packages/mama-core/src/entities/recall-bridge.ts`
  `queryCanonicalEntities(query, scope)` — read path consumed by `memory/api.ts recallMemory()` under `dual-write` mode. Replaces the originally-planned `truth-store.ts` bridge.
- `packages/standalone/src/api/entity-audit-queue.ts`
  Purpose-built audit-run queue that persists state in `entity_audit_runs`. Does NOT reuse `packages/standalone/src/memory/audit-task-queue.ts`.
- `packages/mama-core/tests/entities/recall-bridge.test.ts`
  Recall-bridge coverage.
- `packages/standalone/tests/api/entity-audit-queue.test.ts`
  Audit-queue coverage (enqueue, concurrent rejection, status polling, restart recovery).
- `packages/mama-core/tests/entities/types.test.ts`
  Domain contract coverage.
- `packages/mama-core/tests/entities/normalization.test.ts`
  Label normalization coverage for Korean/English/Japanese inputs.
- `packages/mama-core/tests/entities/store.test.ts`
  Store and migration coverage.
- `packages/mama-core/tests/entities/candidate-generator.test.ts`
  Blocking and scoring coverage.
- `packages/mama-core/tests/entities/resolution-engine.test.ts`
  Auto-merge vs review-needed coverage.
- `packages/mama-core/tests/entities/projection.test.ts`
  Projection coverage into memory/truth records.
- `packages/mama-core/db/migrations/026-create-canonical-entity-tables.sql`
  Core ontology/entity tables.
- `packages/mama-core/db/migrations/027-create-entity-review-support.sql`
  Candidate, merge action, and review support tables/indexes.
- `packages/mama-core/db/migrations/028-create-entity-audit-tables.sql`
  Entity benchmark and audit run storage.
- `packages/standalone/src/api/entity-review-handler.ts`
  Minimal API helpers for candidate queue and review actions if `graph-api.ts` becomes too crowded.
- `packages/standalone/src/api/entity-audit-handler.ts`
  Minimal API helpers for benchmark/audit runs and audit report retrieval.
- `packages/standalone/public/viewer/src/modules/entity-review.ts`
  Minimal review queue/list/detail surface for v1.
- `packages/standalone/public/viewer/src/modules/entity-audit.ts`
  Minimal audit report surface for v1.
- `packages/standalone/tests/api/entity-review-handler.test.ts`
  API coverage.
- `packages/standalone/tests/api/entity-audit-handler.test.ts`
  Audit API coverage.
- `packages/standalone/tests/viewer/entity-review.test.ts`
  Viewer behavior coverage.
- `packages/standalone/tests/viewer/entity-audit.test.ts`
  Viewer audit behavior coverage.
- `packages/mama-core/tests/entities/fixtures/gold-canonical-identities.json`
  Curated gold canonical identity groups.
- `packages/mama-core/tests/entities/fixtures/cross-language-aliases.json`
  Korean/English/Japanese alias benchmark cases.
- `packages/mama-core/tests/entities/fixtures/perturbation-cases.json`
  Normalization and blocking stress cases.
- `packages/mama-core/tests/entities/fixtures/historical-replay-sample.json`
  Replay sample for baseline comparison.
- `packages/mama-core/tests/entities/audit-metrics.test.ts`
  Metric calculation and baseline classification coverage.

### Modify

- `packages/mama-core/src/index.ts`
  Export entity-layer modules.
- `packages/mama-core/src/db-manager.ts`
  Initialize and expose entity migrations/store helpers where needed.
- `packages/mama-core/src/memory/api.ts`
  Route selected recall/save flows through entity-aware projection instead of raw topic authority.
- `packages/mama-core/src/memory/types.ts`
  Add projection-facing types or references without overloading existing memory types.
- `packages/standalone/src/memory/history-extractor.ts`
  Emit entity observations from raw operational history instead of jumping straight to topic-centric memory assumptions.
- `packages/standalone/src/cli/runtime/connector-init.ts`
  Wire one real ingest path into the entity observation pipeline.
- `packages/standalone/src/api/graph-api.ts`
  Add minimal entity review and audit routes if not split into helpers.
- `packages/standalone/public/viewer/viewer.html`
  Register the minimal review and audit surfaces in navigation only if needed.
- `packages/standalone/public/viewer/src/utils/api.ts`
  Add API client methods for entity candidate list/detail/review actions and audit reads.
- `packages/standalone/public/viewer/src/utils/ui-commands.ts`
  Publish page context for the review view if needed later by `os-agent`.
- `README.md`
  Update roadmap language once the branch lands meaningful entity-substrate progress.

### Existing Assets To Reuse

- `packages/mama-core/src/memory/api.ts`
  Existing recall/truth/search entry points and embedding pipeline.
- `packages/mama-core/src/memory/truth-store.ts`
  Existing bootstrap/truth seam. Referenced for architectural context only; not a v1 modification target after CT3.
- `packages/mama-core/src/memory/bootstrap-builder.ts`
  Existing bootstrap path that still reads `memory_truth`; important for understanding why Task 7 avoids `memory_truth` writes in v1.
- `packages/mama-core/src/memory/evolution-engine.ts`
  Useful contrast for what belongs in memory evolution vs identity resolution.
- `packages/mama-core/src/db-manager.ts`
  Existing DB bootstrap and FTS/vector wiring.
- `packages/standalone/src/memory/history-extractor.ts`
  Existing raw/history ingestion path where entity observations should begin.
- `packages/standalone/src/api/graph-api.ts`
  Existing authenticated API routing surface.
- `packages/standalone/src/connectors/slack/*` + `packages/standalone/src/connectors/framework/raw-store.ts`
  Slack connector and per-connector RawStore. Task 6 reads raw identity from here; Task 6 does NOT FK into it (cross-DB boundary).

---

## Chunk 1: Establish The Entity Substrate

### Chunk 1 Prerequisites `[DX3]`

Verify your environment in 60 seconds before starting Task 1.

```bash
# pnpm version (must be >= 8)
pnpm --version

# vitest available in mama-core
pnpm --dir ./packages/mama-core exec vitest --version

# confirm the entities dir and tests dir do NOT exist yet — you'll create them in Task 1
ls packages/mama-core/src/entities 2>/dev/null && echo "UNEXPECTED — entities dir already exists" || echo "OK — will be created in Task 1"
ls packages/mama-core/tests/entities 2>/dev/null && echo "UNEXPECTED — tests dir already exists" || echo "OK — will be created in Task 1"

# confirm last migration on main is 025 — your new migrations 026/027/028 slot in after
ls packages/mama-core/db/migrations/025-extend-kind-check.sql

# confirm the files you plan to modify actually exist
ls packages/mama-core/src/memory/truth-store.ts \
   packages/mama-core/src/memory/api.ts \
   packages/mama-core/src/memory/event-store.ts \
   packages/mama-core/src/db-manager.ts \
   packages/standalone/src/memory/history-extractor.ts \
   packages/standalone/src/api/graph-api.ts
```

If any of these fail unexpectedly, stop and investigate before starting.

### Chunk 1 Test Command Cheatsheet `[DX4]`

Use these exact commands. Inconsistent spacing or directory depth causes copy-paste failures.

```bash
# Run a single test file, one-shot (use during TDD red/green cycles)
pnpm --dir ./packages/mama-core exec vitest run tests/entities/<file>.test.ts

# Run the full entities test suite, one-shot (use at the end of each task)
pnpm --dir ./packages/mama-core exec vitest run tests/entities/

# Watch mode (preferred during active implementation — re-runs on save)
pnpm --dir ./packages/mama-core exec vitest --watch tests/entities/
```

For standalone-side tests (Chunks 3-5), swap `mama-core` → `standalone` and adjust the test path.

**Interpreting vitest failure output:**

- `Cannot find module '../../src/entities/X'` → correct TDD red state. Your test is wired; the implementation doesn't exist yet.
- `No test files found, exiting with code 1` → your test file is in the wrong directory, or you forgot to create it.
- `Expected X, received Y` → implementation exists but is wrong.

### Task 1: Define the ontology/entity domain contracts and errors

**Files:**

- Create: `packages/mama-core/src/entities/types.ts`
- Create: `packages/mama-core/src/entities/errors.ts`
- Test: `packages/mama-core/tests/entities/types.test.ts`
- Test: `packages/mama-core/tests/entities/errors.test.ts`

- [ ] **Step 1: Write failing type-contract tests**

Cover:

- `EntityKind` includes `project`, `person`, `organization`, `work_item`
- `EntityAliasLabelType` includes `pref`, `alt`, `hidden`, `source_native`
- `EntityCandidateStatus` includes `pending`, `auto_merged`, `approved`, `rejected`, `deferred`
- `EntityMergeActionType` includes `merge`, `reject`, `defer`, `split`
- `EntityScopeKind` includes `project`, `channel`, `user`, `global` `[Decision 1]`
- `EntityNode.scope_kind` + `scope_id` fields (nullable `scope_id` when `scope_kind = global`) `[Decision 1]`
- `EntityObservation.extractor_version` + `embedding_model_version` fields `[Decision 9]`
- `EntityObservation.source_connector`, `source_raw_db_ref`, `source_raw_record_id` fields for cross-DB raw-evidence soft-reference `[CT7]`
- `EntityResolutionCandidate.extractor_version` + `embedding_model_version` fields `[Decision 9]`
- `errors.ts` exports named classes: `InvalidEntityLabelError`, `EmbeddingUnavailableError`, `OntologyViolationError`, `MergeTargetStaleError`, `EntityLabelMissingError`, `CandidateStaleError`, `AuditRunInProgressError` `[Decision 6]`
- each error class carries **all five fields**: `code` (namespaced dot-delimited string, e.g., `entity.invalid_label`), `message` (human-readable one-liner), `context` (structured debugging data — objects, not strings), `hint` (one-line suggested fix), `doc_section` (anchor that matches a heading in `docs/operations/entity-substrate-runbook.md`, e.g., `#embedding-unavailable`) `[DX7]`
- each error class extends a shared `EntityError` base that also provides `toErrorEnvelope()` returning `{error: {code, message, hint?, doc_url?}}` for HTTP API serialization `[DX6]`
- failure-path test: `new InvalidEntityLabelError({input: null, reason: 'null_input'})` round-trips through `toErrorEnvelope()` and produces a valid envelope

- [ ] **Step 2: Run the test to verify it fails** `[DX5]`

Create the directories first — they do not exist on main:

```bash
mkdir -p packages/mama-core/src/entities
mkdir -p packages/mama-core/tests/entities
```

Write your failing test at `packages/mama-core/tests/entities/types.test.ts` (import from `../../src/entities/types.js`).

Run:

```bash
pnpm --dir ./packages/mama-core exec vitest run tests/entities/types.test.ts
```

Expected: FAIL with `Cannot find module '../../src/entities/types'` — this is the correct TDD red state. If you instead see `No test files found, exiting with code 1`, your test file is in the wrong directory — fix the path, do not proceed.

- [ ] **Step 3: Implement `entities/types.ts` and `entities/errors.ts`**

Define concrete interfaces for:

- `EntityNode` (with `scope_kind`, `scope_id`)
- `EntityAlias`
- `EntityObservation` (with `extractor_version`, `embedding_model_version`, `scope_kind`, `scope_id`)
- `EntityResolutionCandidate` (with `extractor_version`, `embedding_model_version`)
- `EntityLink`
- `EntityTimelineEvent`
- `EntityMergeAction`

Include explicit provenance fields instead of loose `Record<string, unknown>` bags where possible.

Implement `errors.ts` per the expanded spec from Step 1 `[DX7]`:

```ts
export abstract class EntityError extends Error {
  abstract readonly code: string; // e.g. 'entity.invalid_label'
  abstract readonly doc_section: string; // e.g. '#invalid-label'
  readonly context: Record<string, unknown>;
  readonly hint: string;

  constructor(opts: { message: string; context?: Record<string, unknown>; hint: string }) {
    super(opts.message);
    this.context = opts.context ?? {};
    this.hint = opts.hint;
  }

  toErrorEnvelope(): { error: { code: string; message: string; hint: string; doc_url?: string } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        hint: this.hint,
        doc_url: `docs/operations/entity-substrate-runbook.md${this.doc_section}`,
      },
    };
  }
}
```

Each subclass supplies a stable `code` string for log matching and a `doc_section` anchor that must match a real heading in the runbook created in Task 12 Step 5.

- [ ] **Step 4: Re-run the test**

Run:

```bash
pnpm --dir ./packages/mama-core exec vitest run tests/entities/types.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/mama-core/src/entities/types.ts packages/mama-core/src/entities/errors.ts packages/mama-core/tests/entities/types.test.ts packages/mama-core/tests/entities/errors.test.ts
git commit -m "feat: add canonical entity domain types and errors"
```

### Task 2: Add core entity tables and migration coverage

**Files:**

- Create: `packages/mama-core/db/migrations/026-create-canonical-entity-tables.sql`
- Create: `packages/mama-core/db/migrations/027-create-entity-review-support.sql`
- Create: `packages/mama-core/src/entities/store.ts`
- Test: `packages/mama-core/tests/entities/store.test.ts`
- Modify: `packages/mama-core/src/index.ts`

- [ ] **Step 1: Write failing store tests**

Cover:

- migrations create `entity_nodes`
- migrations create `entity_aliases`
- migrations create `entity_observations`
- migrations create `entity_resolution_candidates`
- migrations create `entity_links`
- migrations create `entity_timeline_events`
- migrations create `entity_merge_actions`

- [ ] **Step 2: Run the tests to verify failure**

Run:

```bash
pnpm --dir ./packages/mama-core exec vitest run tests/entities/store.test.ts
```

Expected: FAIL because the tables and store functions do not exist.

- [ ] **Step 3: Write migration 026**

Add:

- `entity_nodes` — includes `scope_kind TEXT`, `scope_id TEXT` (both nullable; `scope_kind='global'` + `scope_id IS NULL` is the global case)
- `entity_aliases`
- `entity_observations` — includes `scope_kind TEXT`, `scope_id TEXT`, `extractor_version TEXT NOT NULL`, `embedding_model_version TEXT`, **plus cross-DB raw-evidence soft-reference**: `source_connector TEXT NOT NULL` (e.g., `'slack'`), `source_raw_db_ref TEXT` (path or logical name of the per-connector RawStore DB), `source_raw_record_id TEXT NOT NULL` (the raw record id inside that RawStore). No FK constraint — this is an intentional cross-DB boundary per CT7. Audit replay is responsible for reaching into `~/.mama/connectors/<name>/raw.db` to fetch raw evidence.
- `entity_links`
- `entity_timeline_events`

Use explicit indexes for:

- `kind`
- `preferred_label`
- `normalized_label`
- `entity_id`
- `observed_at`
- `(scope_kind, scope_id)` composite on `entity_nodes` and `entity_observations`
- `(source_connector, source_raw_record_id)` on `entity_observations` for idempotent re-ingest

Also add failing store tests that assert:

- `scope_kind`/`scope_id` columns exist and accept the four scope kinds
- `source_connector`/`source_raw_db_ref`/`source_raw_record_id` columns exist
- `source_connector` NOT NULL is enforced
- repeated insert with the same `(source_connector, source_raw_record_id)` is either rejected by unique constraint or idempotent by upsert (pick one, document it)

- [ ] **Step 4: Write migration 027**

Add:

- `entity_resolution_candidates` — includes `extractor_version TEXT NOT NULL`, `embedding_model_version TEXT`
- `entity_merge_actions`
- **Composite index (P2 fix):** `CREATE INDEX entity_candidates_status_score ON entity_resolution_candidates(status, score_total DESC, created_at DESC);` — the common "list pending candidates ordered by score" query hits this directly instead of filesort
- Other indexes: merge provenance lookup (`source_entity_id`, `target_entity_id`), `candidate_id` on merge actions
- failing store test that asserts the version columns exist on `entity_resolution_candidates`
- failing store test that asserts the composite index exists (via `PRAGMA index_list`)

- [ ] **Step 5: Implement `entities/store.ts`**

Add CRUD helpers for:

- create/list/get entity nodes
- attach/list aliases
- insert/list observations
- insert/list/update candidates
- insert/list links
- insert/list timeline events
- insert/list merge actions

- [ ] **Step 6: Export the new module**

Update:

```ts
// packages/mama-core/src/index.ts
export * from './entities/types.js';
export * from './entities/store.js';
```

- [ ] **Step 7: Re-run the tests**

Run:

```bash
pnpm --dir ./packages/mama-core exec vitest run tests/entities/store.test.ts
```

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/mama-core/db/migrations/026-create-canonical-entity-tables.sql packages/mama-core/db/migrations/027-create-entity-review-support.sql packages/mama-core/src/entities/store.ts packages/mama-core/src/index.ts packages/mama-core/tests/entities/store.test.ts
git commit -m "feat: add canonical entity persistence"
```

### Task 3: Add multilingual normalization

**Files:**

- Create: `packages/mama-core/src/entities/normalization.ts`
- Test: `packages/mama-core/tests/entities/normalization.test.ts`

- [ ] **Step 1: Write failing normalization tests**

Cover:

- Unicode normalization
- whitespace/punctuation normalization
- script detection hints for Korean/English/Japanese
- structured key extraction for email/handle/domain-like aliases
- no ASCII-only destruction of Korean or Japanese labels

- [ ] **Step 2: Run the tests to verify failure**

Run:

```bash
pnpm --dir ./packages/mama-core exec vitest run tests/entities/normalization.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement normalization**

Implement:

- `normalizeEntityLabel(input)`
- `detectScript(input)`
- `extractStructuredIdentifiers(input)`

Rules:

- preserve original label
- generate normalized key
- attach script/lang hints
- never collapse cross-language labels into the same key unless deterministic rules justify it

- [ ] **Step 4: Re-run the tests**

Run:

```bash
pnpm --dir ./packages/mama-core exec vitest run tests/entities/normalization.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/mama-core/src/entities/normalization.ts packages/mama-core/tests/entities/normalization.test.ts
git commit -m "feat: add multilingual entity normalization"
```

---

## Chunk 2: Candidate Generation And Resolution

### Task 4: Add blocking and candidate generation

**Files:**

- Create: `packages/mama-core/src/entities/candidate-generator.ts`
- Test: `packages/mama-core/tests/entities/candidate-generator.test.ts`

- [ ] **Step 1: Write failing candidate-generation tests**

Cover:

- exact normalized-label blocking
- structured identifier blocking
- same-source dedup
- cross-language candidates enter the queue when embedding/context evidence exists
- unrelated same-script labels do not flood the top-N result set

- [ ] **Step 2: Run the tests to verify failure**

Run:

```bash
pnpm --dir ./packages/mama-core exec vitest run tests/entities/candidate-generator.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement deterministic blocking**

Include:

- normalized label blocks
- external/source-local id blocks
- email/handle/domain blocks

- [ ] **Step 4: Implement candidate scoring**

Expose a score breakdown with:

- `score_structural`
- `score_string`
- `score_context`
- `score_graph`
- `score_embedding`
- `score_total`

Important:

- embeddings rank candidates
- embeddings do not authorize auto-merge on their own
- **top-N gate:** after deterministic blocking produces a candidate pool, **embed only the top 50 survivors** ranked by structural+string+context+graph scores. Never fan out embeddings across every alias-pair in a block. Add a config constant `ENTITY_EMBEDDING_TOPN = 50` so it is tunable.
- stamp each candidate row with `extractor_version` + `embedding_model_version` from the current runtime
- on embedding model unavailability, raise `EmbeddingUnavailableError` (defined in Task 1) and leave the candidate in `pending` state; never silently score as 0
- add at least one failure-path test: `EmbeddingUnavailableError` propagates and candidate stays `pending`
- add at least one "hostile" test: 10k-alias blowout where blocking correctly bounds the pool; top-50 gate holds

- [ ] **Step 5: Re-run the tests**

Run:

```bash
pnpm --dir ./packages/mama-core exec vitest run tests/entities/candidate-generator.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/mama-core/src/entities/candidate-generator.ts packages/mama-core/tests/entities/candidate-generator.test.ts
git commit -m "feat: add entity candidate generation"
```

### Task 5: Add conservative resolution rules

**Files:**

- Create: `packages/mama-core/src/entities/resolution-engine.ts`
- Test: `packages/mama-core/tests/entities/resolution-engine.test.ts`

- [ ] **Step 1: Write failing resolution tests**

Cover:

- exact structural identity auto-merges
- cross-language embedding-only matches become `review-needed`
- ontology-disallowed merges are rejected
- merge decisions emit reversible merge-action records

- [ ] **Step 2: Run the tests to verify failure**

Run:

```bash
pnpm --dir ./packages/mama-core exec vitest run tests/entities/resolution-engine.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement `resolution-engine.ts`**

Add:

- `evaluateResolutionCandidate`
- `shouldAutoMerge`
- `buildReviewReason`

Rules:

- narrow auto-merge
- Korean/English/Japanese alias candidates can be generated
- cross-language auto-merge is forbidden in v1 unless a strong structural key exists

- [ ] **Step 4: Re-run the tests**

Run:

```bash
pnpm --dir ./packages/mama-core exec vitest run tests/entities/resolution-engine.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/mama-core/src/entities/resolution-engine.ts packages/mama-core/tests/entities/resolution-engine.test.ts
git commit -m "feat: add reviewable entity resolution rules"
```

---

## Chunk 3: Observation Ingest And Projection

### Task 6: Re-plumb the Slack raw→LLM→save chain to emit entity observations with preserved source provenance

**Source:** Slack connector (locked by CEO review).

**Scope expansion per Codex CT6:** the current save path (`packages/standalone/src/cli/runtime/connector-init.ts:165`) drops `sourceId`, Slack `channelId`, message `ts`, and raw-store identity before calling `saveMemory`. Task 6 is NOT a simple extractor refactor. It is re-plumbing the full raw→LLM→save chain so that the raw provenance survives all the way into `entity_observations`.

**Files:**

- Modify: `packages/standalone/src/memory/history-extractor.ts`
- Modify: `packages/standalone/src/cli/runtime/connector-init.ts`
- Modify: `packages/standalone/src/connectors/slack/index.ts` (preserve immutable `channelId` alongside display `channel.name` throughout the item shape)
- Modify: `packages/standalone/src/connectors/framework/raw-store.ts` (expose a stable `raw_record_id` accessor for history-extractor)
- Modify: `packages/mama-core/src/memory/api.ts` (add `saveEntityObservation` entry point that does not LLM-process)

- [ ] **Step 1: Write a failing integration test for the Slack path** `[DX10]`

**Mock strategy:** Use vitest module mocking to stub `SlackConnector` and `RawStore`. Reference existing mock patterns in `packages/standalone/tests/` (check `tests/connectors/` or `tests/memory/` for the closest prior art). Do not hit real Slack APIs in this test. Supply synthetic raw records with explicit `channelId`, `ts`, and `source_raw_record_id` so the test is deterministic and PII-free `[Decision 4]`.

Verify:

- Slack raw messages produce entity observations
- observations persist with full soft-reference: `source_connector='slack'`, `source_raw_db_ref` = per-connector RawStore path, `source_raw_record_id` = immutable raw row id
- `entity_observations.scope_kind = 'channel'` and `scope_id = <slack channel ID>` (the **immutable** Slack channel ID, NEVER `channel.name`)
- `extractor_version` and `embedding_model_version` are populated from runtime config
- raw records with missing `source_raw_record_id` raise a structured warning log and skip the observation (no silent-drop, no crash)
- re-running the same raw batch is idempotent (same `(source_connector, source_raw_record_id)` pair → same observation, no duplicate)
- channel rename between batches preserves `scope_id` (channel ID) while the display label on any dependent entity updates (via alias/timeline event, not scope re-binding)
- archived channel: new observations are rejected with a structured log; existing observations stay intact
- no direct canonical truth is assumed from raw labels

- [ ] **Step 2: Run the test to verify failure**

```bash
pnpm --dir ./packages/standalone exec vitest run tests/connectors/slack-entity-observation.test.ts
```

Expected: FAIL

- [ ] **Step 3: Re-plumb the Slack ingest path**

Three coordinated changes:

**3a. Slack item shape** (`slack/index.ts`)
Extend the item shape so both `channelId` (immutable) and `channelName` (display) are preserved. Do NOT conflate them.

**3b. history-extractor grouping** (`history-extractor.ts`)
Change the grouping key from `source:channel` (which resolves to name today) to `source:channel_id`. The display name becomes evidence on a separate code path (alias/label), not a grouping primitive.

**3c. observation emission** (`connector-init.ts` + new `saveEntityObservation` in `memory/api.ts`)

Wrap per-batch observations in a single `db.transaction(() => {...})` (P5 fix).

Each observation must carry:

- `source_connector = 'slack'`
- `source_raw_db_ref` — path or logical key of the per-connector RawStore
- `source_raw_record_id` — immutable raw row id
- `scope_kind = 'channel'`, `scope_id = <slack_channel_id>`
- `extractor_version` + `embedding_model_version` stamped from runtime config
- `message_ts` retained as observation time

Log one structured line per observation batch: `(count, channel_id, extractor_version, source_raw_db_ref)`.

Also add a table-exists guard (A2 fix): if `entity_observations` does not exist yet because migration 026 has not run on this DB, log a structured warning and return. Do NOT crash the connector and do NOT drop memory.

- [ ] **Step 4: Re-run the focused test**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/memory/history-extractor.ts packages/standalone/src/cli/runtime/connector-init.ts packages/mama-core/src/memory/api.ts
git commit -m "feat: emit entity observations from raw history"
```

### Task 7: Project canonical entities into recall (not memory_truth) via recall-bridge

**Codex CT3/CT5 redesign:** `memory/api.ts recallMemory()` does not read `memory_truth` today. Only `bootstrap-builder.ts` does, and it reads every row when `query=''`. Writing canonical rows into `memory_truth` during shadow mode would therefore contaminate session bootstrap, which defeats the safety argument. This task is redesigned to NOT write to `memory_truth` at all. Projection output stays in the entity tables themselves, and a new `recall-bridge.ts` exposes a read-only function that `recallMemory()` calls as an additional source under `dual-write`.

**Files:**

- Create: `packages/mama-core/src/entities/projection.ts`
- Create: `packages/mama-core/src/entities/recall-bridge.ts`
- Test: `packages/mama-core/tests/entities/projection.test.ts`
- Test: `packages/mama-core/tests/entities/recall-bridge.test.ts`
- Modify: `packages/mama-core/src/memory/api.ts` (add `recallMemory()` augmentation under `MAMA_ENTITY_PROJECTION_MODE`)
- **Not modified in v1:** `packages/mama-core/src/memory/truth-store.ts` (no writes go through truth-store from entities)

- [ ] **Step 1: Write failing projection + recall-bridge tests**

Cover:

**Projection tests (`projection.test.ts`):**

- `projectEntityToRecallSummary(entity_id)` produces a recall-shaped row with `preferred_label`, top N aliases, latest timeline event, scope, and `canonical_entity_id`
- Missing preferred label raises `EntityLabelMissingError`
- Circular `merged_into` (A→B→A) is detected and raises a structured error (not infinite loop)
- `project...` functions never write to `memory_truth` (assert by mocking truth-store and expecting zero calls)

**Recall-bridge tests (`recall-bridge.test.ts`):**

- `queryCanonicalEntities(query, scope)` returns empty when no canonical entities exist
- Returns top-N canonical entities by FTS match on preferred_label + aliases, scoped to the caller's scope
- Returns empty for a scope the caller has no access to (defense in depth; primary auth is at API layer)
- Never reads from `memory_truth`

**Integration tests (`memory/api.ts` mode tests):**

- `off` mode: `recallMemory('Project Alpha')` returns legacy results; `queryCanonicalEntities` is never called
- `shadow` mode: `recallMemory('Project Alpha')` returns legacy results; `queryCanonicalEntities` is called **and** its results are logged to audit only (not merged into the recall response)
- `dual-write` mode: `recallMemory('Project Alpha')` returns legacy results merged with `queryCanonicalEntities` results; canonical rows appear in the response with an explicit `source='entity_canonical'` marker
- Config key missing: default to `shadow` and emit a one-time structured warning
- `buildMemoryBootstrap()` results are **unchanged** across all three modes (the shadow-mode safety assertion — this is the regression test)

- [ ] **Step 2: Run the tests to verify failure**

Run:

```bash
pnpm --dir ./packages/mama-core exec vitest run tests/entities/projection.test.ts tests/entities/recall-bridge.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement projection helpers (read-shaping only, no writes to memory_truth)**

Add:

- `projectEntityToRecallSummary(entity_id, { includeTimeline })`
- `projectTimelineSliceToEvidence(entity_id, fromTs, toTs)`
- `projectCanonicalEntityTopAliases(entity_id, limit)`

All pure functions. No side effects. No truth-store writes.

- [ ] **Step 4: Implement `recall-bridge.ts`**

Export `queryCanonicalEntities(query: string, scope: ScopeRef, options: { limit: number })` which:

1. Runs an FTS search on `entity_aliases.normalized_label` scoped by the caller's scope
2. Joins to `entity_nodes` and filters out `merged_into IS NOT NULL` (merged-away entities)
3. For each surviving entity, calls `projectEntityToRecallSummary(entity_id)` to shape the result
4. Returns top-N by score

No writes. No mutation of memory_truth. No mutation of decisions table.

- [ ] **Step 5: Wire `recallMemory()` to the mode flag**

Read `MAMA_ENTITY_PROJECTION_MODE` from env + standalone config (A7 fix).

```text
recallMemory(query, scope):
  legacy = recallLegacy(query, scope)           # unchanged path
  if mode == 'off':
    return legacy
  canonical = queryCanonicalEntities(query, scope)
  if mode == 'shadow':
    auditLog('entity_recall_shadow', {query, canonical_count: canonical.length})
    return legacy                               # canonical NEVER reaches the caller
  if mode == 'dual-write':
    return merge(legacy, canonical)             # canonical rows tagged source='entity_canonical'
```

No change to `truth-store.ts`. No writes to `memory_truth` from entities. Shadow mode is invisible by construction (CT5 fix).

- [ ] **Step 6: Re-run the tests**

Run:

```bash
pnpm --dir ./packages/mama-core exec vitest run tests/entities/projection.test.ts tests/entities/recall-bridge.test.ts
pnpm --dir ./packages/mama-core exec vitest run tests/unit/memory-v2-bootstrap-builder.test.ts tests/unit/memory-v2-extraction.test.ts
```

Expected: PASS. Bootstrap test is the load-bearing regression gate — its output must be byte-identical across mode `off` / `shadow` / `dual-write`.

- [ ] **Step 7: Commit**

```bash
git add packages/mama-core/src/entities/projection.ts packages/mama-core/src/entities/recall-bridge.ts packages/mama-core/tests/entities/projection.test.ts packages/mama-core/tests/entities/recall-bridge.test.ts packages/mama-core/src/memory/api.ts
git commit -m "feat: project canonical entities via recall-bridge (no memory_truth writes)"
```

---

## Chunk 4: Review Workflow And Minimal UI

### Task 8: Add minimal entity review APIs

**Files:**

- Create: `packages/standalone/src/api/entity-review-handler.ts`
- Test: `packages/standalone/tests/api/entity-review-handler.test.ts`
- Modify: `packages/standalone/src/api/graph-api.ts`

- [ ] **Step 1: Write failing API tests**

Cover:

- list pending candidates
- get candidate detail with evidence
- approve candidate
- reject candidate
- defer candidate

- [ ] **Step 2: Run the tests to verify failure**

Run:

```bash
pnpm --dir ./packages/standalone exec vitest run tests/api/entity-review-handler.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement the API**

Keep v1 intentionally small, but add the contracts the eng review demanded:

- `GET /api/entities/candidates?limit=50&cursor=<opaque>&scope_kind=&scope_id=` — **cursor-based pagination (T2 fix):** opaque cursor encodes `(score_total, id)` tuple. Default `limit=50`, hard max `200`. Scope filter from query params and intersected with auth-context scope (defense in depth).
- `GET /api/entities/candidates/:id` — 404 on unknown id; 403 on cross-scope access where the auth context has no read rights to the candidate's scope.
- `POST /api/entities/candidates/:id/approve` — `actor_id` is always pulled from auth context, NEVER from POST body (security test). 409 `CandidateStaleError` if the candidate is already resolved. Idempotent on replay (same `(actor_id, candidate_id, action)` returns the same merge_action_id).
- `POST /api/entities/candidates/:id/reject` — same rules as approve.
- `POST /api/entities/candidates/:id/defer` — same rules as approve.

Structured audit log on every mutation: `{candidate_id, actor_id, action, outcome, merge_action_id}`.

**Response shapes (stable contract for integrators) `[DX6]`:**

```ts
// GET /api/entities/candidates
interface CandidateListResponse {
  candidates: CandidateSummary[];
  next_cursor: string | null; // opaque, pass to ?cursor=...
}

interface CandidateSummary {
  id: string;
  candidate_kind: 'alias_to_entity' | 'entity_to_entity' | 'cluster';
  status: 'pending' | 'auto_merged' | 'approved' | 'rejected' | 'deferred';
  score_total: number;
  left_ref: { kind: string; id: string; label: string };
  right_ref: { kind: string; id: string; label: string };
  created_at: string; // ISO 8601
  scope_kind: string | null;
  scope_id: string | null;
}

// GET /api/entities/candidates/:id
interface CandidateDetail extends CandidateSummary {
  score_structural: number;
  score_string: number;
  score_context: number;
  score_graph: number;
  score_embedding: number;
  rule_trace: string[]; // ordered list of rule hits that produced this candidate
  evidence: EvidenceRow[]; // raw observations that support each side
  extractor_version: string;
  embedding_model_version: string | null;
}

// POST /api/entities/candidates/:id/approve | reject | defer
interface MergeActionResult {
  candidate_id: string;
  merge_action_id: string; // idempotent: same (actor_id, candidate_id, action) → same id
  action: 'merge' | 'reject' | 'defer';
  actor_id: string; // pulled from auth context, never POST body
  created_at: string;
}

// Error envelope (from EntityError.toErrorEnvelope() — see Task 1 Step 3)
interface ErrorEnvelope {
  error: {
    code: string; // e.g. 'entity.candidate_stale'
    message: string;
    hint: string;
    doc_url?: string; // points at entity-substrate-runbook.md section
  };
}
```

All error responses use `ErrorEnvelope`. A 409 for stale candidates looks like:

```json
{
  "error": {
    "code": "entity.candidate_stale",
    "message": "Candidate already resolved",
    "hint": "Refetch /api/entities/candidates/:id to see current status",
    "doc_url": "docs/operations/entity-substrate-runbook.md#candidate-stale"
  }
}
```

- [ ] **Step 4: Re-run the tests**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/api/entity-review-handler.ts packages/standalone/src/api/graph-api.ts packages/standalone/tests/api/entity-review-handler.test.ts
git commit -m "feat: add entity review api"
```

### Task 9: Add a minimal review queue surface

**Files:**

- Create: `packages/standalone/public/viewer/src/modules/entity-review.ts`
- Create: `packages/standalone/tests/viewer/entity-review.test.ts`
- Modify: `packages/standalone/public/viewer/src/utils/api.ts`
- Modify: `packages/standalone/public/viewer/viewer.html`

- [ ] **Step 1: Write failing viewer tests**

Cover:

- pending candidates render as a list
- selecting a candidate shows evidence and score breakdown
- approve/reject/defer triggers API calls
- empty-state renders safely

- [ ] **Step 2: Run the tests to verify failure**

Run:

```bash
pnpm --dir ./packages/standalone exec vitest run tests/viewer/entity-review.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement the minimal module**

Do not build a grand UI. v1 only needs:

- queue list
- candidate detail
- evidence/score summary
- approve/reject/defer actions

- [ ] **Step 4: Re-run the tests**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/public/viewer/src/modules/entity-review.ts packages/standalone/public/viewer/src/utils/api.ts packages/standalone/public/viewer/viewer.html packages/standalone/tests/viewer/entity-review.test.ts
git commit -m "feat: add entity review queue viewer"
```

---

## Chunk 5: Benchmark And Audit Loop

### Task 10: Add benchmark fixtures and audit metrics

**Files:**

- Create: `packages/mama-core/tests/entities/fixtures/gold-canonical-identities.json`
- Create: `packages/mama-core/tests/entities/fixtures/cross-language-aliases.json`
- Create: `packages/mama-core/tests/entities/fixtures/perturbation-cases.json`
- Create: `packages/mama-core/tests/entities/fixtures/historical-replay-sample.json`
- Create: `packages/mama-core/tests/entities/audit-metrics.test.ts`
- Create: `packages/mama-core/db/migrations/028-create-entity-audit-tables.sql`

- [ ] **Step 1: Write failing audit-metric tests**

Cover:

- `false_merge_rate`
- `cross_language_candidate_recall@10`
- `ontology_violation_count`
- `projection_fragmentation_rate`
- run classification into `improved`, `stable`, `regressed`, `inconclusive`

- [ ] **Step 2: Run the tests to verify failure**

Run:

```bash
pnpm --dir ./packages/mama-core exec vitest run tests/entities/audit-metrics.test.ts
```

Expected: FAIL

- [ ] **Step 3: Add benchmark fixtures (synthetic only)**

Add small but real fixture sets for:

- reviewed gold canonical identity groups
- Korean/English/Japanese alias cases
- normalization perturbations
- replayable historical raw samples

**PII policy (non-negotiable):** fixtures MUST use synthetic multilingual data only. No copy-paste from real Slack/Notion/Telegram/Gmail records. Synthetic names, synthetic project names, synthetic channel IDs. If a fixture needs a real-world pattern, construct a structurally equivalent synthetic example. Fixture files must be explicitly reviewed for PII leakage before commit.

Fixtures must also declare the `extractor_version` and `embedding_model_version` they were generated under, so audit replay can refuse incompatible baselines loudly rather than silently.

- [ ] **Step 4: Add audit tables and single-writer lock (migration 028)**

Migration 028 is written **in full in this task**, not stubbed earlier. Chunk 1 reserves the version number but commits no empty file (CT1 fix).

Create:

- `entity_audit_runs` — includes `id`, `status` (`running` | `complete` | `failed` | `timeout`), `created_at`, `completed_at`, `baseline_run_id`, `classification` (`improved` | `stable` | `regressed` | `inconclusive`), `metric_summary_json`
- `entity_audit_metrics` — per-run metric values, keyed by `(run_id, metric_name)`
- `entity_audit_findings` — named findings per run (false merge example, ontology violation example, fragmentation spike, etc.)
- **A3 partial unique index:** `CREATE UNIQUE INDEX entity_audit_runs_single_running ON entity_audit_runs(status) WHERE status = 'running';` — enforces single concurrent audit run at the schema level. A second `INSERT ... status='running'` fails with `SQLITE_CONSTRAINT`, which the handler maps to `AuditRunInProgressError`. Survives process restart.

Add failing store test for the partial index: assert that two concurrent inserts with `status='running'` fail on the second.

- [ ] **Step 5: Implement metric calculation helpers**

Add helpers that compute:

- candidate metrics
- merge metrics
- ontology consistency metrics
- projection fragmentation metrics
- baseline delta classification

**V1 release gate (hard ceiling):** `false_merge_rate ≤ 0.02` on the gold canonical identity fixture set. The first audit run establishes the ongoing baseline; every subsequent run must satisfy both (a) the `≤ 0.02` ceiling and (b) no regression against the stored baseline on `false_merge_rate`. If either fails, the audit run is classified `regressed` regardless of other metric movement.

- [ ] **Step 6: Re-run the tests**

Run:

```bash
pnpm --dir ./packages/mama-core exec vitest run tests/entities/audit-metrics.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/mama-core/tests/entities/fixtures packages/mama-core/tests/entities/audit-metrics.test.ts packages/mama-core/db/migrations/028-create-entity-audit-tables.sql
git commit -m "feat: add entity benchmark fixtures and audit metrics"
```

### Task 11: Add minimal audit APIs, purpose-built audit-run queue, and viewer report surface

**Codex CT2:** do NOT reuse `packages/standalone/src/memory/audit-task-queue.ts`. That file is a synchronous 30s-timeout memory-agent conversation queue — wrong abstraction. Build a purpose-built `entity-audit-queue.ts` that persists runs in `entity_audit_runs` with the A3 partial unique index.

**Files:**

- Create: `packages/standalone/src/api/entity-audit-handler.ts`
- Create: `packages/standalone/src/api/entity-audit-queue.ts` (purpose-built, NOT reusing audit-task-queue.ts)
- Create: `packages/standalone/tests/api/entity-audit-handler.test.ts`
- Create: `packages/standalone/tests/api/entity-audit-queue.test.ts`
- Create: `packages/standalone/public/viewer/src/modules/entity-audit.ts`
- Create: `packages/standalone/tests/viewer/entity-audit.test.ts`
- Modify: `packages/standalone/src/api/graph-api.ts`
- Modify: `packages/standalone/public/viewer/src/utils/api.ts`
- Modify: `packages/standalone/public/viewer/viewer.html`

- [ ] **Step 1: Write failing API, queue, and viewer tests**

**Queue tests (`entity-audit-queue.test.ts`):**

- `enqueue(runSpec)` inserts a row into `entity_audit_runs` with `status='running'` and returns immediately with `run_id`
- Concurrent `enqueue()` fails the second call with `AuditRunInProgressError` via the migration 028 partial unique index (A3)
- `getStatus(run_id)` returns `running | complete | failed | timeout` without blocking
- `complete(run_id, result)` transitions to `complete` and persists metric results
- Restart recovery: queue reads `entity_audit_runs WHERE status='running'` on boot and marks orphaned runs as `failed` with reason `'standalone_restart'` (no silent resurrection)
- Time budget: a run exceeding `ENTITY_AUDIT_TIME_BUDGET_MS` transitions to `timeout` with the partial findings persisted

**Handler tests (`entity-audit-handler.test.ts`):**

- `POST /api/entities/audit/run` returns `202 Accepted` with `{run_id}` immediately (non-blocking)
- Concurrent `POST /run` returns `409 AuditRunInProgressError`
- `GET /api/entities/audit/runs` lists historical runs ordered by created_at DESC
- `GET /api/entities/audit/runs/:id` returns run detail; 404 on unknown id
- Baseline missing → run still completes, classified `inconclusive`
- `false_merge_rate > 0.02` on gold set → run classified `regressed` regardless of other metrics
- All handlers use `actor_id` from auth context, not POST body (security test)

**Viewer tests (`entity-audit.test.ts`):**

- Renders baseline delta summary
- Renders `inconclusive` result correctly (different affordance than `stable`)
- Highlights `regressed` result (e.g., red banner) on `false_merge_rate` spike
- Concurrent run lockout UX: "Audit already running" message with link to in-progress run

- [ ] **Step 2: Run the tests to verify failure**

Run:

```bash
pnpm --dir ./packages/standalone exec vitest run tests/api/entity-audit-queue.test.ts tests/api/entity-audit-handler.test.ts tests/viewer/entity-audit.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement the purpose-built audit-run queue and minimal audit routes**

Build `entity-audit-queue.ts` as a thin persisted wrapper around `entity_audit_runs`:

```text
class EntityAuditRunQueue {
  constructor(db, config: { timeBudgetMs: number })
  enqueue(spec): { run_id }          // INSERT status='running', spawn detached worker
  getStatus(run_id): RunStatus       // SELECT status
  complete(run_id, result): void     // UPDATE status, persist metrics
  fail(run_id, reason): void         // UPDATE status='failed'
  recoverOrphans(): number           // called on boot; marks running→failed with reason
}
```

Detached worker executes benchmark replay + audit-metrics calculation off the HTTP request thread. Time budget enforced via `setTimeout` + worker cooperative check.

Keep audit API routes small:

- `POST /api/entities/audit/run` → enqueue + return `{run_id}` (202 Accepted)
- `GET /api/entities/audit/runs` → list
- `GET /api/entities/audit/runs/:id` → detail (includes `status`, `baseline_delta`, `classification`, partial metrics if running)

- [ ] **Step 4: Implement minimal audit viewer**

Render:

- baseline summary
- critical guardrails
- candidate quality changes
- ontology violations
- projection fragmentation change
- recommended next tuning move

- [ ] **Step 5: Re-run the tests**

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/standalone/src/api/entity-audit-handler.ts packages/standalone/tests/api/entity-audit-handler.test.ts packages/standalone/public/viewer/src/modules/entity-audit.ts packages/standalone/tests/viewer/entity-audit.test.ts packages/standalone/src/api/graph-api.ts packages/standalone/public/viewer/src/utils/api.ts packages/standalone/public/viewer/viewer.html
git commit -m "feat: add entity audit reporting surface"
```

---

## Chunk 6: End-To-End Verification And Handoff

### Task 12: Verify the first operational vertical slice and ship observability

**Files:**

- Modify only if verification reveals defects
- Create/modify: observability outputs (log formatters, counter emission, runbook doc)

- [ ] **Step 1: Run targeted package tests**

Run:

```bash
pnpm --dir ./packages/mama-core exec vitest run tests/entities/types.test.ts tests/entities/normalization.test.ts tests/entities/store.test.ts tests/entities/candidate-generator.test.ts tests/entities/resolution-engine.test.ts tests/entities/projection.test.ts
pnpm --dir ./packages/mama-core exec vitest run tests/entities/audit-metrics.test.ts
pnpm --dir ./packages/standalone exec vitest run tests/api/entity-review-handler.test.ts tests/viewer/entity-review.test.ts tests/api/entity-audit-handler.test.ts tests/viewer/entity-audit.test.ts
```

Expected: PASS

- [ ] **Step 2: Run broader regression checks**

Run:

```bash
pnpm --dir ./packages/mama-core test
pnpm --dir ./packages/standalone build
pnpm --dir ./packages/standalone test
```

Expected: PASS

- [ ] **Step 3: Run one real backfill / smoke flow**

Manually verify:

- one raw source emits observations
- at least one Korean/English/Japanese candidate appears
- structural exact cases auto-merge only when allowed
- ambiguous cross-language candidates remain review-needed
- projected entity data is readable through at least one current memory/truth path
- one audit run can compare against a saved baseline and report improved/stable/regressed/inconclusive

**Final success signal `[DX11]`:**

Run these three commands. If they all work, the branch is functionally complete:

```bash
# 1. Trigger an audit run, capture the run_id
RUN_ID=$(curl -s -X POST http://localhost:3847/api/entities/audit/run | jq -r .run_id)
echo "Started audit run: $RUN_ID"

# 2. Poll until the run completes (up to 5 min)
while true; do
  STATUS=$(curl -s http://localhost:3847/api/entities/audit/runs/$RUN_ID | jq -r .status)
  echo "status: $STATUS"
  [ "$STATUS" = "complete" ] && break
  [ "$STATUS" = "failed" ] && { echo "audit run failed"; break; }
  [ "$STATUS" = "timeout" ] && { echo "audit run timed out"; break; }
  sleep 5
done

# 3. Read the classification
curl -s http://localhost:3847/api/entities/audit/runs/$RUN_ID | jq '{classification, false_merge_rate: .metrics.false_merge_rate, cross_lang_recall: .metrics.cross_language_candidate_recall_at_10}'
# Expected on first run: classification='inconclusive' (no baseline yet). Second run onward, expect 'improved' or 'stable'.
```

- [ ] **Step 4: Update docs**

Update:

- `README.md` roadmap wording if the branch materially shifts the next milestone
- any affected architecture docs that still claim topic-centric memory is the primary identity model

- [ ] **Step 5: Ship observability deliverables (required, not post-launch)** `[Decision 7]`

Add before the merge summary:

- **Structured logs:** each resolution decision writes one log line with `candidate_id`, `score_breakdown`, `rule_trace`, `decision` (`auto_merged` / `review_needed` / `rejected`). Each auto-merge and each audit-run start/complete writes one log line with metric deltas.
- **Counters:** expose runtime counters `entity.candidates.generated`, `entity.candidates.auto_merged`, `entity.candidates.reviewed`, `entity.projection.writes`, `entity.audit.runs`, `entity.audit.false_merge_rate`. Counters emit to the existing MAMA instrumentation sink (or minimally to stdout/file if no sink).

- **Runbook:** create `docs/operations/entity-substrate-runbook.md` with at least these sections. Every `EntityError` subclass `doc_section` anchor must match a heading here `[DX8]`:

````markdown
# Entity Substrate Runbook

## Overview

One-paragraph summary: what the entity substrate is, when operators interact with it, how to reach for help.

## Projection Mode Flag

- How to read current value of `MAMA_ENTITY_PROJECTION_MODE` (env + standalone config).
- How to toggle (env var, restart required vs hot-reload).
- What each mode does (off | shadow | dual-write).

## Common Failure Modes

### #embedding-unavailable

Symptom: `EmbeddingUnavailableError` in logs.
Cause: embedding server (port 3847) down or model file missing.
Fix:

1. `curl http://localhost:3847/health`
2. If unhealthy, restart standalone: `mama stop && mama start`
3. Candidates in `pending` status will be rescored on next audit run — no manual recovery needed.

### #invalid-label

Symptom: `InvalidEntityLabelError` in logs during Slack ingest.
Cause: raw Slack message has nullish text or non-string content in an unexpected field.
Fix: check the offending raw row in `~/.mama/connectors/slack/raw.db` using the `source_raw_record_id` from the error context. Either fix the extractor to handle that raw shape, or add a skip rule.

### #candidate-stale

Symptom: 409 from `/api/entities/candidates/:id/approve`.
Cause: two reviewers resolved the same candidate concurrently.
Fix: refetch the candidate via GET; the resolved one wins. This is not a bug, it is the race-safety mechanism.

### #audit-run-in-progress

Symptom: 409 from `/api/entities/audit/run`.
Cause: another audit run is active (partial unique index on `entity_audit_runs.status='running'`).
Fix: wait for completion via `GET /api/entities/audit/runs` (order by created_at DESC). If a run is stuck in `running` after a standalone restart, the restart-recovery logic in `entity-audit-queue.ts` should mark it `failed` on next boot — if not, manually: `UPDATE entity_audit_runs SET status='failed', reason='manual_recovery' WHERE status='running';`

### #false-merge-spike

Symptom: latest audit run classification = `regressed`, `false_merge_rate > 0.02`.
Fix (disable auto-merge, investigate, restore):

1. `MAMA_ENTITY_PROJECTION_MODE=off` (stops propagation)
2. Read audit findings: `curl /api/entities/audit/runs/$LATEST_ID | jq .findings`
3. Identify false-merge examples in the findings
4. Roll back offending merges via `POST /api/entities/candidates/:id/split` actions (audit trail preserved via `entity_merge_actions`)
5. Re-run audit to confirm `false_merge_rate` back under 0.02
6. Restore `MAMA_ENTITY_PROJECTION_MODE=shadow` (or dual-write)

### #candidate-backlog

Symptom: `pending` candidate count growing unbounded.
Fix: check `ENTITY_EMBEDDING_TOPN` (should be 50). Check blocking rules in `candidate-generator.ts` for overly-permissive normalized_label matches. Consider adding a stricter structured-identifier block.

### #entity-merge-timeline

How to read `entity_merge_actions` for a given entity's history:

```sql
SELECT created_at, action_type, actor_id, reason FROM entity_merge_actions WHERE source_entity_id = ? OR target_entity_id = ? ORDER BY created_at;
```
````

## Rollback Procedure (branch-level)

`MAMA_ENTITY_PROJECTION_MODE=off` disables projection reads + writes. All 026/027/028 tables are append-only so leaving data in place is safe. No migration reversal required. If full rollback desired: drop the three migrations' tables manually (SQL snippets in this section).

```

- **Rollback procedure (written above):** `MAMA_ENTITY_PROJECTION_MODE=off` disables projection reads + writes. All 026/027/028 tables are append-only so leaving data in place is safe. No migration reversal required.

- [ ] **Step 6: Prepare merge summary**

Include:

- what is now canonical
- what still remains projection-only
- what is intentionally deferred to the next `os-agent` same-view branch
- which decisions from the CEO review were resolved and where
- **os-agent consumption boundary** (A6): one paragraph stating exactly what os-agent can assume after this branch lands (canonical entities exist, Slack observations backfilled, `queryCanonicalEntities` available under `dual-write` mode) and what it must NOT assume yet (wiki/dashboard projection, cross-language auto-merge, multi-connector backfill, stable baselines on any metric except `false_merge_rate` on gold set)

- [ ] **Step 7: Final commit(s)**

Use small, truthful commits for any final fixes and docs.

---

## Definition Of Done

This branch is done when:

1. `mama-core` has first-class entity, alias, observation, candidate, link, timeline, and merge-action models.
2. One real raw source can feed the entity observation pipeline.
3. Korean/English/Japanese aliases can generate ranked candidates.
4. Auto-merge remains narrow and structural.
5. Ambiguous cases land in a review queue with evidence and score breakdown.
6. Canonical entity projection reaches at least one memory/truth read path.
7. Benchmark fixtures and entity audit metrics exist.
8. At least one audit run can classify baseline deltas.
9. Minimal review and audit APIs and Viewer UI exist.
10. Package tests and build checks pass.

---

Plan complete and saved to `docs/superpowers/plans/2026-04-12-canonical-entity-ontology-implementation.md`. Ready to execute?

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | HOLD_SCOPE | 8 issues / 5 critical failure-mode gaps / 9 decisions resolved |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | APPLIED_WITH_2_SUPERSEDES | 7 arch + 5 quality + 38 test gaps + 4 perf; 17 recommendations, 15 applied (`Q3`, `P6` superseded by Codex) |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | CORRECTIONS_APPLIED | 8 new findings; reversed Eng Q3 + P6; redesigned Task 7 via recall-bridge |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 1 | APPLIED | score 6.7→9.1/10; TTHW ~50min→~25min for Chunk 1 Task 1; 11 fixes applied |

**CROSS-MODEL:** Codex verified prior-review findings against actual code and caught 3 P1 issues both CEO and Eng missed (raw-evidence boundary, Slack save-path raw-provenance drop, migration stub hazard). Reversed 2 Eng recommendations (Q3 empty 028 stub, P6 audit-task-queue reuse). Task 7 fully redesigned — `memory_truth` writes dropped, replaced by `recall-bridge.ts`.

**UNRESOLVED:** 0. All 9 CEO decisions + 15 Eng recommendations + 7 Codex tensions (CT1-CT3, CT5-CT8, with CT4 held) + 11 DX fixes applied.

**VERDICT:** CEO + ENG + CODEX + DX CLEARED — ready to implement.

Full reviews:
- `docs/superpowers/reviews/2026-04-12-canonical-entity-ontology-ceo-review.md`
- `docs/superpowers/reviews/2026-04-12-canonical-entity-ontology-eng-review.md`
- `docs/superpowers/reviews/2026-04-12-canonical-entity-ontology-codex-review.md`
- `docs/superpowers/reviews/2026-04-12-canonical-entity-ontology-dx-review.md`
```
