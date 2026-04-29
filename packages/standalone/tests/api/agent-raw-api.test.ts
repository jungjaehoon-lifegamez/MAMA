import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

import { getAdapter } from '../../../mama-core/src/db-manager.js';
import { upsertConnectorEventIndex } from '../../../mama-core/src/connectors/event-index.js';
import * as rawQuery from '../../../mama-core/src/connectors/raw-query.js';
import { cleanupTestDB, initTestDB } from '../../../mama-core/src/test-utils.js';

import Database from '../../src/sqlite.js';
import { createApiServer } from '../../src/api/index.js';
import {
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
  channel?: string;
  content?: string;
  timestampMs: number;
  scopeId?: string;
}): string {
  const saved = upsertConnectorEventIndex(getAdapter(), {
    source_connector: overrides.connector ?? 'slack',
    source_type: 'message',
    source_id: overrides.sourceId,
    source_locator: `${overrides.connector ?? 'slack'}:${overrides.channel ?? 'general'}:${overrides.sourceId}`,
    channel: overrides.channel ?? 'general',
    author: 'alice',
    content: overrides.content ?? 'rawapi searchable content',
    event_datetime: overrides.timestampMs,
    source_timestamp_ms: overrides.timestampMs,
    memory_scope_kind: 'project',
    memory_scope_id: overrides.scopeId ?? 'alpha',
    metadata: { seeded: overrides.sourceId },
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

  function makeServer(rawQueryOverrides: Partial<AgentRawRouterOptions['rawQuery']> = {}) {
    const app = express();
    app.use('/api', requireAuth);
    app.use(
      '/api/agent/raw',
      createAgentRawRouter({
        memoryDb: getAdapter(),
        envelopeAuthority: authority,
        rawQuery: { ...rawQuery, ...rawQueryOverrides },
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
