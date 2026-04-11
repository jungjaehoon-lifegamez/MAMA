# v0.19 Agent Lifecycle — Phase 3: Agent Monitoring & Reporting Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 에이전트 운영 가시성 확보 — 이상 감지 + 알림 + Dashboard 브리핑에 에이전트 활동 포함. 자동 대응은 하지 않음 (alert + recommend only, CEO 리뷰 반영).

**Architecture:** `agent_activity` 집계 쿼리 + Conductor audit cron에 에이전트 점검 추가 + Dashboard briefing에 에이전트 섹션. 기존 cron/scheduler/heartbeat 인프라 재사용. 신규 tool 없음.

**Spec:** `docs/superpowers/specs/2026-04-11-v019-agent-lifecycle-design.md` (Phase 3, Section 3.0-3.4)

**Depends on:** Phase 2B + 1B (agent_test + auto-log + Conductor persona) — in plan.

---

## Design Decisions

| Decision                          | Rationale                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------- |
| **자동 대응 없음** (v0.19)        | CEO 리뷰: "auto-remediation은 opt-in. Default = alert + recommend."              |
| **기존 cron 인프라 사용**         | `CronScheduler` + `CronWorker` + `CronResultRouter` 이미 존재. 새 인프라 불필요. |
| **Dashboard Agent 페르소나 확장** | `dashboard-agent-persona.ts` 기존 briefing에 에이전트 활동 섹션 추가.            |
| **신규 gateway tool 없음**        | 집계 쿼리는 Conductor가 `mama_search` + `agent_get` 조합으로 수행 가능.          |

---

## File Structure

| File                                         | Changes                                        |
| -------------------------------------------- | ---------------------------------------------- |
| `src/db/agent-store.ts`                      | `getActivitySummary(db, since)` 집계 쿼리 추가 |
| `src/api/agent-handler.ts`                   | `GET /api/agents/activity-summary` 핸들러      |
| `src/api/graph-api.ts`                       | activity-summary 라우팅                        |
| `~/.mama/personas/conductor.md`              | Agent Monitor 섹션 추가 (audit cron에서 호출)  |
| `src/multi-agent/dashboard-agent-persona.ts` | 에이전트 활동 섹션 브리핑 지시 추가            |
| `public/viewer/src/utils/api.ts`             | `getActivitySummary()` 클라이언트 메서드       |
| `tests/db/agent-activity-summary.test.ts`    | 집계 쿼리 테스트 (NEW)                         |

---

## Task 1: agent_activity 집계 쿼리

**Size: S** | **Files:** `agent-store.ts`, tests

- [ ] **Step 1: 테스트 작성**

```typescript
// tests/db/agent-activity-summary.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from '../../src/sqlite.js';
import { initAgentTables, logActivity, getActivitySummary } from '../../src/db/agent-store.js';

describe('getActivitySummary', () => {
  let db: InstanceType<typeof Database>;
  beforeEach(() => {
    db = new Database(':memory:');
    initAgentTables(db);
  });

  it('returns per-agent summary for period', () => {
    logActivity(db, { agent_id: 'a1', agent_version: 1, type: 'task_complete', duration_ms: 1000 });
    logActivity(db, { agent_id: 'a1', agent_version: 1, type: 'task_complete', duration_ms: 2000 });
    logActivity(db, {
      agent_id: 'a1',
      agent_version: 1,
      type: 'task_error',
      error_message: 'fail',
    });
    logActivity(db, { agent_id: 'a2', agent_version: 1, type: 'task_complete' });

    const summary = getActivitySummary(db, '2000-01-01');
    expect(summary).toHaveLength(2);

    const a1 = summary.find((s) => s.agent_id === 'a1')!;
    expect(a1.total).toBe(3);
    expect(a1.errors).toBe(1);
    expect(a1.error_rate).toBeCloseTo(33.33, 0);
  });

  it('returns empty array when no activity', () => {
    expect(getActivitySummary(db, '2000-01-01')).toEqual([]);
  });

  it('detects consecutive errors', () => {
    // 3 consecutive errors for a1
    logActivity(db, { agent_id: 'a1', agent_version: 1, type: 'task_error', error_message: 'e1' });
    logActivity(db, { agent_id: 'a1', agent_version: 1, type: 'task_error', error_message: 'e2' });
    logActivity(db, { agent_id: 'a1', agent_version: 1, type: 'task_error', error_message: 'e3' });

    const summary = getActivitySummary(db, '2000-01-01');
    const a1 = summary.find((s) => s.agent_id === 'a1')!;
    expect(a1.consecutive_errors).toBe(3);
  });
});
```

- [ ] **Step 2: 구현**

```typescript
export interface ActivitySummaryRow {
  agent_id: string;
  total: number;
  completed: number;
  errors: number;
  error_rate: number;
  consecutive_errors: number;
  last_activity_type: string | null;
  last_activity_at: string | null;
  avg_duration_ms: number;
}

export function getActivitySummary(db: DB, since: string): ActivitySummaryRow[] {
  // Aggregate counts per agent
  const rows = db
    .prepare(
      `
    SELECT
      agent_id,
      COUNT(*) as total,
      SUM(CASE WHEN type = 'task_complete' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN type = 'task_error' THEN 1 ELSE 0 END) as errors,
      ROUND(SUM(CASE WHEN type = 'task_error' THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 2) as error_rate,
      AVG(CASE WHEN duration_ms > 0 THEN duration_ms END) as avg_duration_ms
    FROM agent_activity
    WHERE created_at >= ?
    GROUP BY agent_id
    ORDER BY total DESC
  `
    )
    .all(since) as Array<Record<string, unknown>>;

  // For each agent, find consecutive errors from most recent
  return rows.map((row) => {
    const agentId = String(row.agent_id);
    const recentTypes = db
      .prepare(
        'SELECT type FROM agent_activity WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT 10'
      )
      .all(agentId) as Array<{ type: string }>;

    let consecutiveErrors = 0;
    for (const r of recentTypes) {
      if (r.type === 'task_error') consecutiveErrors++;
      else break;
    }

    const lastActivity = db
      .prepare(
        'SELECT type, created_at FROM agent_activity WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
      )
      .get(agentId) as { type: string; created_at: string } | undefined;

    return {
      agent_id: agentId,
      total: Number(row.total),
      completed: Number(row.completed),
      errors: Number(row.errors),
      error_rate: Number(row.error_rate),
      consecutive_errors: consecutiveErrors,
      last_activity_type: lastActivity?.type ?? null,
      last_activity_at: lastActivity?.created_at ?? null,
      avg_duration_ms: Math.round(Number(row.avg_duration_ms ?? 0)),
    };
  });
}
```

- [ ] **Step 3: 테스트 실행**
- [ ] **Step 4: Commit**

```bash
git add packages/standalone/src/db/agent-store.ts packages/standalone/tests/db/agent-activity-summary.test.ts
git commit -m "feat(agents): getActivitySummary — per-agent aggregation with consecutive error detection"
```

---

## Task 2: Activity Summary API 엔드포인트

**Size: XS** | **Files:** `agent-handler.ts`, `graph-api.ts`, `api.ts`

- [ ] **Step 1: handler**

```typescript
// agent-handler.ts
export function handleGetActivitySummary(
  res: ServerResponse,
  db: SQLiteDatabase,
  since: string
): void {
  const summary = getActivitySummary(db, since);
  const alerts: string[] = [];
  for (const s of summary) {
    if (s.error_rate > 30) alerts.push(`${s.agent_id}: error rate ${s.error_rate}%`);
    if (s.consecutive_errors >= 3)
      alerts.push(`${s.agent_id}: ${s.consecutive_errors} consecutive errors`);
  }
  json(res, 200, { summary, alerts });
}
```

- [ ] **Step 2: route** — `GET /api/agents/activity-summary?since=`
- [ ] **Step 3: API client** — `static async getActivitySummary(since: string)`
- [ ] **Step 4: Commit**

```bash
git add packages/standalone/src/api/agent-handler.ts packages/standalone/src/api/graph-api.ts packages/standalone/public/viewer/src/utils/api.ts
git commit -m "feat(agents): GET /api/agents/activity-summary with alert detection"
```

---

## Task 3: Conductor 페르소나 — Agent Monitor 섹션

**Size: S** | **Files:** `~/.mama/personas/conductor.md`

- [ ] **Step 1: Agent Monitor 섹션 추가** (Agent Factory 뒤에):

```markdown
## Agent Monitor (v0.19)

During hourly audit (audit-checklist.md), add this check:

### Agent Health Check

1. Check agent activity summary (R4 #1 — mama_search는 decisions 테이블만 검색, agent_activity 불가):
   - Dashboard Agent가 `/api/agents/activity-summary?since={yesterday}` 호출 → summary + alerts 반환
   - 또는 `agent_notices` 로 최근 에이전트 이벤트 확인
2. Flag issues:
   - Error rate > 30% → "⚠️ [agent] error rate [N]% — investigate"
   - 3+ consecutive errors → "🚨 [agent] [N] consecutive errors — immediate attention"
   - 24h no activity (for enabled agents) → "ℹ️ [agent] no activity in 24h — verify"
3. For each flagged agent:
   - Read recent errors: `agent_get(agent_id)` → check last activity
   - Diagnose: analyze error patterns
   - **Recommend** (do NOT auto-fix): "Suggested fix: [specific change]. Apply?"
4. Report in chat + viewer_notify for urgent items

### Daily Briefing Contribution

When generating the daily briefing, include agent activity:

- Total delegations today
- Per-agent completion rate
- Any active alerts
```

- [ ] **Step 2: Commit**

```bash
git add ~/.mama/personas/conductor.md
git commit -m "feat(agents): Conductor Agent Monitor persona — health check + alert + recommend"
```

---

## Task 3b: Agents 탭 — Alert 배너 [R4 #2, #3]

**Size: S** | **Files:** `agents.ts`

Design 리뷰: "Phase 3 builds a monitoring backend with no viewer surface."

- [ ] **Step 1: loadAgents에서 activity-summary 병렬 조회**

```typescript
const [{ agents }, summaryRes] = await Promise.all([
  API.getAgents(),
  API.getActivitySummary(new Date(Date.now() - 86400000).toISOString().slice(0, 10)).catch(() => ({
    summary: [],
    alerts: [],
  })),
]);
```

- [ ] **Step 2: 리스트 헤더에 alert 배너 렌더링**

alerts가 있으면 카드 그리드 위에 표시:

```typescript
const alertBanner =
  alerts.length > 0
    ? `<div class="mb-3 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-[12px] text-red-700">
      ⚠ ${alerts.length} agent(s) need attention: ${alerts.slice(0, 3).join(', ')}
    </div>`
    : '';
```

- [ ] **Step 3: Commit**

```bash
git add packages/standalone/public/viewer/src/modules/agents.ts
git commit -m "feat(agents): alert banner on Agents tab from activity-summary"
```

---

## Task 4: Dashboard Agent — 에이전트 활동 브리핑 섹션

**Size: XS** | **Files:** `dashboard-agent-persona.ts`

- [ ] **Step 1: Dashboard persona에 에이전트 섹션 추가**

`DASHBOARD_AGENT_PERSONA` 상수의 "## What to Write" 항목에 추가:

```markdown
- Agent activity summary (if agents are active): delegations, errors, test scores
```

"## How to Write"에 추가:

```markdown
5. Check agent activity: fetch /api/agents/activity-summary?since={yesterday}
6. If active agents exist, add "Agent Activity" section to briefing
```

- [ ] **Step 2: MANAGED_DASHBOARD_PERSONA_MARKER 버전 업** (v3 → v4)
- [ ] **Step 3: Commit**

```bash
git add packages/standalone/src/multi-agent/dashboard-agent-persona.ts
git commit -m "feat(agents): Dashboard briefing includes agent activity summary"
```

---

## Task 5: Build + E2E

**Size: S**

- [ ] `pnpm build` + `pnpm test`
- [ ] Restart MAMA + daemon.log check

### Verification

1. `curl /api/agents/activity-summary?since=2026-04-01` → summary + alerts 반환
2. Conductor audit → 에이전트 health check 수행 (activity-summary API 사용)
3. Dashboard briefing → 에이전트 활동 섹션 포함 (활성 에이전트 있을 때)
4. 에러 3회 연속 시뮬레이션 → Conductor가 alert + recommend (자동 수정 안 함)
5. **Agents 탭 → 리스트 헤더에 alert 배너 표시** (R4 #2, #3)
6. alert 없을 때 → 배너 미표시

---

## GSTACK REVIEW REPORT

| Review                  | Status | Notes               |
| ----------------------- | ------ | ------------------- | ---------------------- |
| CEO + Eng + DX + Design | R4     | 3 findings (1C, 2H) | Resolved in this Rev.2 |

**R4 Findings Applied:**

| #   | Finding                                     | Severity | Resolution                                                          |
| --- | ------------------------------------------- | :------: | ------------------------------------------------------------------- |
| 1   | `mama_search`로 agent_activity 조회 불가    | Critical | Conductor 페르소나에서 `/api/agents/activity-summary` 사용으로 변경 |
| 2   | activity-summary API에 viewer consumer 없음 |   High   | Task 3b 추가: Agents 탭 리스트 헤더에 alert 배너                    |
| 3   | 에러 에이전트 Agents 탭에서 비가시          |   High   | Task 3b에서 alert count 표시                                        |

**VERDICT:** All findings resolved. Plan ready for implementation.
