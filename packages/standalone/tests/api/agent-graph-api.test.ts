import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

import { getAdapter } from '../../../mama-core/src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../../mama-core/src/test-utils.js';
import { normalizeEntityLabel } from '../../../mama-core/src/entities/normalization.js';
import { attachEntityAlias, createEntityNode } from '../../../mama-core/src/entities/store.js';
import { beginModelRunInAdapter } from '../../../mama-core/src/model-runs/store.js';

import Database from '../../src/sqlite.js';
import { createApiServer } from '../../src/api/index.js';
import { createAgentGraphRouter } from '../../src/api/agent-graph-handler.js';
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

async function seedAlias(entityId: string, label: string, aliasId: string): Promise<void> {
  const normalized = normalizeEntityLabel(label);
  await attachEntityAlias({
    id: aliasId,
    entity_id: entityId,
    label,
    normalized_label: normalized.normalized,
    lang: normalized.script === 'Hang' ? 'ko' : normalized.script === 'Jpan' ? 'ja' : 'en',
    script: normalized.script,
    label_type: 'alt',
    source_type: 'fixture',
    source_ref: 'fixture:m6',
    confidence: 0.95,
    status: 'active',
  });
}

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
    adapter.prepare('DELETE FROM entity_lineage_links').run();
    adapter.prepare('DELETE FROM entity_observations').run();
    adapter.prepare('DELETE FROM entity_aliases').run();
    adapter.prepare('DELETE FROM entity_nodes').run();
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

  function makeServer() {
    const app = express();
    app.use(express.json());
    app.use('/api', requireAuth);
    app.use(
      '/api/agent',
      createAgentGraphRouter({
        memoryAdapter: getAdapter(),
        envelopeAuthority: authority,
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
    await createEntityNode({
      id: 'entity_project_alpha',
      kind: 'project',
      preferred_label: 'Project Alpha',
      status: 'active',
      scope_kind: 'project',
      scope_id: 'alpha',
      merged_into: null,
    });
    insertEdge({
      edgeId: 'edge_old_mentions',
      edgeType: 'mentions',
      subjectKind: 'entity',
      subjectId: 'entity_project_alpha',
      objectKind: 'memory',
      objectId: 'mem-visible-old',
      createdAt: 1_000,
    });
    insertEdge({
      edgeId: 'edge_new_mentions',
      edgeType: 'mentions',
      subjectKind: 'entity',
      subjectId: 'entity_project_alpha',
      objectKind: 'memory',
      objectId: 'mem-visible-new',
      createdAt: 2_000,
    });
    insertEdge({
      edgeId: 'edge_hidden_beta',
      edgeType: 'mentions',
      subjectKind: 'entity',
      subjectId: 'entity_project_alpha',
      objectKind: 'memory',
      objectId: 'mem-hidden-beta',
      createdAt: 900,
    });
    insertEdge({
      edgeId: 'edge_blocks',
      edgeType: 'blocks',
      subjectKind: 'entity',
      subjectId: 'entity_project_alpha',
      objectKind: 'memory',
      objectId: 'mem-visible-old',
      createdAt: 800,
    });
  }

  describe('AC #1: worker envelope gates graph/entity reads', () => {
    it('rejects missing envelopes and requested scopes outside the envelope', async () => {
      const apiServer = makeServer();

      const missing = await request(apiServer.app)
        .get('/api/agent/entities/resolve?label=Alpha')
        .set(TUNNEL_HEADERS)
        .set('Authorization', 'Bearer agent-graph-token');
      expect(missing.status).toBe(401);
      expect(missing.body.code).toBe('worker_envelope_missing');

      const scopeOutside = await authed(
        request(apiServer.app).get('/api/agent/entities/resolve?label=Alpha&scopes=project%3Abeta')
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
            '/api/agent/graph/neighborhood?ref=entity%3Aentity_project_alpha&depth=1'
          )
        );

        expect(response.status).toBe(200);
        expect(response.body.nodes).toContainEqual({ kind: 'entity', id: 'entity_project_alpha' });
      } finally {
        scheduler.shutdown();
      }
    });
  });

  describe('AC #2: entity.resolve is multilingual and scoped', () => {
    it('resolves Korean, English, and Japanese labels to the same entity', async () => {
      await createEntityNode({
        id: 'entity_person_jaehoon',
        kind: 'person',
        preferred_label: 'Jaehoon Jung',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
      });
      await seedAlias('entity_person_jaehoon', '\uC815\uC7AC\uD6C8', 'alias_jaehoon_ko');
      await seedAlias('entity_person_jaehoon', '\u30B8\u30A7\u30D5\u30F3', 'alias_jaehoon_ja');
      const apiServer = makeServer();

      for (const label of ['Jaehoon Jung', '\uC815\uC7AC\uD6C8', '\u30B8\u30A7\u30D5\u30F3']) {
        const response = await authed(
          request(apiServer.app).get(
            `/api/agent/entities/resolve?label=${encodeURIComponent(label)}`
          )
        );
        expect(response.status).toBe(200);
        expect(response.body.entity.id).toBe('entity_person_jaehoon');
      }
    });
  });

  describe('AC #3: graph traversal applies edge filters and as_of', () => {
    it('serves neighborhood, paths, and timeline with edge filters and as_of', async () => {
      await seedGraph();
      const apiServer = makeServer();

      const neighborhood = await authed(
        request(apiServer.app).get(
          '/api/agent/graph/neighborhood?ref=entity%3Aentity_project_alpha&depth=1&edge_types=mentions&as_of=1970-01-01T00%3A00%3A01.500Z'
        )
      );
      expect(neighborhood.status).toBe(200);
      expect(neighborhood.body.edges.map((edge: { edge_id: string }) => edge.edge_id)).toEqual([
        'edge_old_mentions',
      ]);

      const paths = await authed(
        request(apiServer.app).get(
          '/api/agent/graph/paths?from=entity%3Aentity_project_alpha&to=memory%3Amem-visible-old&max_depth=1&edge_types=mentions'
        )
      );
      expect(paths.status).toBe(200);
      expect(paths.body.paths).toHaveLength(1);
      expect(paths.body.paths[0].edges[0].edge_id).toBe('edge_old_mentions');

      const timeline = await authed(
        request(apiServer.app).get(
          '/api/agent/graph/timeline?ref=entity%3Aentity_project_alpha&edge_types=mentions&as_of=1970-01-01T00%3A00%3A01.500Z'
        )
      );
      expect(timeline.status).toBe(200);
      expect(
        timeline.body.events.map((event: { edge: { edge_id: string } }) => event.edge.edge_id)
      ).toEqual(['edge_old_mentions']);
    });
  });

  describe('AC #4: alias writes create durable provenance', () => {
    it('creates a committed model run plus alias_of edge when no model run is supplied', async () => {
      await createEntityNode({
        id: 'entity_alias_target',
        kind: 'person',
        preferred_label: 'Alias Target',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
      });
      const apiServer = makeServer();

      const response = await authed(
        request(apiServer.app)
          .post('/api/agent/entities/entity_alias_target/aliases')
          .send({ label: '\uC815\uC7AC\uD6C8', confidence: 0.9, idempotency_key: 'alias-api-key' })
      );

      expect(response.status).toBe(200);
      expect(response.body.alias.label).toBe('\uC815\uC7AC\uD6C8');
      expect(response.body.edge.edge_type).toBe('alias_of');
      expect(response.body.edge.model_run_id).toMatch(/^mr_/);

      const runs = getAdapter()
        .prepare('SELECT status, envelope_hash FROM model_runs ORDER BY created_at')
        .all() as Array<{ status: string; envelope_hash: string }>;
      expect(runs).toEqual([{ status: 'committed', envelope_hash: validEnvelope.envelope_hash }]);
    });

    it('rejects supplied model runs outside the worker envelope', async () => {
      await createEntityNode({
        id: 'entity_alias_denied',
        kind: 'person',
        preferred_label: 'Alias Denied',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
      });
      beginModelRunInAdapter(getAdapter(), {
        model_run_id: 'mr_mismatch',
        agent_id: 'worker-m6',
        envelope_hash: 'other-envelope',
        input_refs: { test: true },
      });
      const apiServer = makeServer();

      const response = await authed(
        request(apiServer.app)
          .post('/api/agent/entities/entity_alias_denied/aliases')
          .set('x-mama-model-run-id', 'mr_mismatch')
          .send({ label: 'Denied Alias' })
      );

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('agent_graph_model_run_denied');
    });
  });
});
