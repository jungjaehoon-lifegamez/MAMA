# DX Plan Review — Canonical Entity Ontology Implementation

**Target plan:** `docs/superpowers/plans/2026-04-12-canonical-entity-ontology-implementation.md` (post-CEO + Eng + Codex edits)
**Prior reviews:**

- `docs/superpowers/reviews/2026-04-12-canonical-entity-ontology-ceo-review.md`
- `docs/superpowers/reviews/2026-04-12-canonical-entity-ontology-eng-review.md`
- `docs/superpowers/reviews/2026-04-12-canonical-entity-ontology-codex-review.md`

**Branch:** `codex/mama-entity-ontology`
**Base:** `main`
**Reviewer:** gstack `/plan-devex-review`
**Date:** 2026-04-12
**Mode:** DX POLISH

---

## 1. Product Classification + Applicability

Primary product type is **internal substrate** (mama-core/entities), not a public API/CLI/SDK. However, the plan has three developer-adjacent surfaces that justify a focused DX pass:

1. **The plan itself as an onboarding document.** The "developer" is the next implementer (Claude Code subagent or human contributor) who must execute Chunks 1-6 end-to-end. The plan IS the getting-started guide.
2. **`/api/entities/*` HTTP surface.** Consumed today by the MAMA OS viewer; tomorrow by os-agent and potentially third-party integrations.
3. **Test command ergonomics.** The plan has 10+ `pnpm --dir ./... exec vitest run ...` invocations scattered across tasks. If they are inconsistent, the implementer loses 5-10 minutes per mis-typed command.

**Product type: Internal Substrate + Internal API + Implementation Guide.**

---

## 2. Step 0 — DX Investigation

### 0A. Developer Persona

**Primary persona:** MAMA contributor picking up this plan cold in 48 hours.

- Skills: TypeScript, Vitest, better-sqlite3. Has NOT touched mama-core entities (does not exist yet).
- Prep: read CLAUDE.md and the two specs.
- Tolerance: 2 hours to get through Chunk 1 Task 1 before frustration compounds.
- Expects: the plan to be directly executable without cross-referencing the specs.

**Secondary persona:** MAMA OS operator using the review queue + audit UI.

- Skill level: shell-comfortable, not TypeScript-fluent.
- Uses the UI to approve/reject merges and read audit reports.
- Wants: error messages that explain what to do, a runbook that maps error codes to operational responses.

### 0B. Empathy Narrative

> I open `docs/superpowers/plans/2026-04-12-canonical-entity-ontology-implementation.md`. It is 55 KB. I scan the File Map, note 25 files to create, and jump to "Chunk 1 Task 1." I see "Write failing type-contract tests," read the list of required types, and realize `EntityScopeKind` wasn't in the architecture spec but is in the plan. I re-read "Decisions Resolved" to understand why.
>
> I run `pnpm --dir ./packages/mama-core exec vitest run tests/entities/types.test.ts`. Vitest says `No test files found, exiting with code 1`. I am confused. The plan says "Run the test to verify it fails" but this is not a test failing, this is vitest complaining there is no test. Is my command wrong? Is my pnpm version wrong? Is the test directory supposed to already exist? I waste 10 minutes figuring out that I need to `mkdir -p packages/mama-core/tests/entities` first.
>
> I write the test file, re-run, and now vitest says `Cannot find module '../../src/entities/types'`. OK this is the fail state the plan wanted. I implement `types.ts`. Tests pass. I feel like I have finally started.
>
> Time elapsed: 50 minutes. Most of it fighting the framework, not writing the work.

### 0C. Competitive Benchmark

No public competitors (this is an internal plan). Reference points:

| Reference                    | TTHW         | DX choice                                                       |
| ---------------------------- | ------------ | --------------------------------------------------------------- |
| Rails generators             | ~30s         | `rails g model` creates file + test in one shot                 |
| Next.js plan docs            | ~15min       | Tasks name exact file + expected output per step                |
| **Aspiration for this plan** | **≤ 25 min** | Contributor finishes Chunk 1 Task 1 in ≤ 25 min of focused work |

### 0D. Magical Moment

For this internal substrate, the magical moment is **the first audit run reporting a verdict**. It is the instant the contributor goes from "I built a bunch of tables and handlers" to "the system can measure whether it got safer." Delivery vehicle: a copy-paste `curl` sequence in Task 12 Step 3.

### 0E. Mode

**DX POLISH.** Plan scope is set by CEO + Eng + Codex. No DX expansion needed. Make every touchpoint bulletproof for the implementer.

### 0F. Journey Trace

| Stage          | Implementer does         | Friction points                                           | Status |
| -------------- | ------------------------ | --------------------------------------------------------- | ------ |
| 1. Discover    | Reads plan top-to-bottom | TOC missing (DX1), no "how to read" (DX2)                 | fixed  |
| 2. Install     | Verifies pnpm, vitest    | Not documented (DX3)                                      | fixed  |
| 3. Hello World | Chunk 1 Task 1           | Test dir doesn't exist; vitest "no tests" vs "fail" (DX5) | fixed  |
| 4. Real usage  | Chunks 2-5               | Inconsistent vitest commands (DX4), no watch-mode mention | fixed  |
| 5. Debug       | Reads runbook            | Runbook is "one paragraph" (DX8)                          | fixed  |
| 6. Upgrade     | N/A (v1)                 | —                                                         | —      |

### 0G. First-Time Developer Confusion Report

```
T+0:00  Opens plan. 55 KB. Scrolls to find ToC — none exists. Scans headings.
T+0:10  Jumps to Chunk 1 Task 1.
T+0:15  Reads Step 1 (write tests). Runs Step 2 command. Gets "no test files found."
T+0:20  Re-reads Step 1. Unclear if tests directory already exists. Tries `ls`. Missing.
T+0:25  Creates test dir manually. Runs command again. Now gets the actual fail state.
T+0:35  Implements types.ts. Tests pass.
T+0:45  Moves to Task 2 migrations. Reads migration path. Realizes 028 is reserved but Chunk 5. Hunts for 028 stub file.
T+0:50  Loses more time on migration sequencing confusion.
```

**Addressed by:** DX1 (ToC), DX2 (how to read), DX3 (prerequisites), DX4 (command cheatsheet), DX5 (explicit mkdir + failure-message distinction).

---

## 3. Pass Results

### Pass 1 — Getting Started

**Initial: 5/10.** TDD flow breaks on step 1 because test dir does not exist. No one-block cheatsheet. No prerequisites section.

**Post-fix: 8/10.** DX3 prerequisites block + DX4 command cheatsheet + DX5 explicit scaffolding close the Chunk 1 onboarding cliff.

### Pass 2 — API/CLI/SDK Design

**Initial: 7/10** after CEO + Eng + Codex. Already strong.

**Remaining gaps:** No TypeScript response shapes documented (DX6). Error envelope shape unspecified.

**Post-fix: 9/10.** DX6 adds `CandidateListResponse`, `CandidateSummary`, `CandidateDetail`, `MergeActionResult`, `ErrorEnvelope` as stable integrator contracts.

### Pass 3 — Error Messages

**Initial: 8/10** after CEO + Eng (errors.ts + failure-path tests + structured logs).

**Remaining gaps:** No error-message template. No error→runbook cross-reference (DX7).

**Post-fix: 9/10.** DX7 expands `EntityError` spec with `code` + `message` + `context` + `hint` + `doc_section` + `toErrorEnvelope()`. Every runtime error now maps to a runbook section.

### Pass 4 — Documentation

**Initial: 6/10.** ~55 KB plan, no ToC, weak cross-refs between Decisions and task bodies, runbook "one paragraph."

**Post-fix: 9/10.** DX1 ToC + DX2 how-to-read + DX8 expanded runbook (≥ 5 operational scenarios) + DX9 tag legend all applied.

### Pass 5 — Upgrade Path

**N/A → 10/10.** V1 substrate. No prior version.

### Pass 6 — Developer Environment & Tooling

**Initial: 7/10.** Inconsistent vitest commands across tasks. No watch-mode mention. No Slack mocking guidance.

**Post-fix: 9/10.** DX4 normalizes commands + adds watch mode. DX10 names the mocking strategy in Task 6 Step 1.

### Pass 7 — Community

**N/A.** Internal substrate.

### Pass 8 — DX Measurement

**Initial: 9/10.** The audit loop IS the measurement system (`false_merge_rate`, `cross_language_candidate_recall@10`, `ontology_violation_count`, `projection_fragmentation_rate` with baseline classification). Actually better than most shipping products.

**Remaining gap:** No "time-to-first-audit-run" success signal.

**Post-fix: 10/10.** DX11 adds the three-command curl sequence in Task 12 Step 3 as the branch-complete success signal.

---

## 4. DX Scorecard

```
+====================================================================+
|              DX PLAN REVIEW — SCORECARD                             |
+====================================================================+
| Dimension            | Initial | Post-fix | Trend                  |
|----------------------|---------|----------|------------------------|
| Getting Started      |  5/10   |  8/10    | ↑↑                     |
| API/CLI/SDK          |  7/10   |  9/10    | ↑                      |
| Error Messages       |  8/10   |  9/10    | ↑                      |
| Documentation        |  6/10   |  9/10    | ↑↑                     |
| Upgrade Path         |  N/A    | 10/10    | —                      |
| Dev Environment      |  7/10   |  9/10    | ↑                      |
| Community            |  N/A    |  N/A     | —                      |
| DX Measurement       |  9/10   | 10/10    | ↑                      |
+--------------------------------------------------------------------+
| TTHW (Chunk 1 Task 1)| ~50 min |  ~25 min |                        |
| Competitive tier     | Needs Work → Competitive                     |
| Product type         | Internal substrate + API + impl guide        |
| Mode                 | DX POLISH                                    |
| Overall DX           |  6.7/10 |  9.1/10  | ↑↑                     |
+====================================================================+
| DX PRINCIPLE COVERAGE (post-fix)                                    |
| Zero Friction at T0    | covered — Chunk 1 prerequisites + cheatsheet |
| Learn by Doing         | covered — TDD flow with explicit fail state |
| Fight Uncertainty      | covered — errors have code+hint+doc_section |
| Opinionated + Escape   | covered — shadow default, dual-write override|
| Code in Context        | covered — response shapes + runbook wired   |
| Magical Moments        | covered — first audit run as success signal |
+====================================================================+
```

---

## 5. Applied Fixes (11)

| #    | Fix                                                                                                                                              | Location    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| DX1  | Quick Navigation table with section purposes                                                                                                     | plan header |
| DX2  | "How to Read This Plan" 200-word section + tag legend                                                                                            | plan header |
| DX3  | Chunk 1 Prerequisites block (environment verification)                                                                                           | Chunk 1     |
| DX4  | Chunk 1 Test Command Cheatsheet (normalized commands + watch mode + failure-message interpretation)                                              | Chunk 1     |
| DX5  | Task 1 Step 2: explicit `mkdir`, failure-message distinction (`Cannot find module` vs `No test files found`)                                     | Task 1      |
| DX6  | Task 8 Step 3: TypeScript response shapes (`CandidateListResponse`, `CandidateSummary`, `CandidateDetail`, `MergeActionResult`, `ErrorEnvelope`) | Task 8      |
| DX7  | Task 1 Step 1 + Step 3: expanded `EntityError` spec (`code` + `message` + `context` + `hint` + `doc_section` + `toErrorEnvelope()`)              | Task 1      |
| DX8  | Task 12 Step 5: runbook expanded to ≥ 5 operational sections with anchored headings                                                              | Task 12     |
| DX9  | Retroactive tags `[CT*]`, `[A*]`, `[Q*]`, `[T*]`, `[P*]`, `[Decision N]`, `[DX*]` throughout tasks + tag legend in "How to Read"                 | all tasks   |
| DX10 | Task 6 Step 1: mock strategy (vitest module mocking of Slack + RawStore, synthetic test data)                                                    | Task 6      |
| DX11 | Task 12 Step 3: final success curl sequence (trigger audit, poll, read classification)                                                           | Task 12     |

---

## 6. NOT in Scope

- Public API documentation (internal only)
- Community channel setup (internal only)
- SDK generation (internal only)
- Upgrade path (v1 substrate)
- Magical moment delivery vehicle beyond the curl sequence (internal dev velocity)

## 7. TODOs

No new DX TODOs. All Pass-level gaps resolved in-plan.

## 8. Next Steps

1. All reviews (CEO + Eng + Codex + DX) cleared.
2. Plan is ready to implement.
3. Run `/ship` when implementation is complete, or start Chunk 1 Task 1 inline.
4. After landing, consider running `/devex-review` on the live API surface as the boomerang — plan said TTHW ~25 min for Chunk 1 Task 1, did reality match?
