# v0.19 Epic 1: Interactive Agent Management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a conversation-driven agent management system where agents can view, modify, and evolve themselves and other agents through chat interaction, with full version tracking and Before/After metrics comparison.

**Architecture:** New `/api/agents/*` REST endpoints backed by `agent_versions` + `agent_metrics` SQLite tables in mama-sessions.db. Viewer gets a new Agents module (vanilla TS) with bidirectional Agent↔UI communication ported from SmartStore (page-context reporting + command polling). Six new gateway tools let agents manipulate the viewer and agent configs programmatically.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), vanilla TS viewer modules, gateway tool registry

**Spec:** `docs/superpowers/specs/2026-04-10-v019-agent-management-design.md`

---

## File Structure

### New Files

| File                                     | Responsibility                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/api/agent-handler.ts`               | Agent CRUD API handlers (create, get, list, update, archive, versions, metrics, compare) |
| `src/api/ui-command-handler.ts`          | UI command queue — page-context receive + command dispatch                               |
| `src/db/agent-store.ts`                  | agent_versions + agent_metrics DB init, CRUD, queries                                    |
| `public/viewer/src/modules/agents.ts`    | Viewer Agents tab module (list + detail views)                                           |
| `public/viewer/src/utils/ui-commands.ts` | Page context reporting + command polling (SmartStore port)                               |

### Modified Files

| File                             | Changes                                                      |
| -------------------------------- | ------------------------------------------------------------ |
| `src/agent/types.ts`             | Add 6 new GatewayToolName entries                            |
| `src/agent/tool-registry.ts`     | Register 6 new gateway tools                                 |
| `src/api/graph-api.ts`           | Route dispatch for `/api/agents/*` and `/api/ui/*` endpoints |
| `src/api/graph-api-types.ts`     | Add new GraphHandlerOptions callbacks                        |
| `src/api/token-handler.ts`       | Add `agent_version` column to token_usage                    |
| `public/viewer/viewer.html`      | Add Agents tab button + container + module import            |
| `public/viewer/src/utils/api.ts` | Add Agent CRUD + UI command API methods                      |

---

## Task 1: Agent Store — DB Schema & CRUD

**Files:**

- Create: `packages/standalone/src/db/agent-store.ts`
- Test: `packages/standalone/tests/db/agent-store.test.ts`

- [ ] **Step 1: Write failing test for table initialization**

```typescript
// packages/standalone/tests/db/agent-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initAgentTables, getAgentVersion } from '../../src/db/agent-store.js';

describe('agent-store', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('creates agent_versions and agent_metrics tables', () => {
    initAgentTables(db);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agent_versions','agent_metrics')"
      )
      .all();
    expect(tables).toHaveLength(2);
  });

  it('is idempotent — calling twice does not error', () => {
    initAgentTables(db);
    initAgentTables(db);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agent_versions','agent_metrics')"
      )
      .all();
    expect(tables).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/standalone && pnpm vitest run tests/db/agent-store.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement initAgentTables**

```typescript
// packages/standalone/src/db/agent-store.ts
import type BetterSqlite3 from 'better-sqlite3';

type DB = BetterSqlite3.Database;

export function initAgentTables(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_versions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id     TEXT NOT NULL,
      version      INTEGER NOT NULL,
      snapshot     TEXT NOT NULL,
      persona_text TEXT,
      change_note  TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(agent_id, version)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_versions_agent ON agent_versions(agent_id)
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_metrics (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id        TEXT NOT NULL,
      agent_version   INTEGER NOT NULL,
      period_start    TEXT NOT NULL,
      period_end      TEXT NOT NULL,
      input_tokens    INTEGER DEFAULT 0,
      output_tokens   INTEGER DEFAULT 0,
      tool_calls      INTEGER DEFAULT 0,
      delegations     INTEGER DEFAULT 0,
      errors          INTEGER DEFAULT 0,
      avg_response_ms REAL DEFAULT 0,
      UNIQUE(agent_id, agent_version, period_start)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_metrics_agent ON agent_metrics(agent_id, agent_version)
  `);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/standalone && pnpm vitest run tests/db/agent-store.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing tests for version CRUD**

```typescript
// Append to tests/db/agent-store.test.ts
import { createAgentVersion, getLatestVersion, listVersions } from '../../src/db/agent-store.js';

describe('agent version CRUD', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    initAgentTables(db);
  });

  it('creates version 1 for new agent', () => {
    const v = createAgentVersion(db, {
      agent_id: 'conductor',
      snapshot: { model: 'claude-sonnet-4-6', tier: 1 },
      persona_text: 'You are Conductor.',
      change_note: 'Initial creation',
    });
    expect(v.version).toBe(1);
    expect(v.agent_id).toBe('conductor');
  });

  it('auto-increments version for existing agent', () => {
    createAgentVersion(db, { agent_id: 'conductor', snapshot: { tier: 1 } });
    const v2 = createAgentVersion(db, {
      agent_id: 'conductor',
      snapshot: { tier: 2 },
      change_note: 'Tier upgrade',
    });
    expect(v2.version).toBe(2);
  });

  it('getLatestVersion returns highest version', () => {
    createAgentVersion(db, { agent_id: 'dev', snapshot: { tier: 1 } });
    createAgentVersion(db, { agent_id: 'dev', snapshot: { tier: 2 } });
    const latest = getLatestVersion(db, 'dev');
    expect(latest?.version).toBe(2);
  });

  it('getLatestVersion returns null for unknown agent', () => {
    expect(getLatestVersion(db, 'unknown')).toBeNull();
  });

  it('listVersions returns all versions in desc order', () => {
    createAgentVersion(db, { agent_id: 'dev', snapshot: { v: 1 } });
    createAgentVersion(db, { agent_id: 'dev', snapshot: { v: 2 } });
    createAgentVersion(db, { agent_id: 'dev', snapshot: { v: 3 } });
    const versions = listVersions(db, 'dev');
    expect(versions).toHaveLength(3);
    expect(versions[0].version).toBe(3);
  });

  it('skips version bump on no-op (identical snapshot)', () => {
    const snap = { model: 'sonnet', tier: 1 };
    createAgentVersion(db, { agent_id: 'dev', snapshot: snap });
    const v2 = createAgentVersion(db, { agent_id: 'dev', snapshot: snap });
    expect(v2.version).toBe(1); // No increment
    expect(listVersions(db, 'dev')).toHaveLength(1);
  });
});
```

- [ ] **Step 6: Implement version CRUD functions**

```typescript
// Append to packages/standalone/src/db/agent-store.ts

export interface CreateVersionInput {
  agent_id: string;
  snapshot: Record<string, unknown>;
  persona_text?: string;
  change_note?: string;
}

export interface AgentVersionRow {
  id: number;
  agent_id: string;
  version: number;
  snapshot: string; // JSON string
  persona_text: string | null;
  change_note: string | null;
  created_at: string;
}

export function createAgentVersion(db: DB, input: CreateVersionInput): AgentVersionRow {
  const snapshotJson = JSON.stringify(input.snapshot);
  const latest = getLatestVersion(db, input.agent_id);

  // No-op detection: if snapshot is identical, return existing
  if (latest && latest.snapshot === snapshotJson) {
    return latest;
  }

  const nextVersion = latest ? latest.version + 1 : 1;
  const stmt = db.prepare(`
    INSERT INTO agent_versions (agent_id, version, snapshot, persona_text, change_note)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    input.agent_id,
    nextVersion,
    snapshotJson,
    input.persona_text ?? null,
    input.change_note ?? null
  );
  return db
    .prepare('SELECT * FROM agent_versions WHERE id = ?')
    .get(result.lastInsertRowid) as AgentVersionRow;
}

export function getLatestVersion(db: DB, agentId: string): AgentVersionRow | null {
  return (
    (db
      .prepare('SELECT * FROM agent_versions WHERE agent_id = ? ORDER BY version DESC LIMIT 1')
      .get(agentId) as AgentVersionRow | undefined) ?? null
  );
}

export function getAgentVersion(db: DB, agentId: string, version: number): AgentVersionRow | null {
  return (
    (db
      .prepare('SELECT * FROM agent_versions WHERE agent_id = ? AND version = ?')
      .get(agentId, version) as AgentVersionRow | undefined) ?? null
  );
}

export function listVersions(db: DB, agentId: string): AgentVersionRow[] {
  return db
    .prepare('SELECT * FROM agent_versions WHERE agent_id = ? ORDER BY version DESC')
    .all(agentId) as AgentVersionRow[];
}
```

- [ ] **Step 7: Run all tests**

Run: `cd packages/standalone && pnpm vitest run tests/db/agent-store.test.ts`
Expected: ALL PASS

- [ ] **Step 8: Write failing tests for metrics CRUD**

```typescript
// Append to tests/db/agent-store.test.ts
import { upsertMetrics, getMetrics, compareVersionMetrics } from '../../src/db/agent-store.js';

describe('agent metrics', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    initAgentTables(db);
  });

  it('inserts new metrics row', () => {
    upsertMetrics(db, {
      agent_id: 'conductor',
      agent_version: 1,
      period_start: '2026-04-10',
      input_tokens: 1000,
      output_tokens: 500,
      tool_calls: 10,
    });
    const rows = getMetrics(db, 'conductor', '2026-04-01', '2026-04-11');
    expect(rows).toHaveLength(1);
    expect(rows[0].input_tokens).toBe(1000);
  });

  it('upserts: adds to existing row for same period', () => {
    const base = { agent_id: 'dev', agent_version: 2, period_start: '2026-04-10' };
    upsertMetrics(db, { ...base, input_tokens: 100, output_tokens: 50, tool_calls: 5 });
    upsertMetrics(db, { ...base, input_tokens: 200, output_tokens: 100, tool_calls: 3 });
    const rows = getMetrics(db, 'dev', '2026-04-10', '2026-04-11');
    expect(rows).toHaveLength(1);
    expect(rows[0].input_tokens).toBe(300);
    expect(rows[0].tool_calls).toBe(8);
  });

  it('compareVersionMetrics returns aggregated diff', () => {
    const mk = (ver: number, tokens: number) =>
      upsertMetrics(db, {
        agent_id: 'dev',
        agent_version: ver,
        period_start: '2026-04-10',
        input_tokens: tokens,
        output_tokens: tokens / 2,
        tool_calls: 10,
      });
    mk(1, 1000);
    mk(2, 400);
    const cmp = compareVersionMetrics(db, 'dev', 1, 2);
    expect(cmp.version_a.input_tokens).toBe(1000);
    expect(cmp.version_b.input_tokens).toBe(400);
  });
});
```

- [ ] **Step 9: Implement metrics functions**

```typescript
// Append to packages/standalone/src/db/agent-store.ts

export interface UpsertMetricsInput {
  agent_id: string;
  agent_version: number;
  period_start: string;
  input_tokens?: number;
  output_tokens?: number;
  tool_calls?: number;
  delegations?: number;
  errors?: number;
  avg_response_ms?: number;
}

export interface MetricsRow {
  agent_id: string;
  agent_version: number;
  period_start: string;
  period_end: string;
  input_tokens: number;
  output_tokens: number;
  tool_calls: number;
  delegations: number;
  errors: number;
  avg_response_ms: number;
}

export function upsertMetrics(db: DB, input: UpsertMetricsInput): void {
  const periodEnd = input.period_start; // Same day for daily granularity
  db.prepare(
    `
    INSERT INTO agent_metrics (agent_id, agent_version, period_start, period_end,
      input_tokens, output_tokens, tool_calls, delegations, errors, avg_response_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id, agent_version, period_start) DO UPDATE SET
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      tool_calls = tool_calls + excluded.tool_calls,
      delegations = delegations + excluded.delegations,
      errors = errors + excluded.errors
  `
  ).run(
    input.agent_id,
    input.agent_version,
    input.period_start,
    periodEnd,
    input.input_tokens ?? 0,
    input.output_tokens ?? 0,
    input.tool_calls ?? 0,
    input.delegations ?? 0,
    input.errors ?? 0,
    input.avg_response_ms ?? 0
  );
}

export function getMetrics(db: DB, agentId: string, from: string, to: string): MetricsRow[] {
  return db
    .prepare(
      'SELECT * FROM agent_metrics WHERE agent_id = ? AND period_start >= ? AND period_start < ? ORDER BY period_start'
    )
    .all(agentId, from, to) as MetricsRow[];
}

export interface VersionComparison {
  version_a: { version: number } & Partial<MetricsRow>;
  version_b: { version: number } & Partial<MetricsRow>;
}

export function compareVersionMetrics(
  db: DB,
  agentId: string,
  versionA: number,
  versionB: number
): VersionComparison {
  const sumForVersion = (ver: number) =>
    db
      .prepare(
        `
    SELECT COALESCE(SUM(input_tokens),0) as input_tokens,
           COALESCE(SUM(output_tokens),0) as output_tokens,
           COALESCE(SUM(tool_calls),0) as tool_calls,
           COALESCE(SUM(delegations),0) as delegations,
           COALESCE(SUM(errors),0) as errors
    FROM agent_metrics WHERE agent_id = ? AND agent_version = ?
  `
      )
      .get(agentId, ver) as MetricsRow;

  return {
    version_a: { version: versionA, ...sumForVersion(versionA) },
    version_b: { version: versionB, ...sumForVersion(versionB) },
  };
}
```

- [ ] **Step 10: Run all tests and commit**

Run: `cd packages/standalone && pnpm vitest run tests/db/agent-store.test.ts`
Expected: ALL PASS

```bash
git add packages/standalone/src/db/agent-store.ts packages/standalone/tests/db/agent-store.test.ts
git commit -m "feat(agents): agent_versions + agent_metrics DB store with TDD"
```

---

## Task 2: Agent CRUD API Handlers

**Files:**

- Create: `packages/standalone/src/api/agent-handler.ts`
- Modify: `packages/standalone/src/api/graph-api.ts:1572-1677` (route dispatch)
- Modify: `packages/standalone/src/api/graph-api-types.ts:66-83` (GraphHandlerOptions)
- Test: `packages/standalone/tests/api/agent-handler.test.ts`

- [ ] **Step 1: Write failing tests for agent list and get**

```typescript
// packages/standalone/tests/api/agent-handler.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initAgentTables, createAgentVersion } from '../../src/db/agent-store.js';
import { handleGetAgents, handleGetAgent } from '../../src/api/agent-handler.js';

// Minimal mock for IncomingMessage and ServerResponse
function mockRes() {
  const res: any = { _status: 0, _body: '', _headers: {} };
  res.writeHead = (status: number, headers: any) => {
    res._status = status;
    res._headers = headers;
  };
  res.end = (body: string) => {
    res._body = body;
  };
  return res;
}

function mockReq(method = 'GET', body?: any): any {
  return { method, headers: {}, body };
}

describe('agent-handler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initAgentTables(db);
  });

  describe('handleGetAgents', () => {
    it('returns agents list from config with latest version', () => {
      createAgentVersion(db, { agent_id: 'conductor', snapshot: { tier: 1 } });
      const config = {
        multi_agent: {
          enabled: true,
          agents: {
            conductor: { name: 'Conductor', tier: 1, model: 'claude-opus-4-6' },
          },
        },
      };
      const res = mockRes();
      handleGetAgents(res, config as any, db);
      const body = JSON.parse(res._body);
      expect(body.agents).toHaveLength(1);
      expect(body.agents[0].version).toBe(1);
    });
  });

  describe('handleGetAgent', () => {
    it('returns single agent with full details', () => {
      createAgentVersion(db, {
        agent_id: 'conductor',
        snapshot: { tier: 1, model: 'claude-opus-4-6' },
        persona_text: 'You are Conductor.',
      });
      const config = {
        multi_agent: {
          agents: { conductor: { name: 'Conductor', tier: 1 } },
        },
      };
      const res = mockRes();
      handleGetAgent(res, 'conductor', config as any, db);
      const body = JSON.parse(res._body);
      expect(body.id).toBe('conductor');
      expect(body.system).toBe('You are Conductor.');
      expect(body.version).toBe(1);
    });

    it('returns 404 for unknown agent', () => {
      const res = mockRes();
      handleGetAgent(res, 'unknown', { multi_agent: { agents: {} } } as any, db);
      expect(res._status).toBe(404);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/standalone && pnpm vitest run tests/api/agent-handler.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement agent-handler.ts (list + get)**

```typescript
// packages/standalone/src/api/agent-handler.ts
import type { ServerResponse } from 'node:http';
import type BetterSqlite3 from 'better-sqlite3';
import type { MAMAConfig } from '../cli/config/types.js';
import {
  getLatestVersion,
  listVersions,
  getMetrics,
  compareVersionMetrics,
} from '../db/agent-store.js';

type DB = BetterSqlite3.Database;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function handleGetAgents(res: ServerResponse, config: MAMAConfig, db: DB): void {
  const agents = config.multi_agent?.agents ?? {};
  const list = Object.entries(agents).map(([id, cfg]) => {
    const latest = getLatestVersion(db, id);
    return {
      id,
      name: (cfg as any).name ?? id,
      display_name: (cfg as any).display_name ?? (cfg as any).name ?? id,
      model: (cfg as any).model ?? null,
      backend: (cfg as any).backend ?? 'claude',
      tier: (cfg as any).tier ?? 1,
      enabled: (cfg as any).enabled !== false,
      can_delegate: (cfg as any).can_delegate ?? false,
      effort: (cfg as any).effort ?? null,
      version: latest?.version ?? 0,
      archived_at: null,
    };
  });
  json(res, 200, { agents: list });
}

export function handleGetAgent(
  res: ServerResponse,
  agentId: string,
  config: MAMAConfig,
  db: DB
): void {
  const agentCfg = (config.multi_agent?.agents as any)?.[agentId];
  if (!agentCfg) {
    json(res, 404, { error: `Agent '${agentId}' not found` });
    return;
  }
  const latest = getLatestVersion(db, agentId);
  json(res, 200, {
    id: agentId,
    name: agentCfg.name ?? agentId,
    display_name: agentCfg.display_name ?? agentCfg.name ?? agentId,
    model: agentCfg.model ?? null,
    backend: agentCfg.backend ?? 'claude',
    tier: agentCfg.tier ?? 1,
    enabled: agentCfg.enabled !== false,
    can_delegate: agentCfg.can_delegate ?? false,
    effort: agentCfg.effort ?? null,
    trigger_prefix: agentCfg.trigger_prefix ?? null,
    cooldown_ms: agentCfg.cooldown_ms ?? 5000,
    auto_continue: agentCfg.auto_continue ?? false,
    persona_file: agentCfg.persona_file ?? null,
    tool_permissions: agentCfg.tool_permissions ?? null,
    system: latest?.persona_text ?? null,
    description: null,
    tools: [],
    metadata: {},
    version: latest?.version ?? 0,
    created_at: latest?.created_at ?? null,
    updated_at: latest?.created_at ?? null,
    archived_at: null,
  });
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd packages/standalone && pnpm vitest run tests/api/agent-handler.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing tests for agent create and update**

```typescript
// Append to tests/api/agent-handler.test.ts
import { handleCreateAgent, handleUpdateAgent } from '../../src/api/agent-handler.js';

describe('handleCreateAgent', () => {
  it('creates agent with version 1', () => {
    const res = mockRes();
    handleCreateAgent(res, { id: 'qa', name: 'QA Bot', model: 'claude-sonnet-4-6', tier: 2 }, db);
    const body = JSON.parse(res._body);
    expect(res._status).toBe(201);
    expect(body.id).toBe('qa');
    expect(body.version).toBe(1);
  });

  it('rejects duplicate id', () => {
    handleCreateAgent(res, { id: 'qa', name: 'QA', model: 'sonnet', tier: 1 }, db);
    const res2 = mockRes();
    handleCreateAgent(res2, { id: 'qa', name: 'QA2', model: 'sonnet', tier: 1 }, db);
    expect(res2._status).toBe(409);
  });
});

describe('handleUpdateAgent', () => {
  it('updates agent and increments version', () => {
    createAgentVersion(db, { agent_id: 'dev', snapshot: { model: 'sonnet', tier: 1 } });
    const res = mockRes();
    handleUpdateAgent(
      res,
      'dev',
      {
        version: 1,
        changes: { model: 'opus' },
        change_note: 'Model upgrade',
      },
      db
    );
    const body = JSON.parse(res._body);
    expect(body.new_version).toBe(2);
  });

  it('rejects version mismatch with 409', () => {
    createAgentVersion(db, { agent_id: 'dev', snapshot: { tier: 1 } });
    const res = mockRes();
    handleUpdateAgent(res, 'dev', { version: 99, changes: { tier: 2 } }, db);
    expect(res._status).toBe(409);
  });
});
```

- [ ] **Step 6: Implement create and update handlers**

```typescript
// Append to packages/standalone/src/api/agent-handler.ts
import { createAgentVersion } from '../db/agent-store.js';

export function handleCreateAgent(
  res: ServerResponse,
  body: { id: string; name: string; model: string; tier: number; [k: string]: unknown },
  db: DB
): void {
  const existing = getLatestVersion(db, body.id);
  if (existing) {
    json(res, 409, { error: `Agent '${body.id}' already exists` });
    return;
  }
  const snapshot = { model: body.model, tier: body.tier, backend: body.backend ?? 'claude' };
  const v = createAgentVersion(db, {
    agent_id: body.id,
    snapshot,
    persona_text: (body.system as string) ?? null,
    change_note: 'Initial creation',
  });
  json(res, 201, {
    id: body.id,
    name: body.name,
    version: v.version,
    created_at: v.created_at,
  });
}

export function handleUpdateAgent(
  res: ServerResponse,
  agentId: string,
  body: { version: number; changes: Record<string, unknown>; change_note?: string },
  db: DB
): void {
  const latest = getLatestVersion(db, agentId);
  if (!latest) {
    json(res, 404, { error: `Agent '${agentId}' not found` });
    return;
  }
  if (latest.version !== body.version) {
    json(res, 409, {
      error: `Version conflict: current is v${latest.version}, you sent v${body.version}`,
      current_version: latest.version,
    });
    return;
  }
  const currentSnapshot = JSON.parse(latest.snapshot);
  const newSnapshot = { ...currentSnapshot, ...body.changes };
  const v = createAgentVersion(db, {
    agent_id: agentId,
    snapshot: newSnapshot,
    persona_text: (body.changes.system as string) ?? latest.persona_text,
    change_note: body.change_note,
  });
  json(res, 200, { success: true, new_version: v.version });
}
```

- [ ] **Step 7: Write failing tests for versions list and compare**

```typescript
// Append to tests/api/agent-handler.test.ts
import { handleListVersions, handleCompareVersions } from '../../src/api/agent-handler.js';

describe('handleListVersions', () => {
  it('returns version history', () => {
    createAgentVersion(db, { agent_id: 'dev', snapshot: { v: 1 } });
    createAgentVersion(db, { agent_id: 'dev', snapshot: { v: 2 } });
    const res = mockRes();
    handleListVersions(res, 'dev', db);
    const body = JSON.parse(res._body);
    expect(body.versions).toHaveLength(2);
    expect(body.versions[0].version).toBe(2); // desc order
  });
});

describe('handleCompareVersions', () => {
  it('returns metrics comparison', () => {
    createAgentVersion(db, { agent_id: 'dev', snapshot: { v: 1 } });
    createAgentVersion(db, { agent_id: 'dev', snapshot: { v: 2 } });
    upsertMetrics(db, {
      agent_id: 'dev',
      agent_version: 1,
      period_start: '2026-04-10',
      input_tokens: 1000,
    });
    upsertMetrics(db, {
      agent_id: 'dev',
      agent_version: 2,
      period_start: '2026-04-10',
      input_tokens: 400,
    });
    const res = mockRes();
    handleCompareVersions(res, 'dev', 1, 2, db);
    const body = JSON.parse(res._body);
    expect(body.version_a.input_tokens).toBe(1000);
    expect(body.version_b.input_tokens).toBe(400);
  });
});
```

- [ ] **Step 8: Implement versions list and compare handlers**

```typescript
// Append to packages/standalone/src/api/agent-handler.ts

export function handleListVersions(res: ServerResponse, agentId: string, db: DB): void {
  const versions = listVersions(db, agentId);
  json(res, 200, { versions });
}

export function handleCompareVersions(
  res: ServerResponse,
  agentId: string,
  v1: number,
  v2: number,
  db: DB
): void {
  const comparison = compareVersionMetrics(db, agentId, v1, v2);
  json(res, 200, comparison);
}

export function handleGetAgentMetrics(
  res: ServerResponse,
  agentId: string,
  from: string,
  to: string,
  db: DB
): void {
  const metrics = getMetrics(db, agentId, from, to);
  json(res, 200, { metrics });
}
```

- [ ] **Step 9: Run all agent-handler tests**

Run: `cd packages/standalone && pnpm vitest run tests/api/agent-handler.test.ts`
Expected: ALL PASS

- [ ] **Step 10: Wire routes into graph-api.ts dispatch**

Add to `packages/standalone/src/api/graph-api.ts` at line ~1572 (before existing multi-agent routes), import handlers from agent-handler.ts, and add route matching:

```typescript
// Add routes BEFORE the existing /api/multi-agent/* routes
// in the createGraphHandler() function's route dispatch section

// Route: GET /api/agents — list all agents
if (pathname === '/api/agents' && req.method === 'GET') {
  const config = loadMAMAConfig();
  handleGetAgents(res, config, options.sessionsDb!);
  return true;
}

// Route: GET /api/agents/:id — get single agent
if (pathname.match(/^\/api\/agents\/[^/]+$/) && req.method === 'GET') {
  const agentId = decodeURIComponent(pathname.split('/')[3]);
  const config = loadMAMAConfig();
  handleGetAgent(res, agentId, config, options.sessionsDb!);
  return true;
}

// Route: POST /api/agents — create new agent
if (pathname === '/api/agents' && req.method === 'POST') {
  if (!isAuthenticated(req)) {
    /* 401 */ return true;
  }
  const body = await readBody(req);
  handleCreateAgent(res, body, options.sessionsDb!);
  return true;
}

// Route: POST /api/agents/:id — update agent (Managed Agents pattern)
if (pathname.match(/^\/api\/agents\/[^/]+$/) && req.method === 'POST') {
  if (!isAuthenticated(req)) {
    /* 401 */ return true;
  }
  const agentId = decodeURIComponent(pathname.split('/')[3]);
  const body = await readBody(req);
  handleUpdateAgent(res, agentId, body, options.sessionsDb!);
  return true;
}

// Route: GET /api/agents/:id/versions — version history
if (pathname.match(/^\/api\/agents\/[^/]+\/versions$/) && req.method === 'GET') {
  const agentId = decodeURIComponent(pathname.split('/')[3]);
  handleListVersions(res, agentId, options.sessionsDb!);
  return true;
}

// Route: GET /api/agents/:id/versions/:v1/compare/:v2 — before/after
if (pathname.match(/^\/api\/agents\/[^/]+\/versions\/\d+\/compare\/\d+$/) && req.method === 'GET') {
  const parts = pathname.split('/');
  const agentId = decodeURIComponent(parts[3]);
  const v1 = parseInt(parts[5], 10);
  const v2 = parseInt(parts[7], 10);
  handleCompareVersions(res, agentId, v1, v2, options.sessionsDb!);
  return true;
}
```

- [ ] **Step 11: Add sessionsDb to GraphHandlerOptions**

Modify `packages/standalone/src/api/graph-api-types.ts`:

```typescript
// Add to GraphHandlerOptions interface
sessionsDb?: import('better-sqlite3').Database;
```

- [ ] **Step 12: Run full test suite and commit**

Run: `cd packages/standalone && pnpm vitest run tests/api/agent-handler.test.ts && pnpm vitest run tests/db/agent-store.test.ts`
Expected: ALL PASS

```bash
git add packages/standalone/src/api/agent-handler.ts packages/standalone/src/api/graph-api.ts packages/standalone/src/api/graph-api-types.ts packages/standalone/tests/api/agent-handler.test.ts
git commit -m "feat(agents): CRUD API endpoints aligned with Managed Agents pattern"
```

---

## Task 3: UI Command Infrastructure

**Files:**

- Create: `packages/standalone/src/api/ui-command-handler.ts`
- Modify: `packages/standalone/src/api/graph-api.ts` (route dispatch)
- Test: `packages/standalone/tests/api/ui-command-handler.test.ts`

- [ ] **Step 1: Write failing tests for command queue**

```typescript
// packages/standalone/tests/api/ui-command-handler.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { UICommandQueue } from '../../src/api/ui-command-handler.js';

describe('UICommandQueue', () => {
  let queue: UICommandQueue;

  beforeEach(() => {
    queue = new UICommandQueue();
  });

  it('enqueue and drain returns commands', () => {
    queue.push({ type: 'navigate', payload: { route: 'agents' } });
    queue.push({ type: 'notify', payload: { message: 'hello', severity: 'info' } });
    const cmds = queue.drain();
    expect(cmds).toHaveLength(2);
    expect(cmds[0].type).toBe('navigate');
  });

  it('drain clears the queue', () => {
    queue.push({ type: 'navigate', payload: { route: 'agents' } });
    queue.drain();
    expect(queue.drain()).toHaveLength(0);
  });

  it('setPageContext stores latest context', () => {
    queue.setPageContext({ currentRoute: 'agents', pageData: { pageType: 'agent-list' } });
    expect(queue.getPageContext()?.currentRoute).toBe('agents');
  });

  it('limits queue size to 50', () => {
    for (let i = 0; i < 60; i++) {
      queue.push({ type: 'notify', payload: { message: `msg-${i}`, severity: 'info' } });
    }
    expect(queue.drain().length).toBeLessThanOrEqual(50);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/standalone && pnpm vitest run tests/api/ui-command-handler.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement UICommandQueue**

```typescript
// packages/standalone/src/api/ui-command-handler.ts
import type { ServerResponse, IncomingMessage } from 'node:http';

export interface UICommand {
  type: 'navigate' | 'notify' | 'suggest_change' | 'refresh';
  payload: Record<string, unknown>;
}

export interface PageContext {
  currentRoute: string;
  selectedItem?: { type: string; id: string };
  pageData?: Record<string, unknown>;
}

const MAX_QUEUE = 50;

export class UICommandQueue {
  private commands: UICommand[] = [];
  private pageContext: PageContext | null = null;

  push(cmd: UICommand): void {
    this.commands.push(cmd);
    if (this.commands.length > MAX_QUEUE) {
      this.commands = this.commands.slice(-MAX_QUEUE);
    }
  }

  drain(): UICommand[] {
    const cmds = this.commands;
    this.commands = [];
    return cmds;
  }

  setPageContext(ctx: PageContext): void {
    this.pageContext = ctx;
  }

  getPageContext(): PageContext | null {
    return this.pageContext;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function handleGetUICommands(res: ServerResponse, queue: UICommandQueue): void {
  json(res, 200, { commands: queue.drain() });
}

export function handlePostPageContext(
  res: ServerResponse,
  body: PageContext,
  queue: UICommandQueue
): void {
  queue.setPageContext(body);
  json(res, 200, { success: true });
}

export function handlePostUICommand(
  res: ServerResponse,
  body: UICommand,
  queue: UICommandQueue
): void {
  queue.push(body);
  json(res, 200, { success: true });
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd packages/standalone && pnpm vitest run tests/api/ui-command-handler.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Wire routes into graph-api.ts**

```typescript
// Add to graph-api.ts route dispatch

// Route: GET /api/ui/commands — viewer polls for UI commands
if (pathname === '/api/ui/commands' && req.method === 'GET') {
  handleGetUICommands(res, options.uiCommandQueue!);
  return true;
}

// Route: POST /api/ui/page-context — viewer reports current page state
if (pathname === '/api/ui/page-context' && req.method === 'POST') {
  const body = await readBody(req);
  handlePostPageContext(res, body, options.uiCommandQueue!);
  return true;
}

// Route: POST /api/ui/commands — agent pushes UI commands
if (pathname === '/api/ui/commands' && req.method === 'POST') {
  const body = await readBody(req);
  handlePostUICommand(res, body, options.uiCommandQueue!);
  return true;
}
```

- [ ] **Step 6: Add uiCommandQueue to GraphHandlerOptions**

```typescript
// In graph-api-types.ts, add:
uiCommandQueue?: import('./ui-command-handler.js').UICommandQueue;
```

- [ ] **Step 7: Run tests and commit**

Run: `cd packages/standalone && pnpm vitest run tests/api/ui-command-handler.test.ts`
Expected: ALL PASS

```bash
git add packages/standalone/src/api/ui-command-handler.ts packages/standalone/tests/api/ui-command-handler.test.ts packages/standalone/src/api/graph-api.ts packages/standalone/src/api/graph-api-types.ts
git commit -m "feat(agents): UI command queue for bidirectional Agent↔Viewer communication"
```

---

## Task 4: Gateway Tools Registration

**Files:**

- Modify: `packages/standalone/src/agent/types.ts:654-709` (GatewayToolName)
- Modify: `packages/standalone/src/agent/tool-registry.ts` (register new tools)
- Test: `packages/standalone/tests/agent/tool-registry.test.ts` (verify registration)

- [ ] **Step 1: Write failing test**

```typescript
// packages/standalone/tests/agent/tool-registry.test.ts
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/agent/tool-registry.js';

describe('agent management gateway tools', () => {
  const toolNames = [
    'agent_get',
    'agent_update',
    'agent_create',
    'agent_compare',
    'viewer_navigate',
    'viewer_notify',
  ];

  for (const name of toolNames) {
    it(`registers ${name}`, () => {
      const tool = ToolRegistry.get(name as any);
      expect(tool).toBeDefined();
      expect(tool?.category).toBeDefined();
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/standalone && pnpm vitest run tests/agent/tool-registry.test.ts`
Expected: FAIL — tools not registered

- [ ] **Step 3: Add tool names to GatewayToolName union**

In `packages/standalone/src/agent/types.ts`, add before the closing semicolon of the `GatewayToolName` type (around line 709):

```typescript
  // Agent management tools
  | 'agent_get'
  | 'agent_update'
  | 'agent_create'
  | 'agent_compare'
  // Viewer control tools
  | 'viewer_navigate'
  | 'viewer_notify'
```

- [ ] **Step 4: Register tools in tool-registry.ts**

Append to `packages/standalone/src/agent/tool-registry.ts`:

```typescript
// Agent management tools
register({
  name: 'agent_get',
  description: 'Get agent config, persona, and current version',
  category: 'os_management',
  params: 'agent_id',
});
register({
  name: 'agent_update',
  description:
    'Update agent config. Requires current version for optimistic concurrency. Bumps version on change.',
  category: 'os_management',
  params: 'agent_id, version, changes: {model?, tier?, system?, tools?, ...}, change_note',
});
register({
  name: 'agent_create',
  description: 'Create new agent with initial config and persona',
  category: 'os_management',
  params: 'id, name, model, tier, system?, backend?',
});
register({
  name: 'agent_compare',
  description: 'Compare metrics between two versions of an agent (Before/After)',
  category: 'os_monitoring',
  params: 'agent_id, version_a, version_b',
});

// Viewer control tools
register({
  name: 'viewer_navigate',
  description: 'Navigate viewer to a specific page/tab (e.g., agent detail, metrics)',
  category: 'os_management',
  params: 'route, params?: {id?, tab?, compareV1?, compareV2?}',
});
register({
  name: 'viewer_notify',
  description: 'Show toast or alert card in viewer',
  category: 'os_management',
  params: 'type: info|warning|suggest, message, action?: {label, navigate}',
});
```

- [ ] **Step 5: Run tests**

Run: `cd packages/standalone && pnpm vitest run tests/agent/tool-registry.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Rebuild gateway-tools.md and commit**

```bash
cd packages/standalone && pnpm exec tsx scripts/generate-gateway-tools.ts
git add packages/standalone/src/agent/types.ts packages/standalone/src/agent/tool-registry.ts packages/standalone/src/agent/gateway-tools.md packages/standalone/tests/agent/tool-registry.test.ts
git commit -m "feat(agents): register 6 gateway tools for agent management + viewer control"
```

---

## Task 5: Gateway Tool Execution

**Files:**

- Modify: `packages/standalone/src/agent/agent-loop.ts` or gateway-tool-executor (wherever tools are dispatched)
- Create handler functions for the 6 new tools

- [ ] **Step 1: Find the tool execution dispatch point**

Read: `packages/standalone/src/agent/agent-loop.ts` — search for `VALID_TOOLS` or the switch/if-else that dispatches gateway tool calls to handler functions. This is where `mama_save`, `Bash`, `delegate` etc. are routed.

- [ ] **Step 2: Write failing test for agent_get tool execution**

```typescript
// packages/standalone/tests/agent/gateway-agent-tools.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initAgentTables, createAgentVersion } from '../../src/db/agent-store.js';
import {
  executeAgentGet,
  executeAgentUpdate,
  executeAgentCompare,
} from '../../src/agent/gateway-agent-tools.js';

describe('gateway agent tools', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initAgentTables(db);
  });

  it('agent_get returns agent config + version', () => {
    createAgentVersion(db, {
      agent_id: 'dev',
      snapshot: { model: 'sonnet', tier: 1 },
      persona_text: 'Dev persona',
    });
    const result = executeAgentGet({ agent_id: 'dev' }, db);
    expect(result.success).toBe(true);
    expect(result.data.version).toBe(1);
    expect(result.data.system).toBe('Dev persona');
  });

  it('agent_update bumps version', () => {
    createAgentVersion(db, { agent_id: 'dev', snapshot: { model: 'sonnet' } });
    const result = executeAgentUpdate(
      {
        agent_id: 'dev',
        version: 1,
        changes: { model: 'opus' },
        change_note: 'Upgrade',
      },
      db
    );
    expect(result.success).toBe(true);
    expect(result.data.new_version).toBe(2);
  });

  it('agent_compare returns metrics diff', () => {
    createAgentVersion(db, { agent_id: 'dev', snapshot: { v: 1 } });
    createAgentVersion(db, { agent_id: 'dev', snapshot: { v: 2 } });
    const result = executeAgentCompare({ agent_id: 'dev', version_a: 1, version_b: 2 }, db);
    expect(result.success).toBe(true);
    expect(result.data.version_a).toBeDefined();
  });
});
```

- [ ] **Step 3: Implement gateway-agent-tools.ts**

```typescript
// packages/standalone/src/agent/gateway-agent-tools.ts
import type BetterSqlite3 from 'better-sqlite3';
import {
  getLatestVersion,
  createAgentVersion,
  listVersions,
  compareVersionMetrics,
} from '../db/agent-store.js';

type DB = BetterSqlite3.Database;

interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
}

export function executeAgentGet(args: { agent_id: string }, db: DB): ToolResult {
  const latest = getLatestVersion(db, args.agent_id);
  if (!latest) return { success: false, error: `Agent '${args.agent_id}' not found` };
  return {
    success: true,
    data: {
      agent_id: latest.agent_id,
      version: latest.version,
      config: JSON.parse(latest.snapshot),
      system: latest.persona_text,
      change_note: latest.change_note,
      created_at: latest.created_at,
    },
  };
}

export function executeAgentUpdate(
  args: {
    agent_id: string;
    version: number;
    changes: Record<string, unknown>;
    change_note?: string;
  },
  db: DB
): ToolResult {
  const latest = getLatestVersion(db, args.agent_id);
  if (!latest) return { success: false, error: `Agent '${args.agent_id}' not found` };
  if (latest.version !== args.version) {
    return {
      success: false,
      error: `Version conflict: current v${latest.version}, sent v${args.version}`,
    };
  }
  const currentSnapshot = JSON.parse(latest.snapshot);
  const newSnapshot = { ...currentSnapshot, ...args.changes };
  const v = createAgentVersion(db, {
    agent_id: args.agent_id,
    snapshot: newSnapshot,
    persona_text: (args.changes.system as string) ?? latest.persona_text,
    change_note: args.change_note,
  });
  return { success: true, data: { new_version: v.version } };
}

export function executeAgentCreate(
  args: { id: string; name: string; model: string; tier: number; system?: string },
  db: DB
): ToolResult {
  const existing = getLatestVersion(db, args.id);
  if (existing) return { success: false, error: `Agent '${args.id}' already exists` };
  const v = createAgentVersion(db, {
    agent_id: args.id,
    snapshot: { model: args.model, tier: args.tier, name: args.name },
    persona_text: args.system ?? null,
    change_note: 'Created via agent_create tool',
  });
  return { success: true, data: { id: args.id, version: v.version } };
}

export function executeAgentCompare(
  args: { agent_id: string; version_a: number; version_b: number },
  db: DB
): ToolResult {
  const comparison = compareVersionMetrics(db, args.agent_id, args.version_a, args.version_b);
  return { success: true, data: comparison };
}
```

- [ ] **Step 4: Wire viewer_navigate and viewer_notify to UICommandQueue**

```typescript
// Append to packages/standalone/src/agent/gateway-agent-tools.ts
import type { UICommandQueue } from '../api/ui-command-handler.js';

export function executeViewerNavigate(
  args: { route: string; params?: Record<string, string> },
  queue: UICommandQueue
): ToolResult {
  queue.push({ type: 'navigate', payload: args });
  return { success: true, data: { navigated: args.route } };
}

export function executeViewerNotify(
  args: { type: string; message: string; action?: Record<string, unknown> },
  queue: UICommandQueue
): ToolResult {
  queue.push({ type: 'notify', payload: args });
  return { success: true, data: { notified: true } };
}
```

- [ ] **Step 5: Run tests**

Run: `cd packages/standalone && pnpm vitest run tests/agent/gateway-agent-tools.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Integrate into tool execution dispatch**

Find the tool dispatch point (the file that matches tool names to handler functions) and add cases for the 6 new tools. Each case calls the corresponding `execute*` function from `gateway-agent-tools.ts`, passing `db` and/or `uiCommandQueue` from the runtime context.

- [ ] **Step 7: Run full test suite and commit**

Run: `cd packages/standalone && pnpm test`
Expected: ALL PASS

```bash
git add packages/standalone/src/agent/gateway-agent-tools.ts packages/standalone/tests/agent/gateway-agent-tools.test.ts
git commit -m "feat(agents): gateway tool execution for agent CRUD + viewer control"
```

---

## Task 6: Viewer API Client Extensions

**Files:**

- Modify: `packages/standalone/public/viewer/src/utils/api.ts`

- [ ] **Step 1: Add Agent Management API methods**

```typescript
// Append to API class in packages/standalone/public/viewer/src/utils/api.ts

// =============================================
// Agent Management API (Managed Agents pattern)
// =============================================

static async getAgents(): Promise<{ agents: MultiAgentAgent[] }> {
  return this.get('/api/agents');
}

static async getAgent(agentId: string): Promise<MultiAgentAgent & { system?: string; version?: number }> {
  return this.get(`/api/agents/${encodeURIComponent(agentId)}`);
}

static async createAgent(body: {
  id: string; name: string; model: string; tier: number; system?: string;
}): Promise<JsonRecord> {
  return this.post('/api/agents', body);
}

static async updateAgent(agentId: string, body: {
  version: number; changes: Record<string, unknown>; change_note?: string;
}): Promise<JsonRecord> {
  return this.post(`/api/agents/${encodeURIComponent(agentId)}`, body);
}

static async archiveAgent(agentId: string): Promise<JsonRecord> {
  return this.post(`/api/agents/${encodeURIComponent(agentId)}/archive`, {});
}

static async getAgentVersions(agentId: string): Promise<{ versions: JsonRecord[] }> {
  return this.get(`/api/agents/${encodeURIComponent(agentId)}/versions`);
}

static async compareAgentVersions(
  agentId: string, v1: number, v2: number
): Promise<JsonRecord> {
  return this.get(`/api/agents/${encodeURIComponent(agentId)}/versions/${v1}/compare/${v2}`);
}

static async getAgentMetrics(
  agentId: string, from: string, to: string
): Promise<{ metrics: JsonRecord[] }> {
  return this.get(`/api/agents/${encodeURIComponent(agentId)}/metrics`, { from, to });
}

// =============================================
// UI Command API (SmartStore pattern)
// =============================================

static async getUICommands(): Promise<{ commands: Array<{ type: string; payload: any }> }> {
  return this.get('/api/ui/commands');
}

static async pushPageContext(route: string, data: Record<string, unknown>): Promise<void> {
  await this.post('/api/ui/page-context', { currentRoute: route, pageData: data });
}
```

- [ ] **Step 2: Build viewer TypeScript**

Run: `cd packages/standalone && pnpm exec tsc -p public/viewer/tsconfig.viewer.json`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/standalone/public/viewer/src/utils/api.ts
git commit -m "feat(agents): viewer API client for agent CRUD + UI commands"
```

---

## Task 7: Viewer UI Command Polling

**Files:**

- Create: `packages/standalone/public/viewer/src/utils/ui-commands.ts`
- Modify: `packages/standalone/public/viewer/viewer.html` (add polling in script)

- [ ] **Step 1: Create ui-commands.ts**

```typescript
// packages/standalone/public/viewer/src/utils/ui-commands.ts
import { API } from './api.js';
import { showToast } from './dom.js';

type SwitchTabFn = (tab: string, params?: Record<string, string>) => void;

let polling = false;

export function startUICommandPolling(switchTab: SwitchTabFn): void {
  if (polling) return;
  polling = true;

  setInterval(async () => {
    try {
      const { commands } = await API.getUICommands();
      for (const cmd of commands) {
        if (cmd.type === 'navigate') {
          const p = cmd.payload as { route?: string; params?: Record<string, string> };
          if (p.route) switchTab(p.route, p.params);
        } else if (cmd.type === 'notify') {
          const p = cmd.payload as { message?: string };
          if (p.message) showToast(p.message);
        }
      }
    } catch {
      // Silently ignore polling errors
    }
  }, 1000);
}

export function reportPageContext(route: string, data: Record<string, unknown>): void {
  API.pushPageContext(route, data).catch(() => {});
}
```

- [ ] **Step 2: Import and start polling in viewer.html**

In `viewer.html` script section (around line 1140), after module initialization:

```typescript
import { startUICommandPolling } from '/viewer/js/utils/ui-commands.js';

// After switchTab function is defined:
startUICommandPolling(switchTab);
```

- [ ] **Step 3: Build and verify**

Run: `cd packages/standalone && pnpm exec tsc -p public/viewer/tsconfig.viewer.json`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add packages/standalone/public/viewer/src/utils/ui-commands.ts packages/standalone/public/viewer/viewer.html
git commit -m "feat(agents): viewer UI command polling ported from SmartStore pattern"
```

---

## Task 8: Viewer Agents Module — List View

**Files:**

- Create: `packages/standalone/public/viewer/src/modules/agents.ts`
- Modify: `packages/standalone/public/viewer/viewer.html` (tab registration)

- [ ] **Step 1: Create AgentsModule with list view**

```typescript
// packages/standalone/public/viewer/src/modules/agents.ts
import { API, type MultiAgentAgent, type JsonRecord } from '../utils/api.js';
import { DebugLogger } from '../utils/debug-logger.js';
import { showToast, escapeHtml } from '../utils/dom.js';
import { reportPageContext } from '../utils/ui-commands.js';

const logger = new DebugLogger('Agents');

const COLOR = {
  primary: '#1A1A1A',
  secondary: '#6B6560',
  tertiary: '#9E9891',
  border: '#EDE9E1',
  bg: '#FAFAF8',
  agent: '#8b5cf6',
  green: '#3A9E7E',
  red: '#D94F4F',
  yellow: '#F5C518',
} as const;

type AgentWithVersion = MultiAgentAgent & { version?: number };
type ViewState = 'list' | 'detail';

export class AgentsModule {
  private container: HTMLElement | null = null;
  private initialized = false;
  private viewState: ViewState = 'list';
  private selectedAgentId: string | null = null;
  private agents: AgentWithVersion[] = [];

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.container = document.getElementById('agents-content');
    if (!this.container) return;
    this.loadAgents();
  }

  private async loadAgents(): Promise<void> {
    if (!this.container) return;
    try {
      const { agents } = await API.getAgents();
      this.agents = agents;
      this.renderList();
      reportPageContext('agents', {
        pageType: 'agent-list',
        summary: `${agents.length} agents`,
        total: agents.length,
      });
    } catch (err) {
      logger.error('Failed to load agents', err);
      showToast('Failed to load agents');
    }
  }

  private renderList(): void {
    if (!this.container) return;
    const cards = this.agents
      .map((a) => {
        const statusColor = a.enabled ? COLOR.green : COLOR.tertiary;
        const statusText = a.enabled ? 'Active' : 'Disabled';
        const tierBadge = `T${a.tier ?? 1}`;
        return `
        <div class="agent-card" data-agent-id="${escapeHtml(a.id)}"
             style="background:#fff;border:1px solid ${COLOR.border};border-radius:8px;padding:16px;cursor:pointer;transition:box-shadow 0.15s;"
             onmouseover="this.style.boxShadow='0 2px 8px rgba(0,0,0,0.08)'"
             onmouseout="this.style.boxShadow='none'">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <span style="font-size:15px;font-weight:600;color:${COLOR.primary}">${escapeHtml(a.display_name || a.name || a.id)}</span>
            <span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;background:${COLOR.agent}15;color:${COLOR.agent}">${tierBadge}</span>
          </div>
          <div style="font-size:12px;color:${COLOR.secondary};margin-bottom:6px;">${escapeHtml(a.model || 'No model')}</div>
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-size:11px;color:${statusColor};font-weight:500;">● ${statusText}</span>
            <span style="font-size:11px;color:${COLOR.tertiary};">v${a.version ?? 0}</span>
          </div>
        </div>
      `;
      })
      .join('');

    this.container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
        <h2 style="font-size:18px;font-weight:600;color:${COLOR.primary};margin:0;">Agents</h2>
        <button id="btn-create-agent"
                style="font-size:12px;padding:6px 14px;border-radius:6px;border:none;background:${COLOR.agent};color:#fff;cursor:pointer;font-weight:500;">
          + New Agent
        </button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;">
        ${cards}
      </div>
    `;

    // Bind click events
    this.container.querySelectorAll('.agent-card').forEach((card) => {
      card.addEventListener('click', () => {
        const agentId = (card as HTMLElement).dataset.agentId;
        if (agentId) this.showDetail(agentId);
      });
    });

    this.container.querySelector('#btn-create-agent')?.addEventListener('click', () => {
      this.showCreateModal();
    });
  }

  private async showDetail(agentId: string): Promise<void> {
    this.viewState = 'detail';
    this.selectedAgentId = agentId;
    // Detail view implemented in Task 9
    try {
      const agent = await API.getAgent(agentId);
      this.renderDetail(agent);
      reportPageContext('agents', {
        pageType: 'agent-detail',
        selectedAgent: agentId,
        agentVersion: agent.version,
        summary: `${agent.display_name || agent.name} v${agent.version}`,
      });
    } catch (err) {
      logger.error(`Failed to load agent ${agentId}`, err);
      showToast('Failed to load agent details');
    }
  }

  private renderDetail(_agent: any): void {
    // Placeholder — implemented in Task 9
    if (!this.container) return;
    this.container.innerHTML = '<p>Detail view — see Task 9</p>';
  }

  private showCreateModal(): void {
    // Placeholder — implemented in Task 9
    showToast('Create agent — coming in Task 9');
  }

  showList(): void {
    this.viewState = 'list';
    this.selectedAgentId = null;
    this.loadAgents();
  }
}
```

- [ ] **Step 2: Add Agents tab to viewer.html**

Add tab button to sidebar navigation (after existing nav items):

```html
<button
  class="mama-nav-item"
  data-tab="agents"
  onclick="window.switchTab && window.switchTab('agents')"
>
  Agents
</button>
```

Add tab content container:

```html
<div class="tab-content" id="tab-agents">
  <div id="agents-content"></div>
</div>
```

Add module import and initialization in script section:

```typescript
import { AgentsModule } from '/viewer/js/modules/agents.js';
const agents = new AgentsModule();
// In switchTab function, add:
// } else if (tabName === 'agents') { agents.init(); }
```

- [ ] **Step 3: Build and verify**

Run: `cd packages/standalone && pnpm exec tsc -p public/viewer/tsconfig.viewer.json`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add packages/standalone/public/viewer/src/modules/agents.ts packages/standalone/public/viewer/viewer.html
git commit -m "feat(agents): viewer Agents module with card grid list view"
```

---

## Task 9: Viewer Agents Module — Detail View with Tabs

**Files:**

- Modify: `packages/standalone/public/viewer/src/modules/agents.ts` (replace placeholder renderDetail)

- [ ] **Step 1: Implement detail view with 5 tabs (Config, Persona, Tools, Metrics, History)**

Replace the placeholder `renderDetail()` and `showCreateModal()` in agents.ts with full implementations. Each tab renders its own content panel.

**Config tab**: form fields for name, backend, model, tier, effort, delegate, trigger, cooldown. Save button calls `API.updateAgent()` with version.

**Persona tab**: textarea (monospace, 20 rows) pre-filled with `agent.system`. Save calls `API.updateAgent()` with `changes: { system: newText }`.

**Tools tab**: checkbox list of tools (Bash, Read, Edit, Write, Glob, Grep, WebFetch, WebSearch, NotebookEdit). Pre-populated from agent.tool_permissions. Tier preset dropdown that auto-sets checkboxes.

**Metrics tab**: calls `API.getAgentMetrics()`, renders daily token/toolcall numbers. Version comparison dropdowns call `API.compareAgentVersions()` and display diff table.

**History tab**: calls `API.getAgentVersions()`, renders version list with change_note and created_at. Click version to see config snapshot diff.

- [ ] **Step 2: Implement create agent modal**

HTML modal overlay with fields: ID (slug), Name, Backend, Model, Tier. Submit calls `API.createAgent()`, then navigates to detail view.

- [ ] **Step 3: Add back navigation**

"← Agents" button at top of detail view that calls `this.showList()`.

- [ ] **Step 4: Build and verify**

Run: `cd packages/standalone && pnpm exec tsc -p public/viewer/tsconfig.viewer.json`
Expected: No errors

- [ ] **Step 5: Manual smoke test**

Run: `cd packages/standalone && mama start && open http://localhost:3847/viewer`
Verify: Agents tab visible, cards render, detail tabs switch, create modal opens.

- [ ] **Step 6: Commit**

```bash
git add packages/standalone/public/viewer/src/modules/agents.ts
git commit -m "feat(agents): detail view with Config/Persona/Tools/Metrics/History tabs"
```

---

## Task 10: Metrics Collection — Extend Token Handler

**Files:**

- Modify: `packages/standalone/src/api/token-handler.ts:14-65`
- Modify: wherever `insertTokenUsage()` is called (to pass agent_version)

- [ ] **Step 1: Write failing test**

```typescript
// packages/standalone/tests/api/token-handler-version.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initTokenUsageTable, insertTokenUsage } from '../../src/api/token-handler.js';

describe('token_usage agent_version tracking', () => {
  let db: any;

  beforeEach(() => {
    db = new Database(':memory:');
    initTokenUsageTable(db);
  });

  it('stores agent_version when provided', () => {
    insertTokenUsage(db, {
      channel_key: 'discord:123',
      agent_id: 'conductor',
      agent_version: 4,
      input_tokens: 100,
      output_tokens: 50,
    });
    const row = db
      .prepare('SELECT agent_version FROM token_usage WHERE agent_id = ?')
      .get('conductor');
    expect(row.agent_version).toBe(4);
  });

  it('defaults agent_version to null when not provided', () => {
    insertTokenUsage(db, {
      channel_key: 'discord:123',
      agent_id: 'conductor',
      input_tokens: 100,
      output_tokens: 50,
    });
    const row = db
      .prepare('SELECT agent_version FROM token_usage WHERE agent_id = ?')
      .get('conductor');
    expect(row.agent_version).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/standalone && pnpm vitest run tests/api/token-handler-version.test.ts`
Expected: FAIL — agent_version column doesn't exist

- [ ] **Step 3: Add agent_version column**

In `packages/standalone/src/api/token-handler.ts`:

Add `agent_version?: number` to `TokenUsageRecord` interface.

Add column migration in `initTokenUsageTable()`:

```typescript
// After CREATE TABLE, add migration for existing databases:
try {
  db.exec('ALTER TABLE token_usage ADD COLUMN agent_version INTEGER');
} catch {
  /* column already exists */
}
```

Update `insertTokenUsage()` SQL to include agent_version.

- [ ] **Step 4: Run test to verify pass**

Run: `cd packages/standalone && pnpm vitest run tests/api/token-handler-version.test.ts`
Expected: PASS

- [ ] **Step 5: Add agent_metrics upsert call alongside token insertion**

At the callsite where `insertTokenUsage()` is called, also call `upsertMetrics()` from agent-store.ts to populate the agent_metrics table:

```typescript
// After insertTokenUsage, if agent_id and agent_version are known:
import { upsertMetrics } from '../db/agent-store.js';

const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
upsertMetrics(sessionsDb, {
  agent_id: record.agent_id,
  agent_version: record.agent_version,
  period_start: today,
  input_tokens: record.input_tokens,
  output_tokens: record.output_tokens,
  tool_calls: 1, // Each tool use = 1 call
});
```

- [ ] **Step 6: Run full test suite and commit**

Run: `cd packages/standalone && pnpm test`
Expected: ALL PASS

```bash
git add packages/standalone/src/api/token-handler.ts packages/standalone/tests/api/token-handler-version.test.ts
git commit -m "feat(agents): per-version token tracking in agent_metrics"
```

---

## Task 11: Integration Wiring — DB Init + Options Plumbing

**Files:**

- Modify: `packages/standalone/src/cli/runtime/api-routes-init.ts` (or wherever the API server is initialized)

- [ ] **Step 1: Initialize agent tables at startup**

Find where `initTokenUsageTable(db)` is called at startup. Add `initAgentTables(db)` alongside it.

```typescript
import { initAgentTables } from '../../db/agent-store.js';
import { UICommandQueue } from '../../api/ui-command-handler.js';

// At startup, after sessions DB is opened:
initAgentTables(sessionsDb);

// Create singleton UI command queue:
const uiCommandQueue = new UICommandQueue();
```

- [ ] **Step 2: Pass sessionsDb and uiCommandQueue to GraphHandlerOptions**

Wherever `createGraphHandler(options)` is called, add the new options:

```typescript
const graphHandler = createGraphHandler({
  ...existingOptions,
  sessionsDb: sessionsDb,
  uiCommandQueue: uiCommandQueue,
});
```

- [ ] **Step 3: Seed initial agent versions from existing config**

At startup, after config is loaded, create version 1 entries for agents that don't have any versions yet:

```typescript
import { getLatestVersion, createAgentVersion } from '../../db/agent-store.js';

const agents = config.multi_agent?.agents ?? {};
for (const [id, cfg] of Object.entries(agents)) {
  if (!getLatestVersion(sessionsDb, id)) {
    const personaText = await loadPersonaFile(cfg.persona_file);
    createAgentVersion(sessionsDb, {
      agent_id: id,
      snapshot: { model: cfg.model, tier: cfg.tier, backend: cfg.backend },
      persona_text: personaText,
      change_note: 'Initial version (migrated from config.yaml)',
    });
  }
}
```

- [ ] **Step 4: Verify with manual test**

Run: `mama start && curl http://localhost:3847/api/agents`
Expected: JSON with agents list including version numbers

Run: `curl http://localhost:3847/api/agents/conductor`
Expected: Full agent detail with persona text and version

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/cli/runtime/api-routes-init.ts packages/standalone/src/db/agent-store.ts
git commit -m "feat(agents): integration wiring — DB init, options plumbing, version seeding"
```

---

## Task 12: End-to-End Verification

- [ ] **Step 1: Run full test suite**

```bash
cd /Users/jeongjaehun/project/MAMA && pnpm test
```

Expected: ALL PASS

- [ ] **Step 2: Build all packages**

```bash
pnpm build
```

Expected: No errors

- [ ] **Step 3: Manual E2E verification**

```bash
mama start
# Wait for startup
curl http://localhost:3847/api/agents                           # List agents
curl http://localhost:3847/api/agents/conductor                 # Get single
curl http://localhost:3847/api/agents/conductor/versions        # Version history
curl -X POST http://localhost:3847/api/agents/conductor \
  -H "Content-Type: application/json" \
  -d '{"version":1,"changes":{"tier":2},"change_note":"test"}'  # Update
open http://localhost:3847/viewer                                # Verify Agents tab
```

Check `~/.mama/daemon.log` for errors — never claim success without checking daemon.log.

- [ ] **Step 4: Verify gateway tools work**

Test that an agent can call `agent_get` and `viewer_navigate` by interacting through a gateway (Discord/Slack/viewer chat).

- [ ] **Step 5: Final commit with version bump**

```bash
git add -A
git commit -m "feat(v0.19): Epic 1 — Interactive Agent Management complete"
```
