/**
 * Unit tests for the periodic agent trigger-review (M1-T2 - replaces the outcome-driven
 * evolve binding for the read-only loop). parseReviewDecision is structural-only; applyReview
 * mechanically applies the AGENT's decision (no numeric threshold anywhere).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TriggerRegistry } from '../../src/operator/trigger-registry.js';
import { parseReviewDecision, applyReview } from '../../src/operator/trigger-review.js';
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

describe('parseReviewDecision', () => {
  it('parses kept / retired / refined decisions (prose tolerated)', () => {
    expect(parseReviewDecision('{"action":"kept"}')).toEqual({ action: 'kept' });
    expect(parseReviewDecision('Verdict:\n{"action":"retired","reason":"never useful"}\ndone')).toEqual({
      action: 'retired',
      reason: 'never useful',
    });
    const refined = parseReviewDecision(
      JSON.stringify({
        action: 'refined',
        reason: 'too broad',
        newSpec: {
          kind: 'k2',
          memoryQuery: 'q2',
          match: { keywords: ['weekly report'], keywordMode: 'any', minConfidence: 0.75 },
          procedure: [],
          requiredEvidence: [],
        },
      })
    );
    expect(refined.action).toBe('refined');
  });

  it('throws on garbage / missing reason / invalid refined spec (no-fallback)', () => {
    expect(() => parseReviewDecision('keep it, looks fine')).toThrow();
    expect(() => parseReviewDecision('{"action":"retired"}')).toThrow(); // reason required
    expect(() => parseReviewDecision('{"action":"refined","reason":"r"}')).toThrow(); // newSpec required
    expect(() => parseReviewDecision('{"action":"exploded"}')).toThrow();
  });
});

describe('applyReview', () => {
  let db: SQLiteDatabase;
  let reg: TriggerRegistry;

  beforeEach(() => {
    db = new Database(':memory:');
    reg = new TriggerRegistry(db);
  });
  afterEach(() => reg.close());

  it('kept leaves the trigger active', () => {
    seed(reg);
    expect(applyReview({ action: 'kept' }, 't1', reg)).toBe('kept');
    expect(reg.getById('t1')?.status).toBe('active');
  });

  it('retired disables with the agent reason', () => {
    seed(reg);
    expect(applyReview({ action: 'retired', reason: 'noisy' }, 't1', reg)).toBe('retired');
    expect(reg.getById('t1')?.status).toBe('disabled');
  });

  it('refined supersedes: old disabled, new active with the agent spec', () => {
    seed(reg);
    const result = applyReview(
      {
        action: 'refined',
        reason: 'narrow it',
        newSpec: {
          kind: 'k2',
          memoryQuery: 'q2',
          match: { keywords: ['weekly report'], keywordMode: 'any', minConfidence: 0.75 },
          procedure: [],
          requiredEvidence: [],
        },
      },
      't1',
      reg
    );
    expect(result).toBe('refined');
    expect(reg.getById('t1')?.status).toBe('disabled');
    const active = reg.listActive();
    expect(active).toHaveLength(1);
    expect(active[0].match.keywords).toEqual(['weekly report']);
    expect(active[0].authoredBy).toBe('agent');
  });
});
