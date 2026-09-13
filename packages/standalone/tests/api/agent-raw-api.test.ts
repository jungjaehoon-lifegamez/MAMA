import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import request from 'supertest';
import express from 'express';

import { getAdapter } from '../../../mama-core/src/db-manager.js';
import { upsertConnectorEventIndex } from '../../../mama-core/src/connectors/event-index.js';
import {
  appendObservationVersion,
  getObservationVersion,
  observationVersionId,
} from '../../../mama-core/src/connectors/observation-versions.js';
import { isObservationVersionVisible } from '../../../mama-core/src/connectors/observation-visibility.js';
import * as rawQuery from '../../../mama-core/src/connectors/raw-query.js';
import { cleanupTestDB, initTestDB } from '../../../mama-core/src/test-utils.js';

import Database from '../../src/sqlite.js';
import { createApiServer } from '../../src/api/index.js';
import {
  createAgentObservationRouter,
  createAgentRawRouter,
  type AgentRawRouterOptions,
} from '../../src/api/agent-raw-handler.js';
import { requireAuth } from '../../src/api/auth-middleware.js';
import { CronScheduler } from '../../src/scheduler/index.js';
import { applyEnvelopeTablesMigration } from '../../src/db/migrations/envelope-tables.js';
import { EnvelopeAuthority } from '../../src/envelope/authority.js';
import { EnvelopeStore } from '../../src/envelope/store.js';
import { signEnvelope } from '../../src/envelope/signature.js';
import type { Envelope } from '../../src/envelope/types.js';
import { MessageRouter } from '../../src/gateways/message-router.js';
import { SessionStore } from '../../src/gateways/session-store.js';
import { createMockMamaApi } from '../../src/gateways/context-injector.js';

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
  key: Buffer.from('agent-raw-api-test-key-32-bytes!'),
};

function makeEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return signEnvelope(
    {
      agent_id: 'worker-m4',
      instance_id: `inst_${Math.random().toString(36).slice(2)}`,
      source: 'telegram',
      channel_id: 'tg:1',
      trigger_context: {},
      scope: {
        principal_id: 'principal-m4',
        project_refs: [{ kind: 'project', id: 'alpha' }],
        raw_connectors: ['slack'],
        memory_scopes: [{ kind: 'project', id: 'alpha' }],
        allowed_destinations: [{ kind: 'telegram', id: 'tg:1' }],
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

function seedRaw(overrides: {
  connector?: string;
  sourceId: string;
  entityId?: string;
  channel?: string;
  content?: string;
  timestampMs: number;
  observedAt?: number;
  scopeId?: string;
}): string {
  const saved = upsertConnectorEventIndex(getAdapter(), {
    source_connector: overrides.connector ?? 'slack',
    source_type: 'message',
    source_id: overrides.sourceId,
    source_entity_id: overrides.entityId ?? overrides.sourceId,
    source_locator: `${overrides.connector ?? 'slack'}:${overrides.channel ?? 'general'}:${overrides.sourceId}`,
    channel: overrides.channel ?? 'general',
    author: 'alice',
    content: overrides.content ?? 'rawapi searchable content',
    event_datetime: overrides.timestampMs,
    source_timestamp_ms: overrides.timestampMs,
    memory_scope_kind: 'project',
    memory_scope_id: overrides.scopeId ?? 'alpha',
    metadata: { seeded: overrides.sourceId },
    observation: {
      producer_version_id: overrides.sourceId,
      observed_at: overrides.observedAt ?? overrides.timestampMs,
    },
  });
  return saved.event_index_id;
}

describe('Story M4: /api/agent/raw worker envelope API', () => {
  const originalAuthToken = process.env.MAMA_AUTH_TOKEN;
  let testDbPath = '';
  let sessionsDb: Database;
  let authority: EnvelopeAuthority;
  let validEnvelope: Envelope;

  beforeAll(async () => {
    testDbPath = await initTestDB('agent-raw-api');
  });

  beforeEach(() => {
    process.env.MAMA_AUTH_TOKEN = 'agent-raw-token';
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM connector_event_index_cursors').run();
    adapter.prepare('DELETE FROM connector_event_index').run();

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

  function makeServer(
    rawQueryOverrides: Partial<AgentRawRouterOptions['rawQuery']> = {},
    channelGrant?: () => Record<string, readonly string[]>
  ) {
    const app = express();
    app.use('/api', requireAuth);
    app.use(
      '/api/agent/raw',
      createAgentRawRouter({
        memoryDb: getAdapter(),
        envelopeAuthority: authority,
        rawQuery: { ...rawQuery, ...rawQueryOverrides },
        channelGrant,
      })
    );
    app.use(
      '/api/agent/observations',
      createAgentObservationRouter({
        memoryDb: getAdapter(),
        envelopeAuthority: authority,
        rawQuery: { ...rawQuery, ...rawQueryOverrides },
        channelGrant,
      })
    );
    return {
      app,
    };
  }

  function authed(req: request.Test): request.Test {
    return req
      .set(TUNNEL_HEADERS)
      .set('Authorization', 'Bearer agent-raw-token')
      .set('x-mama-envelope-hash', validEnvelope.envelope_hash);
  }

  describe('AC #1: route-local worker envelope gate is stricter than perimeter auth', () => {
    it('rejects missing, invalid, and expired envelopes even when requireAuth passes', async () => {
      const expired = makeEnvelope({
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      });
      authority.persist(expired);
      const apiServer = makeServer();

      const missing = await request(apiServer.app)
        .get('/api/agent/raw/search-all?query=rawapi')
        .set(TUNNEL_HEADERS)
        .set('Authorization', 'Bearer agent-raw-token');
      expect(missing.status).toBe(401);

      const invalid = await request(apiServer.app)
        .get('/api/agent/raw/search-all?query=rawapi')
        .set(TUNNEL_HEADERS)
        .set('Authorization', 'Bearer agent-raw-token')
        .set('x-mama-envelope-hash', 'not-present');
      expect(invalid.status).toBe(403);

      const expiredResponse = await request(apiServer.app)
        .get('/api/agent/raw/search-all?query=rawapi')
        .set(TUNNEL_HEADERS)
        .set('Authorization', 'Bearer agent-raw-token')
        .set('x-mama-envelope-hash', expired.envelope_hash);
      expect(expiredResponse.status).toBe(403);
    });

    it('rejects envelopes with unparsable expires_at values', async () => {
      const invalidExpiry = makeEnvelope({
        expires_at: 'not-a-date',
      });
      authority.persist(invalidExpiry);
      const apiServer = makeServer();

      const response = await request(apiServer.app)
        .get('/api/agent/raw/search-all?query=rawapi')
        .set(TUNNEL_HEADERS)
        .set('Authorization', 'Bearer agent-raw-token')
        .set('x-mama-envelope-hash', invalidExpiry.envelope_hash);

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('worker_envelope_expired');
    });

    it('rejects parseable non-ISO expires_at values', async () => {
      const invalidExpiry = makeEnvelope({
        expires_at: '2099-01-01 00:00:00',
      });
      authority.persist(invalidExpiry);
      const apiServer = makeServer();

      const response = await request(apiServer.app)
        .get('/api/agent/raw/search-all?query=rawapi')
        .set(TUNNEL_HEADERS)
        .set('Authorization', 'Bearer agent-raw-token')
        .set('x-mama-envelope-hash', invalidExpiry.envelope_hash);

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('worker_envelope_expired');
    });

    it('rejects requested connector or scope filters outside the envelope', async () => {
      const apiServer = makeServer();

      const connectorOutside = await authed(
        request(apiServer.app).get('/api/agent/raw/search-all?query=rawapi&connectors=discord')
      );
      expect(connectorOutside.status).toBe(403);

      const scopeOutside = await authed(
        request(apiServer.app).get('/api/agent/raw/search-all?query=rawapi&scopes=project%3Abeta')
      );
      expect(scopeOutside.status).toBe(403);
    });

    it('preserves colon-containing scope ids in string and JSON scope filters', async () => {
      const colonScopeId = 'repo:alpha:service';
      validEnvelope = makeEnvelope({
        scope: {
          project_refs: [{ kind: 'project', id: colonScopeId }],
          raw_connectors: ['slack'],
          memory_scopes: [{ kind: 'project', id: colonScopeId }],
          allowed_destinations: [{ kind: 'telegram', id: 'tg:1' }],
        },
      });
      authority.persist(validEnvelope);
      seedRaw({
        sourceId: 'colon-scope',
        content: 'colonneedle scoped content',
        timestampMs: Date.parse('2026-04-20T10:00:00.000Z'),
        scopeId: colonScopeId,
      });
      const apiServer = makeServer();

      const stringScope = await authed(
        request(apiServer.app).get(
          `/api/agent/raw/search-all?query=colonneedle&scopes=${encodeURIComponent(
            `project:${colonScopeId}`
          )}`
        )
      );
      const jsonScope = await authed(
        request(apiServer.app).get(
          `/api/agent/raw/search-all?query=colonneedle&scopes=${encodeURIComponent(
            JSON.stringify([{ kind: 'project', id: colonScopeId }])
          )}`
        )
      );

      expect(stringScope.status).toBe(200);
      expect(stringScope.body.hits.map((hit: { source_id: string }) => hit.source_id)).toEqual([
        'colon-scope',
      ]);
      expect(jsonScope.status).toBe(200);
      expect(jsonScope.body.hits.map((hit: { source_id: string }) => hit.source_id)).toEqual([
        'colon-scope',
      ]);
    });

    it('returns a validation error when raw.search cannot resolve one connector', async () => {
      validEnvelope = makeEnvelope({
        scope: {
          project_refs: [{ kind: 'project', id: 'alpha' }],
          raw_connectors: ['slack', 'discord'],
          memory_scopes: [{ kind: 'project', id: 'alpha' }],
          allowed_destinations: [{ kind: 'telegram', id: 'tg:1' }],
        },
      });
      authority.persist(validEnvelope);
      const apiServer = makeServer();

      const response = await authed(
        request(apiServer.app).get('/api/agent/raw/search?query=rawapi')
      );

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('raw_connector_required');
    });

    it('sanitizes unexpected raw query errors', async () => {
      const apiServer = makeServer({
        searchAllRaw: () => {
          throw new Error('sensitive sqlite path /tmp/private.db');
        },
      });

      const response = await authed(
        request(apiServer.app).get('/api/agent/raw/search-all?query=rawapi')
      );

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        error: true,
        code: 'raw_api_error',
        message: 'Internal server error',
      });
    });
  });

  describe('AC #2: omitted filters derive connector and scope visibility from envelope', () => {
    it('search-all applies envelope connectors and scopes when query filters are omitted', async () => {
      seedRaw({
        sourceId: 'slack-alpha',
        timestampMs: Date.parse('2026-04-20T10:00:00.000Z'),
      });
      seedRaw({
        connector: 'discord',
        sourceId: 'discord-alpha',
        timestampMs: Date.parse('2026-04-20T11:00:00.000Z'),
      });
      seedRaw({
        sourceId: 'slack-beta',
        timestampMs: Date.parse('2026-04-20T12:00:00.000Z'),
        scopeId: 'beta',
      });
      const apiServer = makeServer();

      const response = await authed(
        request(apiServer.app).get('/api/agent/raw/search-all?query=rawapi&limit=10')
      );

      expect(response.status).toBe(200);
      expect(response.body.hits.map((hit: { source_id: string }) => hit.source_id)).toEqual([
        'slack-alpha',
      ]);
    });

    it('orders matching raw hits by current observation capture time', async () => {
      seedRaw({
        sourceId: 'old-source-fresh-capture',
        content: 'captureorder needle',
        timestampMs: 100,
        observedAt: 5_000,
      });
      seedRaw({
        sourceId: 'new-source-older-capture',
        content: 'captureorder needle',
        timestampMs: 4_000,
        observedAt: 4_500,
      });
      const response = await authed(
        request(makeServer().app).get('/api/agent/raw/search-all?query=captureorder')
      );
      expect(response.status).toBe(200);
      expect(response.body.hits.map((hit: { source_id: string }) => hit.source_id)).toEqual([
        'old-source-fresh-capture',
        'new-source-older-capture',
      ]);
      expect(response.body.hits[0].created_at).toBe(new Date(5_000).toISOString());
      expect(response.body.hits[0]).toMatchObject({
        source_at: new Date(100).toISOString(),
        observed_at: new Date(5_000).toISOString(),
      });
    });
  });

  describe('AC #3: raw detail and window stay inside envelope visibility', () => {
    it('returns a target raw row and same-channel context window after visibility checks', async () => {
      seedRaw({
        sourceId: 'before',
        channel: 'C1',
        content: 'rawapi context before',
        timestampMs: Date.parse('2026-04-20T09:59:00.000Z'),
      });
      const targetRawId = seedRaw({
        sourceId: 'target',
        channel: 'C1',
        content: 'rawapi target',
        timestampMs: Date.parse('2026-04-20T10:00:00.000Z'),
      });
      seedRaw({
        sourceId: 'after',
        channel: 'C1',
        content: 'rawapi context after',
        timestampMs: Date.parse('2026-04-20T10:01:00.000Z'),
      });
      seedRaw({
        sourceId: 'other-channel',
        channel: 'C2',
        content: 'rawapi other channel',
        timestampMs: Date.parse('2026-04-20T10:00:30.000Z'),
      });
      const apiServer = makeServer();

      const detail = await authed(request(apiServer.app).get(`/api/agent/raw/${targetRawId}`));
      expect(detail.status).toBe(200);
      expect(detail.body.source_id).toBe('target');

      const windowResponse = await authed(
        request(apiServer.app).get(`/api/agent/raw/${targetRawId}/window?before=1&after=1`)
      );
      expect(windowResponse.status).toBe(200);
      expect(
        windowResponse.body.items.map((item: { source_id: string }) => item.source_id)
      ).toEqual(['before', 'target', 'after']);
    });
  });

  describe('PR3B exact observation reads', () => {
    it('returns the exact current observation ref and hides observations outside envelope scope', async () => {
      const rawId = seedRaw({
        sourceId: 'observation-visible',
        content: 'exact observation body',
        timestampMs: Date.parse('2026-04-20T12:00:00.000Z'),
      });
      const hiddenRawId = seedRaw({
        sourceId: 'observation-hidden',
        content: 'hidden observation body',
        timestampMs: Date.parse('2026-04-20T12:01:00.000Z'),
        scopeId: 'beta',
      });
      const visibleRow = getAdapter()
        .prepare(
          'SELECT current_observation_id FROM connector_event_index WHERE event_index_id = ?'
        )
        .get(rawId) as { current_observation_id: string };
      const hiddenRow = getAdapter()
        .prepare(
          'SELECT current_observation_id FROM connector_event_index WHERE event_index_id = ?'
        )
        .get(hiddenRawId) as { current_observation_id: string };
      const apiServer = makeServer();

      const search = await authed(
        request(apiServer.app).get('/api/agent/raw/search-all?query=observation')
      );
      expect(search.status).toBe(200);
      expect(search.body.hits).toContainEqual(
        expect.objectContaining({
          raw_id: rawId,
          observation_ref: visibleRow.current_observation_id,
        })
      );
      const visible = await authed(
        request(apiServer.app).get('/api/agent/observations/' + visibleRow.current_observation_id)
      );
      expect(visible.status).toBe(200);
      expect(visible.body).toMatchObject({
        status: 'available',
        body: 'exact observation body',
        observation: { observationId: visibleRow.current_observation_id },
      });
      const hidden = await authed(
        request(apiServer.app).get('/api/agent/observations/' + hiddenRow.current_observation_id)
      );
      expect(hidden.status).toBe(404);
      expect(JSON.stringify(hidden.body)).not.toContain(hiddenRow.current_observation_id);
    });

    it('uses signed principal plus agent and connector channel authority before reading a body', async () => {
      const visibleRawId = seedRaw({
        sourceId: 'observation-channel-visible',
        channel: 'C1',
        timestampMs: Date.parse('2026-04-20T12:02:00.000Z'),
      });
      const hiddenRawId = seedRaw({
        sourceId: 'observation-channel-hidden',
        channel: 'C2',
        timestampMs: Date.parse('2026-04-20T12:03:00.000Z'),
      });
      const malformedRawId = seedRaw({
        connector: 'discord',
        sourceId: 'observation-connector-hidden-malformed',
        channel: 'C1',
        timestampMs: Date.parse('2026-04-20T12:04:00.000Z'),
      });
      const rows = getAdapter()
        .prepare(
          `SELECT event_index_id, current_observation_id FROM connector_event_index
           WHERE event_index_id IN (?, ?, ?)`
        )
        .all(visibleRawId, hiddenRawId, malformedRawId) as Array<{
        event_index_id: string;
        current_observation_id: string;
      }>;
      const refs = Object.fromEntries(
        rows.map((row) => [row.event_index_id, row.current_observation_id])
      );
      getAdapter()
        .prepare('UPDATE observation_versions SET metadata_json = ? WHERE observation_id = ?')
        .run('{malformed', refs[malformedRawId]);
      expect(
        isObservationVersionVisible(getAdapter(), refs[hiddenRawId]!, {
          principalId: 'principal-m4',
          agentId: 'worker-m4',
          scopes: [{ kind: 'project', id: 'alpha' }],
          connectors: ['slack'],
          channels: { slack: ['C1'] },
        })
      ).toBe(false);
      const apiServer = makeServer({}, () => ({ slack: ['C1'] }));

      expect(
        (await authed(request(apiServer.app).get(`/api/agent/observations/${refs[visibleRawId]}`)))
          .status
      ).toBe(200);
      const hidden = await authed(
        request(apiServer.app).get(`/api/agent/observations/${refs[hiddenRawId]}`)
      );
      const malformedHidden = await authed(
        request(apiServer.app).get(`/api/agent/observations/${refs[malformedRawId]}`)
      );
      const unknown = await authed(
        request(apiServer.app).get('/api/agent/observations/obs_unknown')
      );
      expect([hidden.status, hidden.body]).toEqual([unknown.status, unknown.body]);
      expect([malformedHidden.status, malformedHidden.body]).toEqual([
        unknown.status,
        unknown.body,
      ]);
    });

    it('dereferences owner input only for the matching signed principal and agent', async () => {
      validEnvelope = makeEnvelope({
        agent_id: 'owner-agent',
        source: 'slack',
        channel_id: 'C1',
        scope: {
          principal_id: 'principal-owner',
          project_refs: [{ kind: 'project', id: 'alpha' }],
          raw_connectors: ['slack'],
          memory_scopes: [{ kind: 'project', id: 'alpha' }],
          allowed_destinations: [],
        },
      });
      authority.persist(validEnvelope);
      const observation = appendObservationVersion(getAdapter(), {
        sourceConnector: 'owner-message:slack',
        sourceId: 'owner-delivery',
        producerVersionId: 'owner-delivery',
        body: 'owner input',
        observedAt: 80,
        contentHash: 'owner-content-hash',
        scope: {
          visibility: 'owner',
          principalId: 'principal-owner',
          agentId: 'owner-agent',
          channel: 'C1',
        },
      });
      const apiServer = makeServer({}, () => ({}));
      const visible = await authed(
        request(apiServer.app).get(`/api/agent/observations/${observation.observationId}`)
      );
      expect(visible.status).toBe(200);
      expect(visible.body.body).toBe('owner input');
      const productionScheduler = new CronScheduler();
      try {
        const production = createApiServer({
          scheduler: productionScheduler,
          memoryDb: getAdapter(),
          envelopeAuthority: authority,
          connectorConfigLoadResult: { ok: true, config: {}, enabledNames: [] },
        });
        const productionVisible = await authed(
          request(production.app).get(`/api/agent/observations/${observation.observationId}`)
        );
        expect(productionVisible.status).toBe(200);
      } finally {
        productionScheduler.shutdown();
      }
      const search = await authed(
        request(apiServer.app).get('/api/agent/observations/search?query=owner')
      );
      expect(search.status).toBe(200);
      expect(search.body.items).toEqual([
        expect.objectContaining({ observationRef: observation.observationId }),
      ]);

      validEnvelope = makeEnvelope({
        agent_id: 'owner-agent',
        source: 'slack',
        channel_id: 'C1',
        scope: {
          principal_id: 'principal-other',
          project_refs: [{ kind: 'project', id: 'alpha' }],
          raw_connectors: ['slack'],
          memory_scopes: [{ kind: 'project', id: 'alpha' }],
          allowed_destinations: [],
        },
      });
      authority.persist(validEnvelope);
      const hidden = await authed(
        request(apiServer.app).get(`/api/agent/observations/${observation.observationId}`)
      );
      expect(hidden.status).toBe(404);
      expect(hidden.body).toEqual({ error: true, code: 'observation_not_found' });

      validEnvelope = makeEnvelope({
        agent_id: 'owner-agent',
        source: 'discord',
        channel_id: 'C2',
        scope: {
          principal_id: 'principal-owner',
          project_refs: [{ kind: 'project', id: 'alpha' }],
          raw_connectors: ['slack', 'discord'],
          memory_scopes: [{ kind: 'project', id: 'alpha' }],
          allowed_destinations: [],
        },
      });
      authority.persist(validEnvelope);
      const otherSource = await authed(
        request(apiServer.app).get(`/api/agent/observations/${observation.observationId}`)
      );
      const unknown = await authed(
        request(apiServer.app).get('/api/agent/observations/obs-owner-unknown')
      );
      expect([otherSource.status, otherSource.body]).toEqual([unknown.status, unknown.body]);
    });

    it('keeps owner search authorization bound to each connector-channel pair', async () => {
      for (const connector of ['slack', 'discord']) {
        appendObservationVersion(getAdapter(), {
          sourceConnector: `owner-message:${connector}`,
          sourceId: `${connector}-colliding-channel`,
          producerVersionId: `${connector}-colliding-channel`,
          body: 'paired channel search',
          observedAt: connector === 'slack' ? 90 : 91,
          contentHash: `hash-${connector}-colliding-channel`,
          scope: {
            visibility: 'owner',
            principalId: 'principal-paired',
            agentId: 'owner-agent',
            channel: 'C1',
          },
        });
      }
      validEnvelope = makeEnvelope({
        agent_id: 'owner-agent',
        source: 'slack',
        channel_id: 'C1',
        scope: {
          principal_id: 'principal-paired',
          project_refs: [{ kind: 'project', id: 'alpha' }],
          raw_connectors: ['slack', 'discord'],
          memory_scopes: [{ kind: 'project', id: 'alpha' }],
          allowed_destinations: [],
        },
      });
      authority.persist(validEnvelope);
      const response = await authed(
        request(makeServer().app).get('/api/agent/observations/search?query=paired')
      );
      expect(response.status).toBe(200);
      expect(response.body.items).toMatchObject([{ sourceConnector: 'owner-message:slack' }]);
    });

    it('pages bounded owner previews and keeps exact GET as the full-body reader', async () => {
      validEnvelope = makeEnvelope({
        agent_id: 'worker',
        source: 'slack',
        channel_id: 'C1',
        scope: {
          principal_id: 'principal-page-owner',
          project_refs: [{ kind: 'project', id: 'alpha' }],
          raw_connectors: ['slack'],
          memory_scopes: [{ kind: 'project', id: 'alpha' }],
          allowed_destinations: [],
        },
      });
      authority.persist(validEnvelope);
      const conversationDb = new Database(':memory:');
      const conversationStore = new SessionStore(conversationDb);
      const longResult = `pageable result ${'x'.repeat(700)}`;
      const recordInlineObservation = (input: {
        sourceConnector: string;
        sourceId: string;
        body: string;
        author: string | null;
        observedAt: number;
        metadata: Record<string, unknown>;
        scope: Record<string, unknown>;
      }): string => {
        const candidate = {
          ...input,
          contentHash: createHash('sha256').update(input.body, 'utf8').digest('hex'),
          producerVersionId: input.sourceId,
        };
        const id = observationVersionId(candidate);
        const existing = getObservationVersion(getAdapter(), id);
        return appendObservationVersion(getAdapter(), {
          ...candidate,
          observedAt: existing?.observedAt ?? candidate.observedAt,
        }).observationId;
      };
      const router = new MessageRouter(
        conversationStore,
        { run: async () => ({ response: longResult }) },
        createMockMamaApi([]),
        {},
        undefined,
        undefined,
        { recordInlineObservation }
      );
      const principal = {
        class: 'owner' as const,
        lane: 'owner' as const,
        canonicalId: 'slack:workspace:page-owner',
        principalId: 'principal-page-owner',
        consoleEligible: true,
      };
      try {
        for (const messageId of ['page-message-1', 'page-message-2']) {
          await router.processTurn({
            source: 'slack',
            channelId: 'C1',
            userId: 'page-owner',
            text: `pageable input ${messageId}`,
            metadata: { messageId },
            principal,
          });
        }
        const apiServer = makeServer({}, () => ({}));
        const first = await authed(
          request(apiServer.app).get(
            `/api/agent/observations/search?query=pageable&limit=1&from=0&to=${Date.now() + 1_000}`
          )
        );
        expect(first.status).toBe(200);
        expect(first.body.items).toHaveLength(1);
        expect(first.body.items[0]).not.toHaveProperty('body');
        expect(first.body.items[0].contentPreview.length).toBeLessThanOrEqual(500);
        expect(first.body.nextCursor).toEqual(expect.any(String));
        const second = await authed(
          request(apiServer.app).get(
            `/api/agent/observations/search?query=pageable&limit=1&cursor=${encodeURIComponent(
              first.body.nextCursor
            )}`
          )
        );
        expect(second.status).toBe(200);
        expect(second.body.items).toHaveLength(1);
        expect(second.body.items[0].observationRef).not.toBe(first.body.items[0].observationRef);

        const session = conversationStore.getOrCreate('slack', 'C1', 'page-owner');
        const resultRef = conversationStore.getHistory(session.id).at(-1)?.resultObservationRef;
        expect(resultRef).toEqual(expect.any(String));
        const exact = await authed(
          request(apiServer.app).get(`/api/agent/observations/${resultRef}`)
        );
        expect(exact.status).toBe(200);
        expect(exact.body.body).toBe(longResult);
        expect(exact.body.body.length).toBeGreaterThan(500);
      } finally {
        conversationStore.close();
      }
    });
  });

  describe('AC: /:rawId/revisions returns the entity change history, envelope-scoped', () => {
    it('returns the anchor entity revisions oldest-first and excludes out-of-scope revisions', async () => {
      const t = Date.parse('2026-09-07T00:00:00.000Z');
      seedRaw({ sourceId: 'doc:v1', entityId: 'doc', content: 'rawapi v1', timestampMs: t });
      const anchor = seedRaw({
        sourceId: 'doc:v2',
        entityId: 'doc',
        content: 'rawapi v2',
        timestampMs: t + 1000,
      });
      seedRaw({
        sourceId: 'doc:v3',
        entityId: 'doc',
        content: 'rawapi v3',
        timestampMs: t + 2000,
        scopeId: 'beta',
      });
      const apiServer = makeServer();

      const response = await authed(
        request(apiServer.app).get(`/api/agent/raw/${anchor}/revisions`)
      );
      expect(response.status).toBe(200);
      expect(response.body.hits.map((h: { source_id: string }) => h.source_id)).toEqual([
        'doc:v1',
        'doc:v2',
      ]);
    });

    it('returns no revisions for an anchor the envelope cannot see', async () => {
      const t = Date.parse('2026-09-07T00:00:00.000Z');
      const hidden = seedRaw({
        sourceId: 'sec:v1',
        entityId: 'sec',
        content: 'rawapi secret',
        timestampMs: t,
        scopeId: 'beta',
      });
      const apiServer = makeServer();

      const response = await authed(
        request(apiServer.app).get(`/api/agent/raw/${hidden}/revisions`)
      );
      expect(response.status).toBe(200);
      expect(response.body.hits).toEqual([]);
    });
  });

  describe('AC #4: browser preflight can carry worker envelope headers', () => {
    it('allows x-mama-envelope-hash in localhost CORS preflight requests', async () => {
      const scheduler = new CronScheduler();
      try {
        const apiServer = createApiServer({ scheduler, port: 0 });

        const response = await request(apiServer.app)
          .options('/api/agent/raw/search-all?query=rawapi')
          .set('Origin', 'http://localhost:5173')
          .set('Access-Control-Request-Method', 'GET')
          .set('Access-Control-Request-Headers', 'x-mama-envelope-hash, authorization');

        expect(response.status).toBe(204);
        expect(response.headers['access-control-allow-headers']).toContain('x-mama-envelope-hash');
      } finally {
        scheduler.shutdown();
      }
    });
  });
});
