import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

import { getAdapter } from '../../../mama-core/src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../../mama-core/src/test-utils.js';
import {
  beginModelRunInAdapter,
  getContextPacket,
  getModelRunInAdapter,
  type ContextPacket,
} from '../../../mama-core/src/index.js';

import Database from '../../src/sqlite.js';
import {
  ContextCompileServiceError,
  type ContextCompileService,
} from '../../src/agent/context-compile-service.js';
import {
  createAgentContextRouter,
  type AgentContextRouterOptions,
} from '../../src/api/agent-context-handler.js';
import { createApiServer } from '../../src/api/index.js';
import { requireAuth } from '../../src/api/auth-middleware.js';
import { CronScheduler } from '../../src/scheduler/index.js';
import { makeAuthorityHarness, makeSignedEnvelope } from '../envelope/fixtures.js';
import type { EnvelopeAuthority } from '../../src/envelope/authority.js';
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

function makePacket(overrides: Partial<ContextPacket> = {}): ContextPacket {
  return {
    packet_id: 'ctxp_api_test',
    task: 'compile API context',
    scopes: [{ kind: 'project', id: '/workspace/project-a' }],
    scope_hash: 'scope-hash',
    generated_at: '2026-04-30T09:00:00.000Z',
    source_refs: [{ kind: 'memory', id: 'mem-api' }],
    selected_evidence: [],
    evidence_clusters: [],
    related_decisions: [],
    rejected_refs: [],
    rejected_summary: [],
    missing_context: [],
    caveats: [],
    expansion_trace: [],
    retrieval_diagnostics: {},
    budget: {
      used_tool_calls: 0,
      elapsed_ms: 1,
      estimated_tokens: 0,
    },
    ...overrides,
  };
}

function insertScopedDecision(input: {
  id: string;
  topic: string;
  summary: string;
  details: string;
  scopeId?: string;
}): void {
  const adapter = getAdapter();
  const scopeId = input.scopeId ?? '/workspace/project-a';
  const memoryScopeId = `scope_project_${scopeId.replace(/[^a-zA-Z0-9]/g, '_')}`;
  adapter
    .prepare(
      `
        INSERT INTO decisions (
          id, topic, decision, reasoning, confidence, created_at, updated_at,
          kind, status, summary, event_datetime
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.id,
      input.topic,
      input.summary,
      input.details,
      0.8,
      1_200,
      1_200,
      'decision',
      'active',
      input.summary,
      1_200
    );
  adapter
    .prepare('INSERT OR IGNORE INTO memory_scopes (id, kind, external_id) VALUES (?, ?, ?)')
    .run(memoryScopeId, 'project', scopeId);
  adapter
    .prepare(
      'INSERT OR REPLACE INTO memory_scope_bindings (memory_id, scope_id, is_primary) VALUES (?, ?, 1)'
    )
    .run(input.id, memoryScopeId);
}

describe('STORY-B5: /api/agent/context compile API - AC1-AC4', () => {
  const originalAuthToken = process.env.MAMA_AUTH_TOKEN;
  let testDbPath = '';
  let sessionsDb: Database;
  let authority: EnvelopeAuthority;
  let validEnvelope: Envelope;

  beforeAll(async () => {
    testDbPath = await initTestDB('agent-context-api');
  });

  beforeEach(() => {
    process.env.MAMA_AUTH_TOKEN = 'agent-context-token';
    getAdapter().prepare('DELETE FROM context_packets').run();
    getAdapter().prepare('DELETE FROM model_runs').run();
    getAdapter().prepare('DELETE FROM memory_scope_bindings').run();
    getAdapter().prepare('DELETE FROM memory_scopes').run();
    getAdapter().prepare('DELETE FROM decisions').run();
    sessionsDb = new Database(':memory:');
    const harness = makeAuthorityHarness(sessionsDb);
    authority = harness.authority;
    validEnvelope = makeSignedEnvelope();
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

  function makeServiceMock(
    impl?: ContextCompileService['compileAndPersistContext']
  ): ContextCompileService {
    return {
      compileAndPersistContext:
        impl ??
        vi.fn(async ({ input }) => ({
          packet: makePacket({ task: input.task }),
        })),
    };
  }

  function makeRouterServer(overrides: Partial<AgentContextRouterOptions> = {}) {
    const app = express();
    app.use(express.json());
    app.use('/api', requireAuth);
    app.use(
      '/api/agent/context',
      createAgentContextRouter({
        memoryAdapter: getAdapter(),
        envelopeAuthority: authority,
        contextCompileService: makeServiceMock(),
        ...overrides,
      })
    );
    return { app };
  }

  function authed(req: request.Test): request.Test {
    return req
      .set(TUNNEL_HEADERS)
      .set('Authorization', 'Bearer agent-context-token')
      .set('x-mama-envelope-hash', validEnvelope.envelope_hash);
  }

  it('AC: rejects missing worker envelopes before calling the shared service', async () => {
    const service = makeServiceMock();
    const apiServer = makeRouterServer({ contextCompileService: service });

    const response = await request(apiServer.app)
      .post('/api/agent/context/compile')
      .set(TUNNEL_HEADERS)
      .set('Authorization', 'Bearer agent-context-token')
      .send({ task: 'compile API context' });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('worker_envelope_missing');
    expect(service.compileAndPersistContext).not.toHaveBeenCalled();
  });

  it('AC: converts headers to a loaded envelope only in the HTTP handler and returns { packet }', async () => {
    const compileAndPersistContext = vi.fn(async ({ input, envelope, modelRunId, caller }) => {
      expect(caller).toBe('http');
      expect(modelRunId).toBe('mr_parent_from_header');
      expect(envelope).toMatchObject({
        envelope_hash: validEnvelope.envelope_hash,
        agent_id: validEnvelope.agent_id,
        instance_id: validEnvelope.instance_id,
      });
      return { packet: makePacket({ packet_id: 'ctxp_api_success', task: input.task }) };
    });
    const apiServer = makeRouterServer({
      contextCompileService: makeServiceMock(compileAndPersistContext),
    });

    const response = await authed(
      request(apiServer.app)
        .post('/api/agent/context/compile')
        .set('x-mama-model-run-id', 'mr_parent_from_header')
        .send({
          task: 'compile API context',
          scopes: [{ kind: 'project', id: '/workspace/project-a' }],
          connectors: ['telegram'],
          seed_refs: [{ kind: 'memory', id: 'mem-api' }],
          limit: 3,
        })
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      packet: makePacket({ packet_id: 'ctxp_api_success', task: 'compile API context' }),
    });
    expect(compileAndPersistContext).toHaveBeenCalledTimes(1);
    expect(compileAndPersistContext.mock.calls[0][0].input).toMatchObject({
      task: 'compile API context',
      scopes: [{ kind: 'project', id: '/workspace/project-a' }],
      connectors: ['telegram'],
      seed_refs: [{ kind: 'memory', id: 'mem-api' }],
      limit: 3,
    });
  });

  it('AC: rejects malformed compile filter fields before calling the shared service', async () => {
    const service = makeServiceMock();
    const apiServer = makeRouterServer({ contextCompileService: service });

    const malformedInputs = [
      { task: 'compile API context', connectors: 'telegram' },
      { task: 'compile API context', scopes: { kind: 'project', id: '/workspace/project-a' } },
      { task: 'compile API context', project_refs: 'repo-a' },
      { task: 'compile API context', seed_refs: { kind: 'memory', id: 'mem-api' } },
      { task: 'compile API context', range: { start_ms: '1000' } },
      { task: 'compile API context', strictness: 'strict' },
      { task: 'compile API context', limit: 'abc' },
      { task: 'compile API context', max_tool_calls: '0' },
      { task: 'compile API context', max_ms: null },
      { task: 'compile API context', max_tokens: '1000' },
    ];

    for (const body of malformedInputs) {
      const response = await authed(
        request(apiServer.app).post('/api/agent/context/compile').send(body)
      );

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: true,
        code: 'context_compile_input_invalid',
      });
    }
    expect(service.compileAndPersistContext).not.toHaveBeenCalled();
  });

  it('AC: preserves stable service error codes and hides unexpected error details', async () => {
    const invalidService = makeServiceMock(
      vi.fn(async () => {
        throw new ContextCompileServiceError(
          400,
          'context_compile_input_invalid',
          'task is required'
        );
      })
    );
    const invalidServer = makeRouterServer({ contextCompileService: invalidService });

    const invalid = await authed(
      request(invalidServer.app).post('/api/agent/context/compile').send({})
    );
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({
      error: true,
      code: 'context_compile_input_invalid',
      message: 'task is required',
    });

    const explodingService = makeServiceMock(
      vi.fn(async () => {
        throw new Error('database path /secret leaked');
      })
    );
    const explodingServer = makeRouterServer({ contextCompileService: explodingService });

    const exploded = await authed(
      request(explodingServer.app)
        .post('/api/agent/context/compile')
        .send({ task: 'compile API context' })
    );
    expect(exploded.status).toBe(500);
    expect(exploded.body).toEqual({
      error: true,
      code: 'agent_context_api_error',
      message: 'Internal server error',
    });
  });

  it('AC: mounts the compile route through createApiServer with the shared service', async () => {
    const scheduler = new CronScheduler();
    const service = makeServiceMock(
      vi.fn(async ({ input }) => ({
        packet: makePacket({ packet_id: 'ctxp_create_api_server', task: input.task }),
      }))
    );
    const apiServer = createApiServer({
      scheduler,
      port: 0,
      memoryAdapter: getAdapter(),
      envelopeAuthority: authority,
      contextCompileService: service,
    });

    try {
      const response = await authed(
        request(apiServer.app)
          .post('/api/agent/context/compile')
          .send({ task: 'compile through createApiServer' })
      );

      expect(response.status).toBe(200);
      expect(response.body.packet.packet_id).toBe('ctxp_create_api_server');
      expect(service.compileAndPersistContext).toHaveBeenCalledTimes(1);
    } finally {
      scheduler.shutdown();
    }
  });

  it('AC: createApiServer default service persists a packet and committed child model_run', async () => {
    const adapter = getAdapter();
    insertScopedDecision({
      id: 'mem-api-real-path',
      topic: 'real context compile API path',
      summary: 'The real API path should persist a context packet.',
      details: 'This verifies createApiServer default service construction and DB persistence.',
    });
    beginModelRunInAdapter(adapter, {
      model_run_id: 'mr_api_parent',
      agent_id: validEnvelope.agent_id,
      instance_id: validEnvelope.instance_id,
      envelope_hash: validEnvelope.envelope_hash,
      input_snapshot_ref: 'agent-loop:api-test',
      input_refs: { tool: 'agent.loop', test: true },
    });
    const scheduler = new CronScheduler();
    const apiServer = createApiServer({
      scheduler,
      port: 0,
      memoryAdapter: adapter,
      envelopeAuthority: authority,
    });

    try {
      const response = await authed(
        request(apiServer.app)
          .post('/api/agent/context/compile')
          .set('x-mama-model-run-id', 'mr_api_parent')
          .send({ task: 'real context compile API path', limit: 5, max_tool_calls: 1 })
      );

      expect(response.status).toBe(200);
      const packetId = response.body.packet.packet_id as string;
      const stored = getContextPacket(adapter, packetId);
      expect(stored).toMatchObject({
        packet_id: packetId,
        envelope_hash: validEnvelope.envelope_hash,
        agent_id: validEnvelope.agent_id,
      });
      expect(response.body.packet.selected_evidence).toEqual([
        expect.objectContaining({
          ref: { kind: 'memory', id: 'mem-api-real-path' },
        }),
      ]);
      expect(getModelRunInAdapter(adapter, stored?.model_run_id ?? '')).toMatchObject({
        status: 'committed',
        parent_model_run_id: 'mr_api_parent',
      });
    } finally {
      scheduler.shutdown();
    }
  });
});
