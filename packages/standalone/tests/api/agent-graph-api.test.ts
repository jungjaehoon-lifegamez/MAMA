import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

import { createNode } from '../../../mama-core/src/registry/store.js';
import { getAdapter } from '../../../mama-core/src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../../mama-core/src/test-utils.js';
import { upsertConnectorEventIndex } from '../../../mama-core/src/connectors/event-index.js';

import Database from '../../src/sqlite.js';
import { createApiServer } from '../../src/api/index.js';
import {
  createAgentGraphRouter,
  type AgentGraphRouterOptions,
} from '../../src/api/agent-graph-handler.js';
import { requireAuth } from '../../src/api/auth-middleware.js';
import { applyEnvelopeTablesMigration } from '../../src/db/migrations/envelope-tables.js';
import { EnvelopeAuthority } from '../../src/envelope/authority.js';
import { EnvelopeStore } from '../../src/envelope/store.js';
import { signEnvelope } from '../../src/envelope/signature.js';
import type { Envelope } from '../../src/envelope/types.js';
import { CronScheduler } from '../../src/scheduler/index.js';

vi.mock('@jungjaehoon/mama-core/debug-logger', () => ({
  DebugLogger: class {
    warn(): void {}
    debug(): void {}
    info(): void {}
    error(): void {}
  },
}));

const TUNNEL_HEADERS = {
  'cf-connecting-ip': '198.51.100.7',
  'x-forwarded-for': '198.51.100.7',
};

const SIGNING_KEY = {
  key_id: 'test',
  key_version: 1,
  key: Buffer.from('agent-graph-api-test-key-32!!!'),
};

function makeEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return signEnvelope(
    {
      agent_id: 'worker-m6',
      instance_id: `inst_${Math.random().toString(36).slice(2)}`,
      source: 'slack',
      channel_id: 'slack:C1',
      trigger_context: {},
      scope: {
        principal_id: 'principal-m6',
        project_refs: [{ kind: 'project', id: 'alpha' }],
        raw_connectors: ['slack'],
        memory_scopes: [{ kind: 'project', id: 'alpha' }],
        allowed_destinations: [{ kind: 'slack', id: 'slack:C1' }],
      },
      tier: 1,
      budget: { wall_seconds: 60 },
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      envelope_hash: '',
      ...overrides,
    },
    SIGNING_KEY
  );
}

type ScopeKind = 'project' | 'user' | 'channel' | 'global';

function insertScopedMemory(id: string, kind: ScopeKind, externalId: string): void {
  const adapter = getAdapter();
  const scopeId = `scope_${kind}_${externalId}`;
  adapter
    .prepare(
      `
        INSERT INTO decisions (id, topic, decision, reasoning, confidence, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(id, `topic-${id}`, `decision-${id}`, `reasoning-${id}`, 0.8, 1_000, 1_000);
  adapter
    .prepare(
      `
        INSERT OR IGNORE INTO memory_scopes (id, kind, external_id)
        VALUES (?, ?, ?)
      `
    )
    .run(scopeId, kind, externalId);
  adapter
    .prepare(
      `
        INSERT OR REPLACE INTO memory_scope_bindings (memory_id, scope_id, is_primary)
        VALUES (?, ?, 1)
      `
    )
    .run(id, scopeId);
}

function insertScopedRaw(input: {
  sourceId: string;
  connector: string;
  scopeKind: ScopeKind;
  scopeId: string;
  projectId?: string;
  tenantId?: string;
  channel?: string;
}): string {
  return upsertConnectorEventIndex(getAdapter(), {
    source_connector: input.connector,
    source_type: 'message',
    source_id: input.sourceId,
    channel: input.channel,
    content: `raw ${input.sourceId}`,
    event_datetime: 1_000,
    memory_scope_kind: input.scopeKind,
    memory_scope_id: input.scopeId,
    project_id: input.projectId,
    tenant_id: input.tenantId,
  }).event_index_id;
}

function insertEdge(input: {
  edgeId: string;
  edgeType: string;
  subjectKind: string;
  subjectId: string;
  objectKind: string;
  objectId: string;
  createdAt: number;
}): void {
  getAdapter()
    .prepare(
      `
        INSERT INTO twin_edges (
          edge_id, edge_type, subject_kind, subject_id, object_kind, object_id,
          confidence, source, reason_text, content_hash, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 1, 'code', 'fixture graph edge', ?, ?)
      `
    )
    .run(
      input.edgeId,
      input.edgeType,
      input.subjectKind,
      input.subjectId,
      input.objectKind,
      input.objectId,
      Buffer.alloc(32, input.edgeId.length),
      input.createdAt
    );
}

let projectAlpha = '';
let rawScopeNode = '';

describe('Story M6.2: /api/agent graph and entity worker API', () => {
  const originalAuthToken = process.env.MAMA_AUTH_TOKEN;
  let testDbPath = '';
  let sessionsDb: Database;
  let authority: EnvelopeAuthority;
  let validEnvelope: Envelope;

  beforeAll(async () => {
    testDbPath = await initTestDB('agent-graph-api');
  });

  beforeEach(() => {
    process.env.MAMA_AUTH_TOKEN = 'agent-graph-token';
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM twin_edges').run();
    adapter.prepare('DELETE FROM registry_ref_assignments').run();
    adapter.prepare('DELETE FROM registry_scope_bindings').run();
    adapter.prepare('DELETE FROM registry_aliases').run();
    adapter.prepare('DELETE FROM registry_nodes').run();
    adapter.prepare('DELETE FROM connector_event_index').run();
    adapter.prepare('DELETE FROM memory_scope_bindings').run();
    adapter.prepare('DELETE FROM memory_scopes').run();
    adapter.prepare('DELETE FROM decisions').run();
    adapter.prepare('DELETE FROM model_runs').run();

    sessionsDb = new Database(':memory:');
    applyEnvelopeTablesMigration(sessionsDb);
    authority = new EnvelopeAuthority(
      new EnvelopeStore(sessionsDb),
      SIGNING_KEY,
      (keyId, keyVersion) =>
        keyId === SIGNING_KEY.key_id && keyVersion === SIGNING_KEY.key_version
          ? SIGNING_KEY.key
          : undefined
    );
    validEnvelope = makeEnvelope();
    authority.persist(validEnvelope);
  });

  afterEach(() => {
    sessionsDb.close();
    if (originalAuthToken === undefined) {
      delete process.env.MAMA_AUTH_TOKEN;
    } else {
      process.env.MAMA_AUTH_TOKEN = originalAuthToken;
    }
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  function makeServer(overrides: Partial<AgentGraphRouterOptions> = {}) {
    const app = express();
    app.use(express.json());
    app.use('/api', requireAuth);
    app.use(
      '/api/agent',
      createAgentGraphRouter({
        memoryAdapter: getAdapter(),
        envelopeAuthority: authority,
        ...overrides,
      })
    );
    return { app };
  }

  function authed(req: request.Test): request.Test {
    return req
      .set(TUNNEL_HEADERS)
      .set('Authorization', 'Bearer agent-graph-token')
      .set('x-mama-envelope-hash', validEnvelope.envelope_hash);
  }

  async function seedGraph(): Promise<void> {
    insertScopedMemory('mem-visible-old', 'project', 'alpha');
    insertScopedMemory('mem-visible-new', 'project', 'alpha');
    insertScopedMemory('mem-hidden-beta', 'project', 'beta');
    projectAlpha = createNode({
      kind: 'item',
      name: 'Project Alpha',
      scopes: [{ kind: 'project', id: 'alpha' }],
    });
    getAdapter()
      .prepare('UPDATE registry_nodes SET created_at = ?, updated_at = ? WHERE id = ?')
      .run(500, 500, projectAlpha);
    insertEdge({
      edgeId: 'edge_old_mentions',
      edgeType: 'mentions',
      subjectKind: 'registry',
      subjectId: projectAlpha,
      objectKind: 'memory',
      objectId: 'mem-visible-old',
      createdAt: 1_000,
    });
    insertEdge({
      edgeId: 'edge_new_mentions',
      edgeType: 'mentions',
      subjectKind: 'registry',
      subjectId: projectAlpha,
      objectKind: 'memory',
      objectId: 'mem-visible-new',
      createdAt: 2_000,
    });
    insertEdge({
      edgeId: 'edge_hidden_beta',
      edgeType: 'mentions',
      subjectKind: 'registry',
      subjectId: projectAlpha,
      objectKind: 'memory',
      objectId: 'mem-hidden-beta',
      createdAt: 900,
    });
    insertEdge({
      edgeId: 'edge_blocks',
      edgeType: 'blocks',
      subjectKind: 'registry',
      subjectId: projectAlpha,
      objectKind: 'memory',
      objectId: 'mem-visible-old',
      createdAt: 800,
    });
  }

  describe('AC #1: worker envelope gates graph/entity reads', () => {
    it('rejects missing envelopes and requested scopes outside the envelope', async () => {
      const apiServer = makeServer();

      const missing = await request(apiServer.app)
        .get('/api/agent/graph/neighborhood?ref=memory%3Amem-visible-old&depth=1')
        .set(TUNNEL_HEADERS)
        .set('Authorization', 'Bearer agent-graph-token');
      expect(missing.status).toBe(401);
      expect(missing.body.code).toBe('worker_envelope_missing');

      const scopeOutside = await authed(
        request(apiServer.app).get(
          '/api/agent/graph/neighborhood?ref=memory%3Amem-visible-old&depth=1&scopes=project%3Abeta'
        )
      );
      expect(scopeOutside.status).toBe(403);
      expect(scopeOutside.body.code).toBe('worker_envelope_scope_denied');
    });

    it('mounts the worker graph routes through createApiServer', async () => {
      await seedGraph();
      const scheduler = new CronScheduler();
      const apiServer = createApiServer({
        scheduler,
        port: 0,
        memoryAdapter: getAdapter(),
        envelopeAuthority: authority,
      });

      try {
        const response = await authed(
          request(apiServer.app).get(
            `/api/agent/graph/neighborhood?ref=registry%3A${projectAlpha}&depth=1`
          )
        );

        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(response.body.nodes).toContainEqual({ kind: 'registry', id: projectAlpha });
      } finally {
        scheduler.shutdown();
      }
    });
  });

  describe('AC #3: graph traversal applies edge filters and as_of', () => {
    it('serves neighborhood, paths, and timeline with edge filters and as_of', async () => {
      await seedGraph();
      const apiServer = makeServer();

      const neighborhood = await authed(
        request(apiServer.app).get(
          `/api/agent/graph/neighborhood?ref=registry%3A${projectAlpha}&depth=1&edge_types=mentions&as_of=1970-01-01T00%3A00%3A01.500Z`
        )
      );
      expect(neighborhood.status).toBe(200);
      expect(neighborhood.body.edges.map((edge: { edge_id: string }) => edge.edge_id)).toEqual([
        'edge_old_mentions',
      ]);

      const paths = await authed(
        request(apiServer.app).get(
          `/api/agent/graph/paths?from=registry%3A${projectAlpha}&to=memory%3Amem-visible-old&max_depth=1&edge_types=mentions`
        )
      );
      expect(paths.status).toBe(200);
      expect(paths.body.paths).toHaveLength(1);
      expect(paths.body.paths[0].edges[0].edge_id).toBe('edge_old_mentions');

      const timeline = await authed(
        request(apiServer.app).get(
          `/api/agent/graph/timeline?ref=registry%3A${projectAlpha}&edge_types=mentions&as_of=1970-01-01T00%3A00%3A01.500Z`
        )
      );
      expect(timeline.status).toBe(200);
      expect(
        timeline.body.events
          .filter((event: { kind: string }) => event.kind === 'edge')
          .map((event: { edge: { edge_id: string } }) => event.edge.edge_id)
      ).toEqual(['edge_old_mentions']);
      expect(timeline.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'memory',
            ref: { kind: 'memory', id: 'mem-visible-old' },
          }),
        ])
      );
    });

    it('treats envelope as_of as an upper bound over request as_of', async () => {
      validEnvelope = makeEnvelope({
        scope: {
          project_refs: [{ kind: 'project', id: 'alpha' }],
          raw_connectors: ['slack'],
          memory_scopes: [{ kind: 'project', id: 'alpha' }],
          allowed_destinations: [{ kind: 'slack', id: 'slack:C1' }],
          as_of: '1970-01-01T00:00:01.500Z',
        },
      });
      authority.persist(validEnvelope);
      await seedGraph();
      const apiServer = makeServer();

      const response = await authed(
        request(apiServer.app).get(
          `/api/agent/graph/neighborhood?ref=registry%3A${projectAlpha}&depth=1&edge_types=mentions&as_of=1970-01-01T00%3A00%3A03.000Z`
        )
      );

      expect(response.status).toBe(200);
      expect(response.body.edges.map((edge: { edge_id: string }) => edge.edge_id)).toEqual([
        'edge_old_mentions',
      ]);
    });

    it('accepts JSON refs, rejects over-wide depth, and filters raw endpoints by full envelope visibility', async () => {
      rawScopeNode = createNode({
        kind: 'item',
        name: 'Raw Scope',
        scopes: [{ kind: 'project', id: 'alpha' }],
      });
      insertScopedMemory('mem-visible-old', 'project', 'alpha');
      const slackRaw = insertScopedRaw({
        sourceId: 'raw-slack-visible',
        connector: 'slack',
        scopeKind: 'project',
        scopeId: 'alpha',
        projectId: 'alpha',
        tenantId: 'default',
      });
      const discordRaw = insertScopedRaw({
        sourceId: 'raw-discord-hidden',
        connector: 'discord',
        scopeKind: 'project',
        scopeId: 'alpha',
        projectId: 'alpha',
        tenantId: 'default',
      });
      insertEdge({
        edgeId: 'edge_slack_raw',
        edgeType: 'derived_from',
        subjectKind: 'registry',
        subjectId: rawScopeNode,
        objectKind: 'raw',
        objectId: slackRaw,
        createdAt: 1_000,
      });
      insertEdge({
        edgeId: 'edge_discord_raw',
        edgeType: 'derived_from',
        subjectKind: 'registry',
        subjectId: rawScopeNode,
        objectKind: 'raw',
        objectId: discordRaw,
        createdAt: 1_000,
      });
      const apiServer = makeServer();
      const jsonRef = encodeURIComponent(JSON.stringify({ kind: 'registry', id: rawScopeNode }));

      const neighborhood = await authed(
        request(apiServer.app).get(
          `/api/agent/graph/neighborhood?ref=${jsonRef}&depth=1&connectors=slack`
        )
      );
      expect(neighborhood.status).toBe(200);
      expect(neighborhood.body.edges.map((edge: { edge_id: string }) => edge.edge_id)).toEqual([
        'edge_slack_raw',
      ]);

      const tooDeep = await authed(
        request(apiServer.app).get(
          `/api/agent/graph/paths?from=registry%3A${rawScopeNode}&to=memory%3Amem-visible-old&max_depth=6`
        )
      );
      expect(tooDeep.status).toBe(400);
      expect(tooDeep.body.code).toBe('agent_graph_query_invalid');
    });
  });
});
