/**
 * Unit tests for TriggerRegistry (Task 0 - generic agent-authored trigger substrate).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TriggerRegistry } from '../../src/operator/trigger-registry.js';
import type { CreateTriggerInput } from '../../src/operator/trigger-types.js';

function sampleInput(id = 't1'): CreateTriggerInput {
  return {
    id,
    kind: 'recurring_report_request', // arbitrary agent-authored string, NOT a fixed enum
    memoryQuery: 'weekly status report cadence',
    match: { keywords: ['report'], keywordMode: 'any', minConfidence: 0.7 },
    procedure: [{ action: 'recall_and_surface', description: 'surface the report cadence memory' }],
    requiredEvidence: ['current_message'],
    authoredBy: 'agent',
    provenance: { createdFrom: 'agent-authored', note: '' },
  };
}

describe('TriggerRegistry', () => {
  let db: SQLiteDatabase;
  let reg: TriggerRegistry;

  beforeEach(() => {
    db = new Database(':memory:');
    reg = new TriggerRegistry(db);
  });

  afterEach(() => {
    reg.close();
  });

  it('created trigger is active without human approval (G4 unfrozen)', () => {
    const t = reg.create(sampleInput('t1'));
    expect(t.status).toBe('active');
    expect(reg.listActive().map((r) => r.id)).toContain('t1');
  });

  it('roundtrips agent-authored fields (open kind/action, not a fixed catalog - G3)', () => {
    reg.create(sampleInput('t2'));
    const got = reg.getById('t2');
    expect(got?.kind).toBe('recurring_report_request');
    expect(got?.procedure[0].action).toBe('recall_and_surface');
    expect(got?.match.keywords).toEqual(['report']);
    expect(got?.authoredBy).toBe('agent');
  });

  it('recordOutcome bumps stats (G2 evolution feed)', () => {
    reg.create(sampleInput('t3'));
    reg.recordOutcome('t3', 'failed');
    reg.recordOutcome('t3', 'succeeded');
    expect(reg.getById('t3')?.stats).toEqual({ fired: 2, succeeded: 1, failed: 1 });
  });

  it('disable retires a trigger (drops from listActive)', () => {
    reg.create(sampleInput('t4'));
    reg.disable('t4', 'superseded by t5');
    expect(reg.getById('t4')?.status).toBe('disabled');
    expect(reg.listActive().map((r) => r.id)).not.toContain('t4');
  });

  it('recordOutcome / disable on unknown id throws (no-fallback)', () => {
    expect(() => reg.recordOutcome('nope', 'failed')).toThrow();
    expect(() => reg.disable('nope', 'x')).toThrow();
  });
});
