# CEO Plan Review — Canonical Entity Ontology Implementation

**Target plan:** `docs/superpowers/plans/2026-04-12-canonical-entity-ontology-implementation.md`
**Related specs:**

- `docs/superpowers/specs/2026-04-12-canonical-entity-ontology-architecture-design.md`
- `docs/superpowers/specs/2026-04-12-canonical-entity-benchmark-audit-design.md`

**Branch:** `codex/mama-entity-ontology`
**Base:** `main` (GitHub, `jungjaehoon-lifegamez/MAMA`)
**Reviewer:** gstack `/plan-ceo-review`
**Date:** 2026-04-12
**Recommended mode:** HOLD SCOPE

---

## 1. Pre-Review System Audit

| Item                 | Finding                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch state         | `codex/mama-entity-ontology`, no PR, 3 new untracked docs only — zero code yet                                                                                                           |
| Migration slot       | Last on-disk migration is `025-extend-kind-check.sql`; plan adds `026/027/028` — contiguous                                                                                              |
| Reuse surface        | `memory/truth-store.ts`, `memory/evolution-engine.ts`, `db-manager.ts`, `standalone/src/memory/history-extractor.ts`, `standalone/src/api/graph-api.ts` — all exist, all cited correctly |
| Prior reviews        | None logged for this branch                                                                                                                                                              |
| Design docs          | Two on-repo specs (architecture + benchmark-audit) serve as the design source                                                                                                            |
| Checkpoint alignment | User checkpoint explicitly warns **"do not drift into os-agent same-view completion or broad worker/auditor refactors"**                                                                 |
| Recent memory work   | v0.18 memory stabilization, v0.16 LongMemEval — third major memory-layer refactor                                                                                                        |
| Design scope         | YES — Tasks 9 & 11 ship `entity-review.ts` and `entity-audit.ts` viewer modules (minimal)                                                                                                |

**Retrospective note:** The memory layer is the third substrate being refactored in 6 months. The plan explicitly says "do not patch topic logic forever" — this reads as lessons from prior cycles. Good signal, not a red flag.

---

## 2. Step 0A — Premise Challenge

**Is this the right problem?** Yes, concretely. The pain is not theoretical: `Project Alpha / 프로젝트 알파 / プロジェクトアルファ / Alpha launch stream` are real connector outputs in MAMA OS today, and the current `topic`-centric memory collides them or fragments them. The architecture doc's Gap 2 (`topic` overloaded as identity) and Gap 4 (no multilingual alias layer) are observable in `packages/mama-core/src/memory/` — there is no entities module and the truth-store pivots on topic.

**Proxy skepticism.** One risk: is "ontology" fashionable framing, or load-bearing? Load-bearing. The SKOS/SHACL/PROV concepts map onto real needs (multilingual labels, review rules, provenance) that would otherwise be ad-hoc. The plan correctly stops short of a full RDF runtime.

**Do nothing?** Each new connector in v0.17+ compounds the fragmentation. Validation session (v0.19) and os-agent (next branch) both depend on durable identity. The cost of waiting is real.

**Framing risk:** the plan is substrate-first, not user-outcome-first. End-user visible benefit lands at Task 6 (one real source) and Task 7 (one projection bridge) — Chunks 3-4 out of 6. A cathedral built before anyone can see the stained glass. Mitigations are in the Issues section.

---

## 3. Step 0B — Existing Code Leverage

| Sub-problem                                                          | Existing code                                | Reused?                      | Notes                                                                        |
| -------------------------------------------------------------------- | -------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------- |
| Truth projection seam                                                | `memory/truth-store.ts`                      | ✅ Task 7                    | Correct — extends, doesn't replace                                           |
| Raw→memory ingest path                                               | `standalone/src/memory/history-extractor.ts` | ✅ Task 6                    | Correct — observation layer inserted before truth                            |
| Auth + API routing                                                   | `standalone/src/api/graph-api.ts`            | ✅ Tasks 8, 11               | Correct                                                                      |
| FTS + vector wiring                                                  | `db-manager.ts` + existing embeddings        | ✅ Task 4                    | Candidate-generator reuses, not rebuilds                                     |
| Decision edges (`supersedes`, `builds_on`, `debates`, `synthesizes`) | `memory/evolution-engine.ts`                 | ❌ Intentionally avoided     | Correct — memory evolution ≠ identity resolution (Gap 6)                     |
| Scope isolation                                                      | `memory/scope-store.ts`                      | ⚠️ **Not mentioned in plan** | Entity nodes/aliases/observations have no scope binding in the plan's schema |

**Rebuilding check:** The plan is NOT rebuilding topic-centric memory. It's adding a new substrate below it. Clean.

**Gap:** the plan's schema has no scope binding (project/user/channel/global). Today mama-core isolates memories per scope — if entities are global-only, a multi-tenant MAMA install can cross-contaminate canonical identities. See Issue 1.

---

## 4. Step 0C — Dream State Delta

```
CURRENT STATE                    THIS PLAN                      12-MONTH IDEAL
─────────────                    ─────────                      ──────────────
topic-centric memory    →        raw → observation →            os-agent pulls canonical
decisions/truth/recall           candidate → review →           identity; wiki pages generated
multilingual collides            canonical → projection         from canonical; dashboard shows
                                 (shadow mode, one real         linked people/projects/work items;
                                 source, minimal viewer)        continuous audit classifies every
                                                                tuning move
```

Direction: **toward** the ideal. Ambition: **right-sized for one branch** given the explicit non-goals. The audit loop shipping in v1 is the most important decision — without it, future tuning is unmeasurable.

---

## 5. Step 0C-bis — Implementation Alternatives

### Approach A — "Substrate-first, shadow mode" (the current plan)

- **Effort:** L (human team ~1 week / CC+gstack ~4-6 hours). **Risk:** Med.
- **Pros:** Clean substrate, reversible, raw-first, audit loop ships in v1 so quality is measurable, narrow auto-merge caps false-merge damage.
- **Cons:** End-user value delayed to projection consumers in v2; only one real connector wired; viewer UI is minimal so dogfooding is weak.
- **Reuses:** truth-store seam, history-extractor, graph-api, db-manager, FTS/vector.

### Approach B — "Vertical slice, one connector end-to-end"

- **Summary:** Pick one connector up front. Cut candidate-generator to exact+structural only. Skip multilingual candidate generation. Full review UI on that slice. No audit layer in v1.
- **Effort:** M. **Risk:** Low for slice, HIGH that substrate won't generalize.
- **Pros:** Faster user-visible result; easier to dogfood.
- **Cons:** Kills the multilingual premise, which is the whole point. No audit = no trust signal. Rebuilding later is painful and requires re-migrating raw records.
- **Verdict:** Rejected. The multilingual cut defeats the architecture's reason for existing.

### Approach C — "Observation layer first, resolution deferred"

- **Summary:** Ship only raw→observation→projection in v1. No candidate gen, no resolution, no review queue.
- **Effort:** S-M. **Risk:** Low structurally.
- **Pros:** Smallest substrate that unlocks next branch; minimum false-merge risk (no merging).
- **Cons:** Ships zero canonical identity improvement. Multilingual pain unresolved in v1. v2 has to do candidate+resolution+review anyway — work is delayed, not reduced.
- **Verdict:** Rejected. Doesn't pay rent for the branch.

### Recommendation

**Approach A** because it is the only option that (a) preserves the multilingual premise, (b) caps false-merge risk via narrow auto-merge + audit, and (c) doesn't defer the hard problem to another branch. Needs two sharpening edits — see Issues 2 and 3.

---

## 6. Step 0D — Mode-Specific Analysis

**Complexity check (HOLD lens):**

- Files touched: ~25 (14 create in mama-core entities + fixtures + audit, 8 create in standalone api/viewer/tests, ~6 modify). Above the 8-file smell threshold.
- New "classes/services": entities module (types/normalization/store/candidate-generator/resolution-engine/projection) = 6 logical services. Above the 2-service smell threshold.
- **But:** every one is load-bearing — pipeline stages cannot collapse without losing the raw→observation→candidate→resolution→projection contract.
- **Verdict:** size is justified, not overbuilt.

**Minimum set that ships value:** Tasks 1-7 = substrate + one real source + projection. Tasks 8-9 = review UI. Tasks 10-11 = audit loop. Task 12 = verify. Each chunk is load-bearing for different reasons and none can be cut without killing a capability.

**Expansion scan:** None recommended. The checkpoint's explicit non-drift instruction, the user's `feedback_verify_goal_alignment` memory, and the plan's disciplined non-goals list all say hold scope.

---

## 7. Step 0E — Temporal Interrogation

Implementation decisions that should be resolved NOW, not at implementation time:

| Hour              | Implementer will hit                                     | Plan currently says                                       | Pre-resolve?                        |
| ----------------- | -------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------- |
| H1 (foundations)  | Which connector source for Task 6?                       | "one operational source path already present in the repo" | **YES — pick now**                  |
| H2-3 (resolution) | Where do embeddings come from for candidate scoring?     | silent                                                    | **YES — decide reuse vs new table** |
| H3 (store)        | Do entities/aliases/observations carry `scope` bindings? | silent                                                    | **YES — missing contract**          |
| H4 (projection)   | Shadow mode expressed as what? Feature flag? Config key? | "shadow mode first" in spec, not in plan                  | **YES — needs a concrete toggle**   |
| H5 (review)       | Does the review viewer require auth? Which tier?         | silent                                                    | YES — use existing graph-api auth   |
| H6 (audit)        | What is the concrete v1 target for `false_merge_rate`?   | "no worse than baseline" but no baseline exists yet       | **YES — need starter threshold**    |

These become Issues 1-6 below.

---

## 8. Step 0F — Mode Recommendation

**Recommended mode: HOLD SCOPE.**

- **Why:** Checkpoint explicitly says do not drift. User memory `feedback_verify_goal_alignment` reinforces. Plan is right-sized — each layer is load-bearing. Substrate-first is the correct shape; expanding would drift into os-agent or full same-view completion.
- **Posture:** Make it bulletproof — architecture, error paths, scope isolation, observability, rollback. No scope growth. No cherry-picks.

---

## 9. Review Sections (HOLD mode) — findings only where real issues exist

### Section 1: Architecture Review

```
NEW SUBSTRATE (packages/mama-core/src/entities/)
┌──────────────────────────────────────────────────────────────────┐
│  types.ts                                                         │
│       │                                                           │
│       ▼                                                           │
│  normalization.ts ────────┐                                       │
│       │                    │                                      │
│       ▼                    ▼                                      │
│  store.ts ◄─── candidate-generator.ts ◄─── (embeddings pipeline)  │
│       │                    │                                      │
│       │                    ▼                                      │
│       │            resolution-engine.ts                           │
│       │                    │                                      │
│       │                    ▼                                      │
│       └──────────────► projection.ts                              │
│                            │                                      │
│                            ▼                                      │
│             memory/truth-store.ts (existing, bridged)             │
│             memory/api.ts (existing, bridged)                     │
└──────────────────────────────────────────────────────────────────┘

INGEST EDGE
  standalone/src/memory/history-extractor.ts
       │  (Task 6 — emits EntityObservation alongside existing outputs)
       ▼
  mama-core entity_observations  (append-only)

API/UI EDGE
  standalone/src/api/entity-review-handler.ts ──┐
  standalone/src/api/entity-audit-handler.ts ───┼── graph-api.ts (existing auth)
                                                │
  standalone/public/viewer/src/modules/entity-review.ts
  standalone/public/viewer/src/modules/entity-audit.ts
```

**Findings:**

- Boundaries clean — entity substrate is beneath memory, not parallel to it.
- Projection is one-directional (canonical → truth), preventing circular identity authority.

**Issue 1 — Scope isolation missing.**
Schema has no `scope_id` or scope binding on `entity_nodes` / `entity_aliases` / `entity_observations`. Current mama-core isolates memories per project/channel/user/global. If entities are global-only, a user running MAMA OS across multiple projects will see canonical identities collide across tenants. **Fix:** add `scope_ref` (kind + id) to `entity_nodes`, or an `entity_scope_bindings` table. Decide now.

**Issue 2 — Task 6 source is unspecified.**
"one operational source path already present in the repo" defers a load-bearing decision to implementation time. With MAMA OS having Notion, Slack, Telegram, Discord, Chatwork, Gmail, Calendar, Drive, Sheets, Trello, Obsidian, Kagemusha connectors, the choice determines whether the slice is multilingual (i.e., actually tests the premise). **Fix:** pin the source now. Recommendation: Slack/Telegram channel names + messages (highest multilingual density in your data) or Notion project pages. Commit before Chunk 3.

**Issue 3 — "Shadow mode" is vocabulary, not mechanism.**
The architecture spec names shadow mode as the migration strategy. The implementation plan does not express it as a concrete switch. Without a concrete switch, Chunk 3 Task 7 step 4 ("Bridge the existing truth path...without deleting the old behavior") is ambiguous. **Fix:** add `MAMA_ENTITY_PROJECTION_MODE = off | shadow | dual-write` as a config key, default `shadow` in v1. Projection writes happen, but `memory/api.ts` reads fall back to legacy topic path unless `dual-write` is set.

**Issue 4 — No rollback plan.**
Migrations 026/027/028 add 9 tables. If projection bridge breaks production reads, what's the rollback? Migrations in this repo are forward-only (no down scripts in `db/migrations`). **Fix:** document the rollback as "feature flag off + leave tables in place; data is append-only so tables are inert when unread." Write that rollback step into Task 12.

### Section 2: Error & Rescue Map

Plan currently has zero explicit error handling coverage. Every test says "failing tests first, implement, tests pass" — no error-path tests, no failure-mode tests, no exception class names.

| Method / codepath                         | What can go wrong                           | Exception class (proposed)                | Plan mentions? |
| ----------------------------------------- | ------------------------------------------- | ----------------------------------------- | -------------- |
| `normalizeEntityLabel(input)`             | null / empty / non-string / invalid Unicode | `InvalidEntityLabelError`                 | ❌             |
| `candidate-generator` blocking            | no aliases match any block → empty set      | (returns empty, not error)                | ❌             |
| `candidate-generator` embedding call      | embedding model unavailable / timeout       | `EmbeddingUnavailableError`               | ❌             |
| `resolution-engine.shouldAutoMerge`       | conflicting ontology + evidence             | `OntologyViolationError` (→ review queue) | ❌             |
| `store.insertMergeAction`                 | merge target already superseded             | `MergeTargetStaleError`                   | ❌             |
| `projection.projectEntityToTruthRow`      | canonical entity has no preferred label     | `EntityLabelMissingError`                 | ❌             |
| `history-extractor` emitting observations | raw record missing source_ref               | (silent drop today)                       | ❌             |
| `entity-review-handler` POST approve      | candidate status already resolved (race)    | `CandidateStaleError` (409)               | ❌             |
| `entity-audit-handler` POST run           | concurrent audit run in progress            | `AuditRunInProgressError`                 | ❌             |

**Issue 5 — Error map is a hole.** Chunk 1 Task 1 must add `errors.ts` listing these classes before Chunks 2-4. Tests in Chunks 2-5 must include at least one failure-path test per module (not just happy-path). Eng review should hammer this.

### Section 3: Security & Threat Model

| Concern                               | Plan stance                                                           | Finding                                                                                                                                                                                                         |
| ------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New API surface                       | `/api/entities/candidates*`, `/api/entities/audit*` on `graph-api.ts` | Uses existing auth-middleware (good). Need scope-level authorization — e.g., reviewer must have scope access to approve a merge affecting that scope's entities.                                                |
| Review action integrity               | "every approved merge attributable"                                   | Good principle. Verify `actor_id` is pulled from auth context, not POST body.                                                                                                                                   |
| Prompt injection via raw observations | extractor reads raw strings that could contain adversarial content    | Not addressed. Observations are not executed as prompts in this plan, so risk is low, but flag it: if extractor uses LLM, injection can poison `entity_kind_hint`.                                              |
| PII in benchmark fixtures             | `historical-replay-sample.json` = real raw records                    | CONCERN. Need a written rule: fixtures must not contain real names from the user's actual Slack/Notion/etc. Use synthetic or redacted samples only. User memory `feedback_no_pii_in_source` explicitly applies. |

**Issue 6 — Fixture PII policy.** Add to plan Task 10 Step 3: "Fixtures use synthetic multilingual data only. No copy-paste from real raw connector records." This is not optional — user memory says so.

### Section 4: Data Flow & Edge Cases

**Edge cases the plan does not map:**

| Flow                 | Edge case                                                       | Handled?                                                   |
| -------------------- | --------------------------------------------------------------- | ---------------------------------------------------------- |
| Observation emission | Same raw record replayed after extractor version bump           | plan says raw immutable + extractor_version column — good  |
| Candidate generation | Entity has 10k+ aliases, top-N overflow                         | not addressed                                              |
| Candidate scoring    | Embedding dimensions change (1024 → new model)                  | not addressed — hard block for replay                      |
| Resolution           | Candidate approved then source raw record retracted             | not addressed                                              |
| Merge action         | `split` on an entity that was merged from three sources         | partially — `action_type: split` exists, semantics unclear |
| Projection           | Canonical label changes mid-session while a recall is in flight | not addressed                                              |
| Audit run            | Baseline has no equivalent metric (metric added after baseline) | "inconclusive" status covers it per spec — good            |

Most of these are v2 problems but **"embedding dimensions change"** is a real hazard given the embedding model migrated from e5-small to e5-large in v0.18. TODO.

### Section 5: Code Quality

No plan-level issues.

### Section 6: Test Review

```
NEW CONTRACTS THE PLAN INTRODUCES
─────────────────────────────────
Data flows:       raw → observation → candidate → resolution → projection
Codepaths:        types, normalize, store, candidate-gen, resolve, project, ingest, api, viewer, audit
Async:            audit-run (task 11)
External:         embedding pipeline (existing)
Error/rescue:     NONE in plan ← CRITICAL GAP
```

Plan has one happy-path test per module. Zero failure-path tests. Zero chaos tests.

**Issue 7 — Test ambition gap.** For each module, add at least one failure-path test and one "hostile QA engineer" test to the plan before implementation starts. Specifically:

- normalization: null/empty/non-BMP unicode/homoglyph attack
- candidate-generator: 10k-alias blowout, empty block, all-same-score ties
- resolution-engine: ontology violation, stale candidate, dual-approve race
- projection: missing preferred label, circular merged_into, dimension mismatch
- audit-metrics: empty benchmark, baseline missing, metric direction flip

Eng Review's territory, but flagged here because the plan's test philosophy is too thin.

### Section 7: Performance

- Candidate blocking: plan uses normalized-label + structured-id blocks, so worst case is O(aliases_in_block). Fine unless any block grows unbounded. Add index on `entity_aliases.normalized_label` (plan says so) and consider alerting on max block size in audit.
- Audit run replay: "historical-replay-sample" size is undefined. Runtime could be minutes to hours. Put a per-run time budget in the audit handler.
- Embedding calls per candidate: could explode if every alias-pair triggers an embedding. Plan says "embeddings rank candidates" but not "only top-N survive blocking." Make that explicit in Task 4 — embed top-N (e.g., N=50) after blocking, not everything.

### Section 8: Observability

Zero observability in the plan. No logs specified, no metrics specified, no dashboards, no runbooks. For a substrate that is supposed to be "continuously improving" via audit, this is a hole.

**Issue 8 — Observability is scope.** At minimum the plan needs:

- **Logs:** each resolution decision with score breakdown + rule_trace (already in schema, just needs structured log line); each auto-merge; each audit-run start/complete with metric deltas.
- **Metrics:** `entity.candidates.generated`, `entity.candidates.auto_merged`, `entity.candidates.reviewed`, `entity.projection.writes`, `entity.audit.runs`, `entity.audit.false_merge_rate`.
- **Day-1 dashboard panels:** pending candidates count, auto-merge rate, latest `false_merge_rate`, oldest pending candidate age.
- **Runbook:** "false_merge_rate spike → disable auto-merge via config, queue reprocess, investigate via audit findings."

Eng review should turn this into concrete code tasks.

### Section 9: Deployment & Rollout

- Migrations 026/027/028 are append-only (new tables). Zero-downtime. Good.
- **No feature flag in plan.** See Issue 3. Without a flag, Task 7 step 4 could regress current recall path.
- Deploy order: migrate first (safe), deploy second (safe because projection writes are gated by flag).
- Rollback: flag off; data inert. Document in Task 12.

### Section 10: Long-Term Trajectory

- **Reversibility: 4/5.** Append-only data + feature-flagged projection + no forced replacement of topic-centric memory.
- **Debt items introduced:** (1) dual identity model during shadow phase — topic vs canonical. (2) Embedding model lock-in — replay requires versioning. (3) No cross-language auto-merge means some real duplicates persist until human reviews them.
- **The 1-year question:** Plan says "minimal viewer UI v1." In 12 months this UI is either gone (replaced) or deeply inadequate. Budget for that.
- **Ecosystem fit:** Ontology-guided + relational-first is the right trajectory. OWL/SKOS/SHACL/PROV framing sets future contributors up well.

### Section 11: Design & UX Review (minimal scope)

- The plan deliberately ships a minimal viewer. Correct for v1.
- Review queue list + candidate detail + approve/reject/defer has real interaction states to cover — empty queue, loading, stale candidate (someone else resolved it), network error on approve, keyboard-nav for fast reviewers, bulk actions deferred to v2.
- Plan mentions empty-state test (good) but no loading / error state tests.
- Not an issue at CEO level, but `/plan-design-review` should cover this if wanted.

---

## 10. Failure Modes Registry

| Codepath               | Failure mode            | Rescued?           | Test? | User sees?           | Logged? | Severity     |
| ---------------------- | ----------------------- | ------------------ | ----- | -------------------- | ------- | ------------ |
| normalization          | null / invalid input    | ❌                 | ❌    | 500                  | ❌      | CRITICAL GAP |
| candidate-generator    | embedding unavailable   | ❌                 | ❌    | 500 or silent drop   | ❌      | CRITICAL GAP |
| resolution-engine      | ontology violation      | partial (→ review) | ❌    | review queue         | ❌      | partial      |
| projection             | missing preferred label | ❌                 | ❌    | truth row corruption | ❌      | CRITICAL GAP |
| review-handler approve | stale candidate (race)  | ❌                 | ❌    | 500                  | ❌      | CRITICAL GAP |
| audit-handler run      | concurrent run          | ❌                 | ❌    | 500                  | ❌      | partial      |
| history-extractor      | raw missing source_ref  | silent drop        | ❌    | nothing              | ❌      | CRITICAL GAP |

**Total: 5 CRITICAL GAPS** — all are silent-failure class. Eng review must close these.

---

## 11. NOT in Scope (confirmed)

- Full RDF triple-store runtime
- Rewriting all memory APIs before substrate exists
- Aggressive cross-language auto-merge
- Full os-agent same-view completion
- Global conductor → auditor rename

## 12. What Already Exists (correctly reused)

- `memory/truth-store.ts` (projection seam, Task 7)
- `memory/api.ts` (recall routing, Task 7)
- `memory/evolution-engine.ts` (intentionally not reused — correct)
- `db-manager.ts` (FTS/vector wiring)
- `standalone/src/memory/history-extractor.ts` (observation insertion point)
- `standalone/src/api/graph-api.ts` (auth + routing for new handlers)

## 13. Dream State Delta

After this branch: canonical substrate exists in shadow mode, one real source feeds observations, one projection bridge lets recall taste canonical identity, minimal review queue unblocks humans, audit loop establishes baselines. Still missing at branch end: wiki projection, dashboard projection, multi-connector backfill, full os-agent consumption, cross-language auto-merge policy tuning. Those belong to future branches.

---

## 14. TODOS (proposed)

1. **Embedding model version lock** — track `extractor_version` + `embedding_model_version` on observations so replay can reject incompatible baselines. P1. Context: v0.18 migrated e5-small→e5-large; without version tracking, replay across that migration is lying. Effort: S (CC: 15min).
2. **Cross-language auto-merge policy v2** — after v1 ships and baselines exist, decide when embedding-only cross-language merges become allowed (with score threshold + secondary evidence). P2.
3. **Review queue bulk actions** — defer from v1 UI. P3.
4. **Dashboard + wiki projection consumers** — once substrate is stable. P2.
5. **Entity audit → continuous monitoring** — turn audit runs into a scheduled job per connector. P3.

---

## 15. Unresolved Decisions

These are the load-bearing questions the plan should resolve before Eng review.

**Decision 0F — Mode.** Recommended: HOLD SCOPE.

**Decision 1 — Scope binding on entities.** Should `entity_nodes` carry a `scope_ref` (kind+id), or should scope isolation live only at the observation/projection edges? Recommendation: scope_ref on entity_nodes, because multi-tenant MAMA is a real use case and cross-tenant canonical collision is a data-integrity bug.

**Decision 2 — Task 6 source choice.** Pick one connector now. Options: Slack, Telegram, Discord, Chatwork, Notion, Gmail, Calendar, Drive, Sheets, Trello, Obsidian, iMessage. Recommendation: Slack or Telegram — highest multilingual density, raw→history extraction already exists on both.

**Decision 3 — Shadow mode switch.** `MAMA_ENTITY_PROJECTION_MODE = off | shadow | dual-write`, default `shadow` for v1. Recommendation: yes, exactly that switch.

**Decision 4 — Fixture PII policy.** Synthetic-only fixtures, no real connector records. Recommendation: yes.

**Decision 5 — `false_merge_rate` v1 target.** No baseline exists yet. Recommendation: first run establishes baseline AND `false_merge_rate ≤ 0.02` on the gold canonical identity set as a hard ceiling.

**Decision 6 — Error map before implementation.** Chunk 1 Task 1 adds `entities/errors.ts` with named exception classes; Chunks 2-5 each add ≥1 failure-path test per module. Recommendation: yes — make this a Task 1 addition.

**Decision 7 — Observability scope.** Add logs + counters + 1-paragraph runbook to Task 12 (verify) as a required deliverable. Recommendation: yes.

**Decision 8 — Candidate-generator top-N gate.** "Embeddings rank top-N after blocking, N=50" baked into Task 4. Recommendation: yes.

**Decision 9 — Embedding model version tracking.** Add `extractor_version` + `embedding_model_version` columns to `entity_observations` and `entity_resolution_candidates` in migration 026/027. Recommendation: yes.

---

## 16. Completion Summary

```
+====================================================================+
|            CEO PLAN REVIEW — COMPLETION SUMMARY                    |
+====================================================================+
| Mode recommended     | HOLD SCOPE                                   |
| System audit         | Clean branch, contiguous migrations, good    |
|                      | reuse seams, checkpoint non-drift clear      |
| Step 0A (premise)    | Load-bearing; proxy skepticism passes        |
| Step 0B (leverage)   | Good reuse, 1 gap: no scope binding          |
| Step 0C (dream)      | Moves toward ideal, right-sized              |
| Step 0C-bis (alts)   | 3 approaches, A recommended                  |
| Step 0D (complexity) | Above smell threshold but justified          |
| Step 0E (temporal)   | 6 decisions to pre-resolve                   |
| Section 1  (Arch)    | 4 issues (scope, Task 6 source, shadow       |
|                      | mode switch, rollback)                       |
| Section 2  (Errors)  | 5 CRITICAL GAPS — error map is a hole        |
| Section 3  (Security)| 1 issue (fixture PII policy)                 |
| Section 4  (Data/UX) | 1 hazard (embedding dim change)              |
| Section 5  (Quality) | No issues                                    |
| Section 6  (Tests)   | Test ambition too thin; Issue 7              |
| Section 7  (Perf)    | 1 issue (embedding blowup if no top-N gate)  |
| Section 8  (Observ)  | Entire layer missing; Issue 8                |
| Section 9  (Deploy)  | Gated on shadow mode flag (Issue 3)          |
| Section 10 (Future)  | Reversibility 4/5, 3 debt items              |
| Section 11 (Design)  | Minimal UI correct for v1                    |
+--------------------------------------------------------------------+
| NOT in scope         | 5 items confirmed                            |
| What already exists  | 6 reuses verified                            |
| Error/rescue registry| 5 CRITICAL GAPS, 2 partial                   |
| Failure modes        | 7 codepaths, 5 critical gaps                 |
| TODOS proposed       | 5                                            |
| CEO plan on disk     | Skipped (HOLD mode)                          |
| Outside voice        | Deferred to full review cycle                |
| Diagrams produced    | 1 architecture, 5 flagged for eng review     |
| Unresolved decisions | 9 (listed above)                             |
+====================================================================+
```

---

## 17. Next Steps

1. Resolve Decisions 0F, 1, 2, 3 at minimum before implementation.
2. Run `/plan-eng-review` (required gate) — it will hammer the error map, test ambition, scope binding, and observability into concrete code tasks.
3. Run `/plan-devex-review` — developer onboarding + CLI ergonomics for the review queue.
4. Optional: `/plan-design-review` on the minimal viewer modules if the review UI needs to be more than "barely usable."
