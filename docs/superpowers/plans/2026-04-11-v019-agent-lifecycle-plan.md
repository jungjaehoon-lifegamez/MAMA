# v0.19 Agent Lifecycle Implementation Plan (Rev.2 — Post-Review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the agent lifecycle system — create agents via chat, verify with real data, track in production — all orchestrated by Conductor.

**Architecture:** Settings 탭의 에이전트 편집을 Agents 탭으로 통합. 기존 `PUT /api/multi-agent/agents/:id` 핫리로드 경로 재사용. agent_versions는 감사 전용. agent_activity 자동 로깅은 delegation handler에 삽입.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), vanilla TS viewer modules (Tailwind), gateway tool registry

**Spec:** `docs/superpowers/specs/2026-04-11-v019-agent-lifecycle-design.md`

**Review:** Codex + Claude 서브에이전트 리뷰 반영 (2026-04-11). Critical 이슈 2건, High 2건 수정.

---

## Review Findings Applied

| #   | Finding                                   | Severity | Resolution                                                                                           |
| --- | ----------------------------------------- | :------: | ---------------------------------------------------------------------------------------------------- |
| 1   | config.yaml vs agent_versions 이중 저장소 | Critical | Config 저장 → 기존 `PUT /api/multi-agent/agents/:id` 사용. agent_versions는 감사 전용 기록만.        |
| 2   | agent_activity 자동 로깅 없음             | Critical | delegation handler (`gateway-tool-executor.ts`)에서 delegate 시작/완료/에러 시 자동 logActivity 호출 |
| 3   | Settings에 이미 에이전트 편집 존재        | Critical | Settings 에이전트 섹션 → Agents 탭으로 이동. Settings에서 제거.                                      |
| 4   | agent_enable 보안 경계 누락               |   High   | checkViewerOnly() 적용                                                                               |
| 5   | config.yaml 직접 fs.writeFileSync         |   High   | saveConfig() 헬퍼 사용 또는 기존 multi-agent PUT 경로                                                |
| 6   | details/suggestion DB 미반영              |  Medium  | agent_activity에 details TEXT (JSON) 컬럼 추가                                                       |

---

## File Structure

### Modified Files

| File                                    | Changes                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| `public/viewer/src/modules/agents.ts`   | Settings의 에이전트 카드 코드 통합, Config 편집 (기존 PUT 사용), Activity 탭 추가   |
| `public/viewer/src/modules/settings.ts` | 에이전트 섹션 제거 → "Agents 탭에서 관리" 안내                                      |
| `public/viewer/src/utils/api.ts`        | getAgentActivity API 메서드 추가                                                    |
| `src/agent/gateway-tool-executor.ts`    | delegate() 전후에 logActivity 자동 호출 + agent_activity_log 도구에 checkViewerOnly |
| `src/agent/tool-registry.ts`            | agent_activity_log 등록                                                             |
| `src/agent/types.ts`                    | GatewayToolName에 agent_activity_log 추가                                           |
| `src/api/agent-handler.ts`              | GET /api/agents/:id/activity 핸들러 추가                                            |
| `src/api/graph-api.ts`                  | activity 엔드포인트 라우팅                                                          |
| `src/db/agent-store.ts`                 | agent_activity 테이블 (details 컬럼 포함) + logActivity/getActivity                 |

### New Files

| File                              | Responsibility                      |
| --------------------------------- | ----------------------------------- |
| `tests/db/agent-activity.test.ts` | agent_activity 테이블 + CRUD 테스트 |

---

## Task 1: agent_activity DB Table + CRUD

**Files:**

- Modify: `packages/standalone/src/db/agent-store.ts`
- Create: `packages/standalone/tests/db/agent-activity.test.ts`

- [ ] **Step 1: Write failing test for table initialization**

```typescript
// packages/standalone/tests/db/agent-activity.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initAgentTables, logActivity, getActivity } from '../../src/db/agent-store.js';

describe('agent_activity', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    initAgentTables(db);
  });

  it('creates agent_activity table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_activity'")
      .all();
    expect(tables).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/standalone && pnpm vitest run tests/db/agent-activity.test.ts`
Expected: FAIL — logActivity, getActivity not exported

- [ ] **Step 3: Add agent_activity table to initAgentTables**

Append to `initAgentTables()` in `packages/standalone/src/db/agent-store.ts`:

```typescript
db.exec(`
    CREATE TABLE IF NOT EXISTS agent_activity (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id        TEXT NOT NULL,
      agent_version   INTEGER NOT NULL,
      type            TEXT NOT NULL,
      input_summary   TEXT,
      output_summary  TEXT,
      tokens_used     INTEGER DEFAULT 0,
      tools_called    TEXT,
      duration_ms     INTEGER DEFAULT 0,
      score           REAL,
      details         TEXT,
      error_message   TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_agent_activity_agent ON agent_activity(agent_id, created_at)`
);
```

- [ ] **Step 4: Run test — table creation passes**

- [ ] **Step 5: Write failing tests for logActivity and getActivity**

```typescript
describe('activity CRUD', () => {
  let db: InstanceType<typeof Database>;
  beforeEach(() => {
    db = new Database(':memory:');
    initAgentTables(db);
  });

  it('logs activity with details JSON', () => {
    const row = logActivity(db, {
      agent_id: 'test-agent',
      agent_version: 1,
      type: 'task_complete',
      input_summary: 'Process file X',
      output_summary: 'Matched to project A',
      tokens_used: 150,
      tools_called: ['Read', 'Bash'],
      duration_ms: 2300,
      details: { items: [{ input: 'file.mov', result: 'pass' }] },
    });
    expect(row.id).toBeGreaterThan(0);
    expect(row.type).toBe('task_complete');
    expect(JSON.parse(row.details!).items).toHaveLength(1);
  });

  it('retrieves activity by agent_id newest first', () => {
    logActivity(db, { agent_id: 'a1', agent_version: 1, type: 'task_complete' });
    logActivity(db, {
      agent_id: 'a1',
      agent_version: 1,
      type: 'task_error',
      error_message: 'timeout',
    });
    logActivity(db, { agent_id: 'a2', agent_version: 1, type: 'task_complete' });

    const a1 = getActivity(db, 'a1', 10);
    expect(a1).toHaveLength(2);
    expect(a1[0].type).toBe('task_error');
  });

  it('logs test_run with score and details', () => {
    const row = logActivity(db, {
      agent_id: 'test-agent',
      agent_version: 2,
      type: 'test_run',
      input_summary: '3 files tested',
      output_summary: '3/3 passed',
      score: 95,
      details: { total: 3, passed: 3, failed: 0, suggestion: null },
    });
    expect(row.score).toBe(95);
  });
});
```

- [ ] **Step 6: Implement logActivity and getActivity**

```typescript
export interface LogActivityInput {
  agent_id: string;
  agent_version: number;
  type: string;
  input_summary?: string;
  output_summary?: string;
  tokens_used?: number;
  tools_called?: string[];
  duration_ms?: number;
  score?: number;
  details?: Record<string, unknown>;
  error_message?: string;
}

export interface ActivityRow {
  id: number;
  agent_id: string;
  agent_version: number;
  type: string;
  input_summary: string | null;
  output_summary: string | null;
  tokens_used: number;
  tools_called: string | null;
  duration_ms: number;
  score: number | null;
  details: string | null;
  error_message: string | null;
  created_at: string;
}

export function logActivity(db: DB, input: LogActivityInput): ActivityRow {
  const stmt = db.prepare(`
    INSERT INTO agent_activity (agent_id, agent_version, type, input_summary, output_summary, tokens_used, tools_called, duration_ms, score, details, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    input.agent_id,
    input.agent_version,
    input.type,
    input.input_summary ?? null,
    input.output_summary ?? null,
    input.tokens_used ?? 0,
    input.tools_called ? JSON.stringify(input.tools_called) : null,
    input.duration_ms ?? 0,
    input.score ?? null,
    input.details ? JSON.stringify(input.details) : null,
    input.error_message ?? null
  );
  return db
    .prepare('SELECT * FROM agent_activity WHERE id = ?')
    .get(result.lastInsertRowid) as ActivityRow;
}

export function getActivity(db: DB, agentId: string, limit: number): ActivityRow[] {
  return db
    .prepare(
      'SELECT * FROM agent_activity WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
    )
    .all(agentId, limit) as ActivityRow[];
}
```

Note: `ORDER BY created_at DESC, id DESC` — same-second 이벤트도 순서 보장 (Codex 리뷰 반영).

- [ ] **Step 7: Run tests — ALL PASS**
- [ ] **Step 8: Commit**

```bash
git add packages/standalone/src/db/agent-store.ts packages/standalone/tests/db/agent-activity.test.ts
git commit -m "feat(agents): agent_activity table with details JSON column"
```

---

## Task 2: Auto-log Activity on Delegation

**Files:**

- Modify: `packages/standalone/src/agent/gateway-tool-executor.ts`

이건 리뷰에서 나온 Critical 이슈 해결. delegation handler에서 자동으로 activity를 기록.

- [ ] **Step 1: Find the delegate case in gateway-tool-executor.ts**

Locate the `case 'delegate':` block and add auto-logging.

- [ ] **Step 2: Add auto-logging around delegation**

delegate case 시작에 task_start, 완료에 task_complete, catch에 task_error 로깅 추가:

```typescript
case 'delegate': {
  // ... existing args parsing ...
  const startTime = Date.now();

  // Log task_start
  if (this.sessionsDb) {
    const latest = getLatestVersion(this.sessionsDb, delegateArgs.agentId);
    logActivity(this.sessionsDb, {
      agent_id: delegateArgs.agentId,
      agent_version: latest?.version ?? 0,
      type: 'task_start',
      input_summary: delegateArgs.task?.slice(0, 200),
    });
  }

  try {
    // ... existing delegation logic ...
    const result = /* existing result */;

    // Log task_complete
    if (this.sessionsDb) {
      const latest = getLatestVersion(this.sessionsDb, delegateArgs.agentId);
      logActivity(this.sessionsDb, {
        agent_id: delegateArgs.agentId,
        agent_version: latest?.version ?? 0,
        type: 'task_complete',
        input_summary: delegateArgs.task?.slice(0, 200),
        output_summary: typeof result === 'string' ? result.slice(0, 500) : JSON.stringify(result).slice(0, 500),
        duration_ms: Date.now() - startTime,
      });
    }

    return result;
  } catch (err) {
    // Log task_error
    if (this.sessionsDb) {
      const latest = getLatestVersion(this.sessionsDb, delegateArgs.agentId);
      logActivity(this.sessionsDb, {
        agent_id: delegateArgs.agentId,
        agent_version: latest?.version ?? 0,
        type: 'task_error',
        input_summary: delegateArgs.task?.slice(0, 200),
        error_message: String(err),
        duration_ms: Date.now() - startTime,
      });
    }
    throw err;
  }
}
```

- [ ] **Step 3: Add logActivity import** (if not already added)
- [ ] **Step 4: Build and verify**
- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/agent/gateway-tool-executor.ts
git commit -m "feat(agents): auto-log activity on delegation start/complete/error"
```

---

## Task 3: Settings → Agents 탭 통합

**Files:**

- Modify: `packages/standalone/public/viewer/src/modules/agents.ts`
- Modify: `packages/standalone/public/viewer/src/modules/settings.ts`

Settings의 에이전트 편집 UI를 Agents 탭으로 이동하고, Settings에서는 제거.

- [ ] **Step 1: Agents Config 탭 — Settings의 PUT 경로 재사용**

`agents.ts`의 `renderConfigTab`을 교체. Settings의 `toggleAgent`와 `saveAgent`가 사용하는 `PUT /api/multi-agent/agents/:id` 경로를 그대로 사용:

```typescript
  private renderConfigTab(el: HTMLElement, a: AgentWithVersion): void {
    const backend = a.backend || 'claude';
    const modelOptions = (backend === 'codex-mcp'
      ? ['gpt-5.3-codex', 'gpt-5.4-mini']
      : ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001']
    ).map(m => `<option value="${m}" ${a.model === m ? 'selected' : ''}>${m}</option>`).join('');

    const tierOptions = [1, 2, 3]
      .map(t => `<option value="${t}" ${(a.tier ?? 1) === t ? 'selected' : ''}>T${t}</option>`).join('');

    const backendOptions = ['claude', 'codex-mcp']
      .map(b => `<option value="${b}" ${backend === b ? 'selected' : ''}>${b}</option>`).join('');

    el.innerHTML = `
      <div class="space-y-3">
        <div>
          <label class="block text-[11px] text-gray-400 mb-1">ID</label>
          <div class="text-[13px] text-gray-800 px-2.5 py-1.5 border border-gray-200 rounded-md bg-gray-50">${escapeHtml(a.id ?? '')}</div>
        </div>
        <div>
          <label class="block text-[11px] text-gray-400 mb-1">Name</label>
          <input id="cfg-name" class="agent-input w-full px-2.5 py-1.5 border border-gray-200 rounded-md text-[13px]" value="${escapeHtml(a.display_name || a.name || '')}" />
        </div>
        <div>
          <label class="block text-[11px] text-gray-400 mb-1">Backend</label>
          <select id="cfg-backend" class="agent-input w-full px-2.5 py-1.5 border border-gray-200 rounded-md text-[13px]">${backendOptions}</select>
        </div>
        <div>
          <label class="block text-[11px] text-gray-400 mb-1">Model</label>
          <select id="cfg-model" class="agent-input w-full px-2.5 py-1.5 border border-gray-200 rounded-md text-[13px]">${modelOptions}</select>
        </div>
        <div>
          <label class="block text-[11px] text-gray-400 mb-1">Tier</label>
          <select id="cfg-tier" class="agent-input w-full px-2.5 py-1.5 border border-gray-200 rounded-md text-[13px]">${tierOptions}</select>
        </div>
        <div class="flex items-center gap-3">
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" id="cfg-enabled" ${a.enabled !== false ? 'checked' : ''} class="accent-[#FFCE00] w-4 h-4" />
            <span class="text-[13px]">Enabled</span>
          </label>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" id="cfg-delegate" ${a.can_delegate ? 'checked' : ''} class="accent-[#8b5cf6] w-4 h-4" />
            <span class="text-[13px]">Can Delegate</span>
          </label>
        </div>
        <div class="pt-2">
          <button id="btn-save-config" class="px-4 py-1.5 rounded-md text-[12px] font-medium text-white bg-[#8b5cf6] hover:bg-[#7c3aed] transition-colors">Save</button>
        </div>
      </div>`;

    // Save uses existing PUT /api/multi-agent/agents/:id (same as Settings)
    el.querySelector('#btn-save-config')?.addEventListener('click', async () => {
      if (!a.id) return;
      try {
        await API.put(`/api/multi-agent/agents/${a.id}`, {
          model: (el.querySelector('#cfg-model') as HTMLSelectElement).value,
          backend: (el.querySelector('#cfg-backend') as HTMLSelectElement).value,
          tier: parseInt((el.querySelector('#cfg-tier') as HTMLSelectElement).value, 10),
          enabled: (el.querySelector('#cfg-enabled') as HTMLInputElement).checked,
          can_delegate: (el.querySelector('#cfg-delegate') as HTMLInputElement).checked,
        });
        showToast('Saved — hot reloaded');

        // Also record in agent_versions for audit trail
        if (a.version != null) {
          await API.updateAgent(a.id, {
            version: a.version,
            changes: {
              model: (el.querySelector('#cfg-model') as HTMLSelectElement).value,
              tier: parseInt((el.querySelector('#cfg-tier') as HTMLSelectElement).value, 10),
            },
            change_note: 'Config updated via Agents tab',
          }).catch(() => { /* audit trail is best-effort */ });
        }

        this.showDetail(a.id);
      } catch (err) {
        showToast('Save failed');
      }
    });
  }
```

- [ ] **Step 2: Settings에서 에이전트 섹션을 "Agents 탭으로 이동" 안내로 교체**

`settings.ts`의 `renderMultiAgentSettings()` 내용을 간소화:

```typescript
  private renderMultiAgentSettings(): void {
    const container = getElementByIdOrNull<HTMLElement>('settings-multi-agent-container');
    if (!container) return;

    container.innerHTML = `
      <div class="bg-white border border-gray-200 rounded-lg p-4 text-center">
        <p class="text-sm text-gray-600 mb-2">에이전트 관리는 Agents 탭으로 이동했습니다.</p>
        <button onclick="window.switchTab && window.switchTab('agents')"
          class="text-sm px-4 py-1.5 rounded-md bg-mama-yellow text-mama-black hover:bg-mama-yellow-hover font-medium">
          Agents 탭으로 이동
        </button>
      </div>`;
  }
```

- [ ] **Step 3: Build and verify**
- [ ] **Step 4: Commit**

```bash
git add packages/standalone/public/viewer/src/modules/agents.ts packages/standalone/public/viewer/src/modules/settings.ts
git commit -m "feat(agents): consolidate agent editing from Settings into Agents tab"
```

---

## Task 4: Tools Tab — Save via existing PUT

**Files:**

- Modify: `packages/standalone/public/viewer/src/modules/agents.ts`

- [ ] **Step 1: Replace renderToolsTab — save via PUT /api/multi-agent/agents/:id**

```typescript
  private renderToolsTab(el: HTMLElement, a: AgentWithVersion): void {
    const allTools = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'NotebookEdit'];
    const allowed = a.tool_permissions?.allowed ?? [];
    const isAll = allowed.includes('*');

    const rows = allTools
      .map(t => {
        const checked = isAll || allowed.includes(t);
        return `<label class="flex items-center gap-2 py-1.5 border-b border-gray-100 text-[13px] cursor-pointer">
          <input type="checkbox" ${checked ? 'checked' : ''} data-tool="${t}" class="accent-[#8b5cf6] w-4 h-4" /> ${t}
        </label>`;
      }).join('');

    el.innerHTML = `
      <div class="text-[11px] text-gray-400 mb-2">Tier ${a.tier ?? 1} preset. Toggle tools and save.</div>
      <div>${rows}</div>
      <div class="pt-3">
        <button id="btn-save-tools" class="px-4 py-1.5 rounded-md text-[12px] font-medium text-white bg-[#8b5cf6] hover:bg-[#7c3aed] transition-colors">Save Tools</button>
      </div>`;

    el.querySelector('#btn-save-tools')?.addEventListener('click', async () => {
      const checked: string[] = [];
      el.querySelectorAll<HTMLInputElement>('input[data-tool]').forEach(cb => {
        if (cb.checked) checked.push(cb.dataset.tool!);
      });
      if (!a.id) return;
      try {
        // Save to runtime via existing PUT
        await API.put(`/api/multi-agent/agents/${a.id}`, {
          tool_permissions: { allowed: checked },
        });
        showToast('Tools saved — hot reloaded');

        // Audit trail (best-effort)
        if (a.version != null) {
          await API.updateAgent(a.id, {
            version: a.version,
            changes: { tool_permissions: { allowed: checked } },
            change_note: `Tools: ${checked.join(', ')}`,
          }).catch(() => {});
        }

        this.showDetail(a.id);
      } catch (err) {
        showToast('Save failed');
      }
    });
  }
```

- [ ] **Step 2: Build and verify**
- [ ] **Step 3: Commit**

```bash
git add packages/standalone/public/viewer/src/modules/agents.ts
git commit -m "feat(agents): Tools tab saves via PUT multi-agent + audit trail"
```

---

## Task 5: Activity Tab + API Endpoint

**Files:**

- Modify: `packages/standalone/public/viewer/src/modules/agents.ts`
- Modify: `packages/standalone/public/viewer/src/utils/api.ts`
- Modify: `packages/standalone/src/api/agent-handler.ts`
- Modify: `packages/standalone/src/api/graph-api.ts`

- [ ] **Step 1: Add getAgentActivity to API client**

```typescript
  static async getAgentActivity(agentId: string, limit = 20): Promise<{ activity: Array<Record<string, unknown>> }> {
    return this.get(`/api/agents/${encodeURIComponent(agentId)}/activity?limit=${limit}`);
  }
```

- [ ] **Step 2: Add handler in agent-handler.ts**

```typescript
export function handleGetAgentActivity(
  res: ServerResponse,
  agentId: string,
  db: SQLiteDatabase,
  limit: number
): void {
  const activity = getActivity(db, agentId, limit);
  json(res, 200, { activity });
}
```

- [ ] **Step 3: Route in graph-api.ts**

```typescript
if (pathname.match(/^\/api\/agents\/[^/]+\/activity$/) && req.method === 'GET') {
  const agentId = decodeURIComponent(pathname.split('/')[3]);
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const limit = parseInt(url.searchParams.get('limit') || '20', 10);
  if (options.sessionsDb) {
    const { handleGetAgentActivity } = await import('./agent-handler.js');
    handleGetAgentActivity(res, agentId, options.sessionsDb, Math.min(limit, 100));
  }
  return true;
}
```

- [ ] **Step 4: Replace Metrics tab with Activity tab in agents.ts**

Update `DetailTab` type and tabs array:

```typescript
type DetailTab = 'config' | 'persona' | 'tools' | 'activity' | 'history';
```

Replace `renderMetricsTab` with `renderActivityTab`:

```typescript
  private async renderActivityTab(el: HTMLElement, a: AgentWithVersion): Promise<void> {
    el.innerHTML = '<div class="text-[12px] text-gray-400">Loading...</div>';
    try {
      const { activity } = await API.getAgentActivity(a.id ?? '', 20);
      if (!activity.length) {
        el.innerHTML = '<div class="text-[12px] text-gray-400 py-4 text-center">No activity yet. Delegate a task to this agent to see logs here.</div>';
        return;
      }
      const rows = activity.map((ev: Record<string, unknown>) => {
        const icon = ev.type === 'test_run' ? '🧪' : ev.type === 'task_error' ? '❌' : ev.type === 'config_change' ? '⚙️' : ev.type === 'task_start' ? '▶️' : '✅';
        const scoreStr = ev.score != null ? ` — ${ev.score}/100` : '';
        return `<div class="flex items-start gap-2 py-2 border-b border-gray-100">
          <span class="text-[14px] flex-shrink-0">${icon}</span>
          <div class="flex-1 min-w-0">
            <div class="text-[12px] font-medium text-gray-800">${escapeHtml(String(ev.output_summary || ev.input_summary || ev.type))}${scoreStr}</div>
            ${ev.error_message ? `<div class="text-[11px] text-red-500 mt-0.5">${escapeHtml(String(ev.error_message))}</div>` : ''}
            <div class="text-[10px] text-gray-400 mt-0.5">v${ev.agent_version} · ${ev.duration_ms || 0}ms · ${ev.created_at}</div>
          </div>
        </div>`;
      }).join('');
      el.innerHTML = `<div>${rows}</div>`;
    } catch {
      el.innerHTML = '<div class="text-[12px] text-red-500">Failed to load activity.</div>';
    }
  }
```

- [ ] **Step 5: Build and verify**
- [ ] **Step 6: Commit**

```bash
git add packages/standalone/public/viewer/src/modules/agents.ts packages/standalone/public/viewer/src/utils/api.ts packages/standalone/src/api/agent-handler.ts packages/standalone/src/api/graph-api.ts
git commit -m "feat(agents): Activity tab with auto-logged delegation events"
```

---

## Task 6: Agent Cards — Enable Toggle (using existing PUT)

**Files:**

- Modify: `packages/standalone/public/viewer/src/modules/agents.ts`

- [ ] **Step 1: Update card template with toggle**

Same approach as Settings — use `PUT /api/multi-agent/agents/:id` for toggle:

```typescript
// In renderList(), add toggle click handler:
this.container.querySelectorAll<HTMLInputElement>('[data-toggle-id]').forEach((toggle) => {
  toggle.addEventListener('change', async () => {
    const agentId = toggle.dataset.toggleId;
    if (!agentId) return;
    try {
      await API.put(`/api/multi-agent/agents/${agentId}`, { enabled: toggle.checked });
      showToast(`${agentId} ${toggle.checked ? 'enabled' : 'disabled'}`);
      this.loadAgents();
    } catch {
      showToast('Toggle failed');
      toggle.checked = !toggle.checked;
    }
  });
});
```

- [ ] **Step 2: Build and verify**
- [ ] **Step 3: Commit**

```bash
git add packages/standalone/public/viewer/src/modules/agents.ts
git commit -m "feat(agents): enable/disable toggle via existing multi-agent PUT"
```

---

## Task 7: Build + E2E Verification

- [ ] **Step 1: Full build** — `pnpm build`
- [ ] **Step 2: Run all tests** — `pnpm test`
- [ ] **Step 3: Start MAMA** — `cd packages/standalone && node dist/cli/index.js start`
- [ ] **Step 4: Manual verification checklist**

1. Agents 탭: 카드에 enable toggle 표시
2. 카드 클릭 → Config 탭 → model/backend/tier 편집 → Save → "hot reloaded" toast
3. Tools 탭 → 체크박스 → Save → "hot reloaded" toast
4. Activity 탭 → 빈 상태 메시지
5. 채팅에서 에이전트에게 delegate → Activity 탭에 task_start + task_complete 로그 자동 표시
6. Settings 탭 → 에이전트 섹션 → "Agents 탭으로 이동" 버튼
7. History 탭 → 새 버전 표시 (감사 기록)

- [ ] **Step 5: Commit any fixes**

```bash
git add -A && git commit -m "fix(agents): e2e verification fixes"
```

---

## GSTACK REVIEW REPORT

| Review           | Trigger      | Why                     | Runs | Status       | Findings                                                        |
| ---------------- | ------------ | ----------------------- | ---- | ------------ | --------------------------------------------------------------- |
| CEO + Eng Review | `/autoplan`  | Strategy + Architecture | 1    | issues_found | 6 findings (2 critical, 2 high, 2 medium)                       |
| Codex Voice      | `codex exec` | Independent 2nd opinion | 1    | issues_found | config.yaml 이중 저장소, Settings 중복, 보안 경계, saveConfig() |
| Claude Subagent  | `Agent tool` | Independent review      | 1    | issues_found | agent_activity 미연결, cold start, Phase 2-4 시기상조           |

**VERDICT:** All critical findings resolved in Rev.2. Plan ready for implementation.
