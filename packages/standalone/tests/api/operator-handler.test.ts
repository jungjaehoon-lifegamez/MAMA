/**
 * Unit tests for the /api/operator router (trigger stats + owner veto).
 * The dbPath is a temp dir per test -- never the real ~/.mama (Constraint 5).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOperatorRouter } from '../../src/api/operator-handler.js';
import Database from '../../src/sqlite.js';
import { TriggerRegistry } from '../../src/operator/trigger-registry.js';
import type { CreateTriggerInput } from '../../src/operator/trigger-types.js';

function sampleInput(id: string): CreateTriggerInput {
  return {
    id,
    kind: 'recurring_report_request',
    memoryQuery: 'weekly status report cadence',
    match: { keywords: ['report'], keywordMode: 'any', minConfidence: 0.7 },
    procedure: [{ action: 'recall_and_surface', description: 'surface the cadence memory' }],
    requiredEvidence: ['current_message'],
    authoredBy: 'agent',
    provenance: { createdFrom: 'agent-authored', note: '' },
  };
}

describe('Operator API', () => {
  let dir: string;
  let dbPath: string;
  let app: express.Express;
  let seedReg: TriggerRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'operator-api-'));
    dbPath = join(dir, 'triggers.db');
    seedReg = new TriggerRegistry(new Database(dbPath));

    app = express();
    app.use(express.json());
    app.use('/api/operator', createOperatorRouter({ dbPath }));
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

    const res = await request(app).get('/api/operator/summary');

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
    const res = await request(app).get('/api/operator/summary');

    expect(res.status).toBe(200);
    expect(res.body.triggers).toEqual({
      active: 0,
      disabled: 0,
      fired: 0,
      succeeded: 0,
      failed: 0,
    });
  });

  it('GET /triggers lists all statuses newest first with flat counters', async () => {
    seedReg.create(sampleInput('t1'));
    seedReg.recordFire('t1');
    seedReg.create(sampleInput('t2'));
    seedReg.disable('t2', 'owner veto');

    const res = await request(app).get('/api/operator/triggers');

    expect(res.status).toBe(200);
    expect(res.body.triggers.map((t: { id: string }) => t.id)).toEqual(['t2', 't1']);
    expect(res.body.triggers[0]).toMatchObject({
      status: 'disabled',
      disabledReason: 'owner veto',
      fired: 0,
    });
    expect(res.body.triggers[1]).toMatchObject({
      status: 'active',
      disabledReason: null,
      fired: 1,
    });
  });

  it('POST /triggers/:id/disable stores the reason', async () => {
    seedReg.create(sampleInput('t1'));

    const res = await request(app)
      .post('/api/operator/triggers/t1/disable')
      .send({ reason: 'owner veto' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.trigger).toMatchObject({ status: 'disabled', disabledReason: 'owner veto' });
    expect(seedReg.getById('t1')?.status).toBe('disabled');
  });

  it('POST disable without reason returns 400; unknown id returns 404', async () => {
    seedReg.create(sampleInput('t1'));

    const noReason = await request(app).post('/api/operator/triggers/t1/disable').send({});
    expect(noReason.status).toBe(400);

    const unknown = await request(app)
      .post('/api/operator/triggers/nope/disable')
      .send({ reason: 'x' });
    expect(unknown.status).toBe(404);
  });
});
