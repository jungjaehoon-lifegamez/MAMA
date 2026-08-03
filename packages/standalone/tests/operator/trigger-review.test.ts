/**
 * Unit tests for the periodic agent trigger-review (M1-T2 - replaces the outcome-driven
 * evolve binding for the read-only loop). parseReviewDecision is structural-only; applyReview
 * mechanically applies the AGENT's decision (no numeric threshold anywhere).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TriggerRegistry } from '../../src/operator/trigger-registry.js';
import {
  parseReviewDecision,
  applyReview,
  buildReviewPrompt,
} from '../../src/operator/trigger-review.js';
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
    expect(
      parseReviewDecision('Verdict:\n{"action":"retired","reason":"never useful"}\ndone')
    ).toEqual({
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

  it('TG-06 preserves owner veto when late retired review lands from another connection', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mama-trigger-review-'));
    const databasePath = join(directory, 'triggers.db');
    const reviewRegistry = new TriggerRegistry(new Database(databasePath));
    const ownerRegistry = new TriggerRegistry(new Database(databasePath));
    try {
      seed(reviewRegistry, 'owner-race');
      ownerRegistry.disable('owner-race', 'owner veto during review');

      expect(() =>
        applyReview(
          { action: 'retired', reason: 'late agent retirement' },
          'owner-race',
          reviewRegistry
        )
      ).toThrow(/no active trigger/);
      expect(reviewRegistry.getById('owner-race')).toMatchObject({
        status: 'disabled',
        disabledReason: 'owner veto during review',
      });
    } finally {
      ownerRegistry.close();
      reviewRegistry.close();
      rmSync(directory, { recursive: true, force: true });
    }
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

  it('rolls back the original trigger when a refined replacement ID collides', () => {
    seed(reg, 't1');
    seed(reg, 'existing');

    expect(() =>
      applyReview(
        {
          action: 'refined',
          reason: 'narrow it',
          newSpec: {
            id: 'existing',
            kind: 'k2',
            memoryQuery: 'q2',
            match: { keywords: ['weekly report'], keywordMode: 'any', minConfidence: 0.75 },
            procedure: [],
            requiredEvidence: [],
          },
        },
        't1',
        reg
      )
    ).toThrow();
    expect(reg.getById('t1')?.status).toBe('active');
    expect(reg.getById('existing')?.status).toBe('active');
  });
});

describe('buildReviewPrompt input budget', () => {
  it('TG-05/TG-06 bounds legacy trigger fields and context to a fixed prompt ceiling', () => {
    const giant = 'x'.repeat(50_000);
    const trigger = {
      id: giant,
      kind: giant,
      memoryQuery: giant,
      match: {
        keywords: Array.from({ length: 100 }, () => giant),
        keywordMode: 'any' as const,
        minConfidence: 0.7,
      },
      procedure: [],
      requiredEvidence: [],
      status: 'active' as const,
      authoredBy: 'agent' as const,
      createdAt: 1,
      updatedAt: 1,
      provenance: { createdFrom: 'legacy', note: '' },
      stats: { fired: 1, succeeded: 0, failed: 0 },
    };

    const prompt = buildReviewPrompt(
      trigger,
      Array.from({ length: 100 }, () => giant)
    );

    expect(prompt.length).toBeLessThanOrEqual(30_000);
    expect(prompt).toContain('Return ONLY one JSON object');
  });
});
