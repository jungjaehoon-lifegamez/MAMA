import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

import { getAdapter } from '../../../mama-core/src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../../mama-core/src/test-utils.js';
import { attachEntityAliasWithEdge } from '../../../mama-core/src/agent-graph/index.js';
import { upsertConnectorEventIndex } from '../../../mama-core/src/connectors/event-index.js';
import { normalizeEntityLabel } from '../../../mama-core/src/entities/normalization.js';
import { attachEntityAlias, createEntityNode } from '../../../mama-core/src/entities/store.js';
import {
  beginModelRunInAdapter,
  commitModelRunInAdapter,
} from '../../../mama-core/src/model-runs/store.js';

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
}): string {
  return upsertConnectorEventIndex(getAdapter(), {
    source_connector: input.connector,
    source_type: 'message',
    source_id: input.sourceId,
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
    await createEntityNode({
      id: 'entity_project_alpha',
      kind: 'project',
      preferred_label: 'Project Alpha',
      status: 'active',
      scope_kind: 'project',
      scope_id: 'alpha',
      merged_into: null,
    });
    getAdapter()
      .prepare('UPDATE entity_nodes SET created_at = ?, updated_at = ? WHERE id = ?')
      .run(500, 500, 'entity_project_alpha');
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

      const contextRef = encodeURIComponent(
        JSON.stringify({ kind: 'entity', id: 'entity_person_jaehoon' })
      );
      const withJsonContextRef = await authed(
        request(apiServer.app).get(
          `/api/agent/entities/resolve?label=Jaehoon%20Jung&context_ref=${contextRef}`
        )
      );
      expect(withJsonContextRef.status).toBe(200);
      expect(withJsonContextRef.body.entity.id).toBe('entity_person_jaehoon');
    });

    it('does not resolve preferred labels for entities created after request as_of', async () => {
      await createEntityNode({
        id: 'entity_api_future_preferred',
        kind: 'person',
        preferred_label: 'API Future Preferred',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
      });
      getAdapter()
        .prepare('UPDATE entity_nodes SET created_at = ?, updated_at = ? WHERE id = ?')
        .run(2_000, 2_000, 'entity_api_future_preferred');
      const apiServer = makeServer();

      const response = await authed(
        request(apiServer.app).get(
          '/api/agent/entities/resolve?label=API%20Future%20Preferred&as_of=1970-01-01T00%3A00%3A01.000Z'
        )
      );

      expect(response.status).toBe(200);
      expect(response.body.entity).toBeNull();
      expect(response.body.candidates).toHaveLength(0);
    });

    it('filters alias matches by source ref connector visibility', async () => {
      await createEntityNode({
        id: 'entity_alias_api_connector_filtered',
        kind: 'project',
        preferred_label: 'Alias API Connector Filtered',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
      });
      const discordRaw = insertScopedRaw({
        sourceId: 'raw-api-alias-discord',
        connector: 'discord',
        scopeKind: 'project',
        scopeId: 'alpha',
        projectId: 'alpha',
        tenantId: 'default',
      });
      const aliasInput = {
        entity_id: 'entity_alias_api_connector_filtered',
        label: 'API Discord Only Alias',
        label_type: 'alt' as const,
        source_type: 'agent',
        source_ref: 'model_run:mr_api_alias_discord',
        agent_id: 'worker-m6',
        model_run_id: 'mr_api_alias_discord',
        envelope_hash: validEnvelope.envelope_hash,
        request_idempotency_key: 'api-alias-discord-key',
        source_refs: [{ kind: 'raw' as const, id: discordRaw }],
        scopes: [{ kind: 'project' as const, id: 'alpha' }],
        project_refs: [{ kind: 'project', id: 'alpha' }],
        tenant_id: 'default',
      };
      attachEntityAliasWithEdge(getAdapter(), aliasInput);
      const apiServer = makeServer();

      const response = await authed(
        request(apiServer.app).get('/api/agent/entities/resolve?label=API%20Discord%20Only%20Alias')
      );

      expect(response.status).toBe(200);
      expect(response.body.entity).toBeNull();
      expect(response.body.candidates).toHaveLength(0);
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
          '/api/agent/graph/neighborhood?ref=entity%3Aentity_project_alpha&depth=1&edge_types=mentions&as_of=1970-01-01T00%3A00%3A03.000Z'
        )
      );

      expect(response.status).toBe(200);
      expect(response.body.edges.map((edge: { edge_id: string }) => edge.edge_id)).toEqual([
        'edge_old_mentions',
      ]);
    });

    it('accepts JSON refs, rejects over-wide depth, and filters raw endpoints by full envelope visibility', async () => {
      await createEntityNode({
        id: 'entity_raw_scope',
        kind: 'project',
        preferred_label: 'Raw Scope',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
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
        subjectKind: 'entity',
        subjectId: 'entity_raw_scope',
        objectKind: 'raw',
        objectId: slackRaw,
        createdAt: 1_000,
      });
      insertEdge({
        edgeId: 'edge_discord_raw',
        edgeType: 'derived_from',
        subjectKind: 'entity',
        subjectId: 'entity_raw_scope',
        objectKind: 'raw',
        objectId: discordRaw,
        createdAt: 1_000,
      });
      const apiServer = makeServer();
      const jsonRef = encodeURIComponent(
        JSON.stringify({ kind: 'entity', id: 'entity_raw_scope' })
      );

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
          '/api/agent/graph/paths?from=entity%3Aentity_raw_scope&to=memory%3Amem-visible-old&max_depth=6'
        )
      );
      expect(tooDeep.status).toBe(400);
      expect(tooDeep.body.code).toBe('agent_graph_query_invalid');
    });
  });

  describe('AC #4: alias writes create durable provenance', () => {
    it('requires direct alias writes to carry a stable request idempotency key', async () => {
      await createEntityNode({
        id: 'entity_alias_requires_key',
        kind: 'person',
        preferred_label: 'Alias Requires Key',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
      });
      const apiServer = makeServer();

      const response = await authed(
        request(apiServer.app)
          .post('/api/agent/entities/entity_alias_requires_key/aliases')
          .send({ label: 'Missing Key Alias' })
      );

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('agent_graph_body_invalid');
    });

    it('requires direct alias writes to carry visible source refs', async () => {
      await createEntityNode({
        id: 'entity_alias_requires_sources',
        kind: 'person',
        preferred_label: 'Alias Requires Sources',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
      });
      const apiServer = makeServer();

      const response = await authed(
        request(apiServer.app)
          .post('/api/agent/entities/entity_alias_requires_sources/aliases')
          .send({ label: 'No Source Alias', request_idempotency_key: 'alias-no-source-key' })
      );

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('agent_graph_invalid');
      expect(getAdapter().prepare('SELECT COUNT(*) AS count FROM model_runs').get()).toEqual({
        count: 0,
      });
    });

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
      const rawId = insertScopedRaw({
        sourceId: 'raw-api-alias-target',
        connector: 'slack',
        scopeKind: 'project',
        scopeId: 'alpha',
        projectId: 'alpha',
        tenantId: 'default',
      });
      const apiServer = makeServer();

      const response = await authed(
        request(apiServer.app)
          .post('/api/agent/entities/entity_alias_target/aliases')
          .send({
            label: '\uC815\uC7AC\uD6C8',
            confidence: 0.9,
            request_idempotency_key: 'alias-api-key',
            source_refs: [{ kind: 'raw', id: rawId }],
            source_type: 'human',
            source_ref: 'raw:hidden-provenance',
          })
      );

      expect(response.status).toBe(200);
      expect(response.body.alias.label).toBe('\uC815\uC7AC\uD6C8');
      expect(response.body.alias.source_type).toBe('agent');
      expect(response.body.alias.source_ref).toBe(`model_run:${response.body.edge.model_run_id}`);
      expect(response.body.edge.edge_type).toBe('alias_of');
      expect(response.body.edge.source).toBe('agent');
      expect(response.body.edge.model_run_id).toMatch(/^mr_direct_alias_/);

      const runs = getAdapter()
        .prepare('SELECT status, envelope_hash FROM model_runs ORDER BY created_at')
        .all() as Array<{ status: string; envelope_hash: string }>;
      expect(runs).toEqual([{ status: 'committed', envelope_hash: validEnvelope.envelope_hash }]);
    });

    it('persists visible direct alias source refs in alias_of relation attrs', async () => {
      await createEntityNode({
        id: 'entity_alias_source_refs',
        kind: 'person',
        preferred_label: 'Alias Source Refs',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
      });
      const slackRaw = insertScopedRaw({
        sourceId: 'raw-api-alias-slack-visible',
        connector: 'slack',
        scopeKind: 'project',
        scopeId: 'alpha',
        projectId: 'alpha',
        tenantId: 'default',
      });
      const apiServer = makeServer();

      const response = await authed(
        request(apiServer.app)
          .post('/api/agent/entities/entity_alias_source_refs/aliases')
          .send({
            label: 'Alias With Source Refs',
            request_idempotency_key: 'alias-source-refs-key',
            source_refs: [{ kind: 'raw', id: slackRaw }],
          })
      );

      expect(response.status).toBe(200);
      expect(response.body.edge.relation_attrs).toEqual(
        expect.objectContaining({
          source_refs: [{ kind: 'raw', id: slackRaw }],
        })
      );
    });

    it('rejects hidden direct alias source refs without writing alias or edge rows', async () => {
      await createEntityNode({
        id: 'entity_alias_hidden_source_refs',
        kind: 'person',
        preferred_label: 'Alias Hidden Source Refs',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
      });
      const discordRaw = insertScopedRaw({
        sourceId: 'raw-api-alias-discord-hidden',
        connector: 'discord',
        scopeKind: 'project',
        scopeId: 'alpha',
        projectId: 'alpha',
        tenantId: 'default',
      });
      const apiServer = makeServer();

      const response = await authed(
        request(apiServer.app)
          .post('/api/agent/entities/entity_alias_hidden_source_refs/aliases')
          .send({
            label: 'Alias Hidden Source Refs',
            request_idempotency_key: 'alias-hidden-source-refs-key',
            source_refs: [{ kind: 'raw', id: discordRaw }],
          })
      );

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('agent_graph_invalid');
      const counts = getAdapter()
        .prepare(
          `
            SELECT
              (SELECT COUNT(*) FROM entity_aliases WHERE label = 'Alias Hidden Source Refs') AS aliases,
              (SELECT COUNT(*) FROM twin_edges WHERE request_idempotency_key = 'alias-hidden-source-refs-key') AS edges
          `
        )
        .get() as { aliases: number; edges: number };
      expect(counts).toEqual({ aliases: 0, edges: 0 });
    });

    it('replays identical direct alias writes and rejects changed payloads for the same request key', async () => {
      await createEntityNode({
        id: 'entity_alias_replay',
        kind: 'person',
        preferred_label: 'Alias Replay',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
      });
      const rawId = insertScopedRaw({
        sourceId: 'raw-api-alias-replay',
        connector: 'slack',
        scopeKind: 'project',
        scopeId: 'alpha',
        projectId: 'alpha',
        tenantId: 'default',
      });
      const apiServer = makeServer();
      const payload = {
        label: 'Replay Alias',
        confidence: 0.9,
        request_idempotency_key: 'alias-replay-key',
        source_refs: [{ kind: 'raw', id: rawId }],
      };

      const first = await authed(
        request(apiServer.app).post('/api/agent/entities/entity_alias_replay/aliases').send(payload)
      );
      const replay = await authed(
        request(apiServer.app).post('/api/agent/entities/entity_alias_replay/aliases').send(payload)
      );
      const changed = await authed(
        request(apiServer.app)
          .post('/api/agent/entities/entity_alias_replay/aliases')
          .send({ ...payload, confidence: 0.7 })
      );

      expect(first.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(replay.body.alias.id).toBe(first.body.alias.id);
      expect(replay.body.edge.edge_id).toBe(first.body.edge.edge_id);
      expect(changed.status).toBe(400);
      expect(changed.body.code).toBe('agent_graph_invalid');

      const counts = getAdapter()
        .prepare(
          `
            SELECT
              (SELECT COUNT(*) FROM model_runs) AS runs,
              (SELECT COUNT(*) FROM entity_aliases) AS aliases,
              (SELECT COUNT(*) FROM twin_edges) AS edges
          `
        )
        .get() as { runs: number; aliases: number; edges: number };
      expect(counts).toEqual({ runs: 1, aliases: 1, edges: 1 });
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
      const rawId = insertScopedRaw({
        sourceId: 'raw-api-alias-denied',
        connector: 'slack',
        scopeKind: 'project',
        scopeId: 'alpha',
        projectId: 'alpha',
        tenantId: 'default',
      });
      const apiServer = makeServer();

      const response = await authed(
        request(apiServer.app)
          .post('/api/agent/entities/entity_alias_denied/aliases')
          .set('x-mama-model-run-id', 'mr_mismatch')
          .send({
            label: 'Denied Alias',
            request_idempotency_key: 'denied-alias-key',
            source_refs: [{ kind: 'raw', id: rawId }],
          })
      );

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('agent_graph_model_run_denied');
    });

    it('rejects supplied model runs from unrelated same-envelope work', async () => {
      await createEntityNode({
        id: 'entity_alias_unrelated_run',
        kind: 'person',
        preferred_label: 'Alias Unrelated Run',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
      });
      const rawId = insertScopedRaw({
        sourceId: 'raw-api-alias-unrelated-run',
        connector: 'slack',
        scopeKind: 'project',
        scopeId: 'alpha',
        projectId: 'alpha',
        tenantId: 'default',
      });
      beginModelRunInAdapter(getAdapter(), {
        model_run_id: 'mr_unrelated_alias',
        agent_id: validEnvelope.agent_id,
        instance_id: validEnvelope.instance_id,
        envelope_hash: validEnvelope.envelope_hash,
        input_snapshot_ref: 'memory:unrelated',
        input_refs: { tool: 'memory.write' },
      });
      const apiServer = makeServer();

      const response = await authed(
        request(apiServer.app)
          .post('/api/agent/entities/entity_alias_unrelated_run/aliases')
          .set('x-mama-model-run-id', 'mr_unrelated_alias')
          .send({
            label: 'Unrelated Run Alias',
            request_idempotency_key: 'alias-unrelated-run-key',
            source_refs: [{ kind: 'raw', id: rawId }],
          })
      );

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('agent_graph_model_run_denied');
    });

    it('rejects terminal supplied model runs for the matching alias request', async () => {
      await createEntityNode({
        id: 'entity_alias_terminal_run',
        kind: 'person',
        preferred_label: 'Alias Terminal Run',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
      });
      const rawId = insertScopedRaw({
        sourceId: 'raw-api-alias-terminal-run',
        connector: 'slack',
        scopeKind: 'project',
        scopeId: 'alpha',
        projectId: 'alpha',
        tenantId: 'default',
      });
      beginModelRunInAdapter(getAdapter(), {
        model_run_id: 'mr_terminal_alias',
        agent_id: validEnvelope.agent_id,
        instance_id: validEnvelope.instance_id,
        envelope_hash: validEnvelope.envelope_hash,
        input_snapshot_ref: 'entity-alias:entity_alias_terminal_run:alias-terminal-run-key',
        input_refs: {
          tool: 'entity.alias',
          entity_id: 'entity_alias_terminal_run',
          request_idempotency_key: 'alias-terminal-run-key',
          source_refs: [{ kind: 'raw', id: rawId }],
        },
      });
      commitModelRunInAdapter(getAdapter(), 'mr_terminal_alias', 'already committed');
      const apiServer = makeServer();

      const response = await authed(
        request(apiServer.app)
          .post('/api/agent/entities/entity_alias_terminal_run/aliases')
          .set('x-mama-model-run-id', 'mr_terminal_alias')
          .send({
            label: 'Terminal Run Alias',
            request_idempotency_key: 'alias-terminal-run-key',
            source_refs: [{ kind: 'raw', id: rawId }],
          })
      );

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('agent_graph_model_run_not_running');
    });

    it('removes owned alias and edge rows when direct model-run commit fails', async () => {
      await createEntityNode({
        id: 'entity_alias_commit_failure',
        kind: 'person',
        preferred_label: 'Alias Commit Failure',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
      });
      const rawId = insertScopedRaw({
        sourceId: 'raw-api-alias-commit-failure',
        connector: 'slack',
        scopeKind: 'project',
        scopeId: 'alpha',
        projectId: 'alpha',
        tenantId: 'default',
      });
      const baseAdapter = getAdapter();
      const commitFailingAdapter: AgentGraphRouterOptions['memoryAdapter'] = {
        prepare(sql: string) {
          const statement = baseAdapter.prepare(sql);
          if (sql.includes("SET status = 'committed'")) {
            return {
              run: (..._args: unknown[]) => {
                throw new Error('graph commit store unavailable');
              },
              get: (...args: unknown[]) => statement.get(...args),
              all: (...args: unknown[]) => statement.all(...args),
            };
          }
          return statement;
        },
        transaction<T>(fn: () => T): T {
          return baseAdapter.transaction(fn);
        },
      };
      const apiServer = makeServer({ memoryAdapter: commitFailingAdapter });

      const response = await authed(
        request(apiServer.app)
          .post('/api/agent/entities/entity_alias_commit_failure/aliases')
          .send({
            label: 'Commit Failure Alias',
            request_idempotency_key: 'alias-commit-failure-key',
            source_refs: [{ kind: 'raw', id: rawId }],
          })
      );

      expect(response.status).toBe(500);
      expect(response.body.code).toBe('internal_server_error');
      expect(response.body.message).toBe('An internal error occurred.');
      expect(
        getAdapter()
          .prepare(
            `
              SELECT
                (SELECT COUNT(*) FROM entity_aliases WHERE label = 'Commit Failure Alias') AS aliases,
                (SELECT COUNT(*) FROM twin_edges WHERE request_idempotency_key = 'alias-commit-failure-key') AS edges
            `
          )
          .get()
      ).toEqual({ aliases: 0, edges: 0 });
      expect(
        getAdapter()
          .prepare('SELECT status, error_summary FROM model_runs ORDER BY created_at')
          .all()
      ).toEqual([{ status: 'failed', error_summary: 'graph commit store unavailable' }]);
    });
  });
});
