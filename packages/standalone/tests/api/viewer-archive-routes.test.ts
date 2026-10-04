import { request as httpRequest, type IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type {
  ActionCall,
  ActionContext,
  ActionDispatcher,
  ActionResult,
  WorkGraphPage,
} from '@jungjaehoon/mama-core';
import type { JudgmentAccess } from '@jungjaehoon/mama-core/knowledge';
import {
  createViewerServer,
  type ViewerServer,
  type ViewerServerOptions,
} from '../../src/api/viewer-server.js';
import { readViewerMemoryStats } from '../../src/api/viewer-data.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';

const ownerAccess: JudgmentAccess = {
  principalId: 'owner',
  agentId: 'owner-agent',
  scopes: [{ kind: 'global', id: 'system' }],
  connectors: ['connector'],
  actions: [
    'graph.query',
    'memory.search',
    'memory.checkpoint.list',
    'work.list',
    'work.show',
    'source.read',
    'memory.read:provenance',
  ],
};

function completed(data: unknown): ActionResult {
  return { status: 'completed', data };
}

function graphPage(overrides: Partial<WorkGraphPage> = {}): WorkGraphPage {
  return {
    nodes: [],
    edges: [],
    coverage: { returned: 0, total: null, complete: true, reasons: [] },
    snapshot: { judgmentWatermark: 1, identityRevision: 1, asOf: 2 },
    nextCursor: null,
    ...overrides,
  };
}

function workPage() {
  return {
    view: 'items',
    tasks: [
      {
        id: 7,
        commitmentId: 'commitment-1',
        revision: 2,
        title: 'work title',
        status: 'in_progress',
        priority: 'high',
        assignee: 'worker',
        deadline: '2026-09-30',
        due_at: '2026-09-30T00:00:00.000Z',
        deadline_offset_minutes: 540,
        latest_event: 'review requested',
        sourceChannel: 'connector',
        auto_created: true,
        confirmed: false,
        temporal_state: 'exact_upcoming',
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    total: 1,
    returned: 1,
    nextCursor: null,
    observedAt: new Date(2).toISOString(),
    readVersion: 'read-version',
  };
}

function makeRequest(
  server: ViewerServer,
  path: string,
  method = 'GET'
): Promise<{ status: number; body: string; headers: IncomingMessage['headers'] }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.port, path, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers,
        })
      );
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(
  implementation: (call: ActionCall, context: ActionContext) => Promise<ActionResult>,
  callback: (server: ViewerServer, calls: ActionCall[]) => Promise<void>,
  options: Partial<ViewerServerOptions> = {}
): Promise<void> {
  const calls: ActionCall[] = [];
  const dispatch = vi.fn(async (call: ActionCall, context: ActionContext) => {
    calls.push(call);
    expect(context.access).toBe(ownerAccess);
    return implementation(call, context);
  }) as unknown as ActionDispatcher;
  const server = createViewerServer({
    timeZone: createTimeZoneSetting('UTC'),
    dispatch,
    ownerAccess,
    port: 0,
    getConnectorStatus: async () => [
      {
        name: 'connector',
        enabled: true,
        healthy: true,
        lastPoll: '2026-09-25T00:00:00.000Z',
        channelCount: 1,
      },
    ],
    getRuntimeStatus: () => ({
      running: true,
      version: 'test',
      backend: 'codex',
      model: 'fixture-model',
      startedAt: 1,
      health: null,
      connectors: [{ name: 'connector', enabled: true, state: 'connected' }],
    }),
    ...options,
  });
  await server.start();
  try {
    await callback(server, calls);
  } finally {
    await server.stop();
  }
}

describe('archive-compatible viewer routes', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('serves live memory counts from the supplied daemon database and fails explicitly if unwired', async () => {
    const db = new Database(':memory:');
    const now = Date.now();
    db.exec('CREATE TABLE decisions (created_at INTEGER)');
    db.prepare('INSERT INTO decisions VALUES (?), (?)').run(now - 8 * 86400000, now);
    try {
      await withServer(
        async () => {
          throw new Error('dashboard must read the database, not graph pages');
        },
        async (server) => {
          const response = await makeRequest(server, '/api/dashboard/status');
          expect(response.status).toBe(200);
          expect(JSON.parse(response.body)).toEqual({ memory: { total: 2, thisWeek: 1 } });
          db.prepare('INSERT INTO decisions VALUES (?)').run(now);
          expect(JSON.parse((await makeRequest(server, '/api/dashboard/status')).body)).toEqual({
            memory: { total: 3, thisWeek: 2 },
          });
        },
        { getMemoryStats: () => readViewerMemoryStats(db, now) }
      );
      await withServer(
        async () => completed({}),
        async (server) => {
          expect((await makeRequest(server, '/api/dashboard/status')).status).toBe(503);
        }
      );
    } finally {
      db.close();
    }
  });

  it('redirects the root and serves the carried operator shell', async () => {
    await withServer(
      async () => {
        throw new Error('static routes must not dispatch actions');
      },
      async (server, calls) => {
        const root = await makeRequest(server, '/');
        expect(root.status).toBe(302);
        expect(root.headers.location).toBe('/viewer');

        const viewer = await makeRequest(server, '/viewer');
        expect(viewer.status).toBe(200);
        expect(viewer.headers['content-type']).toContain('text/html');
        expect(viewer.body).toContain('operator-mount');
        expect(viewer.body).toContain('/viewer/operator/operator.js');
        expect(viewer.body).not.toContain('operator/triggers');
        for (const asset of [
          '/viewer/manifest.json',
          '/viewer/sw.js',
          '/viewer/icons/icon-192.png',
          '/viewer/operator/operator.js',
          '/viewer/operator/operator.css',
          '/favicon.ico',
        ]) {
          expect((await makeRequest(server, asset)).status, asset).toBe(200);
        }
        expect(calls).toHaveLength(0);
      }
    );
  });

  it('maps graph.query browse data to the archive graph response shape', async () => {
    await withServer(
      async (call) => {
        expect(call.action).toBe('graph.query');
        expect(call.input).toMatchObject({ view: 'browse', history: 'all', limit: 2 });
        return completed(
          graphPage({
            nodes: [
              {
                ref: { kind: 'memory', id: 'memory-1' },
                resolvedRef: { kind: 'memory', id: 'memory-1' },
                label: 'record',
                data: {
                  kind: 'memory',
                  recordKind: 'commitment',
                  topic: 'topic',
                  summary: 'summary',
                  recordedAt: 1,
                  appliesFrom: 1,
                  appliesUntil: null,
                  stateAtSnapshot: 'current',
                  replaces: [],
                  payload: { reasoning: 'reasoning' },
                  work: null,
                  content: { complete: true, nextRead: null },
                },
              },
            ],
            edges: [],
          })
        );
      },
      async (server) => {
        const response = await makeRequest(server, '/graph?limit=2');
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body)).toMatchObject({
          nodes: [
            {
              id: 'memory:memory-1',
              kind: 'commitment',
              topic: 'topic',
              decision: 'summary',
              reasoning: 'reasoning',
            },
          ],
          edges: [],
          similarityEdges: [],
          meta: { source: 'graph.query:browse' },
        });
      }
    );
  });

  it('shows the source text of an observation and the cited evidence of a memory in graph detail', async () => {
    const memoryNode = {
      ref: { kind: 'memory' as const, id: 'memory-1' },
      resolvedRef: { kind: 'memory' as const, id: 'memory-1' },
      label: 'record',
      data: {
        kind: 'memory' as const,
        recordKind: 'judgment',
        topic: 'work/item',
        summary: 'revision summary',
        recordedAt: 1,
        appliesFrom: 1,
        appliesUntil: null,
        stateAtSnapshot: 'current',
        replaces: [],
        payload: { reasoning: 'why it changed' },
        work: null,
        content: { complete: true, nextRead: null },
      },
    };
    const observationNode = {
      ref: { kind: 'observation' as const, id: 'obs-1' },
      resolvedRef: { kind: 'observation' as const, id: 'obs-1' },
      label: 'connector:source-1',
      data: {
        kind: 'observation' as const,
        connector: 'connector',
        sourceId: 'source-1',
        sourceAt: 1_000,
        observedAt: 2_000,
        contentHash: null,
      },
    };
    await withServer(
      async (call) => {
        if (call.action === 'graph.query') {
          const seed = (call.input as { seeds: Array<{ id: string }> }).seeds[0]!.id;
          return completed(
            graphPage({ nodes: [seed === 'obs-1' ? observationNode : memoryNode] } as never)
          );
        }
        if (call.action === 'source.read') {
          expect(call.input).toMatchObject({ source: 'connector', observationRef: 'obs-1' });
          return completed({
            channel: 'room',
            author: 'sender',
            sourceAt: 1_000,
            content: 'the message text',
          });
        }
        if (call.action === 'memory.read:provenance') {
          expect(call.input).toMatchObject({ memory_id: 'memory-1' });
          return completed({
            events: [{ channel: 'room', observedAt: 'then', excerpt: 'cited text' }],
          });
        }
        throw new Error(`unexpected ${call.action}`);
      },
      async (server) => {
        const observation = JSON.parse(
          (await makeRequest(server, '/graph/detail?id=observation:obs-1')).body
        );
        expect(observation.node.decision).toContain('the message text');
        expect(observation.node.decision).toContain('sender');
        const memory = JSON.parse(
          (await makeRequest(server, '/graph/detail?id=memory:memory-1')).body
        );
        expect(memory.node.reasoning).toContain('why it changed');
        expect(memory.node.reasoning).toContain('cited text');
      }
    );
  });

  it('maps work.list to the archive operator task response shape', async () => {
    await withServer(
      async (call) => {
        expect(call.action).toBe('work.list');
        expect(call.input).toEqual({ view: 'items', limit: 50 });
        return completed(workPage());
      },
      async (server) => {
        const response = await makeRequest(server, '/api/operator/tasks');
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body)).toMatchObject({
          tasks: [
            {
              id: 7,
              commitment_id: 'commitment-1',
              title: 'work title',
              status: 'in_progress',
              priority: 'high',
              assignee: 'worker',
              due_date: '2026-09-30',
              due_at: '2026-09-30T00:00:00.000Z',
              source_channel: 'connector',
              latest_event: 'review requested',
              auto_created: true,
              confirmed: false,
              revision: 2,
            },
          ],
        });
      }
    );
  });

  it('uses the catalog dispatcher for memory search and reports unbound record stores', async () => {
    await withServer(
      async (call) => {
        if (call.action === 'memory.search') {
          expect(call.input).toEqual({ query: 'feedback', limit: 10 });
          return completed({ success: true, count: 1, results: [{ id: 'memory-1' }] });
        }
        throw new Error(`unexpected action ${call.action}`);
      },
      async (server, calls) => {
        const search = await makeRequest(server, '/api/mama/search?q=feedback&limit=10');
        expect(search.status).toBe(200);
        expect(JSON.parse(search.body)).toEqual({ count: 1, results: [{ id: 'memory-1' }] });

        const report = await makeRequest(server, '/api/report');
        expect(report.status).toBe(503);
        expect(JSON.parse(report.body)).toEqual({
          error: true,
          code: 'NOT_AVAILABLE',
          message: 'Report store is not wired',
        });

        const wiki = await makeRequest(server, '/api/wiki/tree');
        expect(wiki.status).toBe(503);
        expect(JSON.parse(wiki.body)).toEqual({
          error: true,
          code: 'NOT_AVAILABLE',
          message: 'Wiki root is not configured',
        });
        expect(calls.map((call) => call.action)).toEqual(['memory.search']);
      }
    );
  });

  it('serves runtime and connector state through read-only routes', async () => {
    await withServer(
      async () => completed({}),
      async (server) => {
        const runtime = await makeRequest(server, '/api/runtime/status');
        expect(runtime.status).toBe(200);
        expect(JSON.parse(runtime.body)).toMatchObject({ running: true, backend: 'codex' });

        const connectors = await makeRequest(server, '/api/connectors/status');
        expect(connectors.status).toBe(200);
        expect(JSON.parse(connectors.body)).toEqual({
          connectors: [
            {
              name: 'connector',
              enabled: true,
              healthy: true,
              lastPoll: '2026-09-25T00:00:00.000Z',
              channelCount: 1,
            },
          ],
        });
      }
    );
  });

  // The memory view is a history of what was saved: day first, then kind, then the item a work
  // revision belongs to.
  it('groups what was written by day, kind and item, across pages', async () => {
    const at = (iso: string) => Date.parse(iso);
    const row = (
      id: string,
      kind: string,
      createdAt: string,
      extra: Record<string, unknown> = {}
    ) => ({
      id,
      kind,
      recordKind: 'judgment',
      status: 'active',
      topic: `topic ${id}`,
      summary: `summary ${id}`,
      createdAt: at(createdAt),
      eventDatetime: null,
      sourceMessageRef: null,
      commitmentId: null,
      revision: null,
      operation: null,
      itemTitle: null,
      ...extra,
    });
    const revision = (id: string, commitmentId: string, n: number, createdAt: string) =>
      row(id, 'decision', createdAt, {
        recordKind: 'commitment',
        commitmentId,
        revision: n,
        operation: n === 1 ? 'create' : 'revise',
        itemTitle: `Item ${commitmentId}`,
        topic: `work/${commitmentId}`,
      });
    const pages: Record<string, unknown> = {
      first: {
        records: [
          row('rule', 'workflow', '2026-10-04T01:00:00Z', { sourceMessageRef: 'telegram:7:4558' }),
          revision('c1_r4', 'c1', 4, '2026-10-04T00:50:00Z'),
          row('lesson', 'lesson', '2026-10-04T00:30:00Z', { sourceMessageRef: 'source_delta:ab' }),
        ],
        nextCursor: 'p2',
      },
      p2: {
        records: [
          revision('c1_r3', 'c1', 3, '2026-10-04T00:10:00Z'),
          row('fact', 'fact', '2026-10-03T10:00:00Z'),
          revision('c2_r1', 'c2', 1, '2026-10-03T09:00:00Z'),
        ],
        nextCursor: null,
      },
    };
    await withServer(
      async (call) => {
        expect(call.action).toBe('memory.read:timeline');
        const input = call.input as { cursor?: string };
        return { status: 'completed', data: pages[input.cursor ?? 'first'] } as ActionResult;
      },
      async (server, calls) => {
        const response = await makeRequest(
          server,
          '/api/memory/timeline?from=2026-10-03&to=2026-10-04'
        );
        expect(response.status).toBe(200);
        expect(calls.map((call) => call.input)).toEqual([
          { since: at('2026-10-03T00:00:00Z'), until: at('2026-10-05T00:00:00Z'), limit: 500 },
          {
            since: at('2026-10-03T00:00:00Z'),
            until: at('2026-10-05T00:00:00Z'),
            limit: 500,
            cursor: 'p2',
          },
        ]);
        const body = JSON.parse(response.body);
        expect(body).toMatchObject({
          from: '2026-10-03',
          to: '2026-10-04',
          total: 6,
          counts: { owner_rule: 1, learned: 1, fact: 1, decision: 0, work: 3 },
        });
        expect(body.days.map((day: { day: string }) => day.day)).toEqual([
          '2026-10-04',
          '2026-10-03',
        ]);
        const [today, yesterday] = body.days;
        expect(today.groups.map((group: { group: string }) => group.group)).toEqual([
          'owner_rule',
          'learned',
          'work',
        ]);
        expect(today.groups[0].records[0]).toMatchObject({ id: 'memory:rule', via: 'owner_chat' });
        expect(today.groups[1].records[0]).toMatchObject({
          id: 'memory:lesson',
          via: 'source_delta',
        });
        expect(today.groups[2].items).toEqual([
          expect.objectContaining({
            commitmentId: 'c1',
            title: 'Item c1',
            revisions: [
              expect.objectContaining({ id: 'memory:c1_r4', revision: 4 }),
              expect.objectContaining({ id: 'memory:c1_r3', revision: 3 }),
            ],
          }),
        ]);
        expect(yesterday.groups.map((group: { group: string }) => group.group)).toEqual([
          'fact',
          'work',
        ]);
        expect(yesterday.groups[0].records[0]).toMatchObject({ id: 'memory:fact', via: null });
        expect(yesterday.groups[1].items[0]).toMatchObject({
          commitmentId: 'c2',
          revisions: [expect.objectContaining({ operation: 'create' })],
        });

        const searched = JSON.parse(
          (await makeRequest(server, '/api/memory/timeline?from=2026-10-03&to=2026-10-04&q=RULE'))
            .body
        );
        expect(searched.total).toBe(1);
        expect(searched.days[0].groups[0].records[0].id).toBe('memory:rule');

        // Kind chips keep their counts while one kind is shown.
        const workOnly = JSON.parse(
          (
            await makeRequest(
              server,
              '/api/memory/timeline?from=2026-10-03&to=2026-10-04&groups=work'
            )
          ).body
        );
        expect(workOnly.total).toBe(3);
        expect(workOnly.counts).toMatchObject({ owner_rule: 1, learned: 1, fact: 1, work: 3 });
        expect(
          workOnly.days.map((day: { groups: Array<{ group: string }> }) =>
            day.groups.map((group) => group.group)
          )
        ).toEqual([['work'], ['work']]);
      }
    );
  });

  it('draws one record with what it links to, one step out', async () => {
    const memory = (id: string, recordKind: string) => ({
      ref: { kind: 'memory', id },
      resolvedRef: { kind: 'memory', id },
      label: id,
      data: {
        kind: 'memory',
        recordKind,
        memoryKind: 'lesson',
        topic: `topic ${id}`,
        summary: `summary ${id}`,
        recordedAt: 1,
        appliesFrom: 1,
        appliesUntil: null,
        stateAtSnapshot: 'current',
        replaces: [],
        payload: {},
        work: null,
        content: { complete: true, nextRead: null },
      },
    });
    await withServer(
      async (call) => {
        expect(call).toMatchObject({
          action: 'graph.query',
          input: {
            view: 'neighbors',
            seeds: [{ kind: 'memory', id: 'm1' }],
            maxDepth: 1,
            history: 'all',
          },
        });
        return completed(
          graphPage({
            nodes: [memory('m1', 'judgment'), memory('m0', 'judgment')] as never,
            edges: [
              {
                id: 'e1',
                from: { kind: 'memory', id: 'm1' },
                to: { kind: 'memory', id: 'm0' },
                resolvedFrom: { kind: 'memory', id: 'm1' },
                resolvedTo: { kind: 'memory', id: 'm0' },
                relation: 'supersedes',
                attrs: {},
              },
            ] as never,
          })
        );
      },
      async (server) => {
        const response = await makeRequest(server, '/api/graph/neighbors?id=memory:m1');
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body)).toMatchObject({
          nodes: [{ id: 'memory:m1' }, { id: 'memory:m0' }],
          edges: [{ from: 'memory:m1', to: 'memory:m0', relationship: 'supersedes' }],
        });
        expect((await makeRequest(server, '/api/graph/neighbors?id=m1')).status).toBe(400);
      }
    );
  });

  it('reads a named period in the owner time zone and refuses a malformed window', async () => {
    await withServer(
      async () =>
        ({ status: 'completed', data: { records: [], nextCursor: null } }) as ActionResult,
      async (server, calls) => {
        const today = new Date().toISOString().slice(0, 10);
        const week = JSON.parse((await makeRequest(server, '/api/memory/timeline?period=7d')).body);
        expect(week.to).toBe(today);
        expect(Date.parse(`${week.to}T00:00:00Z`) - Date.parse(`${week.from}T00:00:00Z`)).toBe(
          6 * 86_400_000
        );
        expect(calls[0]?.input).toMatchObject({
          since: Date.parse(`${week.from}T00:00:00Z`),
          until: Date.parse(`${week.to}T00:00:00Z`) + 86_400_000,
        });

        for (const query of [
          'from=2026-10-04&to=2026-10-03',
          'from=10/03',
          'period=year',
          // Every filter change re-reads the whole window, so a window is at most a month.
          'from=2026-09-03&to=2026-10-04',
        ]) {
          const refused = await makeRequest(server, `/api/memory/timeline?${query}`);
          expect(refused.status).toBe(400);
        }
        const month = await makeRequest(
          server,
          '/api/memory/timeline?from=2026-09-04&to=2026-10-04'
        );
        expect(month.status).toBe(200);
      }
    );
  });

  it('does not serve mutating graph routes', async () => {
    await withServer(
      async () => {
        throw new Error('mutating routes must not dispatch actions');
      },
      async (server) => {
        const response = await makeRequest(server, '/graph/update', 'POST');
        expect(response.status).toBe(405);
        expect(JSON.parse(response.body)).toMatchObject({
          code: 'METHOD_NOT_ALLOWED',
          message: 'read-only viewer: GET is required',
        });
      }
    );
  });
});
