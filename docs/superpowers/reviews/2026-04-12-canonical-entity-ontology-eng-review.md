# Eng Plan Review — Canonical Entity Ontology Implementation

**Target plan:** `docs/superpowers/plans/2026-04-12-canonical-entity-ontology-implementation.md` (post-CEO edits applied)
**Related specs:**

- `docs/superpowers/specs/2026-04-12-canonical-entity-ontology-architecture-design.md`
- `docs/superpowers/specs/2026-04-12-canonical-entity-benchmark-audit-design.md`
  **Prior review:** `docs/superpowers/reviews/2026-04-12-canonical-entity-ontology-ceo-review.md`

**Branch:** `codex/mama-entity-ontology`
**Base:** `main` (GitHub, `jungjaehoon-lifegamez/MAMA`)
**Reviewer:** gstack `/plan-eng-review`
**Date:** 2026-04-12
**Scope mode:** HOLD SCOPE (from CEO review)

---

## 1. Re-grounding

The plan now has the 9 CEO decisions applied: scope binding on entities, Slack as locked Task 6 source, `MAMA_ENTITY_PROJECTION_MODE` shadow mode flag, synthetic-only fixture PII policy, `false_merge_rate ≤ 0.02` hard ceiling, `entities/errors.ts` in Chunk 1 Task 1, observability as scope (Task 12), `ENTITY_EMBEDDING_TOPN=50` gate, and extractor/embedding model version columns.

Eng review's job: turn remaining architectural hazards, the 5 silent-failure gaps, and the test philosophy into concrete code tasks, with a per-branch coverage diagram.

---

## 2. Step 0 — Scope Challenge (reaffirm)

Already done in CEO; mode is HOLD SCOPE. Complexity check: still ~25 files, 6 services, but every one load-bearing. No further reduction.

### Search check (Layer 1/2/3)

- **[Layer 1]** Better-sqlite3 prepared statements, SKOS-style label model, blocking-then-scoring entity resolution. All standard tried-and-true.
- **[Layer 1]** FTS5 on `entity_aliases.normalized_label` is the boring right choice for blocking.
- **[Layer 2]** Embedding candidate ranking with a top-N gate is current best practice (dedupe.io, zingg, Splink).
- **[Layer 3]** The plan's raw→observation→candidate separation is ahead of most OSS entity-resolution libraries, which fold observation into candidate rows. This is correct for MAMA's replay/audit needs but new to most contributors. Flag it in Chunk 1 Task 1 comments.

**Prior learning applied:** `feedback_trace_full_path_before_coding` (confidence 9/10). Forcing the Slack path to be pinned before Chunk 3 prevents exactly the drift this memory warns about.

---

## 3. Section 1 — Architecture Review

### A1. Entity substrate is isolated from the existing `memory_events` audit stream (confidence 8/10)

`packages/mama-core/src/memory/event-store.ts` (migration 019) already emits audit events. The plan's `entity_merge_actions` is a parallel audit trail. An operator looking at `memory_events` sees memory changes but not entity merges, and vice versa. Future debugging will need both stitched together.

**Fix:** emit one `memory_events` row per merge action with `kind='entity_merge'`, containing `merge_action_id` + scope. Dual-written, single source of timeline truth. Add to Task 2 store helpers.

**Tradeoff:** +1 INSERT per merge. Irrelevant at expected volumes.

### A2. Migration ordering vs observation emission (confidence 9/10)

`connector-init.ts` starts connectors on MAMA OS boot. If the Slack extractor is modified (Task 6) to emit observations before migration 026 has run on the user's existing DB, `INSERT INTO entity_observations` fails and extracted memory is lost. `db-manager.ts` runs migrations on boot but connector-init may race it depending on startup order.

**Fix:** add an explicit gate in the Slack observation emitter: `if (!db.tableExists('entity_observations')) { logWarn('entity substrate not migrated yet'); return; }`. Alternatively have `connector-init` await `dbManager.ready()`. Task 6 must specify which path.

**Also:** Task 12 smoke flow must test `old DB → migrate → boot` sequence specifically.

### A3. Audit-run concurrency lock is unspecified (confidence 9/10)

Plan says `AuditRunInProgressError` but doesn't say where the lock lives. SQLite can't do `SELECT ... FOR UPDATE`. Options: (a) `entity_audit_runs.status = 'running'` row with unique-partial index; (b) in-process mutex; (c) PID file. (a) is correct for multi-process MAMA OS but requires a migration statement. (b) breaks if the standalone process restarts mid-run.

**Fix:** in migration 028, add `CREATE UNIQUE INDEX entity_audit_runs_single_running ON entity_audit_runs(status) WHERE status = 'running';` (partial index — SQLite supports it). Audit handler inserts with `status='running'`; second insert fails with SQLITE_CONSTRAINT, caller maps to `AuditRunInProgressError`. Clean, survives restarts.

Add failure test: concurrent-run rejection.

### A4. Channel lifecycle (confidence 8/10)

`scope_kind='channel'` + `scope_id=<slack_channel_id>`. Slack channels rename, archive, and get deleted. Current plan ignores this.

**Fix:** do not bind entities to channel names as scope_id. Bind to channel IDs (Slack IDs are immutable). Rename events update display labels only. Archive = soft flag. Delete = entity_observations stay (audit) but no new observations accepted. Write that rule into Task 6.

**TODO:** full channel-lifecycle handler (deleted channel → mark observations as `source_archived=true`). Defer.

### A5. `evidence_json` TEXT blob is a code smell (confidence 7/10)

`entity_merge_actions.evidence_json` as unstructured JSON in SQLite means no index, no schema enforcement, schema drift over months, hard to query historically.

**Fix options:**

- **(a)** Keep as TEXT but define a TypeScript codec (`types/merge-evidence.ts`) with runtime validation (zod/valibot) on read/write. Cheap, explicit.
- **(b)** Structured side table `entity_merge_evidence(merge_action_id, key, value_text, value_num)` key-value style. More indexable but overkill for v1.

**Recommendation: (a).** Minimal diff, explicit shape.

### A6. os-agent spec drift guard (confidence 6/10, medium)

The `docs/superpowers/specs/2026-04-12-os-agent-entity-memory-roadmap-design.md` also exists on this branch, suggesting the os-agent transition will consume entity projection. The plan's Task 12 Step 6 merge summary should call out what os-agent can now assume and what it must not assume yet to prevent the next branch from over-indexing on an unstable substrate.

**Fix:** add one paragraph to Task 12 Step 6: "os-agent consumption boundary." Low cost, high clarity.

### A7. Projection mode flag source (confidence 7/10)

Plan says config key `MAMA_ENTITY_PROJECTION_MODE`, but is this env var, standalone config file, or DB-backed? MAMA has multiple config paths. Hot-reload requires a consistent source.

**Fix:** pin to env var + standalone config file (same pattern as `MAMA_DB_PATH`). No DB-backed flag (chicken-and-egg on bootstrap). Document in Task 7 Step 4.

**Section 1 issues surfaced: 7 (A1-A7).**

---

## 4. Section 2 — Code Quality Review

### Q1. `store.ts` will be ~400 LOC of near-duplicated CRUD across 7 tables (confidence 8/10)

This is the DRY bomb. Seven very similar functions: `create*`, `get*`, `list*`, `update*` for nodes/aliases/observations/candidates/links/timeline/merge-actions.

**Fix:** extract a tiny typed repository helper `createTableRepo<TRow>(table, columns)` that returns `{insert, getById, listBy, updateFields}`. Each entity still has its typed shape, but boilerplate collapses ~70%.

**Avoid over-abstracting:** do NOT build a full ORM. Just a 30-line helper that curries `better-sqlite3` prepared statements by column list. Explicit beats clever.

Add as Task 2 Step 5a.

### Q2. Score calculation coupled to candidate generation (confidence 7/10)

Task 4 Step 4 defines the score breakdown but puts it inside `candidate-generator.ts`. Scoring logic will want to be tuned independently (per the benchmark-audit design — "structural scoring weights" is one of seven named tuning levers).

**Fix:** extract `entities/score-calculator.ts` alongside generator. Generator calls calculator. Tests target calculator directly for edge cases (NaN, all-same, dim mismatch) without wiring blocking.

Minimal diff, matches the spec's tuning-levers language.

### Q3. Migration files must be written upfront, not lazily (confidence 9/10)

Task 2 creates migrations 026/027 in Chunk 1. Task 10 creates migration 028 in Chunk 5. If someone implements chunks out of order, 028 will not exist when store tests need it. Better-sqlite3 migration runner processes files in sorted order; gaps are fine but forward-references are not.

**Fix:** write 028 as an empty stub in Chunk 1 Task 2 (`-- reserved for Chunk 5`), finalize in Chunk 5. Prevents sequencing footguns and lets `db-manager.ts` register the number early.

### Q4. `index.ts` re-exports (confidence 9/10)

Task 1 Step 3 adds types + errors. Task 2 Step 6 says to update `packages/mama-core/src/index.ts` exports, but only mentions `types` and `store`, not `errors`. Missing `errors` export means consumers cannot `instanceof EntityLabelMissingError` from outside mama-core.

**Fix:** Task 2 Step 6 must export `errors.js` alongside types/store. Explicit.

### Q5. No ASCII diagrams inline in code (confidence 7/10)

Per user preference from CLAUDE.md, complex services should carry inline diagrams. `resolution-engine.ts` decision tree (exact/cross-language/review/reject) is exactly the kind of thing that needs an inline diagram.

**Fix:** Task 5 Step 3 must add an ASCII decision-tree comment at the top of `resolution-engine.ts`. Same for `candidate-generator.ts` (blocking→scoring→topN pipeline).

**Section 2 issues surfaced: 5 (Q1-Q5).**

---

## 5. Section 3 — Test Review

**Test framework detection:** Vitest (confirmed from `packages/mama-core/tests/unit/mobile-daemon.test.ts` and plan's explicit `vitest run` commands).

### Code path coverage diagram

```
CODE PATHS
==========================================================
[+] entities/types.ts
    └── pure types, 0 branches ─────── [★★★ PLANNED]

[+] entities/errors.ts
    ├── EntityError base ──────────── [★★ PLANNED]
    └── 7 subclasses w/code+context ─ [★★ PLANNED]

[+] entities/normalization.ts
    ├── normalizeEntityLabel
    │   ├── happy ko/en/ja ──────────── [★★★ PLANNED]
    │   ├── null/undefined ──────────── [GAP] → InvalidEntityLabelError
    │   ├── non-string ──────────────── [GAP] → InvalidEntityLabelError
    │   ├── non-BMP unicode (emoji/CJK) [GAP] preserve
    │   ├── homoglyph (Cyrillic vs Latin) [GAP] no false-merge
    │   └── 64KB boundary ──────────── [GAP]
    ├── detectScript
    │   ├── single-script ──────────── [★★ PLANNED]
    │   └── mixed-script ko+en ─────── [GAP]
    └── extractStructuredIdentifiers
        ├── email/handle/domain ────── [★★ PLANNED]
        └── malformed partial match ── [GAP]

[+] entities/store.ts
    ├── create/get/list nodes ──────── [★★ PLANNED]
    │   ├── scope_kind=global+NULL ─── [GAP]
    │   ├── UNIQUE preferred_label ─── [GAP]
    ├── attachAlias
    │   ├── happy ─────────────────── [★★ PLANNED]
    │   ├── FK violation ──────────── [GAP]
    │   └── duplicate (entity_id,norm) [GAP]
    ├── insertObservation
    │   ├── w/ extractor_version ─── [★★ PLANNED]
    │   ├── missing version NOT NULL [GAP]
    │   └── on merged entity ──────── [GAP]
    ├── insertCandidate ──────────── [★★ PLANNED]
    │   ├── neg score ────────────── [GAP]
    │   └── already-merged target ── [GAP]
    ├── insertMergeAction ────────── [★★ PLANNED]
    │   ├── MergeTargetStaleError ── [GAP]
    │   └── evidence_json too large  [GAP]
    ├── listCandidatesByStatus ──── [★★ PLANNED]
    │   ├── empty ─────────────────── [GAP]
    │   └── stable sort by score+date [GAP]
    └── migration 026/027 partial ── [GAP] — what if 026 applied but 027 hasn't?

[+] entities/candidate-generator.ts
    ├── blockByNormalizedLabel ──── [★★★ PLANNED]
    │   ├── 10k-alias block (top-N holds) [GAP→hostile]
    │   └── empty block ───────────── [GAP]
    ├── blockByStructuredId ─────── [★★ PLANNED]
    │   └── conflicting blocks ───── [GAP]
    ├── scoreCandidate ──────────── [★★ PLANNED]
    │   ├── EmbeddingUnavailableError [GAP] candidate stays pending
    │   ├── embedding dim mismatch ─ [GAP]
    │   ├── all-same-score ties ──── [GAP]
    │   └── NaN in sub-score ──────── [GAP]
    └── topNGate ─────────────────── [★★ PLANNED] (Task 4 explicit)

[+] entities/resolution-engine.ts
    ├── evaluateResolutionCandidate
    │   ├── exact structural → auto ─ [★★ PLANNED]
    │   ├── cross-lang → review ──── [★★ PLANNED]
    │   ├── OntologyViolationError ─ [GAP]
    │   ├── stale candidate race ─── [GAP]
    │   └── dual-approve race ────── [GAP]
    ├── shouldAutoMerge
    │   └── cross-lang+structural key [GAP] — can this slip through?
    └── buildReviewReason ────────── [★ PLANNED]

[+] entities/projection.ts
    ├── projectEntityToMemoryRecord [★★ PLANNED]
    │   ├── EntityLabelMissingError  [GAP]
    │   ├── circular merged_into ── [GAP]
    │   └── mode=off no-op ───────── [GAP]
    ├── projectEntityToTruthRow ─── [★★ PLANNED]
    │   └── concurrent read/write ─ [GAP]
    └── projectTimelineSlice ────── [★ PLANNED]

[M] standalone/memory/history-extractor.ts (Slack)
    ├── extractObservations
    │   ├── Slack raw → obs w/scope  [★★★ PLANNED]
    │   ├── version stamping ────── [★★ PLANNED]
    │   ├── missing source_ref warn [★★ PLANNED]
    │   ├── channel renamed mid-batch [GAP]
    │   ├── channel archived ───── [GAP]
    │   └── mixed-lang raw batch ── [GAP]

[M] mama-core/memory/api.ts (projection mode)
    ├── recallMemory off ────────── [★★ PLANNED]
    ├── recallMemory shadow ────── [★★ PLANNED]
    ├── recallMemory dual-write ── [★★ PLANNED]
    ├── EntityLabelMissingError ── [★★ PLANNED]
    ├── mode flip mid-session ──── [GAP]
    └── config key missing ─────── [GAP] default shadow + warn

[+] standalone/api/entity-review-handler.ts
    ├── GET /candidates
    │   ├── list ─────────────────── [★★ PLANNED]
    │   ├── auth failure ─────────── [GAP]
    │   ├── pagination ──────────── [GAP] ← hard requirement if 10k+
    │   └── scope-filtered by auth ─ [GAP]
    ├── GET /candidates/:id
    │   ├── detail ──────────────── [★★ PLANNED]
    │   ├── 404 unknown ─────────── [GAP]
    │   └── cross-scope access ─── [GAP]
    ├── POST /approve|reject|defer
    │   ├── happy ────────────────── [★★ PLANNED]
    │   ├── CandidateStaleError 409 [GAP]
    │   ├── actor_id from auth ──── [GAP] ← security
    │   └── idempotency ─────────── [GAP]

[+] standalone/api/entity-audit-handler.ts
    ├── POST /audit/run ────────── [★★ PLANNED]
    │   ├── AuditRunInProgressError [GAP] ← lock via A3
    │   ├── time budget ────────── [GAP]
    │   └── baseline missing→inconc [GAP]
    ├── GET /audit/runs ────────── [★ PLANNED]
    └── GET /audit/runs/:id
        ├── detail ──────────────── [★ PLANNED]
        └── 404 ────────────────── [GAP]

[+] viewer/modules/entity-review.ts
    ├── queue list
    │   ├── renders ─────────────── [★★ PLANNED]
    │   ├── empty state ─────────── [★★ PLANNED]
    │   ├── loading state ──────── [GAP]
    │   └── network error state ── [GAP]
    ├── candidate detail
    │   └── stale 409 UX ───────── [GAP]
    └── approve/reject/defer
        ├── api trigger ────────── [★★ PLANNED]
        ├── double-click idempotent [GAP]
        └── keyboard nav ───────── [GAP]

[+] viewer/modules/entity-audit.ts
    ├── baseline delta ─────────── [★★ PLANNED]
    ├── inconclusive rendering ── [GAP]
    └── regressed highlight ───── [GAP]

USER FLOWS
==========
[+] Reviewer resolves 10 candidates
    ├── individual approve ────── [★★ PLANNED]
    ├── [→E2E] full flow load→list→detail→approve→refresh [GAP]
    └── session expires mid-flow  [GAP]

[+] Operator triggers audit run
    ├── trigger ────────────────── [★★ PLANNED]
    ├── [→E2E] run→report render→delta  [GAP]
    └── 10min run wait UX ─────── [GAP]

─────────────────────────────────────────
COVERAGE (plan as written):
  Code paths: ~22/57 tested (39%)
  User flows: ~2/7 tested (29%)
  QUALITY: ★★★=6  ★★=~28  ★=~3  GAPS=~38
─────────────────────────────────────────
```

**Verdict: 38 test gaps. Below lakeboiling threshold. Boil.**

### T1 — Mandatory test additions (add to each chunk's task)

- **Chunk 1 Task 1/2:** normalization null/non-string/non-BMP/homoglyph/length; store FK/UNIQUE/scope=global+NULL; `insertObservation` without version fails.
- **Chunk 2 Task 4:** 10k-alias hostile test; `EmbeddingUnavailableError` path; NaN/tie/dim-mismatch.
- **Chunk 2 Task 5:** `OntologyViolationError` path; stale candidate race; dual-approve race via SQL transaction conflict.
- **Chunk 3 Task 6:** Slack channel rename mid-batch; archived channel new observation rejected.
- **Chunk 3 Task 7:** `EntityLabelMissingError`; circular merged_into; concurrent read/write visibility; config key missing warns and defaults.
- **Chunk 4 Task 8:** `CandidateStaleError` 409; `actor_id`-from-auth (security test, not just function test); idempotent replay.
- **Chunk 4 Task 8 + 9:** pagination contract (add to plan, see T2); empty/loading/error states in viewer; keyboard nav.
- **Chunk 5 Task 11:** concurrent audit-run rejection via partial index; time budget enforcement.
- **Chunk 6 Task 12:** E2E reviewer flow + E2E audit flow.

**Regression check:** Plan modifies `memory/api.ts` and `memory/truth-store.ts`. Existing `tests/unit/memory-v2-bootstrap-builder.test.ts` and `tests/unit/memory-v2-extraction.test.ts` must be run green after projection mode wiring — plan's Task 7 Step 5 names these. But it only runs them. Add a test that toggles `MAMA_ENTITY_PROJECTION_MODE` through all three modes and asserts legacy recall is unchanged in `off` and `shadow`. **This is the regression test.** The whole v1 safety argument hinges on it.

### T2 — Missing contract: pagination

`/api/entities/candidates` has no pagination in plan or spec. At 10k+ candidates (realistic once Slack backfill runs), the viewer OOMs and the API response is minutes. Add now.

**Fix:** `GET /api/entities/candidates?limit=50&cursor=<opaque>` with cursor = `(score_total, id)` tuple. Default limit 50. Document in Task 8 Step 3.

**Section 3 issues surfaced: 2 structural (T1, T2) + 38 code-path/user-flow gaps to add.**

---

## 6. Section 4 — Performance Review

### P1. `entity_resolution_candidates` retention (confidence 7/10)

Candidates never expire. After 6 months of Slack ingest this could be hundreds of thousands of rows. The review queue only cares about `status='pending'`, audit cares about historical, but no archive boundary exists.

**Fix:** TODO for v2 — retention policy (e.g., `status IN ('auto_merged','rejected')` older than 180 days → archive table). Defer, but acknowledge.

### P2. `listCandidatesByStatus` index strategy (confidence 8/10)

Plan says "indexes for candidate status, score ordering." Unclear if composite. Without `(status, score_total DESC)` composite, the common query "list pending candidates ordered by score" does a filesort.

**Fix:** explicit index in migration 027: `CREATE INDEX entity_candidates_status_score ON entity_resolution_candidates(status, score_total DESC, created_at DESC);`. Write into Task 2 Step 4.

### P3. Embedding work bounded by top-N=50

No issue — CEO fix (Task 4) holds.

### P4. Viewer list O(all candidates)

Covered by T2 pagination.

### P5. `history-extractor` Slack path emits per-record observation INSERTs (confidence 7/10)

If Slack backfill hits 50k messages and each message emits 2-5 observations, that is 100k-250k individual INSERTs. Without a transaction wrapper, commit overhead dominates.

**Fix:** observation batch insertion — wrap per-batch observations in a single `db.transaction(() => {...})`. Better-sqlite3 makes this a one-liner. Add to Task 6 Step 3.

### P6. Audit run time budget (confidence 7/10)

Plan says "per-run time budget in the audit handler" (CEO edit) but does not specify enforcement. Long-running vitest-style replays should not block the API request thread.

**Fix:** audit runs execute on a worker or detached task, API returns run_id immediately and status polling via `GET /runs/:id`. Standalone has existing job infrastructure (`audit-task-queue.ts`). Reuse it. Write into Task 11 Step 3.

**Section 4 issues surfaced: 4 (P1 defer, P2/P5/P6 concrete fix).**

---

## 7. Failure Modes Registry (updated)

| Codepath                | Failure            | Rescued?                   | Test?      | User sees?              | Logged?   | Severity          |
| ----------------------- | ------------------ | -------------------------- | ---------- | ----------------------- | --------- | ----------------- |
| normalization           | null/non-string    | pre-edit ❌                | T1 adds    | error surfaced          | ❌        | RESOLVED by T1    |
| candidate-gen           | embedding unavail  | pre-edit ❌                | T1 adds    | candidate stays pending | needs log | RESOLVED by T1+Q2 |
| resolution-engine       | ontology violation | partial                    | T1 adds    | review queue            | needs log | RESOLVED by T1    |
| projection              | missing label      | pre-edit ❌                | T1 adds    | error via API           | needs log | RESOLVED by T1    |
| review-handler approve  | stale race         | pre-edit ❌                | T1 adds    | 409 + UX                | needs log | RESOLVED by T1    |
| audit-handler run       | concurrent         | pre-edit ❌                | T1 adds    | 409                     | needs log | RESOLVED by A3+T1 |
| history-extractor       | missing source_ref | structured warn (CEO edit) | T1 adds    | nothing                 | ✅        | RESOLVED by CEO   |
| migration 026/027/028   | partial apply      | ❌                         | add        | unclear                 | ❌        | **NEW GAP (A2)**  |
| history-extractor batch | txn overhead       | ❌                         | add        | slow                    | ❌        | RESOLVED by P5    |
| api /candidates list    | 10k rows           | ❌                         | pagination | OOM                     | ❌        | RESOLVED by T2    |

**Net: 0 remaining critical silent-failure gaps** after applying this review's fixes. One migration-ordering gap (A2) is high priority.

---

## 8. NOT in Scope (confirmed — CEO + eng)

- Full RDF runtime
- Full memory API rewrite
- Cross-language auto-merge
- os-agent same-view
- Retention/archive for candidates (→ TODO)
- Channel lifecycle handler (→ TODO)
- Structured side table for merge evidence (Q5 option b, deferred)
- Full `/plan-design-review` pass on the minimal viewer (optional)

## 9. What Already Exists (reused correctly — verified from code probe)

- `memory/truth-store.ts`, `memory/api.ts`, `memory/evolution-engine.ts` (intentionally NOT reused — correct)
- `memory/event-store.ts` → **should also be reused for merge audit stream (A1)**
- `db-manager.ts` FTS/vector
- `standalone/src/memory/history-extractor.ts`
- `standalone/src/api/graph-api.ts`
- `standalone/src/memory/audit-task-queue.ts` → **should be reused for audit-run worker (P6)**

## 10. TODOs (proposed)

1. **Retention policy for `entity_resolution_candidates`** (P1). P3.
2. **Channel lifecycle handler** — Slack channel delete/archive/rename → observation soft-flag (A4). P2.
3. **Structured evidence side-table** (Q5 option b) — if `evidence_json` schema drift becomes painful in v2. P3.
4. **E2E test suite for reviewer + auditor flows** — beyond Task 12 unit smokes. P2.
5. Prior TODOs from CEO still stand: embedding model version lock (partially addressed by Decision 9), cross-language auto-merge v2, review queue bulk actions, dashboard/wiki projection consumers, continuous audit monitoring.

---

## 11. Worktree Parallelization Strategy

| Step                                     | Modules touched                                                                            | Depends on                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Chunk 1 (Tasks 1-3)                      | `mama-core/src/entities/*` types/errors/normalize/store + `db/migrations/026,027`          | —                                        |
| Chunk 2 Task 4 (candidate-gen)           | `mama-core/src/entities/candidate-generator.ts` + score-calculator                         | Chunk 1                                  |
| Chunk 2 Task 5 (resolution)              | `mama-core/src/entities/resolution-engine.ts`                                              | Chunk 2 Task 4                           |
| Chunk 3 Task 6 (Slack ingest)            | `standalone/src/memory/*`, `standalone/src/cli/runtime/connector-init.ts`, Slack connector | Chunk 1                                  |
| Chunk 3 Task 7 (projection)              | `mama-core/src/entities/projection.ts`, `memory/truth-store.ts`, `memory/api.ts`           | Chunk 2                                  |
| Chunk 5 Task 10 fixtures + audit-metrics | `mama-core/tests/entities/fixtures/*`, `audit-metrics.test.ts`, `db/migrations/028`        | Chunk 1 (types)                          |
| Chunk 4 Task 8 (review API)              | `standalone/src/api/entity-review-handler.ts` + graph-api wiring                           | Chunk 2                                  |
| Chunk 4 Task 9 (review viewer)           | `standalone/public/viewer/src/modules/entity-review.ts` + api.ts/viewer.html               | Chunk 4 Task 8                           |
| Chunk 5 Task 11 (audit API+viewer)       | `entity-audit-handler.ts` + `entity-audit.ts` viewer                                       | Chunk 5 Task 10 + audit-task-queue reuse |
| Chunk 6 Task 12 (verify + observability) | cross-cutting                                                                              | All                                      |

### Lanes

- **Lane A:** Chunk 1. Must finish first. Sequential.
- **Lane B:** Chunk 2 Task 4 → Task 5. Sequential within lane.
- **Lane C:** Chunk 5 Task 10 (fixtures + audit-metrics + migration 028). Can parallel with Lane B after Lane A.
- **Lane D:** Chunk 3 Task 6 (Slack ingest). Can parallel with Lane B/C after Lane A; touches `standalone/src/memory/`.
- **Lane E:** Chunk 3 Task 7 (projection). Depends on Lane B complete; touches `memory/truth-store.ts`.
- **Lane F:** Chunk 4 Tasks 8+9 (review API+UI). Parallel with Lane E after Lane B.
- **Lane G:** Chunk 5 Task 11 (audit API+UI). After Lane C + Lane F.

### Conflict flags

- Lanes D + E both touch `memory/api.ts` → **serialize D → E**.
- Lanes F + G both touch `standalone/src/api/graph-api.ts` → **serialize F → G** or land route additions in a single merge.

### Execution order

1. Lane A (solo)
2. Lanes B + C + D in parallel
3. Lane E (after B, D)
4. Lane F (after B)
5. Lane G (after C, F)
6. Chunk 6 Task 12 verification

---

## 12. Completion Summary

```
+====================================================================+
|         ENG PLAN REVIEW — COMPLETION SUMMARY                       |
+====================================================================+
| Step 0               | Scope accepted (HOLD from CEO)               |
| Section 1  (Arch)    | 7 issues (A1-A7; 1 medium conf)              |
| Section 2  (Quality) | 5 issues (Q1-Q5)                             |
| Section 3  (Tests)   | 2 structural issues (T1, T2) + 38 code-path  |
|                      | + user-flow gaps. Coverage diagram produced. |
| Section 4  (Perf)    | 4 issues (P1-P6; 1 defer)                    |
+--------------------------------------------------------------------+
| Critical silent-failure gaps (post-fix) | 0 — all resolved if       |
|                                         | A3/T1/T2/P5/P6 applied    |
| NEW architecture gap                    | A2 (migration ordering)   |
| NOT in scope         | 6 items confirmed                            |
| What already exists  | 8 reuses (2 new: event-store, audit-queue)   |
| TODOS proposed       | 5 eng-specific + 5 from CEO still relevant   |
| Parallelization      | 7 lanes, 3 parallel phases, 2 conflict flags |
| Outside voice        | Skipped (deferred to end of review cycle)    |
| Lake Score           | 18/18 recommendations chose complete option  |
+====================================================================+
```

---

## 13. Recommended Fixes (17)

### High priority (apply before implementation)

| #   | Fix                                                                       | Scope         |
| --- | ------------------------------------------------------------------------- | ------------- |
| A2  | Task 6 table-exists guard + Task 12 old-DB→migrate→boot smoke             | ingest        |
| A3  | Migration 028 partial unique index for single-running audit               | audit         |
| A5  | `types/merge-evidence.ts` codec for evidence_json                         | store         |
| A7  | Projection mode = env + standalone config, documented in Task 7           | projection    |
| Q1  | `createTableRepo` helper in Task 2 Step 5a                                | store         |
| Q2  | `entities/score-calculator.ts` extracted                                  | candidate-gen |
| Q3  | Migration 028 empty stub committed in Chunk 1                             | migrations    |
| Q4  | Task 2 Step 6 exports `errors` from index.ts                              | exports       |
| Q5  | ASCII decision-tree comments in resolution-engine and candidate-generator | code comments |
| T1  | 38 new failure-path tests distributed across chunks                       | tests         |
| T2  | Pagination contract on `/api/entities/candidates`                         | API           |
| P2  | Composite index `(status, score_total DESC, created_at DESC)` on 027      | migration     |
| P5  | Transaction wrapper in Slack extractor batch insert                       | ingest        |
| P6  | Audit runs use existing `audit-task-queue.ts` worker                      | audit         |

### Medium

| #   | Fix                                                                | Scope         |
| --- | ------------------------------------------------------------------ | ------------- |
| A1  | Mirror merge actions into `memory_events` as `kind='entity_merge'` | audit stream  |
| A4  | Channel ID (immutable) as `scope_id`, not channel name             | ingest        |
| A6  | Task 12 Step 6 os-agent consumption boundary paragraph             | merge summary |

---

## 14. Next Steps

1. Apply all 17 recommendations to the plan file (or pick & choose).
2. Write the test plan artifact to `~/.gstack/projects/jungjaehoon-lifegamez-MAMA/` for `/qa` consumption.
3. Log eng review via `gstack-review-log`.
4. Proceed to `/plan-devex-review`.
5. Optional: run outside voice (`/codex review`) after DX.
