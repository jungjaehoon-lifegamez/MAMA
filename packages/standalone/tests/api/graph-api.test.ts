import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import request from 'supertest';
import Database from '../../src/sqlite.js';
import { createApiServer, type RuntimeStatusSnapshot } from '../../src/api/index.js';
import { projectRuntimeConnectors } from '../../src/cli/runtime/api-server-init.js';
import { CronScheduler } from '../../src/scheduler/index.js';
import { initValidationTables, createValidationSession } from '../../src/validation/store.js';
import * as validationStore from '../../src/validation/store.js';
import { initAgentTables } from '../../src/db/agent-store.js';

import {
  DEFAULT_GRAPH_LIMIT,
  buildGraphMeta,
  filterEdgesByNodes,
  mapDecisionRowToGraphNode,
  migrateLegacyManagedBackends,
  parseGraphLimit,
  validateConfigUpdate,
  createGraphHandler,
} from '../../src/api/graph-api.js';

const RUNTIME_SNAPSHOT: RuntimeStatusSnapshot = {
  running: true,
  version: '9.8.7',
  backend: 'codex',
  model: 'synthetic-model',
  startedAt: 1000,
  health: { score: 98, status: 'healthy' },
  connectors: [{ name: 'telegram', enabled: true, state: 'connected' }],
};

describe('graph api helpers', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initAgentTables(db);
    initValidationTables(db);
  });

  it('should map decision rows to lightweight overview nodes', () => {
    const node = mapDecisionRowToGraphNode({
      id: 'decision_1',
      topic: 'topic_one',
      decision: 'A'.repeat(400),
      reasoning: 'B'.repeat(800),
      outcome: 'success',
      confidence: 0.9,
      created_at: 123,
    });

    expect(node.id).toBe('decision_1');
    expect(node.topic).toBe('topic_one');
    expect(node.outcome).toBe('success');
    expect(node.confidence).toBe(0.9);
    expect(node.created_at).toBe(123);
    expect(node.decision).toBeUndefined();
    expect(node.reasoning).toBeUndefined();
    expect(node.decision_preview?.length).toBeLessThanOrEqual(223);
  });

  describe('retained shared backend routes', () => {
    it('keeps fixed runtime serialization, report, source, and health routes mounted', async () => {
      const scheduler = new CronScheduler();
      const memoryDb = new Database(':memory:');
      const noisySnapshot = {
        ...RUNTIME_SNAPSHOT,
        secret: 'supplier-extra-value',
        entrypoint: '/synthetic/runtime-entry.js',
      } as unknown as RuntimeStatusSnapshot;

      try {
        const apiServer = createApiServer({
          scheduler,
          port: 0,
          memoryDb,
          getRuntimeStatus: () => noisySnapshot,
        });

        const runtime = await request(apiServer.app).get('/api/runtime/status');
        expect(runtime.status).toBe(200);
        expect(runtime.body).toEqual(RUNTIME_SNAPSHOT);
        expect(JSON.stringify(runtime.body)).not.toContain('supplier-extra-value');
        expect((await request(apiServer.app).get('/api/report')).status).toBe(200);
        expect(
          (await request(apiServer.app).get('/api/agent/raw/search?query=alpha')).status
        ).not.toBe(404);
        expect((await request(apiServer.app).get('/api/metrics/health')).status).toBe(503);
        expect((await request(apiServer.app).get('/health')).status).toBe(200);
      } finally {
        scheduler.shutdown();
        memoryDb.close();
      }
    });

    it('requires authentication for a tunneled runtime-status request', async () => {
      const originalAuthToken = process.env.MAMA_AUTH_TOKEN;
      const scheduler = new CronScheduler();
      process.env.MAMA_AUTH_TOKEN = 'synthetic-test-token';
      try {
        const apiServer = createApiServer({
          scheduler,
          port: 0,
          getRuntimeStatus: () => RUNTIME_SNAPSHOT,
        });
        const response = await request(apiServer.app)
          .get('/api/runtime/status')
          .set('cf-connecting-ip', '198.51.100.7')
          .set('x-forwarded-for', '198.51.100.7');

        expect(response.status).toBe(401);

        const authenticated = await request(apiServer.app)
          .get('/api/runtime/status')
          .set('cf-connecting-ip', '198.51.100.7')
          .set('x-forwarded-for', '198.51.100.7')
          .set('Authorization', 'Bearer synthetic-test-token');
        expect(authenticated.status).toBe(200);
        expect(authenticated.body).toEqual(RUNTIME_SNAPSHOT);
      } finally {
        scheduler.shutdown();
        if (originalAuthToken === undefined) {
          delete process.env.MAMA_AUTH_TOKEN;
        } else {
          process.env.MAMA_AUTH_TOKEN = originalAuthToken;
        }
      }
    });

    it('does not mount runtime status without an authoritative supplier', async () => {
      const scheduler = new CronScheduler();
      try {
        const response = await request(createApiServer({ scheduler, port: 0 }).app).get(
          '/api/runtime/status'
        );
        expect(response.status).not.toBe(200);
      } finally {
        scheduler.shutdown();
      }
    });

    it('serializes nullable health without fabricating a score', async () => {
      const scheduler = new CronScheduler();
      try {
        const apiServer = createApiServer({
          scheduler,
          port: 0,
          getRuntimeStatus: () => ({ ...RUNTIME_SNAPSHOT, health: null }),
        });
        const response = await request(apiServer.app).get('/api/runtime/status');

        expect(response.status).toBe(200);
        expect(response.body.health).toBeNull();
      } finally {
        scheduler.shutdown();
      }
    });

    it('answers 503 with the stable code when the synchronous supplier fails', async () => {
      const scheduler = new CronScheduler();
      try {
        const apiServer = createApiServer({
          scheduler,
          port: 0,
          getRuntimeStatus: () => {
            throw new Error('synthetic status failure');
          },
        });
        const response = await request(apiServer.app).get('/api/runtime/status');

        expect(response.status).toBe(503);
        expect(response.body.code).toBe('runtime_status_unavailable');
      } finally {
        scheduler.shutdown();
      }
    });

    it('projects configured connectors with their registration state', () => {
      expect(
        projectRuntimeConnectors(
          {
            ok: true,
            config: {
              telegram: { enabled: true },
              slack: { enabled: true },
              discord: { enabled: false },
            },
            enabledNames: ['telegram', 'slack'],
          } as never,
          ['telegram']
        )
      ).toEqual([
        { name: 'slack', enabled: true, state: 'unknown' },
        { name: 'telegram', enabled: true, state: 'connected' },
        { name: 'discord', enabled: false, state: 'disconnected' },
      ]);
    });

    it('projects no connectors when none are configured', () => {
      expect(
        projectRuntimeConnectors({ ok: true, config: {}, enabledNames: [] } as never, [])
      ).toEqual([]);
    });
  });

  it('should default graph limit for overview requests', () => {
    expect(parseGraphLimit(new URLSearchParams())).toBe(DEFAULT_GRAPH_LIMIT);
    expect(parseGraphLimit(new URLSearchParams('limit=120'))).toBe(120);
    expect(parseGraphLimit(new URLSearchParams('full=true'))).toBeNull();
  });

  it('should build compact graph metadata for overview responses', () => {
    expect(
      buildGraphMeta({
        totalNodes: 900,
        totalEdges: 1200,
        similarityEdges: 0,
        isPartial: true,
        returnedNodes: 300,
        returnedEdges: 180,
      })
    ).toEqual({
      total_nodes: 300,
      total_edges: 180,
      similarity_edges: 0,
      partial: true,
      total_available_nodes: 900,
      total_available_edges: 1200,
    });
  });

  it('should filter edges down to the nodes shown in a partial graph', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }] as Array<{ id: string }>;
    const edges = [
      { from: 'a', to: 'b', relationship: 'builds_on', reason: null },
      { from: 'x', to: 'y', relationship: 'builds_on', reason: null },
    ];

    const filtered = filterEdgesByNodes(edges, nodes as never);
    expect(filtered).toEqual([{ from: 'a', to: 'b', relationship: 'builds_on', reason: null }]);
  });

  it('rejects validation approval when the session belongs to another agent', async () => {
    createValidationSession(db, {
      id: 'vs-foreign',
      agent_id: 'wiki-agent',
      agent_version: 1,
      trigger_type: 'agent_test',
      metric_profile_json: '{}',
      execution_status: 'completed',
      validation_outcome: 'healthy',
      started_at: Date.now(),
      ended_at: Date.now(),
    });

    const handler = createGraphHandler({ sessionsDb: db });
    const req = {
      method: 'POST',
      url: '/api/agents/dashboard-agent/validation/approve?session_id=vs-foreign',
      headers: { host: 'localhost' },
      socket: { remoteAddress: '127.0.0.1' },
    } as IncomingMessage;
    const res = createMockRes();

    const handled = await handler(req, res as unknown as ServerResponse);

    expect(handled).toBe(true);
    expect(res._status).toBe(403);
  });

  it('returns 500 when validation approval persistence throws', async () => {
    createValidationSession(db, {
      id: 'vs-own',
      agent_id: 'dashboard-agent',
      agent_version: 1,
      trigger_type: 'agent_test',
      metric_profile_json: '{}',
      execution_status: 'completed',
      validation_outcome: 'healthy',
      started_at: Date.now(),
      ended_at: Date.now(),
    });
    const approveSpy = vi
      .spyOn(validationStore, 'approveValidationSession')
      .mockImplementation(() => {
        throw new Error('approval write failed');
      });

    const handler = createGraphHandler({ sessionsDb: db });
    const req = {
      method: 'POST',
      url: '/api/agents/dashboard-agent/validation/approve?session_id=vs-own',
      headers: { host: 'localhost' },
      socket: { remoteAddress: '127.0.0.1' },
    } as IncomingMessage;
    const res = createMockRes();

    const handled = await handler(req, res as unknown as ServerResponse);

    expect(handled).toBe(true);
    expect(res._status).toBe(500);
    expect(res._body).toContain('approval write failed');
    approveSpy.mockRestore();
  });

  it('rejects validation comparison when the session belongs to another agent', async () => {
    createValidationSession(db, {
      id: 'vs-foreign',
      agent_id: 'wiki-agent',
      agent_version: 1,
      trigger_type: 'agent_test',
      metric_profile_json: '{}',
      execution_status: 'completed',
      validation_outcome: 'healthy',
      started_at: Date.now(),
      ended_at: Date.now(),
    });

    const handler = createGraphHandler({ sessionsDb: db });
    const req = {
      method: 'GET',
      url: '/api/agents/dashboard-agent/validation/compare?session=vs-foreign&baseline=approved',
      headers: { host: 'localhost' },
      socket: { remoteAddress: '127.0.0.1' },
    } as IncomingMessage;
    const res = createMockRes();

    const handled = await handler(req, res as unknown as ServerResponse);

    expect(handled).toBe(true);
    expect(res._status).toBe(403);
  });

  it('returns 404 when an explicit baseline session does not exist', async () => {
    createValidationSession(db, {
      id: 'vs-current',
      agent_id: 'dashboard-agent',
      agent_version: 1,
      trigger_type: 'agent_test',
      metric_profile_json: '{}',
      execution_status: 'completed',
      validation_outcome: 'healthy',
      started_at: Date.now(),
      ended_at: Date.now(),
    });

    const handler = createGraphHandler({ sessionsDb: db });
    const req = {
      method: 'GET',
      url: '/api/agents/dashboard-agent/validation/compare?session=vs-current&baseline=vs-missing',
      headers: { host: 'localhost' },
      socket: { remoteAddress: '127.0.0.1' },
    } as IncomingMessage;
    const res = createMockRes();

    const handled = await handler(req, res as unknown as ServerResponse);

    expect(handled).toBe(true);
    expect(res._status).toBe(404);
    expect(res._body).toContain('baseline session not found');
  });

  it('rejects explicit baselines whose trigger type differs from the current session', async () => {
    createValidationSession(db, {
      id: 'vs-current',
      agent_id: 'dashboard-agent',
      agent_version: 1,
      trigger_type: 'agent_test',
      metric_profile_json: '{}',
      execution_status: 'completed',
      validation_outcome: 'healthy',
      started_at: Date.now(),
      ended_at: Date.now(),
    });
    createValidationSession(db, {
      id: 'vs-baseline',
      agent_id: 'dashboard-agent',
      agent_version: 1,
      trigger_type: 'delegate_run',
      metric_profile_json: '{}',
      execution_status: 'completed',
      validation_outcome: 'healthy',
      started_at: Date.now(),
      ended_at: Date.now(),
    });

    const handler = createGraphHandler({ sessionsDb: db });
    const req = {
      method: 'GET',
      url: '/api/agents/dashboard-agent/validation/compare?session=vs-current&baseline=vs-baseline',
      headers: { host: 'localhost' },
      socket: { remoteAddress: '127.0.0.1' },
    } as IncomingMessage;
    const res = createMockRes();

    const handled = await handler(req, res as unknown as ServerResponse);

    expect(handled).toBe(true);
    expect(res._status).toBe(400);
    expect(res._body).toContain('trigger_type');
  });

  it.each(['/', '/viewer', '/viewer/viewer.css', '/viewer/js/modules/system.js'])(
    'does not serve the retired browser route %s',
    async (pathname) => {
      const handler = createGraphHandler({});
      const req = {
        method: 'GET',
        url: pathname,
        headers: { host: 'localhost' },
        socket: { remoteAddress: '127.0.0.1' },
      } as IncomingMessage;
      const res = createMockRes();

      const handled = await handler(req, res as unknown as ServerResponse);

      expect(handled).toBe(false);
      expect(res._status).not.toBe(200);
      expect(res._status).not.toBe(302);
    }
  );

  it.each([
    { method: 'GET', pathname: '/api/ui/commands' },
    { method: 'GET', pathname: '/api/ui/page-context' },
    { method: 'POST', pathname: '/api/ui/commands' },
    { method: 'POST', pathname: '/api/ui/commands/ack' },
    { method: 'POST', pathname: '/api/ui/page-context' },
  ])('does not handle the retired UI route $method $pathname', async ({ method, pathname }) => {
    const handler = createGraphHandler({});
    const req = {
      method,
      url: pathname,
      headers: { host: 'localhost' },
      socket: { remoteAddress: '127.0.0.1' },
    } as IncomingMessage;
    const res = createMockRes();

    const handled = await handler(req, res as unknown as ServerResponse);

    expect(handled).toBe(false);
    expect(res._status).not.toBe(200);
  });

  describe('Story CODE-ACT-HTTP: /api/code-act runtime contract', () => {
    describe('AC: rate limits execution per client', () => {
      it('rate-limits Code-Act execution requests per client', async () => {
        const previousLimit = process.env.MAMA_CODE_ACT_RATE_LIMIT_PER_MINUTE;
        const previousAuthToken = process.env.MAMA_AUTH_TOKEN;
        process.env.MAMA_CODE_ACT_RATE_LIMIT_PER_MINUTE = '2';
        process.env.MAMA_AUTH_TOKEN = 'test-code-act-token';
        try {
          const executeCodeAct = vi.fn().mockResolvedValue({
            success: true,
            value: 1,
            logs: [],
            metrics: { durationMs: 1, hostCallCount: 0, memoryUsedBytes: 0 },
          });
          const handler = createGraphHandler({ executeCodeAct });

          for (let i = 0; i < 2; i++) {
            const req = createBodyReq('/api/code-act', JSON.stringify({ code: '1 + 1' }), {
              remoteAddress: '127.0.0.77',
              headers: { authorization: 'Bearer test-code-act-token' },
            });
            const res = createMockRes();
            const handled = await handler(req, res as unknown as ServerResponse);
            expect(handled).toBe(true);
            expect(res._status).toBe(200);
          }

          const limitedReq = createBodyReq('/api/code-act', JSON.stringify({ code: '1 + 1' }), {
            remoteAddress: '127.0.0.77',
            headers: { authorization: 'Bearer test-code-act-token' },
          });
          const limitedRes = createMockRes();
          const handled = await handler(limitedReq, limitedRes as unknown as ServerResponse);

          expect(handled).toBe(true);
          expect(limitedRes._status).toBe(429);
          expect(limitedRes._body).toContain('rate limit exceeded');
          expect(executeCodeAct).toHaveBeenCalledTimes(2);
        } finally {
          if (previousLimit === undefined) {
            delete process.env.MAMA_CODE_ACT_RATE_LIMIT_PER_MINUTE;
          } else {
            process.env.MAMA_CODE_ACT_RATE_LIMIT_PER_MINUTE = previousLimit;
          }
          if (previousAuthToken === undefined) {
            delete process.env.MAMA_AUTH_TOKEN;
          } else {
            process.env.MAMA_AUTH_TOKEN = previousAuthToken;
          }
        }
      });
    });

    describe('AC: forwards caller identity and request policy', () => {
      it('passes Code-Act caller identity and gateway allowlist to the executor', async () => {
        const previousAuthToken = process.env.MAMA_AUTH_TOKEN;
        process.env.MAMA_AUTH_TOKEN = 'test-code-act-token';
        const executeCodeAct = vi.fn().mockResolvedValue({
          success: true,
          value: 1,
          logs: [],
          metrics: { durationMs: 1, hostCallCount: 0, memoryUsedBytes: 0 },
        });
        try {
          const handler = createGraphHandler({ executeCodeAct });
          const req = createBodyReq(
            '/api/code-act',
            JSON.stringify({
              code: 'mama_search({query:"ctx"})',
              agent_id: 'dashboard-agent',
              allowed_tools: ['mama_search', 'report_publish'],
              blocked_tools: ['mama_save'],
            }),
            {
              remoteAddress: '127.0.0.88',
              headers: { authorization: 'Bearer test-code-act-token' },
            }
          );
          const res = createMockRes();

          expect(await handler(req, res as unknown as ServerResponse)).toBe(true);

          expect(res._status).toBe(200);
          expect(executeCodeAct).toHaveBeenCalledWith('mama_search({query:"ctx"})', {
            agentId: 'dashboard-agent',
            allowedTools: ['mama_search', 'report_publish'],
            blockedTools: ['mama_save'],
          });
        } finally {
          if (previousAuthToken === undefined) {
            delete process.env.MAMA_AUTH_TOKEN;
          } else {
            process.env.MAMA_AUTH_TOKEN = previousAuthToken;
          }
        }
      });

      it('preserves terminal mutation metadata in the HTTP response', async () => {
        const previousAuthToken = process.env.MAMA_AUTH_TOKEN;
        process.env.MAMA_AUTH_TOKEN = 'test-code-act-token';
        const executeCodeAct = vi.fn().mockResolvedValue({
          success: false,
          error: 'Mutation outcome is unknown',
          terminalCode: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
          retryable: false,
          abort: true,
          logs: [],
          metrics: { durationMs: 1, hostCallCount: 1, memoryUsedBytes: 0 },
        });
        try {
          const handler = createGraphHandler({ executeCodeAct });
          const req = createBodyReq('/api/code-act', JSON.stringify({ code: 'mutate()' }), {
            remoteAddress: '127.0.0.91',
            headers: { authorization: 'Bearer test-code-act-token' },
          });
          const res = createMockRes();

          expect(await handler(req, res as unknown as ServerResponse)).toBe(true);
          expect(res._status).toBe(200);
          expect(JSON.parse(res._body)).toMatchObject({
            success: false,
            terminalCode: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
            retryable: false,
            abort: true,
          });
        } finally {
          if (previousAuthToken === undefined) {
            delete process.env.MAMA_AUTH_TOKEN;
          } else {
            process.env.MAMA_AUTH_TOKEN = previousAuthToken;
          }
        }
      });

      it('TG-03/TG-04 forwards a valid process context key to the executor', async () => {
        const previousAuthToken = process.env.MAMA_AUTH_TOKEN;
        process.env.MAMA_AUTH_TOKEN = 'test-code-act-token';
        const executeCodeAct = vi.fn().mockResolvedValue({ success: true, value: 2, logs: [] });
        const contextKey = 'A'.repeat(43);
        try {
          const handler = createGraphHandler({ executeCodeAct });
          const req = createBodyReq(
            '/api/code-act',
            JSON.stringify({ code: '1 + 1', context_key: contextKey }),
            {
              remoteAddress: '127.0.0.92',
              headers: { authorization: 'Bearer test-code-act-token' },
            }
          );
          const res = createMockRes();

          expect(await handler(req, res as unknown as ServerResponse)).toBe(true);

          expect(res._status).toBe(200);
          expect(executeCodeAct).toHaveBeenCalledWith('1 + 1', { contextKey });
        } finally {
          if (previousAuthToken === undefined) {
            delete process.env.MAMA_AUTH_TOKEN;
          } else {
            process.env.MAMA_AUTH_TOKEN = previousAuthToken;
          }
        }
      });

      it('TG-06 rejects a malformed process context key before execution', async () => {
        const previousAuthToken = process.env.MAMA_AUTH_TOKEN;
        process.env.MAMA_AUTH_TOKEN = 'test-code-act-token';
        const executeCodeAct = vi.fn().mockResolvedValue({ success: true, value: 2, logs: [] });
        try {
          const handler = createGraphHandler({ executeCodeAct });
          const req = createBodyReq(
            '/api/code-act',
            JSON.stringify({ code: '1 + 1', context_key: 'not-a-signed-process-key' }),
            {
              remoteAddress: '127.0.0.93',
              headers: { authorization: 'Bearer test-code-act-token' },
            }
          );
          const res = createMockRes();

          expect(await handler(req, res as unknown as ServerResponse)).toBe(true);

          expect(res._status).toBe(400);
          expect(res._body).toContain('context_key');
          expect(executeCodeAct).not.toHaveBeenCalled();
        } finally {
          if (previousAuthToken === undefined) {
            delete process.env.MAMA_AUTH_TOKEN;
          } else {
            process.env.MAMA_AUTH_TOKEN = previousAuthToken;
          }
        }
      });

      it('rejects malformed Code-Act agent identity before execution', async () => {
        const previousAuthToken = process.env.MAMA_AUTH_TOKEN;
        process.env.MAMA_AUTH_TOKEN = 'test-code-act-token';
        const executeCodeAct = vi.fn().mockResolvedValue({
          success: true,
          value: 1,
          logs: [],
          metrics: { durationMs: 1, hostCallCount: 0, memoryUsedBytes: 0 },
        });
        try {
          const handler = createGraphHandler({ executeCodeAct });
          const req = createBodyReq(
            '/api/code-act',
            JSON.stringify({
              code: 'mama_search({query:"ctx"})',
              agent_id: 42,
            }),
            {
              remoteAddress: '127.0.0.89',
              headers: { authorization: 'Bearer test-code-act-token' },
            }
          );
          const res = createMockRes();

          expect(await handler(req, res as unknown as ServerResponse)).toBe(true);

          expect(res._status).toBe(400);
          expect(res._body).toContain('agent_id must be a non-empty string');
          expect(executeCodeAct).not.toHaveBeenCalled();
        } finally {
          if (previousAuthToken === undefined) {
            delete process.env.MAMA_AUTH_TOKEN;
          } else {
            process.env.MAMA_AUTH_TOKEN = previousAuthToken;
          }
        }
      });
    });

    describe('AC: rate limit identity ignores untrusted forwarded headers', () => {
      it('ignores spoofed x-forwarded-for for Code-Act rate limits from untrusted peers', async () => {
        const previousLimit = process.env.MAMA_CODE_ACT_RATE_LIMIT_PER_MINUTE;
        const previousAuthToken = process.env.MAMA_AUTH_TOKEN;
        process.env.MAMA_CODE_ACT_RATE_LIMIT_PER_MINUTE = '1';
        process.env.MAMA_AUTH_TOKEN = 'test-code-act-token';
        try {
          const executeCodeAct = vi.fn().mockResolvedValue({
            success: true,
            value: 1,
            logs: [],
            metrics: { durationMs: 1, hostCallCount: 0, memoryUsedBytes: 0 },
          });
          const handler = createGraphHandler({ executeCodeAct });
          const firstReq = createBodyReq('/api/code-act', JSON.stringify({ code: '1 + 1' }), {
            remoteAddress: '198.51.100.77',
            headers: {
              authorization: 'Bearer test-code-act-token',
              'x-forwarded-for': '203.0.113.1',
            },
          });
          const firstRes = createMockRes();
          expect(await handler(firstReq, firstRes as unknown as ServerResponse)).toBe(true);
          expect(firstRes._status).toBe(200);

          const spoofedReq = createBodyReq('/api/code-act', JSON.stringify({ code: '1 + 1' }), {
            remoteAddress: '198.51.100.77',
            headers: {
              authorization: 'Bearer test-code-act-token',
              'x-forwarded-for': '203.0.113.2',
            },
          });
          const spoofedRes = createMockRes();
          expect(await handler(spoofedReq, spoofedRes as unknown as ServerResponse)).toBe(true);
          expect(spoofedRes._status).toBe(429);
          expect(executeCodeAct).toHaveBeenCalledTimes(1);
        } finally {
          if (previousLimit === undefined) {
            delete process.env.MAMA_CODE_ACT_RATE_LIMIT_PER_MINUTE;
          } else {
            process.env.MAMA_CODE_ACT_RATE_LIMIT_PER_MINUTE = previousLimit;
          }
          if (previousAuthToken === undefined) {
            delete process.env.MAMA_AUTH_TOKEN;
          } else {
            process.env.MAMA_AUTH_TOKEN = previousAuthToken;
          }
        }
      });
    });
  });

  it('returns 400 for malformed JSON on managed-agent update POST', async () => {
    const handler = createGraphHandler({ sessionsDb: db });
    const req = createBodyReq('/api/agents/dashboard-agent', '{bad-json');
    const res = createMockRes();

    const handled = await handler(req, res as unknown as ServerResponse);

    expect(handled).toBe(true);
    expect(res._status).toBe(400);
    expect(res._body).toContain('Invalid JSON');
  });

  it('requires trigger_type for validation summary', async () => {
    const handler = createGraphHandler({ sessionsDb: db });
    const req = {
      method: 'GET',
      url: '/api/agents/dashboard-agent/validation/summary',
      headers: { host: 'localhost' },
      socket: { remoteAddress: '127.0.0.1' },
    } as IncomingMessage;
    const res = createMockRes();

    const handled = await handler(req, res as unknown as ServerResponse);

    expect(handled).toBe(true);
    expect(res._status).toBe(400);
    expect(res._body).toContain('trigger_type required');
  });

  it('filters validation summary and history by trigger_type', async () => {
    const now = Date.now();
    createValidationSession(db, {
      id: 'vs-agent-test',
      agent_id: 'dashboard-agent',
      agent_version: 1,
      trigger_type: 'agent_test',
      metric_profile_json: '{}',
      execution_status: 'completed',
      validation_outcome: 'healthy',
      started_at: now - 1000,
      ended_at: now - 900,
    });
    createValidationSession(db, {
      id: 'vs-delegate',
      agent_id: 'dashboard-agent',
      agent_version: 2,
      trigger_type: 'delegate_run',
      metric_profile_json: '{}',
      execution_status: 'completed',
      validation_outcome: 'regressed',
      started_at: now,
      ended_at: now,
    });

    const handler = createGraphHandler({ sessionsDb: db });

    const summaryReq = {
      method: 'GET',
      url: '/api/agents/dashboard-agent/validation/summary?trigger_type=agent_test',
      headers: { host: 'localhost' },
      socket: { remoteAddress: '127.0.0.1' },
    } as IncomingMessage;
    const summaryRes = createMockRes();
    await handler(summaryReq, summaryRes as unknown as ServerResponse);

    expect(summaryRes._status).toBe(200);
    expect(summaryRes._body).toContain('vs-agent-test');
    expect(summaryRes._body).not.toContain('vs-delegate');

    const historyReq = {
      method: 'GET',
      url: '/api/agents/dashboard-agent/validation/history?trigger_type=delegate_run&limit=10',
      headers: { host: 'localhost' },
      socket: { remoteAddress: '127.0.0.1' },
    } as IncomingMessage;
    const historyRes = createMockRes();
    await handler(historyReq, historyRes as unknown as ServerResponse);

    expect(historyRes._status).toBe(200);
    expect(historyRes._body).toContain('vs-delegate');
    expect(historyRes._body).not.toContain('vs-agent-test');
  });

  describe('Story LEGACY-MANAGED-BACKENDS: managed-agent backend migration', () => {
    describe('AC: validates supported managed backend families', () => {
      it('accepts Codex and Cline backends and rejects unsupported Gemini backends in legacy config validation', () => {
        expect(
          validateConfigUpdate({
            agent: { backend: 'codex', model: 'gpt-5.4-mini' },
            multi_agent: {
              agents: {
                coder: { backend: 'codex', model: 'gpt-5.4' },
              },
            },
          })
        ).toEqual([]);
        expect(
          validateConfigUpdate({
            agent: { backend: 'cline', model: 'deepseek/deepseek-v4-flash' },
            multi_agent: {
              agents: {
                coder: { backend: 'cline', model: 'deepseek/deepseek-v4-flash' },
              },
            },
          })
        ).toEqual([]);
        expect(
          validateConfigUpdate({
            multi_agent: {
              agents: {
                resolver: { backend: 'gemini', model: 'gemini-2.5-pro' },
              },
            },
          })
        ).toContain('multi_agent.agents.resolver.backend must be "claude", "codex", or "cline"');
      });
    });

    describe('AC: migrates persisted legacy Gemini backend configs', () => {
      it('migrates the previous codex-mcp backend alias to codex app-server', () => {
        const migrated = migrateLegacyManagedBackends({
          agent: { backend: 'codex-mcp', model: 'gpt-5.2-codex' },
          multi_agent: {
            backend: 'codex-mcp',
            agents: {
              inherited: { model: 'gpt-5.2-codex' },
              explicit: { backend: 'codex-mcp', model: 'gpt-5.2-codex' },
            },
          },
        });

        expect(migrated.agent.backend).toBe('codex');
        expect(migrated.multi_agent.backend).toBe('codex');
        expect(migrated.multi_agent.agents.inherited.backend).toBe('codex');
        expect(migrated.multi_agent.agents.explicit.backend).toBe('codex');
        expect(validateConfigUpdate(migrated)).toEqual([]);
      });

      it('migrates persisted legacy Gemini managed-agent backends before validation', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const migrated = migrateLegacyManagedBackends({
          agent: { backend: 'gemini', model: 'gemini-2.5-pro' },
          multi_agent: {
            agents: {
              resolver: { backend: 'gemini', model: 'gemini-2.5-pro' },
              coder: { backend: 'codex', model: 'gpt-5.4-mini' },
            },
          },
        });

        expect(migrated.agent.backend).toBe('claude');
        expect(migrated.agent.model).toBe('claude-sonnet-4-6');
        expect(migrated.multi_agent.agents.resolver.backend).toBe('claude');
        expect(migrated.multi_agent.agents.resolver.model).toBe('claude-sonnet-4-6');
        expect(migrated.multi_agent.agents.coder.backend).toBe('codex');
        expect(validateConfigUpdate(migrated)).toEqual([]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Deprecated backend "gemini"'));
        warn.mockRestore();
      });

      it('migrates agents inheriting a legacy Gemini multi-agent backend before validation', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const migrated = migrateLegacyManagedBackends({
          multi_agent: {
            backend: 'gemini',
            agents: {
              resolver: { model: 'gemini-2.5-pro' },
            },
          },
        });

        expect(migrated.multi_agent.backend).toBe('claude');
        expect(migrated.multi_agent.agents.resolver.backend).toBe('claude');
        expect(migrated.multi_agent.agents.resolver.model).toBe('claude-sonnet-4-6');
        expect(validateConfigUpdate(migrated)).toEqual([]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Deprecated backend "gemini"'));
        warn.mockRestore();
      });
    });
  });
});

function createMockRes() {
  return {
    _status: 0,
    _body: '',
    _headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this._headers[name] = value;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      this._status = status;
      this._headers = { ...this._headers, ...(headers ?? {}) };
    },
    end(body: string) {
      this._body = body;
    },
  };
}

function createBodyReq(
  url: string,
  body: string,
  options: { remoteAddress?: string; headers?: Record<string, string> } = {}
): IncomingMessage {
  const listeners = new Map<string, Array<(value?: unknown) => void>>();
  const req = {
    method: 'POST',
    url,
    headers: { host: 'localhost', 'content-type': 'application/json', ...options.headers },
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    on(event: string, handler: (value?: unknown) => void) {
      const bucket = listeners.get(event) ?? [];
      bucket.push(handler);
      listeners.set(event, bucket);
      return this;
    },
    destroy() {
      return this;
    },
  } as IncomingMessage;

  queueMicrotask(() => {
    for (const handler of listeners.get('data') ?? []) {
      handler(Buffer.from(body));
    }
    for (const handler of listeners.get('end') ?? []) {
      handler();
    }
  });

  return req;
}
