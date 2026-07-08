/**
 * Unit tests for evolveTrigger (Task 4 - G2: intervention outcome evolves the trigger).
 * The keep/refine/retire decision is the AGENT's, INJECTED (decide stub) so the test is
 * deterministic. There is NO numeric threshold in the module - the same stats can be kept OR
 * retired purely by agent judgment (proven below), which is what unfreezes G2.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TriggerRegistry } from '../../src/operator/trigger-registry.js';
import { evolveTrigger, type DecideEvolution } from '../../src/operator/trigger-evolve.js';
import type { CreateTriggerInput } from '../../src/operator/trigger-types.js';

function seed(reg: TriggerRegistry, id = 't1'): void {
  const input: CreateTriggerInput = {
    id,
    kind: 'k',
    memoryQuery: 'q',
    match: { keywords: ['report'], keywordMode: 'any', minConfidence: 0.7 },
    procedure: [],
    requiredEvidence: [],
    authoredBy: 'agent',
    provenance: { createdFrom: 'agent-authored', note: '' },
  };
  reg.create(input);
}

describe('evolveTrigger', () => {
  let db: SQLiteDatabase;
  let reg: TriggerRegistry;

  beforeEach(() => {
    db = new Database(':memory:');
    reg = new TriggerRegistry(db);
  });
  afterEach(() => reg.close());

  it('retired -> disabled, and the failure stat is recorded', async () => {
    seed(reg);
    const decide: DecideEvolution = async () => ({ action: 'retired', reason: 'kept misfiring' });
    const action = await evolveTrigger('t1', 'failed', 'fired but wrong target', reg, decide);
    expect(action).toBe('retired');
    expect(reg.getById('t1')?.status).toBe('disabled');
    expect(reg.getById('t1')?.stats.failed).toBe(1);
  });

  it('kept -> stays active, success stat recorded', async () => {
    seed(reg);
    const action = await evolveTrigger('t1', 'succeeded', 'worked', reg, async () => ({ action: 'kept' }));
    expect(action).toBe('kept');
    expect(reg.getById('t1')?.status).toBe('active');
    expect(reg.getById('t1')?.stats.succeeded).toBe(1);
  });

  it('refined -> old disabled, new active trigger carries the new keywords', async () => {
    seed(reg);
    const decide: DecideEvolution = async () => ({
      action: 'refined',
      reason: 'narrow the keywords',
      newSpec: {
        kind: 'k2',
        memoryQuery: 'q2',
        match: { keywords: ['weekly report'], keywordMode: 'any', minConfidence: 0.75 },
        procedure: [],
        requiredEvidence: [],
      },
    });
    const action = await evolveTrigger('t1', 'corrected', 'too broad', reg, decide);
    expect(action).toBe('refined');
    expect(reg.getById('t1')?.status).toBe('disabled');
    const active = reg.listActive();
    expect(active).toHaveLength(1);
    expect(active[0].match.keywords).toEqual(['weekly report']);
  });

  it('same failure stat can be kept OR retired by agent judgment (no fixed threshold - G2)', async () => {
    seed(reg, 'a');
    seed(reg, 'b');
    await evolveTrigger('a', 'failed', 'x', reg, async () => ({ action: 'kept' }));
    await evolveTrigger('b', 'failed', 'x', reg, async () => ({ action: 'retired', reason: 'r' }));
    expect(reg.getById('a')?.status).toBe('active');
    expect(reg.getById('b')?.status).toBe('disabled');
  });

  it('unknown trigger id throws (no-fallback)', async () => {
    await expect(evolveTrigger('nope', 'failed', 'x', reg, async () => ({ action: 'kept' }))).rejects.toThrow();
  });
});
