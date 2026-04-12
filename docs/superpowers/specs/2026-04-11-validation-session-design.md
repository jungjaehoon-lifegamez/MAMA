# Validation Session v1 — Shared Observable Validation Model

> 사람과 Conductor가 같은 증거를 보고, 에이전트의 개선 전후를 비교할 수 있게 만드는 공통관측모델.
>
> **Scope:** v1은 `validation_session` 데이터 모델, 공통 실행 봉투(raw run envelope), Viewer 검증 UX, baseline 비교, Conductor audit/report 루프까지 정의한다. 자동 self-remediation과 고급 DOM diff는 제외한다.
>
> **Design Goal:** "에이전트가 돌았다"가 아니라 "이전보다 나아졌는가/나빠졌는가를 사람과 Conductor가 같은 기준으로 설명할 수 있는가"를 시스템의 중심으로 올린다.

## Problem

현재 MAMA OS는 실행 조각은 있지만 검증 시스템은 아니다.

- 어떤 경로는 실제로 실행되지만 Activity에 남지 않는다.
- 어떤 경로는 Activity에 남아도 사람이 그것으로 개선 여부를 판단할 수 없다.
- Viewer는 로그를 보여줄 뿐, validation과 benchmark 결과를 보여주지 않는다.
- Conductor는 일부 실행 결과를 읽을 수 있지만, 사람이 보는 화면과 같은 증거를 읽지 않는다.
- 결과적으로 "실행은 되었지만 더미처럼 보이는" 상태가 반복된다.

즉 문제는 단순한 로깅 누락이 아니다. **사람과 Conductor가 공유하는 검증 현실(shared reality)이 없다.**

## Existing Assets (Reuse First)

v1은 완전히 새로 짓지 않고, 이미 있는 자산을 기반으로 쌓는다.

### Existing runtime / persistence

- `agent_activity` + `agent_versions`: `packages/standalone/src/db/agent-store.ts`
- agent CRUD + activity APIs: `packages/standalone/src/api/agent-handler.ts`
- Agent execution + `agent_test` + `auto_score`: `packages/standalone/src/agent/gateway-tool-executor.ts`
- delegate activity logging path: `packages/standalone/src/agent/gateway-tool-executor.ts`, `packages/standalone/src/multi-agent/delegation-manager.ts`
- health / metrics: `packages/standalone/src/observability/health-score.ts`

### Existing Viewer surfaces

- Agents detail / Activity tab: `packages/standalone/public/viewer/src/modules/agents.ts`
- Agent APIs used by Viewer: `packages/standalone/public/viewer/src/utils/api.ts`
- Log viewer / audit timeline affordances: `packages/standalone/public/viewer/log-viewer.html`

### Existing benchmark assets

- agent path benchmark: `packages/standalone/tests/benchmark/agent-path-benchmark.test.ts`
- memory provider benchmark: `packages/standalone/tests/benchmark/memory-provider-benchmark.test.ts`
- `packages/memorybench/*` for judge/report infrastructure and compare workflows

## Core Decision

Validation v1 uses a **shared observable model** built around `validation_session`.

The system is split into three layers:

1. **Raw Run Envelope**
   Every execution path emits the same minimal run event.
2. **Validation Session**
   A validation unit that captures before/after state, observations, deltas, and interpretation.
3. **Validation Report**
   A human-readable report from the Conductor that explains what changed and why it matters.

The key rule is:

> **Execution paths may differ, but validation paths must converge.**

This means `delegate_run`, `agent_test`, `system_run`, and `audit` all feed the same validation model.

## Non-Goals

v1 deliberately does **not** include:

- automatic agent self-remediation
- full DOM tree diffs
- correctness-first judge models as the primary validation mechanism
- per-session custom metric profile creation by the user
- manual human-authored benchmark prompts as the main workflow

v1 is about **shared measurement**, not autonomous improvement.

## What "Validation" Means

Validation is **not** "was the answer morally right?"

Validation is:

- did the loop complete?
- did the expected observable state change happen?
- how much time / token / path cost did it take?
- was the new route better or worse than the approved baseline?
- is there enough evidence to make that judgment?

This leads to four canonical statuses:

- `healthy`
- `improved`
- `regressed`
- `inconclusive`

`inconclusive` is first-class. If HTML/API/DB evidence is missing or inconsistent, the run is not silently treated as success.

## Architecture

```text
trigger
  -> raw run envelope starts
  -> before snapshot
  -> execution trace
  -> after snapshot
  -> delta calculation
  -> metric profile application
  -> status classification
  -> Conductor report
  -> optional approval / improvement recommendation
```

## Trigger Model

Validation sessions are created for all of the following:

- `agent_test`
- `delegate_run`
- `system_run`
- `audit`

Current branch note: `agent_test` / `delegate_run` are created in
`packages/standalone/src/agent/gateway-tool-executor.ts`, while `system_run` / `audit`
are created in `packages/standalone/src/cli/runtime/api-routes-init.ts`.

### Trigger semantics

- `agent_test`
  Explicit benchmark/test session
- `delegate_run`
  Real task execution session
- `system_run`
  Direct system-agent execution (e.g. Wiki Agent, Dashboard Agent)
- `audit`
  Observational validation or regression check triggered by Conductor

## Data Model

### 1. Keep `agent_versions`

`agent_versions` remains the source of truth for:

- version numbering
- snapshot/config history
- persona text
- change note

### 2. New table: `validation_sessions`

One validation unit from observation start to human-facing report.

Suggested schema:

```sql
CREATE TABLE validation_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  agent_version INTEGER NOT NULL,
  trigger_type TEXT NOT NULL,          -- agent_test | delegate_run | system_run | audit
  goal TEXT,                           -- latency | token_efficiency | change_detection | ...
  metric_profile_json TEXT NOT NULL,
  baseline_version INTEGER,
  baseline_session_id TEXT,
  execution_status TEXT NOT NULL,      -- started | completed | failed | timeout
  validation_outcome TEXT NOT NULL,    -- healthy | improved | regressed | inconclusive
  summary TEXT,
  recommendation TEXT,
  before_snapshot_json TEXT,
  after_snapshot_json TEXT,
  report_json TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  requires_approval INTEGER DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
```

### 3. Snapshot payloads on `validation_sessions`

현재 브랜치의 v1 구현은 별도 `validation_snapshots` 테이블을 두지 않고,
`validation_sessions`에 JSON blob으로 보관한다.

- `before_snapshot_json`
- `after_snapshot_json`
- `report_json`

별도 `validation_snapshots` / `validation_reports` 테이블 분리는 future work다.

### 4. New table: `validation_metrics`

Stores normalized metrics and their delta against baseline.

```sql
CREATE TABLE validation_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  validation_session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value REAL NOT NULL,
  baseline_value REAL,
  delta_value REAL,
  direction TEXT NOT NULL,             -- up_good | down_good | neutral
  created_at INTEGER NOT NULL
);
```

### 5. New table: `agent_validation_state`

Stores the current approved baseline and validation posture of an agent.

```sql
CREATE TABLE agent_validation_state (
  agent_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  approved_version INTEGER,
  approved_session_id TEXT,
  current_status TEXT,
  last_validation_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, trigger_type)
);
```

## Raw Run Envelope

Every execution path must emit the same minimal record, regardless of how the run started.

This can be implemented as:

- new table, or
- normalized `agent_activity` rows with a stronger run/session key

v1 requirement is behavioral, not storage-specific:

```json
{
  "run_id": "uuid",
  "source": "delegate_run | agent_test | system_run | audit",
  "agent_id": "wiki-agent",
  "agent_version": 3,
  "trigger_reason": "html_changed",
  "status": "started | completed | failed | timeout",
  "started_at": 1775891676488,
  "ended_at": 1775891679000,
  "duration_ms": 2512,
  "input_summary": "Compile wiki for changed project pages",
  "output_summary": "3 pages published",
  "tokens_used": 1420,
  "tools_called": ["mama_search", "obsidian", "wiki_publish"],
  "error_message": null
}
```

### Critical rule

Anything that currently does:

```ts
pm.getSharedProcess(...).sendMessage(...)
```

without logging must be routed through the same envelope writer used by delegate/test runs.

If direct system-agent runs skip this layer, the validation model becomes fake again.

## Snapshot Model

v1 snapshot storage is summary-oriented, not raw dump oriented.

### HTML snapshot (summary only)

Store only human-visible state relevant to validation.

Example:

```json
{
  "route": "agents",
  "selected_agent": "wiki-agent",
  "visible_status_badge": "Error",
  "visible_activity_count": 0,
  "visible_latest_score": null,
  "visible_alert_count": 1
}
```

### API snapshot

Only whitelisted fields used for validation.

Example:

```json
{
  "agent": {
    "enabled": true,
    "version": 3,
    "display_name": "Wiki Agent"
  },
  "activity": {
    "count": 0,
    "latest_type": null,
    "latest_score": null
  },
  "summary": {
    "consecutive_errors": 0,
    "error_rate": 0
  }
}
```

### DB snapshot

Aggregate counters and latest event summaries only.

Example:

```json
{
  "activity_count": 14,
  "latest_run_status": "completed",
  "latest_score": 95,
  "consecutive_errors": 0
}
```

### Activity snapshot

Recent typed event summary for human traceability.

Example:

```json
{
  "recent_types": ["task_start", "task_complete", "test_run"],
  "recent_count": 3
}
```

## Metric Profile

Each agent has a default `metric_profile`. The user does not author this per session.

The profile contains:

- `primary_metrics`
- `thresholds`
- `extensions`

Example:

```json
{
  "primary_metrics": [
    "publish_latency_ms",
    "token_cost",
    "meaningless_run_rate",
    "change_detection_rate"
  ],
  "thresholds": {
    "publish_latency_ms": { "warn": 30000, "critical": 60000 },
    "meaningless_run_rate": { "warn": 0.3, "critical": 0.5 }
  },
  "extensions": ["connector_binding_accuracy", "entity_detection", "data_link_inference"]
}
```

### Example default profiles

#### `wiki-agent`

- `publish_latency_ms`
- `token_cost`
- `meaningless_run_rate`
- `change_detection_rate`
- `path_efficiency`

#### `dashboard-agent`

- `briefing_latency_ms`
- `token_cost`
- `signal_to_noise`
- `staleness`

## Baseline Rules

Comparisons must be deterministic.

Baseline selection order:

All baseline lookups are scoped to the same `(agent_id, trigger_type)` track as the current
session.

1. `approved_session_id`
2. last `healthy` validation session with the same `trigger_type`
3. last completed validation session with the same `trigger_type`
4. otherwise `inconclusive`

All three lookup steps must be restricted to the same `(agent_id, trigger_type)` pair.
This is required because persisted validation state is keyed by `agent_id + trigger_type`,
so `delegate_run`, `agent_test`, `system_run`, and `audit` must not borrow baselines from
one another.

This baseline is used for:

- delta calculations
- version timeline comparison
- improved/regressed classification

## Status Classification

### `healthy`

- loop completed
- no critical threshold violation
- no evidence gap
- no meaningful regression vs baseline

### `improved`

- loop completed
- one or more primary metrics improved
- no critical regression

### `regressed`

- loop completed or partially completed
- but one or more primary metrics regressed beyond threshold
- or severe error pattern detected

### `inconclusive`

- evidence missing or contradictory
- HTML/API/DB do not line up
- run trace incomplete
- baseline unavailable

## Conductor Audit Loop

The Conductor is not a correctness oracle. It is an observer, comparer, and explainer.

### Audit sequence

1. collect snapshots
2. collect run envelopes
3. compute deltas
4. apply metric profile
5. classify status
6. produce recommendation
7. report to human

### Report contract

Each report must answer:

1. what changed?
2. what metric moved?
3. why does it matter?
4. what should happen next?

Example:

```text
Wiki Agent validation: regressed
- HTML changed: yes (3 pages visible)
- API/DB evidence: partial
- activity trace: missing
- publish latency: 24s -> 41s
- token cost: 1200 -> 1800
Recommendation: fix run-to-activity linkage before further optimization
```

## Viewer UX / IA

The Viewer must be a **decision surface**, not a raw log viewer.

### Agent detail IA

Current viewer tabs in `agents.ts` are:

1. `Config`
   - model / backend / tier / enabled state
   - runtime-editable config fields

2. `Persona`
   - current persona text
   - inline edit + save path

3. `Tools`
   - Claude built-in tool permissions
   - current viewer scope: edits Claude CLI built-in `tool_permissions` only
   - gateway tools (`mama_search`, `agent_*`, `viewer_*`, `browser_*`) are implemented in
     `packages/standalone/src/agent/gateway-tool-executor.ts` and are not surfaced by the
     current viewer Tools tab

4. `Activity`
   - task / audit activity feed
   - duration, score, error, run linkage

5. `Validation`
   - latest validation session
   - top metrics
   - recommendation
   - approve / hold / request improvement

6. `History`
   - version timeline
   - approved baseline marker
   - per-version performance summary
   - drill-down to validation sessions

Planned follow-up surfaces:

- `Overview`
- `Diff`
- `Run Trace`

### UX language rule

The UI should speak in **delta-first** language:

- `24s -> 41s`
- `1200 -> 1800 tokens`
- `3 pages -> 3 pages (no visible gain)`

### History requirement

History must not be a plain version list.

Each version row must show:

- run count
- completion rate
- median / p95 latency
- avg / p95 tokens
- path efficiency
- regression count
- status (`testing | approved | regressed | retired`)

## Required APIs

### Validation summary

- `GET /api/agents/:id/validation/summary`

Returns:

- current status
- approved baseline
- top metrics
- latest recommendation

### Validation history

- `GET /api/agents/:id/validation/history`

Returns:

- version timeline
- version performance summary
- baseline markers

### Session detail

- `GET /api/validation-sessions/:id`

Returns:

- snapshots
- metrics
- report
- linked run envelopes

### Approval / improvement actions

- `POST /api/agents/:id/validation/approve?session_id=vs-123`
- `POST /api/agents/:id/validation/request-improvement`

Approval parameters:

- `session_id`: required. The validation session id being approved as the baseline for
  this agent/trigger track.

Example:

- `POST /api/agents/wiki-agent/validation/approve?session_id=vs-123`

### Comparison

- `GET /api/agents/:id/validation/compare?session=vs-123&baseline=approved`

Parameters:

- `session`: validation session id to compare
- `baseline`: `approved` or explicit baseline session id

## Review Validation Flow

The design is considered valid only if it passes all four review stages.

### 1. Design Review

Checks:

- all execution paths converge into raw run envelopes
- validation sessions are generated consistently
- baseline rules are deterministic

### 2. Observability Review

Checks:

- before/after snapshots exist
- evidence gaps become `inconclusive`
- no path looks "successful" without observable proof

### 3. Runtime Review

Checks:

- real system agents create validation sessions
- validation summary matches runtime truth
- activity and validation no longer diverge silently

### 4. Approval Review

Checks:

- human can decide whether to accept a version
- Conductor reports are understandable and actionable

## v1 Implementation Scope

### Must ship

- raw run envelope convergence
- `validation_sessions`
- `validation_metrics`
- `agent_validation_state`
- `before_snapshot_json` / `after_snapshot_json` / `report_json` on `validation_sessions`
- baseline comparison rules
- Config / Persona / Tools / Activity / Validation / History viewer surfaces
- unified handling for `delegate_run`, `agent_test`, `system_run`, `audit`

### Deferred

- automatic self-remediation
- full DOM diff storage
- advanced rubric judge models
- agent-specific extension metrics beyond the initial registry
- multiple baseline strategies

## Acceptance Criteria

v1 is complete only when all are true:

1. any agent execution path creates raw run envelopes
2. a validation session can be reconstructed from shared evidence
3. Viewer and Conductor read the same validation result
4. improved/regressed/inconclusive is visible to the human
5. version history shows performance, not just version numbers
6. missing evidence is surfaced as a first-class failure mode

## Open Risks

- direct process execution paths may still bypass the shared envelope if not fully centralized
- system agent triggers and watchdog restarts may create partial sessions unless carefully bounded
- snapshot schema drift can make comparisons noisy if selectors / API fields are not stabilized

## Next Step

After this spec is approved:

1. create implementation plan
2. define raw run envelope writer
3. centralize all execution paths behind it
4. build validation session persistence
5. expose Config / Persona / Tools / Activity / Validation / History in the Viewer
6. stage Overview / Diff / Run Trace as follow-up UI work
