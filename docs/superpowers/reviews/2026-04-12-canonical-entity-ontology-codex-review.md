# Codex Outside-Voice Review — Canonical Entity Ontology Implementation

**Target plan:** `docs/superpowers/plans/2026-04-12-canonical-entity-ontology-implementation.md` (post-CEO edits applied)
**Prior reviews:**

- `docs/superpowers/reviews/2026-04-12-canonical-entity-ontology-ceo-review.md`
- `docs/superpowers/reviews/2026-04-12-canonical-entity-ontology-eng-review.md`

**Branch:** `codex/mama-entity-ontology`
**Base:** `main`
**Reviewer:** `codex exec` (GPT-5, `model_reasoning_effort=high`, read-only filesystem)
**Date:** 2026-04-12
**Tokens used:** 183,821
**Mandate:** find what CEO + Eng reviews missed. Verify plan claims against actual code.

---

## 1. NEW FINDINGS

### Finding 1 — Empty migration 028 stub is actively dangerous (P1)

**Location:** `packages/mama-core/src/db-adapter/node-sqlite-adapter.ts:412`

Eng Q3's "empty 028 stub now, finalize later" recommendation is **actively dangerous**. The migration runner skips any file whose version is `<= currentVersion`, and it marks a migration applied immediately after executing it. If 028 lands as a stub and reaches any dev/user DB, the real 028 audit tables/indexes will never run unless a new migration 029 is created or `schema_version` is manually repaired.

**Implication:** Eng review's Q3 is wrong. The correct approach is either (a) write the full 028 in Chunk 1 Task 2 even though its consumers ship in Chunk 5, or (b) defer 028 creation until Chunk 5 and accept the forward-reference risk with an explicit comment.

### Finding 2 — Raw evidence boundary is hand-waved (P1)

**Location:** `packages/standalone/src/connectors/framework/raw-store.ts:24`

The plan assumes `entity_observations.raw_record_id` can point at immutable raw evidence, but **Slack raw evidence lives in a separate per-connector SQLite DB under `RawStore`, not in mama-core's DB.** There is no cross-DB FK or shared raw-record identity between the connector raw store and the entity substrate.

The plan needs `source_ref` semantics explicitly (e.g., `(connector_name, raw_record_id, raw_record_db_version)`) or a core-side raw evidence table that mirrors/indexes connector raw IDs. Otherwise "raw → observation" provenance is hand-wavy and cannot be replayed reliably.

**Implication:** This is the most architecturally significant finding. It weakens the foundation of the whole "raw-first" premise unless resolved.

### Finding 3 — Slack save path drops raw provenance before reaching saveMemory (P1)

**Location:** `packages/standalone/src/cli/runtime/connector-init.ts:165`

The Slack extraction path currently saves only LLM-derived memory rows with `source_type: 'connector'`. It drops `sourceId`, Slack `channelId`, message `ts`, and raw-store identity **before** calling `saveMemory`. Task 6's "raw messages + channel names produce observations" is harder than stated because the actual save seam no longer has the raw provenance needed for observation rows.

**Implication:** Task 6 is not a "refactor the extractor path" operation. It requires re-plumbing the raw→LLM→save chain to preserve raw identity all the way through, OR inserting observation emission at a point in the pipeline where raw identity still exists. Neither is free.

### Finding 4 — Slack channel binding is name-shaped, not ID-shaped (P2)

**Location:** `packages/standalone/src/connectors/slack/index.ts:123`, `packages/standalone/src/memory/history-extractor.ts:154`

Slack items set `channel` to `channelCfg.name ?? channelId` and only keep the immutable channel ID in metadata. `history-extractor.ts:154` groups by `source:channel`, so the path naturally groups by display name when configured. Eng A4 said "bind to channel IDs," but missed that the current grouping key and LLM prompt context are name-shaped.

**Implication:** Changing to channel ID binding requires changes in at least three places (slack connector item shape, history-extractor grouping key, LLM prompt templates). Not a one-line fix.

### Finding 5 — audit-task-queue.ts is the wrong abstraction to reuse (P1)

**Location:** `packages/standalone/src/memory/audit-task-queue.ts:4`

Eng P6's "reuse `audit-task-queue.ts`" is **unrealistic as written**. This queue is a memory-agent conversation queue with `MemoryAuditJob` and `MemoryAuditAckLike`, a 30-second timeout, and `enqueue()` returns only after work completes. It is not a detached audit-run worker with persisted `run_id`, status polling, restart recovery, or entity audit result semantics.

**Implication:** Eng review's P6 is wrong. Building a purpose-built `EntityAuditRunQueue` around `entity_audit_runs` is likely simpler than adapting the memory-agent queue. The Codex recommendation: skip the reuse, build a tiny persisted queue.

### Finding 6 — Projection bridge targets the wrong seam (P1)

**Location:** `packages/mama-core/src/memory/api.ts:620`

The plan says projection writes to `memory_truth` and `dual-write` makes `recallMemory()` prefer canonical projection. But **current `recallMemory()` does not read `memory_truth`.** It reads vector/FTS/`decisions`. The only real `memory_truth` read path found is `packages/mama-core/src/memory/bootstrap-builder.ts:18` (session bootstrap, not live recall).

**Implication:** Task 7 is not a small truth-store bridge. It requires either (a) a new recall source path in `memory/api.ts` that reads canonical projection rows, or (b) projection writing into the `decisions` table under a reserved kind/status so existing recall picks it up. Both options are bigger than the plan suggests.

### Finding 7 — Shadow projection is not actually invisible (P2)

**Location:** `packages/mama-core/src/memory/truth-store.ts:119`

Shadow projection is not necessarily invisible. `buildMemoryBootstrap()` calls `queryRelevantTruth({ query: '', includeHistory: true })` and `matchesQuery('', ...)` returns true for every row. If shadow mode writes many canonical rows into `memory_truth`, bootstrap **loads and filters all of them** even though the plan claims live reads stay legacy.

**Implication:** "Shadow mode" as a safety guarantee is leaky. Session bootstrap will contaminate with canonical rows unless bootstrap is taught to filter them, OR projection writes target a different table than `memory_truth` during shadow mode.

### Finding 8 — `memory_events.event_type` does not allow `entity_merge` (P2)

**Location:** `packages/mama-core/src/memory/types.ts:112`

Eng A1 says emit `memory_events` with `kind='entity_merge'`, but `MemoryEventRecord.event_type` does not allow `entity_merge` in its current type union. The recommendation needs a type update and probably a schema/query convention for entity IDs, because `memory_events` is still `memory_id`/`topic` shaped.

**Implication:** Eng A1 is a good idea but mis-estimated in effort. It requires a types.ts change, possibly a migration to extend the CHECK constraint, and a decision about how to key entity events against the memory_id column.

---

## 2. CONTRADICTIONS WITH CODE

| Plan assumption                                                                 | Code reality                                                                                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Slack observations use `scope_kind='channel'` and `scope_id=<slack_channel_id>` | `connector-init.ts:171` currently uses `scopes: [{ kind: 'project', id: projectName }]`                             |
| `memory/api.ts` reads can prefer canonical projection                           | `recallMemory()` at `api.ts:620` does not read `memory_truth` at all; reads vector/FTS/decisions                    |
| Raw evidence is immutable and replayable under the entity substrate             | Raw connector evidence lives in a separate RawStore DB; entity tables are in mama-core DB with no cross-DB identity |
| Empty migration 028 stub is safe (Eng Q3)                                       | Migration versioning marks the stub permanent; real 028 never runs                                                  |
| Existing audit queue is reusable for entity audit runs (Eng P6)                 | `AuditTaskQueue` is a synchronous memory-agent queue, not an entity audit job runner                                |

---

## 3. OVERCOMPLEXITY CANDIDATES

1. **Reuse `memory_scopes` instead of duplicating `scope_kind` + `scope_id`.** The existing table already has `kind`, `external_id`, and uniqueness constraints in `packages/mama-core/db/migrations/017-create-memory-scopes.sql:1`. Entity tables can reference `memory_scopes.id` via FK instead of carrying two denormalized columns.

2. **Skip `memory_truth` as the canonical recall bridge for v1.** Either add a small explicit entity recall query path or project entity summaries into `decisions` under a reserved kind/status. The current "truth plus recall tables" wording is too vague for the actual code.

3. **Do not adapt `AuditTaskQueue`; build a tiny persisted `EntityAuditRunQueue` around `entity_audit_runs`.** Simpler than forcing entity benchmark semantics through a conversation-audit queue.

---

## 4. STRATEGIC MISCALIBRATION

The direction is still basically right, but **the plan underestimates the raw-evidence boundary**. The real substrate problem is not just entity tables; it is making connector raw records addressable from mama-core. Without solving that, the ontology layer becomes a second projection system over already-summarized LLM outputs, which weakens the whole "raw → observation → candidate" premise.

---

## 5. AGREE WITH PRIOR REVIEWS

Correctly prioritized:

- CEO: scope binding, shadow-mode flag, fixture PII policy, error map, top-N gate, observability
- Eng: A2 migration/startup ordering, A3 audit lock, T2 pagination, P2 composite candidate index, P5 batch inserts

---

## 6. DISAGREE WITH PRIOR REVIEWS

1. **Eng Q3 is wrong:** do not commit an empty 028 stub if any DB might run it. The migration runner will mark the stub applied and the real 028 never ships.
2. **Eng P6 is mis-prioritized:** reusing `audit-task-queue.ts` is likely more work than a purpose-built entity audit queue.
3. **CEO/Eng both overstate `truth-store.ts` as a recall seam:** it is mostly a bootstrap/truth seam today, not the main recall path. Task 7's projection bridge targets the wrong pipe.

---

## 7. Cross-Model Tension Summary (for user decision)

The user must decide, per Codex-review integration rules, whether to apply these findings. Codex findings are INFORMATIONAL until explicitly approved.

### Tension points requiring decision

| #   | Topic                                | Eng Review said                                                       | Codex says                                                                              | Recommendation                                                                                                                |
| --- | ------------------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| CT1 | Migration 028 stub                   | Commit empty stub in Chunk 1, finalize in Chunk 5 (Q3)                | DO NOT commit stub. Write full 028 in Chunk 1 OR accept forward-reference in Chunk 5    | **Codex** — the migration runner behavior is a hard fact                                                                      |
| CT2 | Audit run worker                     | Reuse `audit-task-queue.ts` (P6)                                      | Build new `EntityAuditRunQueue` from scratch                                            | **Codex** — the existing queue has wrong semantics                                                                            |
| CT3 | Projection bridge target             | Task 7 bridges `truth-store.ts` and `memory/api.ts` (plan as written) | `recallMemory()` does not read `memory_truth`; bridge must be redesigned                | **Codex** — verified in code                                                                                                  |
| CT4 | Scope binding representation         | Add `scope_kind`/`scope_id` columns to entity tables (CEO Decision 1) | Reuse `memory_scopes` FK instead (overcomplexity candidate)                             | **CEO/Eng** — denormalized columns are simpler for v1; `memory_scopes` FK is cleaner but adds coupling. This is a taste call. |
| CT5 | Shadow mode guarantee                | "Shadow mode writes to memory_truth, reads stay legacy"               | Bootstrap reads all `memory_truth` rows, so shadow is not invisible                     | **Codex** — requires either bootstrap filter or a separate projection table during shadow mode                                |
| CT6 | Slack source feasibility             | Task 6 emits observations from Slack raw                              | Current save path drops raw provenance; Task 6 requires re-plumbing, not refactor       | **Codex** — Task 6 scope is larger than CEO/Eng assumed                                                                       |
| CT7 | Raw evidence boundary                | Not addressed                                                         | Connector raw records live in separate RawStore DB; no cross-DB identity with mama-core | **Codex** — most architecturally significant gap; needs `source_ref` schema decision                                          |
| CT8 | `memory_events.event_type` extension | Eng A1: emit `kind='entity_merge'`                                    | Current type union doesn't allow it; requires type + migration + keying convention      | **Codex** — Eng A1 is still directionally right but effort was under-estimated                                                |

### Proposed actions (subject to user approval)

**Hard corrections (reverse Eng recommendations):**

- Drop Eng Q3 (empty 028 stub). Replace with: "Migration 028 is written in Chunk 5 Task 10. Chunk 1 documents the reserved version but does NOT commit an empty file."
- Drop Eng P6 (reuse audit-task-queue). Replace with: "Task 11 Step 3 creates a purpose-built `EntityAuditRunQueue` under `standalone/src/api/entity-audit-queue.ts`, persisting `entity_audit_runs.status` with the partial unique index from A3. No reuse of `audit-task-queue.ts`."

**New plan additions (apply if approved):**

- **CT3 fix:** Task 7 redesign. Option A: add canonical recall path to `memory/api.ts` that reads from a new `entity_projections` table. Option B: project entity summaries into the `decisions` table with `kind='entity_canonical'` so existing recall picks them up naturally. Option A is cleaner; Option B is smaller diff.
- **CT5 fix:** Add a bootstrap filter in `buildMemoryBootstrap()` that excludes rows where `source='entity_projection'`, OR route shadow-mode projection writes to a separate `entity_projection_shadow` table that `bootstrap-builder.ts` doesn't read.
- **CT6 fix:** Task 6 explicitly scopes "re-plumb the Slack raw→LLM→save chain to preserve `source_ref = (connector, raw_record_id, ts)` end to end." This is a larger sub-task than the current plan suggests.
- **CT7 fix:** Add a new `source_ref` concept to `entity_observations` with shape `(connector_name TEXT, raw_record_db_id TEXT, raw_record_id TEXT)`. Accept cross-DB soft-reference (not FK). Document that audit replay must reach out to the per-connector RawStore to fetch raw evidence.
- **CT8 fix:** Eng A1 becomes a multi-step task: extend `MemoryEventRecord.event_type` type union, update schema CHECK constraint via new migration, decide keying convention (use `memory_id` as synthetic entity-key or add `entity_ref` column). Effort: M (not S as implied).

**Taste call (CT4):**

- **Option A (keep CEO Decision 1):** Denormalized `scope_kind`/`scope_id` on entity_nodes. Simpler, explicit, duplicates data.
- **Option B (Codex suggestion):** FK to `memory_scopes.id`. Normalized, joins needed for read, no duplication.

---

## 8. Next Steps

1. User decides which tension points (CT1-CT8) to accept.
2. For each accepted fix, update the plan file accordingly.
3. Re-run any affected test sections in the eng review's coverage diagram.
4. Proceed to `/plan-devex-review` once the plan is stable.

---

## 9. Meta-Assessment

This Codex review caught **three P1 issues** the prior reviews missed (raw evidence boundary, Slack save path raw-provenance drop, migration stub hazard) and **corrected two Eng recommendations** (Q3 and P6). These are the kind of findings that justify an outside-voice pass: they are grounded in actual code reading, not pattern matching, and they change the plan's feasibility estimate.

The findings are non-speculative. Each cites a specific file and line. The plan is stronger for the critique but the scope of Task 6 and Task 7 is larger than the CEO and Eng reviews estimated.
