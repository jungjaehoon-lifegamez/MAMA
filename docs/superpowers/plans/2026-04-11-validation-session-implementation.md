# Validation Session v1 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a shared observable validation system so every agent run can be measured, compared against a baseline, surfaced in the Viewer, and reported by Conductor with the same evidence humans see.

**Architecture:** Add a `validation_session` layer above raw agent run/activity events. First unify all execution paths behind a raw run envelope, then persist validation snapshots/metrics/reports, then expose them through validation APIs and Viewer surfaces (Overview / Validation / Diff / History), and finally wire Conductor/audit to interpret the same evidence.

**Tech Stack:** TypeScript, SQLite, Express/Graph API, existing `agent_activity`/`agent_versions`, Viewer TypeScript modules, Vitest, existing benchmark tests.

---

## File Map

### Create

- `packages/standalone/src/validation/types.ts`
  Validation session domain types, statuses, snapshot shapes, metric records, baseline types.
- `packages/standalone/src/validation/metric-profiles.ts`
  Built-in metric profiles for `wiki-agent`, `dashboard-agent`, and shared defaults.
- `packages/standalone/src/validation/store.ts`
  SQLite table init + CRUD for `validation_sessions`, `validation_snapshots`, `validation_metrics`, `validation_reports`, `agent_validation_state`.
- `packages/standalone/src/validation/snapshot-builder.ts`
  Summary-only HTML/API/DB/activity snapshot builders for before/after capture.
- `packages/standalone/src/validation/session-service.ts`
  Orchestrates session lifecycle: start, capture, attach raw runs, compute deltas/metrics, classify, and finalize report.
- `packages/standalone/src/api/validation-handler.ts`
  HTTP handlers for validation summary, session detail, history, compare, and approval endpoints.
- `packages/standalone/tests/validation/store.test.ts`
  Persistence tests for new tables and baseline pointer behavior.
- `packages/standalone/tests/validation/session-service.test.ts`
  Session lifecycle tests: before/after snapshots, metric delta, status classification, inconclusive handling.
- `packages/standalone/tests/api/validation-handler.test.ts`
  API contract tests for summary/history/detail/compare/approve.
- `packages/standalone/public/viewer/src/modules/agents/overview-tab.ts`
  Render current validation status and baseline summary.
- `packages/standalone/public/viewer/src/modules/agents/validation-tab.ts`
  Render latest validation session summary, metrics, recommendation, approval actions.
- `packages/standalone/public/viewer/src/modules/agents/diff-tab.ts`
  Render before/after HTML/API/DB/activity diffs in human-readable form.
- `packages/standalone/public/viewer/src/modules/agents/history-tab.ts`
  Render version timeline + validation session drill-down entry list.

### Modify

- `packages/standalone/src/db/agent-store.ts`
  Initialize validation tables alongside existing agent tables; optionally add run/session keys to activity rows if needed.
- `packages/standalone/src/agent/gateway-tool-executor.ts`
  Emit raw run envelopes for `delegate` and `agent_test`; attach tool/path/latency/token evidence to validation service.
- `packages/standalone/src/cli/runtime/api-routes-init.ts`
  Route system-agent direct runs (wiki/dashboard/manual triggers) through the same raw run/validation service instead of bare `sendMessage`.
- `packages/standalone/src/cli/commands/start.ts`
  Wire `ValidationSessionService` and snapshot builders into runtime bootstrap.
- `packages/standalone/src/api/graph-api.ts`
  Register validation endpoints under the existing Graph API router.
- `packages/standalone/public/viewer/src/utils/api.ts`
  Add typed methods for validation summary/history/session/compare/approve.
- `packages/standalone/public/viewer/src/modules/agents.ts`
  Replace current activity-centric detail view with `Overview / Validation / Diff / Run Trace / History` IA while keeping activity as raw trace.
- `packages/standalone/src/multi-agent/conductor-persona.ts`
  Update Conductor guidance so audits and improvement recommendations reference validation sessions, baseline comparisons, and inconclusive states.
- `packages/standalone/tests/db/agent-activity.test.ts`
  Extend current store tests to cover validation table init interplay and run-envelope assumptions.
- `packages/standalone/tests/agent/gateway-tool-executor.test.ts`
  Add coverage for delegate/test runs creating validation evidence.
- `packages/standalone/tests/code-act/host-bridge.test.ts`
  Ensure validation-related agent management paths remain reachable from code-act if required.

### Existing Assets to Reuse

- `packages/standalone/src/observability/health-score.ts`
  Reuse score component patterns for metric/delta normalization, not as final validation authority.
- `packages/standalone/tests/benchmark/agent-path-benchmark.test.ts`
  Reuse for route/path-efficiency regression coverage.
- `packages/standalone/tests/benchmark/memory-provider-benchmark.test.ts`
  Reuse benchmarking/reporting patterns for before/after comparisons.

---

## Chunk 1: Persistence + Domain Model

### Task 1: Define validation domain types and metric profiles

**Files:**

- Create: `packages/standalone/src/validation/types.ts`
- Create: `packages/standalone/src/validation/metric-profiles.ts`
- Test: `packages/standalone/tests/validation/session-service.test.ts`

- [ ] **Step 1: Write the failing type/profile test**

Add a test that imports metric profiles and asserts:

- `wiki-agent` profile exists
- primary metrics include `publish_latency_ms`, `token_cost`, `meaningless_run_rate`
- profile registry can fall back to a default profile

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir ./packages/standalone exec vitest run tests/validation/session-service.test.ts`
Expected: FAIL because `src/validation/types.ts` / `metric-profiles.ts` do not exist yet

- [ ] **Step 3: Implement minimal types and built-in profiles**

Create `types.ts` with:

- `ValidationStatus`
- `ValidationTriggerType`
- snapshot shapes
- metric record shape
- report shape

Create `metric-profiles.ts` with:

- `DEFAULT_METRIC_PROFILE`
- `WIKI_AGENT_METRIC_PROFILE`
- `DASHBOARD_AGENT_METRIC_PROFILE`
- `getMetricProfile(agentId: string)`

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --dir ./packages/standalone exec vitest run tests/validation/session-service.test.ts`
Expected: PASS for profile/type existence assertions

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/validation/types.ts packages/standalone/src/validation/metric-profiles.ts packages/standalone/tests/validation/session-service.test.ts
git commit -m "feat: add validation session domain types"
```

### Task 2: Add validation persistence tables and store

**Files:**

- Modify: `packages/standalone/src/db/agent-store.ts`
- Create: `packages/standalone/src/validation/store.ts`
- Test: `packages/standalone/tests/validation/store.test.ts`
- Test: `packages/standalone/tests/db/agent-activity.test.ts`

- [ ] **Step 1: Write failing persistence tests**

Add tests for:

- `initAgentTables()` also creating validation tables
- inserting/loading a validation session
- storing before/after snapshots
- storing metric deltas
- storing and reading approved baseline pointer

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --dir ./packages/standalone exec vitest run tests/validation/store.test.ts tests/db/agent-activity.test.ts`
Expected: FAIL because validation tables/store are missing

- [ ] **Step 3: Implement store and table initialization**

In `agent-store.ts`:

- extend `initAgentTables()` with validation tables (or call a helper from `validation/store.ts`)

In `validation/store.ts`:

- `initValidationTables(db)`
- `createValidationSession()`
- `saveValidationSnapshot()`
- `saveValidationMetric()`
- `saveValidationReport()`
- `getValidationSummary()`
- `listValidationHistory()`
- `getValidationSessionDetail()`
- `approveValidationSession()`

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --dir ./packages/standalone exec vitest run tests/validation/store.test.ts tests/db/agent-activity.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/db/agent-store.ts packages/standalone/src/validation/store.ts packages/standalone/tests/validation/store.test.ts packages/standalone/tests/db/agent-activity.test.ts
git commit -m "feat: persist validation sessions and baselines"
```

## Chunk 2: Runtime Convergence

### Task 3: Introduce raw run envelope + validation session service

**Files:**

- Create: `packages/standalone/src/validation/snapshot-builder.ts`
- Create: `packages/standalone/src/validation/session-service.ts`
- Test: `packages/standalone/tests/validation/session-service.test.ts`

- [ ] **Step 1: Write failing service tests**

Cover:

- starting a session captures `before`
- finalizing captures `after`
- missing evidence yields `inconclusive`
- baseline comparison produces metric deltas
- status classification resolves to `healthy | improved | regressed | inconclusive`

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --dir ./packages/standalone exec vitest run tests/validation/session-service.test.ts`
Expected: FAIL because service/snapshot builder are missing

- [ ] **Step 3: Implement snapshot builder and session service**

`snapshot-builder.ts`:

- build summary-only HTML/API/DB/activity snapshots from current runtime context

`session-service.ts`:

- `startSession(...)`
- `recordRunEnvelope(...)`
- `captureBefore(...)`
- `captureAfter(...)`
- `computeMetrics(...)`
- `classifyStatus(...)`
- `finalizeSession(...)`

Use profile thresholds from `metric-profiles.ts` and storage functions from `validation/store.ts`.

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --dir ./packages/standalone exec vitest run tests/validation/session-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/validation/snapshot-builder.ts packages/standalone/src/validation/session-service.ts packages/standalone/tests/validation/session-service.test.ts
git commit -m "feat: add validation session service"
```

### Task 4: Converge delegate and agent_test onto raw run envelopes

**Files:**

- Modify: `packages/standalone/src/agent/gateway-tool-executor.ts`
- Modify: `packages/standalone/tests/agent/gateway-tool-executor.test.ts`

- [ ] **Step 1: Write failing runtime evidence tests**

Add tests that verify:

- `delegate()` writes a raw run envelope/session-linked evidence record
- `agent_test()` creates a validation session and updates metrics/details
- failed delegate/test paths classify as `regressed` or `inconclusive` appropriately

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --dir ./packages/standalone exec vitest run tests/agent/gateway-tool-executor.test.ts`
Expected: FAIL because validation session wiring is absent

- [ ] **Step 3: Implement runtime wiring**

Update `GatewayToolExecutor` to:

- inject/use `ValidationSessionService`
- create session on `agent_test`
- emit run envelopes for `delegate`, background delegate, and test item runs
- link `test_run` score/details into validation metrics and report summary

Preserve existing `agent_activity` behavior; do not replace it.

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --dir ./packages/standalone exec vitest run tests/agent/gateway-tool-executor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/agent/gateway-tool-executor.ts packages/standalone/tests/agent/gateway-tool-executor.test.ts
git commit -m "feat: attach validation sessions to delegate and agent tests"
```

### Task 5: Route system-agent direct runs through the same envelope

**Files:**

- Modify: `packages/standalone/src/cli/runtime/api-routes-init.ts`
- Modify: `packages/standalone/src/cli/commands/start.ts`
- Test: `packages/standalone/tests/validation/session-service.test.ts`

- [ ] **Step 1: Write failing regression test for system-agent runs**

Add a test that simulates a direct `wiki-agent` / `dashboard-agent` run and asserts:

- run envelope created
- validation session created
- missing activity evidence becomes `inconclusive` instead of silently “success”

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --dir ./packages/standalone exec vitest run tests/validation/session-service.test.ts`
Expected: FAIL because direct runs bypass the service

- [ ] **Step 3: Implement direct-run wrapper**

In `api-routes-init.ts` and `start.ts`:

- create a helper that wraps `pm.getSharedProcess(...).sendMessage(...)`
- always emits raw run envelope
- captures before/after snapshots
- finalizes validation session

Use this wrapper for:

- Wiki Agent scheduled/manual runs
- Dashboard Agent scheduled/manual runs
- any equivalent system-run path still bypassing `executeDelegate()`

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --dir ./packages/standalone exec vitest run tests/validation/session-service.test.ts tests/agent/gateway-tool-executor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/cli/runtime/api-routes-init.ts packages/standalone/src/cli/commands/start.ts packages/standalone/tests/validation/session-service.test.ts
git commit -m "feat: unify system agent runs under validation sessions"
```

## Chunk 3: API + Viewer Validation UX

### Task 6: Expose validation APIs

**Files:**

- Create: `packages/standalone/src/api/validation-handler.ts`
- Modify: `packages/standalone/src/api/graph-api.ts`
- Modify: `packages/standalone/public/viewer/src/utils/api.ts`
- Test: `packages/standalone/tests/api/validation-handler.test.ts`

- [ ] **Step 1: Write failing API tests**

Cover:

- `GET /api/agents/:id/validation/summary`
- `GET /api/agents/:id/validation/history`
- `GET /api/validation-sessions/:id`
- `GET /api/agents/:id/compare?version=vX&baseline=approved`
- `POST /api/agents/:id/validation/approve`

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --dir ./packages/standalone exec vitest run tests/api/validation-handler.test.ts`
Expected: FAIL because handlers/endpoints are missing

- [ ] **Step 3: Implement handlers and Viewer API client methods**

Add:

- summary aggregation
- history response shape
- session detail response
- baseline compare response
- approval mutation

Expose matching typed methods in `public/viewer/src/utils/api.ts`.

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --dir ./packages/standalone exec vitest run tests/api/validation-handler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/api/validation-handler.ts packages/standalone/src/api/graph-api.ts packages/standalone/public/viewer/src/utils/api.ts packages/standalone/tests/api/validation-handler.test.ts
git commit -m "feat: add validation summary and history APIs"
```

### Task 7: Build Viewer validation surfaces

**Files:**

- Create: `packages/standalone/public/viewer/src/modules/agents/overview-tab.ts`
- Create: `packages/standalone/public/viewer/src/modules/agents/validation-tab.ts`
- Create: `packages/standalone/public/viewer/src/modules/agents/diff-tab.ts`
- Create: `packages/standalone/public/viewer/src/modules/agents/history-tab.ts`
- Modify: `packages/standalone/public/viewer/src/modules/agents.ts`

- [ ] **Step 1: Write failing UI-level module tests or focused DOM tests**

If no existing DOM test harness fits, add a small module-level test that verifies:

- Validation tab renders top metrics and recommendation
- Diff tab renders HTML/API/DB change sections
- History tab renders version timeline rows with metrics
- `inconclusive` status is visible as a first-class state

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --dir ./packages/standalone exec vitest run tests/code-act/host-bridge.test.ts`
Expected: if no UI tests exist yet, add the new test file and expect failure due to missing modules

- [ ] **Step 3: Implement Viewer IA**

Refactor `agents.ts` so the detail view becomes:

- `Overview`
- `Validation`
- `Diff`
- `Run Trace`
- `History`

Requirements:

- delta-first copy
- version timeline with performance summary
- validation status badges
- approval / request improvement actions
- activity preserved as raw trace evidence, not the primary validation surface

- [ ] **Step 4: Run tests and targeted build**

Run:

- `pnpm --dir ./packages/standalone exec vitest run tests/api/validation-handler.test.ts tests/agent/gateway-tool-executor.test.ts`
- `pnpm --dir ./packages/standalone build`

Expected:

- PASS
- build exit code `0`

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/public/viewer/src/modules/agents.ts packages/standalone/public/viewer/src/modules/agents/overview-tab.ts packages/standalone/public/viewer/src/modules/agents/validation-tab.ts packages/standalone/public/viewer/src/modules/agents/diff-tab.ts packages/standalone/public/viewer/src/modules/agents/history-tab.ts
git commit -m "feat: add validation and history surfaces to agents viewer"
```

## Chunk 4: Conductor + Audit Integration

### Task 8: Make Conductor validation-aware

**Files:**

- Modify: `packages/standalone/src/multi-agent/conductor-persona.ts`
- Modify: `packages/standalone/src/cli/runtime/api-routes-init.ts`
- Test: `packages/standalone/tests/validation/session-service.test.ts`

- [ ] **Step 1: Add failing persona/audit regression test**

Verify:

- Conductor guidance references validation sessions, baselines, and `inconclusive`
- audit reports are framed as `change + metric + interpretation + action`

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --dir ./packages/standalone exec vitest run tests/validation/session-service.test.ts`
Expected: FAIL or missing assertions until Conductor behavior is updated

- [ ] **Step 3: Update Conductor guidance and audit path**

Update persona injection so Conductor:

- reads validation summary/history
- treats missing evidence as a problem
- reports improved/regressed/inconclusive against the approved baseline
- recommends approval only when evidence is sufficient

Update audit triggers to create validation sessions instead of ad-hoc, disconnected observations.

- [ ] **Step 4: Run targeted tests**

Run: `pnpm --dir ./packages/standalone exec vitest run tests/validation/session-service.test.ts tests/api/validation-handler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/multi-agent/conductor-persona.ts packages/standalone/src/cli/runtime/api-routes-init.ts packages/standalone/tests/validation/session-service.test.ts
git commit -m "feat: make conductor audit report validation sessions"
```

### Task 9: Final verification and regression pass

**Files:**

- Modify as needed from previous tasks
- Test: existing targeted suites plus full standalone and root regression

- [ ] **Step 1: Run focused validation stack**

Run:

- `pnpm --dir ./packages/standalone exec vitest run tests/validation/store.test.ts tests/validation/session-service.test.ts tests/api/validation-handler.test.ts tests/agent/gateway-tool-executor.test.ts tests/code-act/host-bridge.test.ts tests/code-act/integration.test.ts tests/code-act/type-definition-generator.test.ts`

Expected: PASS

- [ ] **Step 2: Run standalone full test suite**

Run: `pnpm --dir ./packages/standalone test`
Expected: PASS with no new failures

- [ ] **Step 3: Run root regression**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 4: Manual runtime verification**

Run:

- `node packages/standalone/dist/cli/index.js start`
- trigger one `wiki-agent` validation path
- verify summary/history/diff surfaces reflect the same evidence as DB/API

Expected:

- validation session created
- run trace visible
- baseline compare visible
- missing evidence, if any, shown as `inconclusive`

- [ ] **Step 5: Commit**

```bash
git add <all changed files>
git commit -m "feat: add shared observable validation sessions"
```

---

## Review Checklist

Before execution handoff, verify the plan covers:

- raw run envelope convergence
- validation session persistence
- profile-driven metric calculation
- approved baseline comparison
- Viewer Validation / Diff / History IA
- direct system-run path coverage
- `inconclusive` as first-class state
- root `pnpm test` verification

## Notes for Implementers

- Do not treat `agent_activity` as the final validation model. It remains raw evidence.
- Do not introduce correctness-only judge logic as the primary v1 mechanism.
- Keep snapshot payloads summary-oriented; avoid raw HTML dumps in v1.
- Do not let direct process runs bypass validation session creation.
- Prefer adding focused modules in `src/validation/` and `public/viewer/src/modules/agents/` over making `gateway-tool-executor.ts` or `agents.ts` even more monolithic.

Plan complete and saved to `docs/superpowers/plans/2026-04-11-validation-session-implementation.md`. Ready to execute?

---

## GSTACK REVIEW REPORT

| Review        | Trigger               | Why                             | Runs | Status             | Findings                          |
| ------------- | --------------------- | ------------------------------- | ---- | ------------------ | --------------------------------- |
| CEO Review    | `/plan-ceo-review`    | Scope & strategy                | 0    | —                  | —                                 |
| Codex Review  | `/codex review`       | Independent 2nd opinion         | 1    | ISSUES             | 17 findings, 3 accepted into plan |
| Eng Review    | `/plan-eng-review`    | Architecture & tests (required) | 1    | ISSUES_OPEN (PLAN) | 12 issues, 1 critical gap         |
| Design Review | `/plan-design-review` | UI/UX gaps                      | 0    | —                  | —                                 |
| DX Review     | `/plan-devex-review`  | Developer experience gaps       | 0    | —                  | —                                 |

- **CODEX:** 17개 발견. ALTER TABLE migration 누락(반영), execution_status/validation_outcome 분리(반영), agent_validation_state PK 확장(반영). Background delegate async finalize 주의사항 추가.
- **CROSS-MODEL:** Claude와 Codex 모두 agent_activity 확장 선호. Codex는 리팩토링 동시 진행을 반대 → 사용자도 리팩토링 취소 결정.
- **UNRESOLVED:** 0
- **CRITICAL GAP:** 1 — partial session cleanup (ended_at IS NULL → inconclusive 처리)
- **VERDICT:** ENG REVIEW completed with scope reduction. 1 critical gap to resolve during implementation.

### Eng Review 확정 변경사항 (2026-04-11)

1. 테이블 5 → 3 (snapshots/reports → sessions JSON 컬럼 흡수)
2. Raw run envelope = agent_activity 확장 (run_id, status, trigger_reason + ALTER TABLE migration)
3. execution_status + validation_outcome 두 필드 분리
4. agent_validation_state PK = (agent_id, trigger_type)
5. executor 리팩토링 취소 — sessionService.recordRun() 호출만 추가
6. HTML snapshot → API snapshot (CLI 시스템)
7. Viewer = agents.ts 인라인 확장 (기존 detail 페이지 확장)
8. 인덱스 추가: idx_val_metrics_session, idx_val_sessions_agent_status
9. 누락 테스트 4개 추가 (executeValidatedRun, baseline 선택, inconclusive, concurrent sessions)
10. partial session cleanup 로직 (ended_at IS NULL → inconclusive)
11. background delegate 비동기 finalize
12. JSON 저장 시 크기 제한(50KB) + schema_version 필드
13. 사용된 test input을 before_snapshot_json에 기록
