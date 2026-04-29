import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

import {
  AGENT_SITUATION_V0_POLICY_VERSION,
  beginModelRunInAdapter,
  buildAgentSituationPacketRecord,
  buildAgentSituationCacheKey,
  commitModelRunInAdapter,
  type AgentSituationInput,
  type AgentSituationPacketRecord,
} from '../../../mama-core/src/index.js';
import { getAdapter } from '../../../mama-core/src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../../mama-core/src/test-utils.js';

import Database from '../../src/sqlite.js';
import {
  createAgentSituationRouter,
  type AgentSituationRouterOptions,
} from '../../src/api/agent-situation-handler.js';
import { createApiServer } from '../../src/api/index.js';
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
  key: Buffer.from('agent-situation-api-test-key!!'),
};

const FIXED_NOW_MS = Date.parse('2026-04-29T03:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function makeEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return signEnvelope(
    {
      agent_id: 'worker-m5',
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

describe('Story M5.2: /api/agent/situation worker packet API', () => {
  const originalAuthToken = process.env.MAMA_AUTH_TOKEN;
  let testDbPath = '';
  let sessionsDb: Database;
  let authority: EnvelopeAuthority;
  let validEnvelope: Envelope;

  beforeAll(async () => {
    testDbPath = await initTestDB('agent-situation-api');
  });

  beforeEach(() => {
    process.env.MAMA_AUTH_TOKEN = 'agent-situation-token';
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM agent_situation_refresh_leases').run();
    adapter.prepare('DELETE FROM agent_situation_packets').run();
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

  function makeServer(overrides: Partial<AgentSituationRouterOptions> = {}) {
    const app = express();
    app.use('/api', requireAuth);
    app.use(
      '/api/agent/situation',
      createAgentSituationRouter({
        memoryAdapter: getAdapter(),
        envelopeAuthority: authority,
        now: () => FIXED_NOW_MS,
        ...overrides,
      })
    );
    return { app };
  }

  function authed(req: request.Test): request.Test {
    return req
      .set(TUNNEL_HEADERS)
      .set('Authorization', 'Bearer agent-situation-token')
      .set('x-mama-envelope-hash', validEnvelope.envelope_hash);
  }

  function waitForMicrotask(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  function defaultSituationCacheKey(): string {
    return buildAgentSituationCacheKey({
      scopes: [{ kind: 'project', id: 'alpha' }],
      connectors: ['slack'],
      project_refs: [{ kind: 'project', id: 'alpha' }],
      tenant_id: 'default',
      as_of: null,
      range_start_ms: FIXED_NOW_MS - 7 * DAY_MS,
      range_end_ms: FIXED_NOW_MS,
      focus: ['decisions', 'risks', 'open_questions'],
      limit: 7,
      ranking_policy_version: AGENT_SITUATION_V0_POLICY_VERSION,
    }).cacheKey;
  }

  describe('AC #1: worker envelope gates packet visibility', () => {
    it('rejects missing envelopes and requested scopes outside the envelope', async () => {
      const apiServer = makeServer();

      const missing = await request(apiServer.app)
        .get('/api/agent/situation')
        .set(TUNNEL_HEADERS)
        .set('Authorization', 'Bearer agent-situation-token');
      expect(missing.status).toBe(401);
      expect(missing.body.code).toBe('worker_envelope_missing');

      const scopeOutside = await authed(
        request(apiServer.app).get('/api/agent/situation?scopes=project%3Abeta')
      );
      expect(scopeOutside.status).toBe(403);
      expect(scopeOutside.body.code).toBe('worker_envelope_scope_denied');
    });

    it('rejects malformed scope tokens instead of widening to the full envelope', async () => {
      const apiServer = makeServer();

      const malformedToken = await authed(
        request(apiServer.app).get('/api/agent/situation?scopes=project')
      );
      expect(malformedToken.status).toBe(400);
      expect(malformedToken.body.code).toBe('worker_scope_invalid');

      const missingId = await authed(
        request(apiServer.app).get('/api/agent/situation?scope_kind=project')
      );
      expect(missingId.status).toBe(400);
      expect(missingId.body.code).toBe('worker_scope_invalid');
    });

    it('rejects unknown envelope hashes through the explicit invalid-envelope path', async () => {
      const apiServer = makeServer();

      const response = await request(apiServer.app)
        .get('/api/agent/situation')
        .set(TUNNEL_HEADERS)
        .set('Authorization', 'Bearer agent-situation-token')
        .set('x-mama-envelope-hash', 'env_missing');

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('worker_envelope_invalid');
    });

    it('rejects packet generation when the envelope has no effective project ref', async () => {
      validEnvelope = makeEnvelope({
        scope: {
          project_refs: [],
          raw_connectors: ['slack'],
          memory_scopes: [{ kind: 'project', id: 'alpha' }],
          allowed_destinations: [{ kind: 'slack', id: 'slack:C1' }],
        },
      });
      authority.persist(validEnvelope);
      const apiServer = makeServer();

      const response = await authed(request(apiServer.app).get('/api/agent/situation'));

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('worker_envelope_project_required');
    });

    it('rejects unavailable, expired, and connector-denied worker envelopes explicitly', async () => {
      const unavailableServer = makeServer({ envelopeAuthority: undefined });
      const unavailable = await authed(request(unavailableServer.app).get('/api/agent/situation'));
      expect(unavailable.status).toBe(503);
      expect(unavailable.body.code).toBe('worker_envelope_unavailable');

      validEnvelope = makeEnvelope({
        expires_at: new Date(Date.now() - 1_000).toISOString(),
      });
      authority.persist(validEnvelope);
      const expiredServer = makeServer();
      const expired = await authed(request(expiredServer.app).get('/api/agent/situation'));
      expect(expired.status).toBe(403);
      expect(expired.body.code).toBe('worker_envelope_expired');

      validEnvelope = makeEnvelope();
      authority.persist(validEnvelope);
      const connectorDeniedServer = makeServer();
      const connectorDenied = await authed(
        request(connectorDeniedServer.app).get('/api/agent/situation?connectors=github')
      );
      expect(connectorDenied.status).toBe(403);
      expect(connectorDenied.body.code).toBe('worker_envelope_connector_denied');
    });
  });

  describe('AC #2: packet generation is cached and model-run correlated', () => {
    it('mounts the worker packet route through createApiServer', async () => {
      const scheduler = new CronScheduler();
      const apiServer = createApiServer({
        scheduler,
        port: 0,
        memoryAdapter: getAdapter(),
        envelopeAuthority: authority,
        situationNow: () => FIXED_NOW_MS,
      });

      try {
        const response = await authed(request(apiServer.app).get('/api/agent/situation'));

        expect(response.status).toBe(200);
        expect(response.body.packet_id).toMatch(/^situ_/);
        expect(response.body.cache.hit).toBe(false);
      } finally {
        scheduler.shutdown();
      }
    });

    it('creates a committed direct model run on cache miss and reuses fresh cache without a new run', async () => {
      const buildPacket = vi.fn(
        (adapter, input: AgentSituationInput): AgentSituationPacketRecord =>
          buildAgentSituationPacketRecord(adapter, input)
      );
      const apiServer = makeServer({ buildPacket });

      const first = await authed(
        request(apiServer.app).get('/api/agent/situation?range=7d&focus=decisions,raw&limit=5')
      );

      expect(first.status).toBe(200);
      expect(first.body.packet_id).toMatch(/^situ_/);
      expect(first.body.scope).toEqual([{ kind: 'project', id: 'alpha' }]);
      expect(first.body.ranking_policy_version).toBe(AGENT_SITUATION_V0_POLICY_VERSION);
      expect(first.body.cache.hit).toBe(false);
      expect(first.body.cache.cache_key).toEqual(expect.any(String));
      expect(first.body.cache.expires_at).toBe('2026-04-29T03:02:00.000Z');
      expect(buildPacket).toHaveBeenCalledTimes(1);

      const firstRuns = getAdapter()
        .prepare('SELECT model_run_id, status, envelope_hash FROM model_runs ORDER BY created_at')
        .all() as Array<{ model_run_id: string; status: string; envelope_hash: string }>;
      expect(firstRuns).toHaveLength(1);
      expect(firstRuns[0].status).toBe('committed');
      expect(firstRuns[0].envelope_hash).toBe(validEnvelope.envelope_hash);

      const second = await authed(
        request(apiServer.app).get('/api/agent/situation?range=7d&focus=decisions,raw&limit=5')
      );

      expect(second.status).toBe(200);
      expect(second.body.packet_id).toBe(first.body.packet_id);
      expect(second.body.cache.hit).toBe(true);
      expect(buildPacket).toHaveBeenCalledTimes(1);

      const secondRuns = getAdapter().prepare('SELECT model_run_id FROM model_runs').all();
      expect(secondRuns).toHaveLength(1);
    });

    it('reuses the default-range cache while a packet is fresh when request time advances', async () => {
      let currentNowMs = FIXED_NOW_MS;
      const buildPacket = vi.fn(
        (adapter, input: AgentSituationInput): AgentSituationPacketRecord =>
          buildAgentSituationPacketRecord(adapter, input)
      );
      const apiServer = makeServer({
        buildPacket,
        now: () => currentNowMs,
      });

      const first = await authed(request(apiServer.app).get('/api/agent/situation'));
      currentNowMs += 7;
      const second = await authed(request(apiServer.app).get('/api/agent/situation'));

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.packet_id).toBe(first.body.packet_id);
      expect(second.body.cache.hit).toBe(true);
      expect(second.body.range_end).toBe(first.body.range_end);
      expect(buildPacket).toHaveBeenCalledTimes(1);
      expect(getAdapter().prepare('SELECT model_run_id FROM model_runs').all()).toHaveLength(1);
    });

    it('stores and serves canonical scope shape for equivalent duplicate-scope requests', async () => {
      const buildPacket = vi.fn(
        (adapter, input: AgentSituationInput): AgentSituationPacketRecord =>
          buildAgentSituationPacketRecord(adapter, input)
      );
      const apiServer = makeServer({ buildPacket });

      const duplicateScopes = await authed(
        request(apiServer.app).get('/api/agent/situation?scopes=project%3Aalpha,project%3Aalpha')
      );
      const canonicalScope = await authed(
        request(apiServer.app).get('/api/agent/situation?scopes=project%3Aalpha')
      );

      expect(duplicateScopes.status).toBe(200);
      expect(canonicalScope.status).toBe(200);
      expect(duplicateScopes.body.scope).toEqual([{ kind: 'project', id: 'alpha' }]);
      expect(canonicalScope.body.packet_id).toBe(duplicateScopes.body.packet_id);
      expect(canonicalScope.body.scope).toEqual([{ kind: 'project', id: 'alpha' }]);
      expect(canonicalScope.body.cache.hit).toBe(true);
      expect(buildPacket).toHaveBeenCalledTimes(1);
    });

    it('rejects a supplied model run whose envelope hash does not match the worker envelope', async () => {
      const adapter = getAdapter();
      beginModelRunInAdapter(adapter, {
        model_run_id: 'mr_mismatch',
        agent_id: 'worker-m5',
        envelope_hash: 'other-envelope',
        input_refs: { test: true },
      });
      const apiServer = makeServer();

      const response = await authed(
        request(apiServer.app).get('/api/agent/situation').set('x-mama-model-run-id', 'mr_mismatch')
      );

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('agent_situation_model_run_denied');
    });

    it('rejects supplied model runs from unrelated same-envelope work', async () => {
      const adapter = getAdapter();
      beginModelRunInAdapter(adapter, {
        model_run_id: 'mr_unrelated',
        agent_id: validEnvelope.agent_id,
        instance_id: validEnvelope.instance_id,
        envelope_hash: validEnvelope.envelope_hash,
        input_snapshot_ref: 'memory:unrelated',
        input_refs: { tool: 'memory.write' },
      });
      const apiServer = makeServer();

      const response = await authed(
        request(apiServer.app)
          .get('/api/agent/situation')
          .set('x-mama-model-run-id', 'mr_unrelated')
      );

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('agent_situation_model_run_denied');
    });

    it('rejects terminal supplied model runs for the matching situation cache key', async () => {
      const adapter = getAdapter();
      const cacheKey = defaultSituationCacheKey();
      beginModelRunInAdapter(adapter, {
        model_run_id: 'mr_terminal_situation',
        agent_id: validEnvelope.agent_id,
        instance_id: validEnvelope.instance_id,
        envelope_hash: validEnvelope.envelope_hash,
        input_snapshot_ref: `situation:${cacheKey}`,
        input_refs: { tool: 'agent.situation', cache_key: cacheKey },
      });
      commitModelRunInAdapter(adapter, 'mr_terminal_situation', 'already used');
      const apiServer = makeServer();

      const response = await authed(
        request(apiServer.app)
          .get('/api/agent/situation')
          .set('x-mama-model-run-id', 'mr_terminal_situation')
      );

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('agent_situation_model_run_not_running');
    });

    it('marks an owned direct model run failed when packet generation throws', async () => {
      const buildPacket = vi.fn(() => {
        throw new Error('builder exploded');
      });
      const apiServer = makeServer({ buildPacket });

      const response = await authed(
        request(apiServer.app).get('/api/agent/situation?range=7d&refresh=true')
      );

      expect(response.status).toBe(500);
      expect(response.body.code).toBe('agent_situation_api_error');
      expect(buildPacket).toHaveBeenCalledTimes(1);

      const runs = getAdapter()
        .prepare('SELECT status, error_summary FROM model_runs ORDER BY created_at')
        .all() as Array<{ status: string; error_summary: string }>;
      expect(runs).toEqual([{ status: 'failed', error_summary: 'builder exploded' }]);
    });

    it('removes the just-created packet when committing an owned direct model run fails', async () => {
      const baseAdapter = getAdapter();
      const commitFailingAdapter: AgentSituationRouterOptions['memoryAdapter'] = {
        prepare(sql: string) {
          const statement = baseAdapter.prepare(sql);
          if (sql.includes("SET status = 'committed'")) {
            return {
              run: (..._args: unknown[]) => {
                throw new Error('commit store unavailable');
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

      const response = await authed(request(apiServer.app).get('/api/agent/situation'));

      expect(response.status).toBe(500);
      expect(response.body.code).toBe('agent_situation_api_error');
      expect(
        getAdapter().prepare('SELECT COUNT(*) AS count FROM agent_situation_packets').get()
      ).toEqual({ count: 0 });
      expect(
        getAdapter()
          .prepare('SELECT status, error_summary FROM model_runs ORDER BY created_at')
          .all()
      ).toEqual([{ status: 'failed', error_summary: 'commit store unavailable' }]);
    });

    it('singleflights concurrent API refreshes for the same cache key', async () => {
      let releaseBuilder!: () => void;
      const builderGate = new Promise<void>((resolve) => {
        releaseBuilder = resolve;
      });
      const buildPacket = vi.fn(async (adapter, input: AgentSituationInput) => {
        await builderGate;
        return buildAgentSituationPacketRecord(adapter, input);
      });
      const apiServer = makeServer({ buildPacket });

      const responsesPromise = Promise.all(
        Array.from({ length: 5 }, () =>
          authed(request(apiServer.app).get('/api/agent/situation?range=7d&refresh=true'))
        )
      );
      while (buildPacket.mock.calls.length === 0) {
        await waitForMicrotask();
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      releaseBuilder();
      const responses = await responsesPromise;

      expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
      expect(buildPacket).toHaveBeenCalledTimes(1);
      expect(new Set(responses.map((response) => response.body.packet_id)).size).toBe(1);
      expect(getAdapter().prepare('SELECT COUNT(*) AS count FROM model_runs').get()).toEqual({
        count: 1,
      });
    });
  });

  describe('AC #3: query parsing is strict', () => {
    it('rejects malformed limit and focus query values without coercion', async () => {
      const apiServer = makeServer();

      const badLimit = await authed(request(apiServer.app).get('/api/agent/situation?limit=10abc'));
      expect(badLimit.status).toBe(400);
      expect(badLimit.body.code).toBe('agent_situation_query_invalid');

      const badFocus = await authed(
        request(apiServer.app).get('/api/agent/situation?focus=decisions,unknown')
      );
      expect(badFocus.status).toBe(400);
      expect(badFocus.body.code).toBe('agent_situation_query_invalid');
    });

    it('rejects invalid envelope as_of before cache key, packet, or model-run work', async () => {
      validEnvelope = makeEnvelope({
        scope: {
          project_refs: [{ kind: 'project', id: 'alpha' }],
          raw_connectors: ['slack'],
          memory_scopes: [{ kind: 'project', id: 'alpha' }],
          allowed_destinations: [{ kind: 'slack', id: 'slack:C1' }],
          as_of: 'not-a-date',
        },
      });
      authority.persist(validEnvelope);
      const buildPacket = vi.fn(
        (adapter, input: AgentSituationInput): AgentSituationPacketRecord =>
          buildAgentSituationPacketRecord(adapter, input)
      );
      const apiServer = makeServer({ buildPacket });

      const response = await authed(request(apiServer.app).get('/api/agent/situation'));

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('worker_envelope_as_of_invalid');
      expect(buildPacket).not.toHaveBeenCalled();
      expect(getAdapter().prepare('SELECT COUNT(*) AS count FROM model_runs').get()).toEqual({
        count: 0,
      });
      expect(
        getAdapter().prepare('SELECT COUNT(*) AS count FROM agent_situation_packets').get()
      ).toEqual({ count: 0 });
    });
  });
});
