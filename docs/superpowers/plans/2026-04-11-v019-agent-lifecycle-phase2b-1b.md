# v0.19 Agent Lifecycle — Phase 2B + 1B Implementation Plan (Rev.2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 데모 가능한 에이전트 라이프사이클 완성 — "만들고 테스트까지 해줘" → Conductor 생성 → 테스트 → 자동 점수 → Activity 표시 → 활성화 (90초 flow).

**Architecture:** Conductor 페르소나에 Agent Factory 역할 + Demo Mode 추가 (Phase 2B). `agent_test` gateway tool: `RawStore.getRecent()` + delegate + 자동 점수 저장 (Phase 1B). rawStore는 `setRawStore()` setter 패턴으로 주입. 에이전트 config 조회는 `delegationManagerRef.getAgentConfig()` 경유.

**Spec:** `docs/superpowers/specs/2026-04-11-v019-agent-lifecycle-design.md` (Review Round 2 반영)

**Depends on:** Phase 1A + 2A (Rev.2 Task 1-7) — completed.

**Review Round 2 (spec):** CEO + Eng + DX + Design. Critical 3, High 8.
**Review Round 3 (plan):** CEO + Eng + DX + Design. Critical 3, High 5 — Rev.2에 반영.
**Review Round 4 (plan Rev.2 + Phase 3):** CEO + Eng + DX + Design. Critical 1, High 4 — 이 Rev.3에 반영.

---

## Review Findings Applied

### Round 2 (spec review)

| #   | Finding                        | Severity | Resolution                         |
| --- | ------------------------------ | :------: | ---------------------------------- |
| 1   | Phase 순서 잘못됨              | Critical | 2B → 1B 순서로 재편                |
| 2   | 커넥터 데이터 접근 경로 미정의 | Critical | `RawStore.getRecent()` 신규 메서드 |
| 3   | `agent_test` 리턴 타입 미정의  | Critical | 리턴 스키마 정의                   |
| 4   | Tool surface bloat 4→1         |   High   | `agent_test`만 유지                |
| 5   | 동시성 가드 없음               |   High   | in-flight Map                      |
| 6   | `checkViewerOnly()` 보안       |   High   | agent_test에 적용                  |

### Round 3 (plan review)

| #   | Finding                                                      | Severity | Resolution                                                |
| --- | ------------------------------------------------------------ | :------: | --------------------------------------------------------- |
| 7   | **rawStore 초기화 순서** — 생성자에 전달 불가                | Critical | `setRawStore()` setter 사용 (기존 `setSessionsDb()` 패턴) |
| 8   | **`getMultiAgentConfig()` 미존재**                           | Critical | `DelegationManager.getAgentConfig(agentId)` 메서드 추가   |
| 9   | **점수 저장 경로 없음** — Conductor가 점수를 DB에 쓸 수 없음 | Critical | `agent_test` 내부에서 pass/fail ratio 기반 자동 점수 저장 |
| 10  | 커넥터 데이터 없을 때 fallback                               |   High   | 페르소나에 `test_data` fallback 지시 추가                 |
| 11  | Demo Mode 없음 (90초 초과 위험)                              |   High   | 페르소나에 "만들고 테스트까지 해줘" 시 한번에 실행        |
| 12  | 평가 rubric 없음                                             |   High   | 페르소나에 4항목 평가 기준 추가                           |
| 13  | 시스템 프롬프트 소싱 미정의                                  |   High   | `~/.mama/skills/` 에 스타터 템플릿 2-3개                  |
| 14  | expandable card ARIA 누락                                    |   High   | `aria-expanded`, `role="button"` 추가                     |
| 15  | `params` 문자열 컨벤션 불일치                                |  Medium  | `agent_id, sample_count?, test_data?` 로 간소화           |
| 16  | T5-T7은 post-demo polish                                     |  Medium  | Critical path (T1-T4) 분리 표기                           |

### Round 4 (plan Rev.2 review)

| #   | Finding                                                 | Severity | Resolution                                                       |
| --- | ------------------------------------------------------- | :------: | ---------------------------------------------------------------- |
| 17  | **`getAgentConfig`에서 `Map.find()` — Map에 find 없음** | Critical | `this.agents.get(agentId) ?? null` 사용                          |
| 18  | auto-score vs Conductor rubric 이중 점수                |   High   | auto-score = DB 기록, rubric = 채팅 commentary (페르소나에 명시) |
| 19  | 90초 데모에 delegate 3회 빡빡                           |  Medium  | 데모 기본값 `sample_count: 2`, 페르소나에 명시                   |
| 20  | 스타터 템플릿 2→3개                                     |  Medium  | automation 템플릿 추가                                           |

---

## File Structure

### Phase 2B — Conductor Persona + Starter Templates

| File                                         | Changes                                     |
| -------------------------------------------- | ------------------------------------------- |
| `~/.mama/personas/conductor.md`              | Agent Factory + Demo Mode + 평가 rubric     |
| `~/.mama/skills/agent-persona-qa.md`         | QA 에이전트 스타터 템플릿 (NEW)             |
| `~/.mama/skills/agent-persona-analyst.md`    | 분석 에이전트 스타터 템플릿 (NEW)           |
| `~/.mama/skills/agent-persona-automation.md` | 자동화 에이전트 스타터 템플릿 (NEW, R4 #20) |

### Phase 1B — agent_test Gateway Tool

| File                                    | Changes                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `src/connectors/framework/raw-store.ts` | `getRecent(connectorName, count)`                                       |
| `src/agent/types.ts`                    | GatewayToolName에 `agent_test`                                          |
| `src/agent/tool-registry.ts`            | `agent_test` 등록                                                       |
| `src/agent/gateway-tool-executor.ts`    | `setRawStore()` setter + `executeAgentTest()` + 자동 점수 + 동시성 가드 |
| `src/multi-agent/delegation-manager.ts` | `getAgentConfig(agentId)` 메서드 추가                                   |
| `src/db/agent-store.ts`                 | `updateActivityScore()`                                                 |
| `public/viewer/src/modules/agents.ts`   | test_run expandable card (ARIA), 카드 상태 뱃지, 모바일 스크롤          |

| New File                                        | Responsibility   |
| ----------------------------------------------- | ---------------- |
| `tests/connectors/raw-store-get-recent.test.ts` | getRecent 테스트 |

---

## Critical Path: T1 → T2 → T3 → T4 (데모 필수)

## Post-demo Polish: T5 → T6 → T7 (데모 후 가능)

---

## Task 1: Conductor 페르소나 — Agent Factory + Demo Mode + Rubric [Critical Path]

**Size: M** | **Files:** `~/.mama/personas/conductor.md`, `~/.mama/skills/agent-persona-*.md`

- [ ] **Step 1: 현재 Conductor 페르소나 읽기**

Read `~/.mama/personas/conductor.md` (430줄). "Delegation Tool" 뒤, "Agent Result Querying" 앞에 삽입.

- [ ] **Step 2: Agent Factory 섹션 작성**

```markdown
## Agent Factory (v0.19)

### Creating Agents

When the user asks to create an agent ("에이전트 만들어줘", "make an agent"):

1. Check connectors: `kagemusha_overview` → 어떤 데이터 소스가 있는지 확인
2. Read starter template if applicable: `Read ~/.mama/skills/agent-persona-{type}.md`
3. Design config: name, model (default: claude-sonnet-4-6), tier (default: 2), system prompt, tools
4. Present design to user: "[설정 요약]. 진행할까요?"
5. On approval: `agent_create(id, name, model, tier, system)`
6. `viewer_navigate('agents')` → 새 카드 표시
7. Suggest: "테스트할까요?"

### Testing Agents

1. `agent_test(agent_id)` or `agent_test(agent_id, sample_count: 2)` (demo default: 2)
   - Connector data available → auto-fetches recent items
   - No connector data → provide `test_data` directly: `agent_test(agent_id, test_data: [{input: "..."}])`
2. Review returned `results[]` — each has `{input, output, error?}`
3. **Two scores exist** (R4 #18):
   - `auto_score` (DB 기록): pass/fail ratio, agent_test가 자동 저장. 이것이 공식 점수.
   - Your rubric assessment (채팅 보고용): 아래 4항목으로 분석 코멘트 제공. DB에 저장하지 않음.
4. Report: "auto_score: [N]/100 ([passed]/[total]). [rubric commentary]."
5. If auto_score < 80: suggest specific system prompt improvements
6. `agent_update(agent_id, version, {system: improved}, 'Improve: [reason]')` → new version
7. Offer retest: "v2로 다시 테스트할까요?" Always show Before/After: "v1: 70점 → v2: 95점"

### Evaluation Rubric (채팅 보고용 commentary — DB에 저장 안 함)

When reporting results, provide commentary on 4 dimensions:

- **Accuracy (40%)**: Did the agent produce correct output for each input?
- **Tool Usage (20%)**: Did it use appropriate tools?
- **Output Quality (20%)**: Is the output actionable and relevant?
- **Error Handling (20%)**: Did it handle edge cases?

This commentary helps the user understand WHY the auto_score is what it is.

### Enabling/Disabling

`agent_update(agent_id, version, {enabled: true/false}, 'Enable/disable')`

### Demo Mode

When user says "만들고 테스트까지 해줘" or "create and test":
→ Skip intermediate confirmations. Run create → test(sample_count: 2) → evaluate → report in one shot.
→ Demo default: sample_count 2 (90초 내 완료 보장, R4 #19). 정밀 테스트는 sample_count: 5.
→ Only pause if score < 50 (critical failure).
```

- [ ] **Step 3: Intent Gate 테이블에 Agent Factory 분류 추가**

```markdown
| **Agent Management** (create/test/manage agent) | Use Agent Factory flow | AGENT_FACTORY |
```

- [ ] **Step 4: 스타터 템플릿 작성**

`~/.mama/skills/agent-persona-qa.md`:

```markdown
# QA Agent Starter Template

You are a QA agent that tests and validates data quality.

## Core Behavior

- Given input data, verify format, completeness, and correctness
- Report findings as: PASS (valid), WARN (minor issues), FAIL (critical issues)
- Always explain why each item passed or failed

## Tools

- Read, Grep, Glob for file inspection
- Bash for running validation scripts
```

`~/.mama/skills/agent-persona-analyst.md`:

```markdown
# Analyst Agent Starter Template

You are a data analyst that extracts insights from structured data.

## Core Behavior

- Given data records, identify patterns, anomalies, and trends
- Produce concise summaries with key findings
- Cross-reference with project context when available

## Tools

- Read, Grep, Glob for data access
- kagemusha\_\* for business data queries
```

- [ ] **Step 4b: Automation 스타터 템플릿** (R4 #20)

`~/.mama/skills/agent-persona-automation.md`:

```markdown
# Automation Agent Starter Template

You are an automation agent that monitors data sources and takes action on changes.

## Core Behavior

- Watch for new/changed items from connectors (Drive files, Sheets rows, messages)
- Apply business rules to classify and route items
- Take action: update records, send notifications, create tasks

## Tools

- Read, Bash for file/data operations
- kagemusha\_\* for business data
- discord_send / slack_send for notifications
```

- [ ] **Step 5: Commit**

```bash
git add ~/.mama/personas/conductor.md ~/.mama/skills/agent-persona-qa.md ~/.mama/skills/agent-persona-analyst.md ~/.mama/skills/agent-persona-automation.md
git commit -m "feat(agents): Conductor Agent Factory persona + 3 starter templates + Demo Mode"
```

---

## Task 2: RawStore.getRecent() + DelegationManager.getAgentConfig() [Critical Path]

**Size: S** | **Files:** `raw-store.ts`, `delegation-manager.ts`, tests

- [ ] **Step 1: RawStore.getRecent 테스트 작성**

```typescript
// tests/connectors/raw-store-get-recent.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RawStore } from '../../src/connectors/framework/raw-store.js';

describe('RawStore.getRecent', () => {
  let store: RawStore;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rawstore-test-'));
    store = new RawStore(tempDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty array for unknown connector', () => {
    expect(store.getRecent('nonexistent', 5)).toEqual([]);
  });

  it('returns newest first, limited by count', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      source: 'drive',
      sourceId: `file-${i}`,
      channel: 'folder-a',
      author: 'user',
      content: `File ${i}`,
      timestamp: new Date(2026, 3, 10, 12, i),
      type: 'file_change' as const,
    }));
    store.save('drive', items);
    const recent = store.getRecent('drive', 3);
    expect(recent).toHaveLength(3);
    expect(recent[0].sourceId).toBe('file-4');
  });
});
```

- [ ] **Step 2: getRecent 구현** — `raw-store.ts` 의 `query()` 뒤에:

```typescript
getRecent(connectorName: string, count: number): NormalizedItem[] {
  const db = this.getDb(connectorName);
  const rows = db
    .prepare('SELECT * FROM raw_items ORDER BY timestamp DESC LIMIT ?')
    .all(count) as RawRow[];
  return rows.map((row) => ({
    source: row.source, sourceId: row.source_id, channel: row.channel,
    author: row.author, content: row.content,
    timestamp: new Date(row.timestamp),
    type: row.type as NormalizedItem['type'],
    metadata: row.metadata !== null ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
  }));
}
```

- [ ] **Step 3: DelegationManager.getAgentConfig 추가**

`delegation-manager.ts` 에서 기존 `isDelegationAllowed`가 참조하는 config에서 에이전트 정보를 반환:

```typescript
// NOTE: this.agents is Map<string, AgentPersonaConfig>, not Array — use .get() (R4 #17)
getAgentConfig(agentId: string): Record<string, unknown> | null {
  const agent = this.agents.get(agentId);
  return agent ? { ...agent } : null;
}
```

- [ ] **Step 4: 테스트 실행 + 빌드 확인**
- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/connectors/framework/raw-store.ts packages/standalone/src/multi-agent/delegation-manager.ts packages/standalone/tests/connectors/raw-store-get-recent.test.ts
git commit -m "feat(agents): RawStore.getRecent + DelegationManager.getAgentConfig"
```

---

## Task 3: agent_test 등록 + 핸들러 구현 [Critical Path]

**Size: L** | **Files:** `types.ts`, `tool-registry.ts`, `gateway-tool-executor.ts`, `agent-store.ts`

### Step 1: Types + Registry

- [ ] **1a: GatewayToolName에 추가** (`types.ts`):

```typescript
  // Agent lifecycle tools
  | 'agent_test'
```

- [ ] **1b: tool-registry에 등록** (기존 컨벤션 준수):

```typescript
register({
  name: 'agent_test',
  description: 'Test agent with connector data. Auto-scores pass/fail ratio.',
  category: 'os_management',
  params: 'agent_id, sample_count?, test_data?',
});
```

- [ ] **1c: gateway-tools.md 재생성**

### Step 2: updateActivityScore (agent-store.ts)

- [ ] **2a: 테스트 추가**

```typescript
it('updates activity score and details', () => {
  const row = logActivity(db, { agent_id: 'a', agent_version: 1, type: 'test_run' });
  const updated = updateActivityScore(db, row.id, 85, { total: 3, passed: 2, failed: 1 });
  expect(updated.score).toBe(85);
});
```

- [ ] **2b: 구현**

```typescript
export function updateActivityScore(
  db: DB,
  activityId: number,
  score: number,
  details: Record<string, unknown>
): ActivityRow {
  db.prepare('UPDATE agent_activity SET score = ?, details = ? WHERE id = ?').run(
    score,
    JSON.stringify(details),
    activityId
  );
  return db.prepare('SELECT * FROM agent_activity WHERE id = ?').get(activityId) as ActivityRow;
}
```

### Step 3: setRawStore setter (gateway-tool-executor.ts)

- [ ] **3a: rawStore 프로퍼티 + setter 추가** (기존 `setSessionsDb` 패턴):

```typescript
private rawStore: import('../connectors/framework/raw-store.js').RawStore | null = null;

setRawStore(store: import('../connectors/framework/raw-store.js').RawStore): void {
  this.rawStore = store;
}
```

- [ ] **3b: start.ts에서 Phase 9 이후 setter 호출:**

```typescript
// After rawStore creation in Phase 9:
toolExecutor.setRawStore(rawStoreForApi);
```

### Step 4: executeAgentTest 핸들러

- [ ] **4a: 동시성 가드:**

```typescript
private testInFlight = new Map<string, Promise<GatewayToolResult>>();
```

- [ ] **4b: 핸들러 구현** — `checkViewerOnly()` + 커넥터 데이터 수집 + delegate + **자동 점수 저장**:

```typescript
private async executeAgentTest(input: {
  agent_id: string;
  sample_count?: number;
  test_data?: Array<{ input: string; expected?: string }>;
}): Promise<GatewayToolResult> {
  const permError = this.checkViewerOnly();
  if (permError) return { success: false, error: permError } as GatewayToolResult;

  const { agent_id, sample_count = 3 } = input;

  if (this.testInFlight.has(agent_id)) {
    return { success: false, error: 'test_already_running' } as GatewayToolResult;
  }

  const promise = this._runAgentTest(agent_id, sample_count, input.test_data);
  this.testInFlight.set(agent_id, promise);
  try { return await promise; } finally { this.testInFlight.delete(agent_id); }
}

private async _runAgentTest(
  agentId: string, sampleCount: number,
  testData?: Array<{ input: string; expected?: string }>
): Promise<GatewayToolResult> {
  const startTime = Date.now();

  // 1. Collect test data
  let items: Array<{ input: string; expected?: string }>;
  if (testData && testData.length > 0) {
    items = testData;
  } else if (this.rawStore && this.delegationManagerRef) {
    const agentConfig = this.delegationManagerRef.getAgentConfig(agentId);
    const connectors: string[] = (agentConfig?.connectors as string[]) ?? [];
    if (connectors.length === 0) {
      return { success: false, error: 'connector_unavailable: no connectors configured' } as GatewayToolResult;
    }
    const allItems: Array<{ input: string }> = [];
    for (const conn of connectors) {
      const recent = this.rawStore.getRecent(conn, sampleCount);
      for (const item of recent) {
        allItems.push({ input: `[${item.type}] ${item.content}` });
      }
      if (allItems.length >= sampleCount) break;
    }
    if (allItems.length === 0) {
      return { success: false, error: 'connector_unavailable: no recent data' } as GatewayToolResult;
    }
    items = allItems.slice(0, sampleCount);
  } else {
    return { success: false, error: 'connector_unavailable: rawStore not available' } as GatewayToolResult;
  }

  // 2. Log test_run start
  let testRunId: number | null = null;
  if (this.sessionsDb) {
    const ver = getLatestVersion(this.sessionsDb, agentId);
    const row = logActivity(this.sessionsDb, {
      agent_id: agentId, agent_version: ver?.version ?? 0,
      type: 'test_run', input_summary: `Testing with ${items.length} items`,
    });
    testRunId = row.id;
  }

  // 3. Delegate sequentially (v0.19 — parallel in v0.20)
  const results: Array<{ input: string; output?: string; error?: string }> = [];
  for (const item of items) {
    try {
      const r = await this.executeDelegate({ agentId, task: `Process this data:\n${item.input}` });
      results.push({
        input: item.input,
        output: r.success ? String((r.data as Record<string,unknown>)?.response ?? '').slice(0, 500) : undefined,
        error: r.success ? undefined : String((r as Record<string,unknown>).error),
      });
    } catch (err) {
      results.push({ input: item.input, error: String(err) });
    }
  }

  // 4. Auto-score: pass/fail ratio (Finding #9 — score 저장 경로 해결)
  const passed = results.filter(r => !r.error).length;
  const failed = results.length - passed;
  const autoScore = Math.round((passed / results.length) * 100);

  if (this.sessionsDb && testRunId) {
    updateActivityScore(this.sessionsDb, testRunId, autoScore, {
      total: results.length, passed, failed,
      items: results.map(r => ({ input: r.input.slice(0, 100), result: r.error ? 'fail' : 'pass' })),
    });
  }

  return {
    success: true,
    data: {
      test_run_id: testRunId, agent_id: agentId,
      results, auto_score: autoScore,
      duration_ms: Date.now() - startTime,
    },
  } as GatewayToolResult;
}
```

- [ ] **4c: switch에 case 추가:**

```typescript
case 'agent_test':
  return await this.executeAgentTest(input as { agent_id: string; sample_count?: number; test_data?: Array<{ input: string; expected?: string }> });
```

- [ ] **4d: agentProcessManager null check** (Eng #2):

```typescript
// _runAgentTest 시작에 추가:
if (!this.agentProcessManager || !this.delegationManagerRef) {
  return {
    success: false,
    error: 'agent_timeout: multi-agent not configured',
  } as GatewayToolResult;
}
```

### Step 5: 빌드 + 테스트

- [ ] `npx tsc --noEmit`
- [ ] `pnpm test`
- [ ] **Commit**

```bash
git add packages/standalone/src/agent/types.ts packages/standalone/src/agent/tool-registry.ts packages/standalone/src/agent/gateway-tools.md packages/standalone/src/agent/gateway-tool-executor.ts packages/standalone/src/cli/commands/start.ts packages/standalone/src/db/agent-store.ts
git commit -m "feat(agents): agent_test gateway tool — auto-score, setRawStore, concurrency guard"
```

---

## Task 4: Build + Demo Flow E2E [Critical Path]

**Size: S**

- [ ] **Step 1: Full build** — `pnpm build`
- [ ] **Step 2: All tests** — `pnpm test`
- [ ] **Step 3: Restart MAMA** — `mama stop && mama start`
- [ ] **Step 4: daemon.log 확인** — `tail -20 ~/.mama/logs/daemon.log`

### Demo Flow Verification

1. 채팅: "에이전트 만들 수 있어?" → Conductor가 Agent Factory flow 인지
2. 채팅: "QA 에이전트 만들고 테스트까지 해줘" → Demo Mode: create → test → score → report 한번에
3. Agents 탭 → Activity → test_run 항목 표시 (auto_score 포함)
4. 채팅: "점수가 낮으면 개선해줘" → Conductor가 agent_update → retest → Before/After

- [ ] **Step 5: Commit fixes**

---

## Task 5: Activity 탭 — test_run expandable card [Post-demo]

**Size: S** | **Files:** `agents.ts`

- [ ] **Step 1: test_run 특별 렌더링** — `type === 'test_run'`일 때 expandable card:

```typescript
// ARIA 접근성 (Design #14)
<div role="button" aria-expanded="false" aria-controls="expand-${ev.id}" data-expand="${ev.id}">
  ...score summary...
</div>
<div id="expand-${ev.id}" class="hidden" ...>
  ...per-item pass/fail badges...
</div>
```

- [ ] **Step 2: expand 토글 + aria-expanded 업데이트**
- [ ] **Step 3: Commit**

---

## Task 6: 카드 상태 뱃지 + 마지막 실행 [Post-demo]

**Size: M** | **Files:** `agents.ts`, `api.ts`, `agent-handler.ts`

- [ ] **Step 1: GET /api/agents 에 last_activity 포함**
- [ ] **Step 2: 카드에 상태 뱃지 + relative time** ("2m ago")
  - `enabled === false` → disabled (gray)
  - `last_activity?.type === 'task_error'` → error (red)
  - last_activity < 5min → active (green)
  - else → idle (yellow)
- [ ] **Step 3: version을 카드에서 제거** (detail header에만)
- [ ] **Step 4: `relativeTime(date)` util 추가** (Design #12)
- [ ] **Step 5: Commit**

---

## Task 7: 모바일 탭 스크롤 [Post-demo]

**Size: XS** | **Files:** `agents.ts`

- [ ] **Step 1: 탭 바에 `overflow-x:auto;-webkit-overflow-scrolling:touch` 추가**
- [ ] **Step 2: Commit**

---

## Task 8: Final Build + Full E2E

- [ ] `pnpm build` + `pnpm test`
- [ ] Restart MAMA + daemon.log check

### Full Verification Checklist

1. 채팅 → "에이전트 만들고 테스트까지 해줘" → 90초 내 완료 (Demo Day)
2. Activity 탭 → test_run expandable card (pass/fail per item)
3. 카드: 상태 뱃지 + 마지막 실행 시각 (version 없음)
4. 모바일(375px): 5탭 가로 스크롤
5. Settings → "Agents 탭으로 이동"
6. Config/Tools → Save → hot reloaded

---

## GSTACK REVIEW REPORT

| Review                                         | Round | Findings             | Status                 |
| ---------------------------------------------- | ----- | -------------------- | ---------------------- |
| CEO + Eng + DX + Design (spec)                 | R2    | 11 findings (3C, 8H) | Resolved in spec       |
| CEO + Eng + DX + Design (plan)                 | R3    | 8 findings (3C, 5H)  | Resolved in Rev.2      |
| CEO + Eng + DX + Design (plan Rev.2 + Phase 3) | R4    | 5 findings (1C, 4H)  | Resolved in this Rev.3 |

**VERDICT:** All critical/high findings resolved across 4 rounds. Plan ready for implementation.
