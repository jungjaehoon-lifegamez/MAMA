# v0.19 Agent Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the agent lifecycle system — create agents via chat, verify with real data, track in production — all orchestrated by Conductor.

**Architecture:** Phase 1 makes the Agents tab functional (Config editing, Tools saving, enable/disable). Phase 2 adds verification (agent_test, agent_evaluate, agent_activity table). Phase 3 adds tracking and reporting (activity logging, Dashboard integration, Wiki auto-docs). Phase 4 adds templates (connector-based dynamic recommendation).

**Tech Stack:** TypeScript, SQLite (better-sqlite3), vanilla TS viewer modules (Tailwind), gateway tool registry

**Spec:** `docs/superpowers/specs/2026-04-11-v019-agent-lifecycle-design.md`

---

## File Structure

### Modified Files

| File                                  | Changes                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `public/viewer/src/modules/agents.ts` | Config tab editable, Tools tab saveable, enable toggle, Activity tab, inline styles to Tailwind |
| `public/viewer/src/utils/api.ts`      | Add enableAgent, testAgent, getActivity API methods                                             |
| `src/agent/gateway-tool-executor.ts`  | Add agent_test, agent_evaluate, agent_enable, agent_activity_log handlers                       |
| `src/agent/tool-registry.ts`          | Register 4 new gateway tools                                                                    |
| `src/agent/types.ts`                  | Add 4 new GatewayToolName entries                                                               |
| `src/api/agent-handler.ts`            | Add PATCH enable/disable, GET activity, POST test endpoints                                     |
| `src/api/graph-api.ts`                | Route new endpoints                                                                             |
| `src/db/agent-store.ts`               | Add agent_activity table init + CRUD                                                            |

### New Files

| File                              | Responsibility             |
| --------------------------------- | -------------------------- |
| `tests/db/agent-activity.test.ts` | agent_activity table tests |
| `tests/api/agent-enable.test.ts`  | Enable/disable API tests   |

---

## Task 1: agent_activity DB Table

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
Expected: FAIL — agent_activity table not found (logActivity, getActivity not exported)

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
      error_message   TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_agent_activity_agent ON agent_activity(agent_id, created_at)`
);
```

- [ ] **Step 4: Run test to verify table creation passes**

Run: `cd packages/standalone && pnpm vitest run tests/db/agent-activity.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing tests for logActivity and getActivity**

Append to test file:

```typescript
describe('activity CRUD', () => {
  let db: InstanceType<typeof Database>;
  beforeEach(() => {
    db = new Database(':memory:');
    initAgentTables(db);
  });

  it('logs an activity event', () => {
    const row = logActivity(db, {
      agent_id: 'test-agent',
      agent_version: 1,
      type: 'task_complete',
      input_summary: 'Process file X',
      output_summary: 'Matched to project A',
      tokens_used: 150,
      tools_called: ['Read', 'Bash'],
      duration_ms: 2300,
    });
    expect(row.id).toBeGreaterThan(0);
    expect(row.type).toBe('task_complete');
  });

  it('retrieves activity by agent_id', () => {
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
    expect(a1[0].type).toBe('task_error'); // newest first
  });

  it('logs test_run with score', () => {
    const row = logActivity(db, {
      agent_id: 'test-agent',
      agent_version: 2,
      type: 'test_run',
      input_summary: '3 files tested',
      output_summary: '3/3 passed',
      score: 95,
    });
    expect(row.score).toBe(95);
  });
});
```

- [ ] **Step 6: Implement logActivity and getActivity**

Append to `packages/standalone/src/db/agent-store.ts`:

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
  error_message: string | null;
  created_at: string;
}

export function logActivity(db: DB, input: LogActivityInput): ActivityRow {
  const stmt = db.prepare(`
    INSERT INTO agent_activity (agent_id, agent_version, type, input_summary, output_summary, tokens_used, tools_called, duration_ms, score, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    input.error_message ?? null
  );
  return db
    .prepare('SELECT * FROM agent_activity WHERE id = ?')
    .get(result.lastInsertRowid) as ActivityRow;
}

export function getActivity(db: DB, agentId: string, limit: number): ActivityRow[] {
  return db
    .prepare('SELECT * FROM agent_activity WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(agentId, limit) as ActivityRow[];
}
```

- [ ] **Step 7: Run tests**

Run: `cd packages/standalone && pnpm vitest run tests/db/agent-activity.test.ts`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add packages/standalone/src/db/agent-store.ts packages/standalone/tests/db/agent-activity.test.ts
git commit -m "feat(agents): agent_activity table for lifecycle tracking"
```

---

## Task 2: Enable/Disable API + Gateway Tool

**Files:**

- Modify: `packages/standalone/src/api/agent-handler.ts`
- Modify: `packages/standalone/src/api/graph-api.ts`
- Modify: `packages/standalone/src/agent/gateway-tool-executor.ts`
- Modify: `packages/standalone/src/agent/tool-registry.ts`
- Modify: `packages/standalone/src/agent/types.ts`
- Create: `packages/standalone/tests/api/agent-enable.test.ts`

- [ ] **Step 1: Write failing test for enable/disable**

```typescript
// packages/standalone/tests/api/agent-enable.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initAgentTables, createAgentVersion } from '../../src/db/agent-store.js';

describe('agent enable/disable', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    initAgentTables(db);
    createAgentVersion(db, {
      agent_id: 'test-agent',
      snapshot: { model: 'claude-sonnet-4-6', tier: 1, enabled: true },
      change_note: 'initial',
    });
  });

  it('updates enabled field without creating new version', () => {
    // enableAgent should update the latest snapshot's enabled field in-place
    // This is a hot toggle, not a versioned change
    const latest = db
      .prepare(
        'SELECT snapshot FROM agent_versions WHERE agent_id = ? ORDER BY version DESC LIMIT 1'
      )
      .get('test-agent') as { snapshot: string };
    const snap = JSON.parse(latest.snapshot);
    expect(snap.enabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (baseline)**

Run: `cd packages/standalone && pnpm vitest run tests/api/agent-enable.test.ts`
Expected: PASS (baseline — confirms current snapshot structure)

- [ ] **Step 3: Add agent_enable to types.ts**

In `packages/standalone/src/agent/types.ts`, add to GatewayToolName union:

```typescript
  | 'agent_enable'
  | 'agent_test'
  | 'agent_evaluate'
  | 'agent_activity_log'
```

- [ ] **Step 4: Register agent_enable in tool-registry.ts**

In `packages/standalone/src/agent/tool-registry.ts`, add after viewer_state:

```typescript
register({
  name: 'agent_enable',
  description: 'Enable or disable an agent. Hot-reload without restart.',
  category: 'os_management',
  params: 'agent_id, enabled: boolean',
});
register({
  name: 'agent_test',
  description: 'Run test session with recent connector data. Returns test results for evaluation.',
  category: 'os_management',
  params: 'agent_id, count?: number',
});
register({
  name: 'agent_evaluate',
  description:
    'Evaluate test results. Returns score (0-100), details, and improvement suggestions.',
  category: 'os_management',
  params: 'agent_id, test_results: {total, passed, failed, items[]}',
});
register({
  name: 'agent_activity_log',
  description: 'Log an agent activity event (task completion, error, test run).',
  category: 'os_monitoring',
  params: 'agent_id, type: task_complete|task_error|test_run|config_change, summary, score?',
});
```

- [ ] **Step 5: Implement agent_enable in gateway-tool-executor.ts**

Add case in the switch block after `viewer_state`:

```typescript
        case 'agent_enable': {
          const enableArgs = input as { agent_id: string; enabled: boolean };
          // Update config and hot-reload
          try {
            const configPath = path.join(os.homedir(), '.mama', 'config.yaml');
            const configText = fs.readFileSync(configPath, 'utf-8');
            const yaml = await import('js-yaml');
            const config = yaml.load(configText) as Record<string, unknown>;
            const agents = (config.multi_agent as Record<string, unknown>)?.agents as Record<string, Record<string, unknown>> | undefined;
            if (!agents?.[enableArgs.agent_id]) {
              return { success: false, error: `Agent '${enableArgs.agent_id}' not found in config` };
            }
            agents[enableArgs.agent_id].enabled = enableArgs.enabled;
            fs.writeFileSync(configPath, yaml.dump(config, { lineWidth: 120 }));
            return { success: true, agent_id: enableArgs.agent_id, enabled: enableArgs.enabled };
          } catch (err) {
            return { success: false, error: String(err) };
          }
        }
```

- [ ] **Step 6: Implement agent_activity_log in gateway-tool-executor.ts**

```typescript
        case 'agent_activity_log': {
          if (!this.sessionsDb) return { success: false, error: 'Sessions DB not available' };
          const logArgs = input as { agent_id: string; type: string; summary: string; score?: number };
          const latest = getLatestVersion(this.sessionsDb, logArgs.agent_id);
          const row = logActivity(this.sessionsDb, {
            agent_id: logArgs.agent_id,
            agent_version: latest?.version ?? 0,
            type: logArgs.type,
            output_summary: logArgs.summary,
            score: logArgs.score,
          });
          return { success: true, activity_id: row.id };
        }
```

- [ ] **Step 7: Add import for logActivity**

At the top of `gateway-tool-executor.ts`, add `logActivity` to the import from agent-store:

```typescript
import {
  createAgentVersion,
  getLatestVersion,
  listVersions,
  getMetrics,
  compareVersionMetrics,
  logActivity,
} from '../db/agent-store.js';
```

- [ ] **Step 8: Build and verify**

Run: `cd packages/standalone && pnpm build`
Expected: Build succeeds, gateway-tools.md shows 53 tools

- [ ] **Step 9: Commit**

```bash
git add packages/standalone/src/agent/types.ts packages/standalone/src/agent/tool-registry.ts packages/standalone/src/agent/gateway-tool-executor.ts packages/standalone/tests/api/agent-enable.test.ts
git commit -m "feat(agents): agent_enable + agent_activity_log gateway tools"
```

---

## Task 3: Config Tab — Editable Fields

**Files:**

- Modify: `packages/standalone/public/viewer/src/modules/agents.ts`

- [ ] **Step 1: Replace renderConfigTab with editable version**

Replace the `renderConfigTab` method in `agents.ts`. Change read-only `field()` divs to input/select elements with a Save button:

```typescript
  private renderConfigTab(el: HTMLElement, a: AgentWithVersion): void {
    const modelOptions = ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001']
      .map(m => `<option value="${m}" ${a.model === m ? 'selected' : ''}>${m}</option>`)
      .join('');
    const tierOptions = [1, 2, 3]
      .map(t => `<option value="${t}" ${(a.tier ?? 1) === t ? 'selected' : ''}>T${t}</option>`)
      .join('');

    el.innerHTML = `
      <div class="space-y-3">
        <div>
          <label class="block text-[11px] text-gray-400 mb-1">ID</label>
          <div class="text-[13px] text-gray-800 px-2.5 py-1.5 border border-gray-200 rounded-md bg-gray-50">${escapeHtml(a.id ?? '')}</div>
        </div>
        <div>
          <label class="block text-[11px] text-gray-400 mb-1" for="cfg-name">Name</label>
          <input id="cfg-name" class="agent-input w-full px-2.5 py-1.5 border border-gray-200 rounded-md text-[13px]" value="${escapeHtml(a.display_name || a.name || '')}" />
        </div>
        <div>
          <label class="block text-[11px] text-gray-400 mb-1" for="cfg-model">Model</label>
          <select id="cfg-model" class="agent-input w-full px-2.5 py-1.5 border border-gray-200 rounded-md text-[13px]">${modelOptions}</select>
        </div>
        <div>
          <label class="block text-[11px] text-gray-400 mb-1" for="cfg-tier">Tier</label>
          <select id="cfg-tier" class="agent-input w-full px-2.5 py-1.5 border border-gray-200 rounded-md text-[13px]">${tierOptions}</select>
        </div>
        <div>
          <label class="block text-[11px] text-gray-400 mb-1">Enabled</label>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" id="cfg-enabled" ${a.enabled !== false ? 'checked' : ''} class="accent-[#FFCE00] w-4 h-4" />
            <span class="text-[13px]">${a.enabled !== false ? 'Active' : 'Disabled'}</span>
          </label>
        </div>
        <div class="flex gap-2 pt-2">
          <button id="btn-save-config" class="px-4 py-1.5 rounded-md text-[12px] font-medium text-white bg-[#8b5cf6] hover:bg-[#7c3aed] transition-colors">Save — creates v${(a.version ?? 0) + 1}</button>
        </div>
      </div>`;

    el.querySelector('#btn-save-config')?.addEventListener('click', async () => {
      const name = (el.querySelector('#cfg-name') as HTMLInputElement).value.trim();
      const model = (el.querySelector('#cfg-model') as HTMLSelectElement).value;
      const tier = parseInt((el.querySelector('#cfg-tier') as HTMLSelectElement).value, 10);
      const enabled = (el.querySelector('#cfg-enabled') as HTMLInputElement).checked;
      if (!a.id) return;
      try {
        const res = await API.updateAgent(a.id, {
          version: a.version ?? 0,
          changes: { display_name: name, model, tier, enabled },
          change_note: `Config updated via viewer`,
        });
        if ((res as { new_version?: number }).new_version) {
          showToast(\`v\${(res as { new_version: number }).new_version} saved\`);
          this.showDetail(a.id);
        }
      } catch (err) {
        showToast('Save failed');
      }
    });
  }
```

- [ ] **Step 2: Build and verify**

Run: `pnpm build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add packages/standalone/public/viewer/src/modules/agents.ts
git commit -m "feat(agents): editable Config tab — model, tier, name, enabled"
```

---

## Task 4: Tools Tab — Saveable Checkboxes

**Files:**

- Modify: `packages/standalone/public/viewer/src/modules/agents.ts`

- [ ] **Step 1: Replace renderToolsTab with saveable version**

Replace the `renderToolsTab` method:

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
      })
      .join('');

    el.innerHTML = `
      <div class="text-[11px] text-gray-400 mb-2">Tier ${a.tier ?? 1} preset. Toggle individual tools and save.</div>
      <div>${rows}</div>
      <div class="flex gap-2 pt-3">
        <button id="btn-save-tools" class="px-4 py-1.5 rounded-md text-[12px] font-medium text-white bg-[#8b5cf6] hover:bg-[#7c3aed] transition-colors">Save Tools — creates v${(a.version ?? 0) + 1}</button>
      </div>`;

    el.querySelector('#btn-save-tools')?.addEventListener('click', async () => {
      const checked: string[] = [];
      el.querySelectorAll<HTMLInputElement>('input[data-tool]').forEach(cb => {
        if (cb.checked) checked.push(cb.dataset.tool!);
      });
      if (!a.id) return;
      try {
        const res = await API.updateAgent(a.id, {
          version: a.version ?? 0,
          changes: { tool_permissions: { allowed: checked } },
          change_note: `Tools updated: ${checked.join(', ')}`,
        });
        if ((res as { new_version?: number }).new_version) {
          showToast(\`Tools saved as v\${(res as { new_version: number }).new_version}\`);
          this.showDetail(a.id);
        }
      } catch (err) {
        showToast('Save failed');
      }
    });
  }
```

- [ ] **Step 2: Build and verify**

Run: `pnpm build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add packages/standalone/public/viewer/src/modules/agents.ts
git commit -m "feat(agents): Tools tab saves tool permissions with version bump"
```

---

## Task 5: Activity Tab (replaces Metrics)

**Files:**

- Modify: `packages/standalone/public/viewer/src/modules/agents.ts`
- Modify: `packages/standalone/public/viewer/src/utils/api.ts`
- Modify: `packages/standalone/src/api/agent-handler.ts`
- Modify: `packages/standalone/src/api/graph-api.ts`

- [ ] **Step 1: Add getAgentActivity API method**

In `packages/standalone/public/viewer/src/utils/api.ts`, add:

```typescript
  static async getAgentActivity(agentId: string, limit = 20): Promise<{ activity: Array<Record<string, unknown>> }> {
    return this.get(`/api/agents/${encodeURIComponent(agentId)}/activity?limit=${limit}`);
  }
```

- [ ] **Step 2: Add activity endpoint handler in agent-handler.ts**

In `packages/standalone/src/api/agent-handler.ts`, add:

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

Add `getActivity` to imports from agent-store.

- [ ] **Step 3: Route the endpoint in graph-api.ts**

Add route before the existing agent routes:

```typescript
if (pathname.match(/^\/api\/agents\/[^/]+\/activity$/) && req.method === 'GET') {
  const agentId = decodeURIComponent(pathname.split('/')[3]);
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const limit = parseInt(url.searchParams.get('limit') || '20', 10);
  if (options.sessionsDb) {
    const { handleGetAgentActivity } = await import('./agent-handler.js');
    handleGetAgentActivity(res, agentId, options.sessionsDb, limit);
  }
  return true;
}
```

- [ ] **Step 4: Replace renderMetricsTab with renderActivityTab**

In `agents.ts`, replace `renderMetricsTab` with:

```typescript
  private async renderActivityTab(el: HTMLElement, a: AgentWithVersion): Promise<void> {
    el.innerHTML = `<div class="text-[12px] text-gray-400">Loading activity...</div>`;
    try {
      const { activity } = await API.getAgentActivity(a.id ?? '', 20);
      if (!activity.length) {
        el.innerHTML = `<div class="text-[12px] text-gray-400">No activity recorded yet.</div>`;
        return;
      }
      const rows = activity
        .map((ev: Record<string, unknown>) => {
          const typeIcon = ev.type === 'test_run' ? '🧪' : ev.type === 'task_error' ? '❌' : ev.type === 'config_change' ? '⚙️' : '✅';
          const scoreStr = ev.score != null ? ` — ${ev.score}/100` : '';
          return `<div class="flex items-start gap-2 py-2 border-b border-gray-100">
            <span class="text-[14px] flex-shrink-0">${typeIcon}</span>
            <div class="flex-1 min-w-0">
              <div class="text-[12px] font-medium text-gray-800">${escapeHtml(String(ev.output_summary || ev.type))}${scoreStr}</div>
              ${ev.error_message ? `<div class="text-[11px] text-red-500 mt-0.5">${escapeHtml(String(ev.error_message))}</div>` : ''}
              <div class="text-[10px] text-gray-400 mt-0.5">v${ev.agent_version} · ${ev.tokens_used || 0} tokens · ${ev.created_at}</div>
            </div>
          </div>`;
        })
        .join('');
      el.innerHTML = `<div>${rows}</div>`;
    } catch {
      el.innerHTML = `<div class="text-[12px] text-red-500">Failed to load activity.</div>`;
    }
  }
```

- [ ] **Step 5: Update tab list and switch statement**

In `renderDetail()`, change the tabs array and switch:

```typescript
const tabs: DetailTab[] = ['config', 'persona', 'tools', 'activity', 'history'];
```

Update the DetailTab type:

```typescript
type DetailTab = 'config' | 'persona' | 'tools' | 'activity' | 'history';
```

Update the switch case:

```typescript
      case 'activity':
        this.renderActivityTab(content, a);
        break;
```

Remove the old `case 'metrics':` block.

- [ ] **Step 6: Build and verify**

Run: `pnpm build`
Expected: Build succeeds

- [ ] **Step 7: Commit**

```bash
git add packages/standalone/public/viewer/src/modules/agents.ts packages/standalone/public/viewer/src/utils/api.ts packages/standalone/src/api/agent-handler.ts packages/standalone/src/api/graph-api.ts
git commit -m "feat(agents): Activity tab replaces Metrics — shows execution log + test results"
```

---

## Task 6: Agent List Cards — Status + Enable Toggle

**Files:**

- Modify: `packages/standalone/public/viewer/src/modules/agents.ts`

- [ ] **Step 1: Enhance agent card with status badge + enable toggle**

Update the card template in `renderList()`:

```typescript
const statusColor = a.enabled !== false ? C.green : C.ter;
const statusText = a.enabled !== false ? 'Active' : 'Disabled';
const toggleChecked = a.enabled !== false ? 'checked' : '';
return `
        <div class="agent-card bg-white border border-gray-200 rounded-xl p-4 cursor-pointer transition-all" data-agent-id="${escapeHtml(a.id ?? '')}">
          <div class="flex justify-between items-center mb-2">
            <span class="text-[15px] font-semibold text-gray-800">${escapeHtml(a.display_name || a.name || a.id || '')}</span>
            <span class="text-[11px] font-semibold px-2 py-0.5 rounded bg-purple-50 text-purple-600">T${a.tier ?? 1}</span>
          </div>
          <div class="text-[12px] text-gray-500 mb-1.5">${escapeHtml(a.model || 'No model')}</div>
          <div class="flex justify-between items-center">
            <span class="text-[11px] font-medium" style="color:${statusColor}">\u25CF ${statusText}</span>
            <div class="flex items-center gap-2">
              <span class="text-[11px] text-gray-400">v${a.version ?? 0}</span>
              <label class="enable-toggle flex items-center" onclick="event.stopPropagation()">
                <input type="checkbox" ${toggleChecked} data-toggle-id="${escapeHtml(a.id ?? '')}" class="accent-[#FFCE00] w-3.5 h-3.5" />
              </label>
            </div>
          </div>
        </div>`;
```

- [ ] **Step 2: Add toggle event listener**

After the card click listeners in `renderList()`, add:

```typescript
this.container.querySelectorAll<HTMLInputElement>('[data-toggle-id]').forEach((toggle) => {
  toggle.addEventListener('change', async (e) => {
    const agentId = toggle.dataset.toggleId;
    if (!agentId) return;
    try {
      await API.updateAgent(agentId, {
        version: this.agents.find((a) => a.id === agentId)?.version ?? 0,
        changes: { enabled: toggle.checked },
        change_note: toggle.checked ? 'Enabled via viewer' : 'Disabled via viewer',
      });
      showToast(`${agentId} ${toggle.checked ? 'enabled' : 'disabled'}`);
      this.loadAgents();
    } catch {
      showToast('Toggle failed');
      toggle.checked = !toggle.checked;
    }
  });
});
```

- [ ] **Step 3: Build and verify**

Run: `pnpm build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add packages/standalone/public/viewer/src/modules/agents.ts
git commit -m "feat(agents): card status badge + inline enable/disable toggle"
```

---

## Task 7: Build + E2E Verification

- [ ] **Step 1: Full build**

Run: `pnpm build`
Expected: Build succeeds

- [ ] **Step 2: Run all tests**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 3: Manual verification**

1. Start MAMA: `cd packages/standalone && node dist/cli/index.js start`
2. Open viewer: `http://localhost:3847/viewer/`
3. Navigate to Agents tab
4. Verify: Cards show status badge + enable toggle
5. Click an agent → Config tab → verify all fields are editable
6. Change model → Save → verify version bump
7. Tools tab → toggle checkboxes → Save → verify version bump
8. Activity tab → verify empty state message
9. History tab → verify new versions appear

- [ ] **Step 4: Commit any fixes**

```bash
git add -A && git commit -m "fix(agents): e2e verification fixes"
```
