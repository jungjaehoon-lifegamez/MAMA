/**
 * Unit tests for the /api/operator router (trigger stats + owner veto).
 * The dbPath is a temp dir per test -- never the real ~/.mama (Constraint 5).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Request, Response, Router } from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOperatorRouter } from '../../src/api/operator-handler.js';
import Database from '../../src/sqlite.js';
import { TriggerRegistry } from '../../src/operator/trigger-registry.js';
import type { CreateTriggerInput, TriggerRecord } from '../../src/operator/trigger-types.js';

function sampleInput(id: string): CreateTriggerInput {
  return {
    id,
    kind: 'recurring_report_request',
    memoryQuery: 'weekly status report cadence',
    match: {
      keywords: ['report', 'status update'],
      keywordMode: 'every',
      scopeChannelIds: ['channel-synthetic-1', 'channel-synthetic-2'],
      minConfidence: 0.7,
    },
    procedure: [
      { action: 'recall_and_surface', description: 'surface the cadence memory' },
      { action: 'request_evidence', description: 'collect current report context' },
    ],
    requiredEvidence: ['current_message', 'recent_context'],
    authoredBy: 'seed',
    provenance: { createdFrom: 'synthetic-seed', note: 'synthetic fixture' },
  };
}

interface TestRouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{
      handle: (req: Request, res: Response) => unknown;
    }>;
  };
}

type TriggerWire = Omit<TriggerRecord, 'stats' | 'disabledReason'> & {
  fired: number;
  succeeded: number;
  failed: number;
  disabledReason: string | null;
};

interface SummaryResponse {
  triggers: {
    active: number;
    disabled: number;
    fired: number;
    succeeded: number;
    failed: number;
  };
}

interface TriggerListResponse {
  triggers: TriggerWire[];
}

interface DisableResponse {
  ok: true;
  trigger: TriggerWire;
}

async function invokeRoute<T>(
  router: Router,
  method: 'get' | 'post',
  path: string,
  options: { body?: unknown; params?: Record<string, string> } = {}
): Promise<{ status: number; body: T }> {
  const layers = (router as unknown as { stack: TestRouteLayer[] }).stack;
  const layer = layers.find(
    (candidate) => candidate.route?.path === path && candidate.route.methods[method]
  );
  if (!layer?.route) {
    throw new Error(`Test route not found: ${method.toUpperCase()} ${path}`);
  }

  let status = 200;
  let body: T | undefined;
  let didRespond = false;
  const response = {
    status(code: number) {
      status = code;
      return response;
    },
    json(payload: unknown) {
      body = payload as T;
      didRespond = true;
      return response;
    },
  } as unknown as Response;
  const request = {
    body: options.body,
    params: options.params ?? {},
  } as Request;

  await layer.route.stack[0].handle(request, response);
  if (!didRespond) {
    throw new Error(`Test route did not respond: ${method.toUpperCase()} ${path}`);
  }
  return { status, body: body as T };
}

describe('Operator API', () => {
  let dir: string;
  let dbPath: string;
  let router: Router;
  let seedReg: TriggerRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'operator-api-'));
    dbPath = join(dir, 'triggers.db');
    seedReg = new TriggerRegistry(new Database(dbPath));

    router = createOperatorRouter({ dbPath });
  });

  afterEach(() => {
    seedReg.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('GET /summary aggregates trigger counters across statuses', async () => {
    seedReg.create(sampleInput('t1'));
    seedReg.recordOutcome('t1', 'succeeded');
    seedReg.recordOutcome('t1', 'succeeded');
    seedReg.recordOutcome('t1', 'failed');
    seedReg.create(sampleInput('t2'));
    seedReg.disable('t2', 'noisy');

    const res = await invokeRoute<SummaryResponse>(router, 'get', '/summary');

    expect(res.status).toBe(200);
    expect(res.body.triggers).toEqual({
      active: 1,
      disabled: 1,
      fired: 3,
      succeeded: 2,
      failed: 1,
    });
  });

  it('GET /summary returns zeros on an empty registry (fresh install)', async () => {
    const res = await invokeRoute<SummaryResponse>(router, 'get', '/summary');

    expect(res.status).toBe(200);
    expect(res.body.triggers).toEqual({
      active: 0,
      disabled: 0,
      fired: 0,
      succeeded: 0,
      failed: 0,
    });
  });

  it('GET /triggers lists the complete persisted contract newest first', async () => {
    seedReg.create(sampleInput('t1'));
    seedReg.recordFire('t1');
    seedReg.create({
      ...sampleInput('t2'),
      kind: 'empty_match_trigger',
      memoryQuery: 'synthetic empty match',
      match: { keywords: [], keywordMode: 'any', minConfidence: 0.25 },
      procedure: [],
      requiredEvidence: [],
      authoredBy: 'agent',
      provenance: { createdFrom: 'synthetic-agent', note: '' },
    });
    seedReg.disable('t2', 'synthetic stored reason');

    const res = await invokeRoute<TriggerListResponse>(router, 'get', '/triggers');

    expect(res.status).toBe(200);
    expect(res.body.triggers.map((t) => t.id)).toEqual(['t2', 't1']);
    expect(res.body.triggers).toEqual([
      {
        id: 't2',
        kind: 'empty_match_trigger',
        memoryQuery: 'synthetic empty match',
        match: { keywords: [], keywordMode: 'any', minConfidence: 0.25 },
        procedure: [],
        requiredEvidence: [],
        status: 'disabled',
        authoredBy: 'agent',
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
        provenance: { createdFrom: 'synthetic-agent', note: '' },
        fired: 0,
        succeeded: 0,
        failed: 0,
        disabledReason: 'synthetic stored reason',
      },
      {
        id: 't1',
        kind: 'recurring_report_request',
        memoryQuery: 'weekly status report cadence',
        match: {
          keywords: ['report', 'status update'],
          keywordMode: 'every',
          scopeChannelIds: ['channel-synthetic-1', 'channel-synthetic-2'],
          minConfidence: 0.7,
        },
        procedure: [
          { action: 'recall_and_surface', description: 'surface the cadence memory' },
          { action: 'request_evidence', description: 'collect current report context' },
        ],
        requiredEvidence: ['current_message', 'recent_context'],
        status: 'active',
        authoredBy: 'seed',
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
        provenance: { createdFrom: 'synthetic-seed', note: 'synthetic fixture' },
        fired: 1,
        succeeded: 0,
        failed: 0,
        disabledReason: null,
      },
    ]);
  });

  it('POST /triggers/:id/disable stores the reason', async () => {
    seedReg.create(sampleInput('t1'));

    const res = await invokeRoute<DisableResponse>(router, 'post', '/triggers/:id/disable', {
      body: { reason: 'synthetic reason' },
      params: { id: 't1' },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      trigger: {
        id: 't1',
        kind: 'recurring_report_request',
        memoryQuery: 'weekly status report cadence',
        match: {
          keywords: ['report', 'status update'],
          keywordMode: 'every',
          scopeChannelIds: ['channel-synthetic-1', 'channel-synthetic-2'],
          minConfidence: 0.7,
        },
        procedure: [
          { action: 'recall_and_surface', description: 'surface the cadence memory' },
          { action: 'request_evidence', description: 'collect current report context' },
        ],
        requiredEvidence: ['current_message', 'recent_context'],
        status: 'disabled',
        authoredBy: 'seed',
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
        provenance: { createdFrom: 'synthetic-seed', note: 'synthetic fixture' },
        fired: 0,
        succeeded: 0,
        failed: 0,
        disabledReason: 'synthetic reason',
      },
    });
    expect(seedReg.getById('t1')?.status).toBe('disabled');
  });

  it('POST disable without reason returns 400; unknown id returns 404', async () => {
    seedReg.create(sampleInput('t1'));

    const noReason = await invokeRoute<{ error: string }>(router, 'post', '/triggers/:id/disable', {
      body: {},
      params: { id: 't1' },
    });
    expect(noReason.status).toBe(400);

    const unknown = await invokeRoute<{ error: string }>(router, 'post', '/triggers/:id/disable', {
      body: { reason: 'x' },
      params: { id: 'nope' },
    });
    expect(unknown.status).toBe(404);
  });
});
