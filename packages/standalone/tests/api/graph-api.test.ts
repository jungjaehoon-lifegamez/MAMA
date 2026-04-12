import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import Database from '../../src/sqlite.js';
import { initValidationTables, createValidationSession } from '../../src/validation/store.js';
import * as validationStore from '../../src/validation/store.js';
import { initAgentTables } from '../../src/db/agent-store.js';

import {
  DEFAULT_GRAPH_LIMIT,
  buildGraphMeta,
  filterEdgesByNodes,
  mapDecisionRowToGraphNode,
  parseGraphLimit,
  validateConfigUpdate,
  createGraphHandler,
} from '../../src/api/graph-api.js';

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

  it('returns 400 for malformed JSON on ui page-context POST', async () => {
    const handler = createGraphHandler({
      uiCommandQueue: {
        setPageContext: () => {},
        getPageContext: () => null,
        push: () => ({ id: 1, type: 'navigate', payload: {} }),
        drain: () => [],
        ack: () => 0,
      } as unknown as import('../../src/api/ui-command-handler.js').UICommandQueue,
    });
    const req = createBodyReq('/api/ui/page-context', '{bad-json');
    const res = createMockRes();

    const handled = await handler(req, res as unknown as ServerResponse);

    expect(handled).toBe(true);
    expect(res._status).toBe(400);
    expect(res._body).toContain('Invalid JSON');
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

  it('returns 413 for oversized JSON bodies', async () => {
    const handler = createGraphHandler({
      uiCommandQueue: {
        setPageContext: () => {},
        getPageContext: () => null,
        push: () => ({ id: 1, type: 'navigate', payload: {} }),
        drain: () => [],
        ack: () => 0,
      } as unknown as import('../../src/api/ui-command-handler.js').UICommandQueue,
    });
    const req = createBodyReq('/api/ui/page-context', 'a'.repeat(1_048_577));
    const res = createMockRes();

    const handled = await handler(req, res as unknown as ServerResponse);

    expect(handled).toBe(true);
    expect(res._status).toBe(413);
    expect(res._body).toContain('Request body too large');
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

  it('accepts codex and gemini backends in legacy config validation', () => {
    expect(
      validateConfigUpdate({
        agent: { backend: 'codex', model: 'gpt-5.4-mini' },
        multi_agent: {
          agents: {
            resolver: { backend: 'gemini', model: 'gemini-2.5-pro' },
            coder: { backend: 'codex-mcp', model: 'gpt-5.3-codex' },
          },
        },
      })
    ).toEqual([]);
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
    writeHead(status: number) {
      this._status = status;
    },
    end(body: string) {
      this._body = body;
    },
  };
}

function createBodyReq(url: string, body: string): IncomingMessage {
  const listeners = new Map<string, Array<(value?: unknown) => void>>();
  const req = {
    method: 'POST',
    url,
    headers: { host: 'localhost', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
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
