# MAMA Command Center — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the MAMA dashboard from a raw data dump into a curated command center with connector activity feeds, pipeline view, and agent notices.

**Architecture:** Intelligence API gets 3 new endpoints (/summary, /pipeline, /notices). AgentEventBus gains an agent:action event type and notices ring buffer. A new Connector Feed API reads from per-connector raw.db files. Dashboard is rewritten as a 4-section command center. Projects tab is replaced with a Connector Feed tab.

**Tech Stack:** TypeScript, Express 5, SQLite (better-sqlite3), RawStore, ConnectorRegistry, AgentEventBus

**Spec:** `docs/superpowers/specs/2026-04-08-mama-command-center-design.md`

---

### Task 1: AgentEventBus — agent:action event + notices ring buffer

**Files:**

- Modify: `packages/standalone/src/multi-agent/agent-event-bus.ts`
- Create: `packages/standalone/tests/multi-agent/agent-event-bus-notices.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/standalone/tests/multi-agent/agent-event-bus-notices.test.ts
import { describe, it, expect } from 'vitest';
import { AgentEventBus } from '../../src/multi-agent/agent-event-bus.js';

describe('AgentEventBus notices', () => {
  it('stores agent:action events in notices buffer', () => {
    const bus = new AgentEventBus();
    bus.emit({
      type: 'agent:action',
      agent: 'wiki',
      action: 'edited',
      target: 'projects/ProjectAlpha.md',
    });
    const notices = bus.getRecentNotices(10);
    expect(notices).toHaveLength(1);
    expect(notices[0].agent).toBe('wiki');
    expect(notices[0].action).toBe('edited');
    expect(notices[0].target).toBe('projects/ProjectAlpha.md');
    expect(notices[0].timestamp).toBeGreaterThan(0);
    bus.destroy();
  });

  it('limits notices to 50 (ring buffer)', () => {
    const bus = new AgentEventBus();
    for (let i = 0; i < 60; i++) {
      bus.emit({ type: 'agent:action', agent: 'test', action: `action-${i}`, target: `t-${i}` });
    }
    const notices = bus.getRecentNotices(100);
    expect(notices).toHaveLength(50);
    // Most recent should be last emitted
    expect(notices[0].action).toBe('action-59');
    bus.destroy();
  });

  it('getRecentNotices respects limit param', () => {
    const bus = new AgentEventBus();
    for (let i = 0; i < 10; i++) {
      bus.emit({ type: 'agent:action', agent: 'test', action: `a-${i}`, target: `t-${i}` });
    }
    const notices = bus.getRecentNotices(3);
    expect(notices).toHaveLength(3);
    bus.destroy();
  });

  it('does not store non-action events in notices', () => {
    const bus = new AgentEventBus();
    bus.emit({ type: 'memory:saved', topic: 'test', project: 'p' });
    bus.emit({ type: 'dashboard:refresh' });
    expect(bus.getRecentNotices(10)).toHaveLength(0);
    bus.destroy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/standalone && npx vitest run tests/multi-agent/agent-event-bus-notices.test.ts`
Expected: FAIL — `agent:action` type not in union, `getRecentNotices` not a function

- [ ] **Step 3: Implement agent:action event + notices buffer**

In `packages/standalone/src/multi-agent/agent-event-bus.ts`, add `agent:action` to the AgentEvent union and add the notices buffer:

```typescript
export interface AgentNotice {
  agent: string;
  action: string;
  target: string;
  timestamp: number;
}

export type AgentEvent =
  | { type: 'memory:saved'; topic: string; project?: string }
  | { type: 'extraction:completed'; projects: string[] }
  | { type: 'wiki:compiled'; pages: string[] }
  | { type: 'dashboard:refresh' }
  | { type: 'agent:action'; agent: string; action: string; target: string };
```

Add to the `AgentEventBus` class:

```typescript
private notices: AgentNotice[] = [];
private static readonly MAX_NOTICES = 50;

// Inside emit(), after handler dispatch:
if (event.type === 'agent:action') {
  this.notices.unshift({
    agent: event.agent,
    action: event.action,
    target: event.target,
    timestamp: Date.now(),
  });
  if (this.notices.length > AgentEventBus.MAX_NOTICES) {
    this.notices.length = AgentEventBus.MAX_NOTICES;
  }
}

getRecentNotices(limit: number): AgentNotice[] {
  return this.notices.slice(0, Math.min(limit, this.notices.length));
}
```

In `destroy()`, add: `this.notices.length = 0;`

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/standalone && npx vitest run tests/multi-agent/agent-event-bus-notices.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run existing event bus tests**

Run: `cd packages/standalone && npx vitest run tests/multi-agent/agent-event-bus.test.ts`
Expected: PASS (all existing tests still pass)

- [ ] **Step 6: Commit**

```bash
git add packages/standalone/src/multi-agent/agent-event-bus.ts packages/standalone/tests/multi-agent/agent-event-bus-notices.test.ts
git commit -m "feat(event-bus): add agent:action event type + notices ring buffer"
```

---

### Task 2: Intelligence API — /summary, /pipeline, /notices endpoints

**Files:**

- Modify: `packages/standalone/src/api/intelligence-handler.ts`
- Create: `packages/standalone/tests/api/intelligence-pipeline.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/standalone/tests/api/intelligence-pipeline.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildPipelineFallback,
  buildConnectorActivity,
  type ProjectSummary,
  type ConnectorActivityItem,
} from '../../src/api/intelligence-handler.js';

describe('buildPipelineFallback', () => {
  it('returns projects sorted by lastActivity descending', () => {
    const projects: ProjectSummary[] = [
      { project: 'A', activeDecisions: 5, lastActivity: '2026-04-07T10:00:00Z' },
      { project: 'B', activeDecisions: 3, lastActivity: '2026-04-08T10:00:00Z' },
    ];
    const result = buildPipelineFallback(projects);
    expect(result[0].project).toBe('B');
    expect(result[1].project).toBe('A');
  });

  it('returns empty array when no projects', () => {
    expect(buildPipelineFallback([])).toEqual([]);
  });
});

describe('buildConnectorActivity', () => {
  it('picks latest item per connector', () => {
    const items: ConnectorActivityItem[] = [
      {
        connector: 'slack',
        summary: 'old msg',
        channel: '#general',
        timestamp: '2026-04-08T10:00:00Z',
      },
      {
        connector: 'slack',
        summary: 'new msg',
        channel: '#proj',
        timestamp: '2026-04-08T12:00:00Z',
      },
      {
        connector: 'calendar',
        summary: 'meeting',
        channel: 'personal',
        timestamp: '2026-04-08T11:00:00Z',
      },
    ];
    const result = buildConnectorActivity(items);
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.connector === 'slack')?.summary).toBe('new msg');
    expect(result.find((r) => r.connector === 'calendar')?.summary).toBe('meeting');
  });

  it('returns empty array for no items', () => {
    expect(buildConnectorActivity([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/standalone && npx vitest run tests/api/intelligence-pipeline.test.ts`
Expected: FAIL — functions not exported

- [ ] **Step 3: Add types and pure functions to intelligence-handler.ts**

At the bottom of the types section in `packages/standalone/src/api/intelligence-handler.ts`, add:

```typescript
export interface PipelineProject {
  project: string;
  activeDecisions: number;
  lastActivity: string;
  stages?: Record<string, number>; // Trello stages, undefined if no Trello
  isNew?: boolean;
}

export interface ConnectorActivityItem {
  connector: string;
  summary: string;
  channel: string;
  timestamp: string;
}

export function buildPipelineFallback(projects: ProjectSummary[]): PipelineProject[] {
  return [...projects]
    .sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime())
    .map((p) => ({
      project: p.project,
      activeDecisions: p.activeDecisions,
      lastActivity: p.lastActivity,
    }));
}

export function buildConnectorActivity(items: ConnectorActivityItem[]): ConnectorActivityItem[] {
  const latest = new Map<string, ConnectorActivityItem>();
  for (const item of items) {
    const existing = latest.get(item.connector);
    if (!existing || new Date(item.timestamp).getTime() > new Date(existing.timestamp).getTime()) {
      latest.set(item.connector, item);
    }
  }
  return Array.from(latest.values()).sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/standalone && npx vitest run tests/api/intelligence-pipeline.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Add /summary, /pipeline, /notices route handlers**

In `createIntelligenceRouter()` in `packages/standalone/src/api/intelligence-handler.ts`, add three routes. The router receives `db` but also needs `reportStore` and `eventBus`. Update the function signature:

```typescript
export function createIntelligenceRouter(
  db: SQLiteDatabase,
  deps?: {
    reportStore?: { get(slotId: string): { html: string; updatedAt: number } | undefined };
    eventBus?: { getRecentNotices(limit: number): Array<{ agent: string; action: string; target: string; timestamp: number }> };
  }
): Router {
```

Add these routes inside the function:

```typescript
// GET /api/intelligence/summary
// Returns the agent-generated summary from the report store's "summary" slot
router.get(
  '/summary',
  asyncHandler(async (_req, res) => {
    const slot = deps?.reportStore?.get('summary');
    if (!slot) {
      res.json({ text: '', urgentActions: [], generatedAt: null });
      return;
    }
    res.json({
      text: slot.html,
      generatedAt: new Date(slot.updatedAt).toISOString(),
    });
  })
);

// GET /api/intelligence/pipeline
// Returns project pipeline view — Trello data if available, fallback to project list
router.get(
  '/pipeline',
  asyncHandler(async (_req, res) => {
    const rows = db
      .prepare(
        `SELECT
             ms.external_id AS project,
             COUNT(d.id)    AS activeDecisions,
             MAX(d.updated_at) AS lastActivity
           FROM memory_scopes ms
           JOIN memory_scope_bindings msb ON msb.scope_id = ms.id
           JOIN decisions d ON d.id = msb.memory_id
           WHERE ms.kind = 'project'
             AND d.status = 'active'
           GROUP BY ms.external_id
           ORDER BY lastActivity DESC`
      )
      .all() as ProjectRow[];

    const projects: ProjectSummary[] = rows.map((r) => ({
      project: r.project,
      activeDecisions: r.activeDecisions,
      lastActivity: r.lastActivity,
    }));

    res.json({ projects: buildPipelineFallback(projects) });
  })
);

// GET /api/intelligence/notices?limit=10
// Returns recent agent activity notices from the event bus ring buffer
router.get(
  '/notices',
  asyncHandler(async (req, res) => {
    const rawLimit = parseInt((req.query.limit as string) || '10', 10);
    const limit = Math.min(isNaN(rawLimit) || rawLimit < 1 ? 10 : rawLimit, 50);
    const notices = deps?.eventBus?.getRecentNotices(limit) ?? [];
    res.json({ notices });
  })
);
```

- [ ] **Step 6: Run existing intelligence handler tests**

Run: `cd packages/standalone && npx vitest run tests/api/intelligence-handler.test.ts`
Expected: PASS (all existing tests — the new `deps` param is optional)

- [ ] **Step 7: Commit**

```bash
git add packages/standalone/src/api/intelligence-handler.ts packages/standalone/tests/api/intelligence-pipeline.test.ts
git commit -m "feat(intelligence): add /summary, /pipeline, /notices endpoints + pure functions"
```

---

### Task 3: Connector Feed API — /api/connectors/activity + /:name/feed

**Files:**

- Create: `packages/standalone/src/api/connector-feed-handler.ts`
- Create: `packages/standalone/tests/api/connector-feed-handler.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/standalone/tests/api/connector-feed-handler.test.ts
import { describe, it, expect } from 'vitest';
import { buildActivitySummaries, type RawFeedItem } from '../../src/api/connector-feed-handler.js';

describe('buildActivitySummaries', () => {
  it('picks latest item per connector and sorts by timestamp desc', () => {
    const items: RawFeedItem[] = [
      { connector: 'slack', channel: '#general', author: 'kim', content: 'old', timestamp: 1000 },
      { connector: 'slack', channel: '#proj', author: 'park', content: 'new msg', timestamp: 2000 },
      {
        connector: 'calendar',
        channel: 'personal',
        author: 'system',
        content: 'meeting at 14:00',
        timestamp: 1500,
      },
    ];
    const result = buildActivitySummaries(items);
    expect(result).toHaveLength(2);
    expect(result[0].connector).toBe('slack');
    expect(result[0].content).toBe('new msg');
    expect(result[1].connector).toBe('calendar');
  });

  it('returns empty for empty input', () => {
    expect(buildActivitySummaries([])).toEqual([]);
  });

  it('truncates content to 80 chars', () => {
    const items: RawFeedItem[] = [
      { connector: 'slack', channel: '#c', author: 'a', content: 'x'.repeat(200), timestamp: 1000 },
    ];
    const result = buildActivitySummaries(items);
    expect(result[0].content.length).toBeLessThanOrEqual(80);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/standalone && npx vitest run tests/api/connector-feed-handler.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create connector-feed-handler.ts**

```typescript
// packages/standalone/src/api/connector-feed-handler.ts
import { Router } from 'express';
import { asyncHandler } from './error-handler.js';
import type { RawStore } from '../connectors/framework/raw-store.js';

export interface RawFeedItem {
  connector: string;
  channel: string;
  author: string;
  content: string;
  timestamp: number;
  type?: string;
  metadata?: Record<string, unknown>;
}

export interface ActivitySummary {
  connector: string;
  channel: string;
  content: string;
  timestamp: string;
  status: 'active' | 'idle' | 'disconnected';
}

/**
 * Pure function: pick latest item per connector, sort by timestamp desc, truncate content.
 */
export function buildActivitySummaries(items: RawFeedItem[]): ActivitySummary[] {
  const latest = new Map<string, RawFeedItem>();
  for (const item of items) {
    const existing = latest.get(item.connector);
    if (!existing || item.timestamp > existing.timestamp) {
      latest.set(item.connector, item);
    }
  }
  return Array.from(latest.values())
    .sort((a, b) => b.timestamp - a.timestamp)
    .map((item) => ({
      connector: item.connector,
      channel: item.channel,
      content: item.content.length > 80 ? item.content.slice(0, 77) + '...' : item.content,
      timestamp: new Date(item.timestamp).toISOString(),
      status: 'active' as const,
    }));
}

/**
 * Create the connector feed router.
 * GET /activity — latest 1 item per enabled connector (dashboard Connector Activity section)
 * GET /:name/feed — raw items from a specific connector (Connector Feed tab)
 */
export function createConnectorFeedRouter(rawStore: RawStore, enabledConnectors: string[]): Router {
  const router = Router();

  // GET /api/connectors/activity
  router.get(
    '/activity',
    asyncHandler(async (_req, res) => {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const allItems: RawFeedItem[] = [];

      for (const name of enabledConnectors) {
        try {
          const items = rawStore.query(name, oneDayAgo);
          for (const item of items) {
            allItems.push({
              connector: name,
              channel: item.channel,
              author: item.author,
              content: item.content,
              timestamp: item.timestamp.getTime(),
              type: item.type,
              metadata: item.metadata,
            });
          }
        } catch {
          // Connector raw.db may not exist yet — skip
        }
      }

      const summaries = buildActivitySummaries(allItems);

      // Add disconnected connectors
      const activeNames = new Set(summaries.map((s) => s.connector));
      for (const name of enabledConnectors) {
        if (!activeNames.has(name)) {
          summaries.push({
            connector: name,
            channel: '',
            content: '',
            timestamp: '',
            status: 'idle',
          });
        }
      }

      res.json({ connectors: summaries });
    })
  );

  // GET /api/connectors/:name/feed?limit=20&since=<ISO>
  router.get(
    '/:name/feed',
    asyncHandler(async (req, res) => {
      const connectorName = req.params.name;
      if (!enabledConnectors.includes(connectorName)) {
        res.status(404).json({ error: `Connector '${connectorName}' not found or disabled` });
        return;
      }

      const rawLimit = parseInt((req.query.limit as string) || '20', 10);
      const limit = Math.min(isNaN(rawLimit) || rawLimit < 1 ? 20 : rawLimit, 200);
      const since = req.query.since
        ? new Date(req.query.since as string)
        : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      let items = rawStore.query(connectorName, since);
      // Sort descending and limit
      items = items.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()).slice(0, limit);

      // Group by channel
      const channels = new Map<string, typeof items>();
      for (const item of items) {
        const ch = channels.get(item.channel) ?? [];
        ch.push(item);
        channels.set(item.channel, ch);
      }

      const feed = Array.from(channels.entries()).map(([channel, channelItems]) => ({
        channel,
        items: channelItems.map((i) => ({
          author: i.author,
          content: i.content,
          timestamp: i.timestamp.toISOString(),
          type: i.type,
        })),
      }));

      res.json({ connector: connectorName, feed, itemCount: items.length });
    })
  );

  return router;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/standalone && npx vitest run tests/api/connector-feed-handler.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/api/connector-feed-handler.ts packages/standalone/tests/api/connector-feed-handler.test.ts
git commit -m "feat(connectors): add connector feed API — /activity + /:name/feed"
```

---

### Task 4: Wire backend in start.ts + API index

**Files:**

- Modify: `packages/standalone/src/api/index.ts`
- Modify: `packages/standalone/src/cli/commands/start.ts`

- [ ] **Step 1: Mount connector feed router in api/index.ts**

In `packages/standalone/src/api/index.ts`, add to imports:

```typescript
import { createConnectorFeedRouter } from './connector-feed-handler.js';
import type { RawStore } from '../connectors/framework/raw-store.js';
```

Add to `ApiServerOptions`:

```typescript
  /** RawStore for connector feed queries */
  rawStore?: RawStore;
  /** List of enabled connector names */
  enabledConnectors?: string[];
  /** AgentEventBus for notices */
  eventBus?: { getRecentNotices(limit: number): Array<{ agent: string; action: string; target: string; timestamp: number }> };
  /** ReportStore for summary slot */
  reportStoreRef?: { get(slotId: string): { html: string; updatedAt: number } | undefined };
```

In `createApiServer()`, after the intelligence router mount, add:

```typescript
// Pass reportStore + eventBus to intelligence router
if (db) {
  const intelligenceDb = memoryDb ?? db;
  const intelligenceRouter = createIntelligenceRouter(intelligenceDb, {
    reportStore: reportStoreRef ?? reportStore,
    eventBus,
  });
  app.use('/api/intelligence', intelligenceRouter);
}

// Connector feed router
if (rawStore && enabledConnectors && enabledConnectors.length > 0) {
  const connectorFeedRouter = createConnectorFeedRouter(rawStore, enabledConnectors);
  app.use('/api/connectors', connectorFeedRouter);
}
```

- [ ] **Step 2: Pass rawStore + eventBus from start.ts**

In `packages/standalone/src/cli/commands/start.ts`, where `createApiServer()` is called, pass the new options:

```typescript
const apiServer = createApiServer({
  // ...existing options...
  rawStore,
  enabledConnectors: Array.from(connectorRegistry.getActive().keys()),
  eventBus: agentEventBus,
  reportStoreRef: undefined, // reportStore is created inside createApiServer, will use that
});
```

Also, after wiki agent events, emit `agent:action` notices:

```typescript
// After wiki_publish callback in start.ts
agentEventBus.on('wiki:compiled', (event) => {
  if (event.type === 'wiki:compiled') {
    for (const page of event.pages) {
      agentEventBus.emit({
        type: 'agent:action',
        agent: 'Wiki Agent',
        action: 'compiled',
        target: page,
      });
    }
  }
});
```

- [ ] **Step 3: Run full test suite**

Run: `cd packages/standalone && pnpm test`
Expected: All existing 2453+ tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/standalone/src/api/index.ts packages/standalone/src/cli/commands/start.ts
git commit -m "feat: wire intelligence deps + connector feed router in API server"
```

---

### Task 5: Wiki Agent debugging — add tool_call examples to persona

**Files:**

- Modify: `packages/standalone/src/multi-agent/wiki-agent-persona.ts`

- [ ] **Step 1: Add concrete tool_call JSON examples to WIKI_AGENT_PERSONA**

In `packages/standalone/src/multi-agent/wiki-agent-persona.ts`, append to the `WIKI_AGENT_PERSONA` string before the closing backtick:

```typescript
// Add before the final closing backtick of WIKI_AGENT_PERSONA:

## MANDATORY Workflow (follow exactly)

You MUST call tools in this exact sequence. No exceptions.

### Step 1: Search for project decisions
\`\`\`tool_call
{"name": "mama_search", "input": {"query": "project decisions overview", "limit": 10}}
\`\`\`

### Step 2: Search for specific details (optional, max 2 more searches)
\`\`\`tool_call
{"name": "mama_search", "input": {"query": "ProjectAlpha project feedback timeline"}}
\`\`\`

### Step 3: PUBLISH (REQUIRED — you MUST call this)
\`\`\`tool_call
{"name": "wiki_publish", "input": {"pages": [{"path": "projects/ProjectAlpha.md", "title": "ProjectAlpha Project", "type": "entity", "content": "---\\ntitle: ProjectAlpha Project\\ntype: entity\\nconfidence: high\\ncompiled_at: 2026-04-08\\n---\\n\\n## Summary\\n\\nProjectAlpha is a...\\n\\n## Timeline\\n\\n- 2026-04-08: Latest feedback received\\n- 2026-04-05: Initial delivery\\n\\n## Key Decisions\\n\\n- Authentication: JWT adopted (confidence: 85%)\\n", "confidence": "high"}]}}
\`\`\`

CRITICAL: If you do NOT call wiki_publish, your entire run is wasted. Always call it exactly once.
```

- [ ] **Step 2: Run existing wiki agent persona tests**

Run: `cd packages/standalone && npx vitest run tests/multi-agent/ -t "wiki"` (or whatever pattern matches)
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/standalone/src/multi-agent/wiki-agent-persona.ts
git commit -m "fix(wiki-agent): add concrete tool_call examples to prevent wiki_publish omission"
```

---

### Task 6: Frontend API client — new types + methods

**Files:**

- Modify: `packages/standalone/public/viewer/src/utils/api.ts`

- [ ] **Step 1: Add types for new API responses**

In `packages/standalone/public/viewer/src/utils/api.ts`, after the `ProjectDecisionsResponse` interface, add:

```typescript
export interface IntelligenceSummaryResponse {
  text: string;
  generatedAt: string | null;
}

export interface PipelineProject {
  project: string;
  activeDecisions: number;
  lastActivity: string;
  stages?: Record<string, number>;
  isNew?: boolean;
}

export interface PipelineResponse {
  projects: PipelineProject[];
}

export interface AgentNotice {
  agent: string;
  action: string;
  target: string;
  timestamp: number;
}

export interface NoticesResponse {
  notices: AgentNotice[];
}

export interface ConnectorActivitySummary {
  connector: string;
  channel: string;
  content: string;
  timestamp: string;
  status: 'active' | 'idle' | 'disconnected';
}

export interface ConnectorActivityResponse {
  connectors: ConnectorActivitySummary[];
}

export interface ConnectorFeedChannel {
  channel: string;
  items: Array<{
    author: string;
    content: string;
    timestamp: string;
    type: string;
  }>;
}

export interface ConnectorFeedResponse {
  connector: string;
  feed: ConnectorFeedChannel[];
  itemCount: number;
}
```

- [ ] **Step 2: Add API methods**

In the `API` class, add these static methods:

```typescript
  // Intelligence API — new endpoints
  static async getIntelligenceSummary(): Promise<IntelligenceSummaryResponse> {
    return this.get<IntelligenceSummaryResponse>('/api/intelligence/summary');
  }

  static async getPipeline(): Promise<PipelineResponse> {
    return this.get<PipelineResponse>('/api/intelligence/pipeline');
  }

  static async getNotices(limit = 10): Promise<NoticesResponse> {
    return this.get<NoticesResponse>('/api/intelligence/notices', { limit });
  }

  // Connector Feed API
  static async getConnectorActivity(): Promise<ConnectorActivityResponse> {
    return this.get<ConnectorActivityResponse>('/api/connectors/activity');
  }

  static async getConnectorFeed(
    connectorName: string,
    limit = 20
  ): Promise<ConnectorFeedResponse> {
    return this.get<ConnectorFeedResponse>(
      `/api/connectors/${encodeURIComponent(connectorName)}/feed`,
      { limit }
    );
  }
```

- [ ] **Step 3: Commit**

```bash
git add packages/standalone/public/viewer/src/utils/api.ts
git commit -m "feat(viewer): add API client types + methods for intelligence + connector feed"
```

---

### Task 7: Dashboard command center rewrite

**Files:**

- Modify: `packages/standalone/public/viewer/src/modules/dashboard.ts`

- [ ] **Step 1: Rewrite dashboard.ts**

Replace the entire content of `packages/standalone/public/viewer/src/modules/dashboard.ts` with the command center implementation. The module fetches from 4 API groups and renders 4 sections: Summary+Notify, Pipeline, Connector Activity, System.

Key changes from the current implementation:

- Remove `detectEventType`, `eventTypeLabel`, `eventTypeColor` helpers (no longer needed)
- Keep `esc`, `relativeTime`, `severityColor`, `topicLabel` helpers
- Replace `render()` with 4 focused render methods
- `loadDashboard()` calls: `getIntelligenceSummary()`, `getNotices()`, `getPipeline()`, `getConnectorActivity()`, `getProjects()`, `getReportSlots()`
- SSE connection kept for real-time summary updates

The 4 sections:

1. **Summary + Notify**: agent summary text + notices list (newest first)
2. **Pipeline**: project rows with decision counts, sorted by lastActivity desc, NEW badge for < 1hr
3. **Connector Activity**: one line per connector showing latest item, idle/disconnected for others
4. **System**: compact stats bar — agents, wiki pages, memory decisions

- [ ] **Step 2: Build and verify**

Run: `cd packages/standalone && pnpm build`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add packages/standalone/public/viewer/src/modules/dashboard.ts
git commit -m "feat(dashboard): command center rewrite — Summary+Pipeline+ConnectorActivity+System"
```

---

### Task 8: Connector Feed tab (replace Projects tab)

**Files:**

- Create: `packages/standalone/public/viewer/src/modules/connector-feed.ts`
- Modify: `packages/standalone/public/viewer/viewer.html`
- Delete: `packages/standalone/public/viewer/src/modules/projects.ts`

- [ ] **Step 1: Create connector-feed.ts**

Create `packages/standalone/public/viewer/src/modules/connector-feed.ts` with a `ConnectorFeedModule` class that:

- `init()`: loads connector list from `API.getConnectorActivity()`, renders left sidebar with connector names
- Click handler: `selectConnector(name)` calls `API.getConnectorFeed(name)` and renders channel-grouped items on right
- Layout: split-pane like the old projects.ts (left = connector list 280px, right = feed detail)
- Uses the same COLOR/esc/relativeTime patterns from existing modules

- [ ] **Step 2: Update viewer.html**

In `packages/standalone/public/viewer/viewer.html`:

Replace all `data-tab="projects"` with `data-tab="feed"`.
Replace "Projects" label with "Feed" in both desktop nav and mobile nav.
Replace `id="projects-content"` with `id="feed-content"`.

In the script section at bottom, replace:

```javascript
import { ProjectsModule } from '/viewer/js/modules/projects.js';
const projects = new ProjectsModule();
```

with:

```javascript
import { ConnectorFeedModule } from '/viewer/js/modules/connector-feed.js';
const connectorFeed = new ConnectorFeedModule();
```

Update the `switchTab` function to initialize `connectorFeed.init()` when tab is `'feed'` (instead of `projects.init()` for `'projects'`).

- [ ] **Step 3: Delete projects.ts**

```bash
rm packages/standalone/public/viewer/src/modules/projects.ts
```

- [ ] **Step 4: Build and verify**

Run: `cd packages/standalone && pnpm build`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/public/viewer/src/modules/connector-feed.ts packages/standalone/public/viewer/viewer.html
git rm packages/standalone/public/viewer/src/modules/projects.ts
git commit -m "feat(viewer): replace Projects tab with Connector Feed tab"
```

---

### Task 9: Full test suite + build verification

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: 2453+ tests pass, 0 failures

- [ ] **Step 2: Run build**

Run: `pnpm build`
Expected: 0 errors

- [ ] **Step 3: Manual smoke test**

```bash
mama start
# Wait for startup
curl -s http://localhost:3847/api/intelligence/summary | jq .
curl -s http://localhost:3847/api/intelligence/pipeline | jq .
curl -s http://localhost:3847/api/intelligence/notices | jq .
curl -s http://localhost:3847/api/connectors/activity | jq .
# Open viewer in browser — verify 4-section dashboard + Feed tab
```

- [ ] **Step 4: Commit any fixes if needed**
