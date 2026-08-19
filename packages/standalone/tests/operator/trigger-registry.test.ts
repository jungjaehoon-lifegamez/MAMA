/**
 * Unit tests for TriggerRegistry (Task 0 - generic agent-authored trigger substrate).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    reg.recordFire('t3');
    reg.recordFire('t3');
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

  it('recordFire bumps fired ONLY - no succeeded/failed fabrication (M1-T2)', () => {
    reg.create(sampleInput('t5'));
    reg.recordFire('t5');
    reg.recordFire('t5');
    expect(reg.getById('t5')?.stats).toEqual({ fired: 2, succeeded: 0, failed: 0 });
  });

  it('recordFire on unknown id throws (no-fallback)', () => {
    expect(() => reg.recordFire('nope')).toThrow();
  });

  it('listAll returns active and disabled triggers, newest first, with disabledReason', () => {
    reg.create(sampleInput('t6'));
    reg.create(sampleInput('t7'));
    reg.disable('t7', 'noisy');
    const all = reg.listAll();
    expect(all.map((r) => r.id)).toEqual(['t7', 't6']);
    expect(all[0].status).toBe('disabled');
    expect(all[0].disabledReason).toBe('noisy');
    expect(all[1].disabledReason).toBeUndefined();
  });

  it('acquires the migration write lock before inspecting legacy columns', () => {
    const source = readFileSync(
      new URL('../../src/operator/trigger-registry.ts', import.meta.url),
      'utf8'
    );
    const migration = source.slice(
      source.indexOf('private migrateReviewWatermark'),
      source.indexOf('/** Persist an agent-authored trigger')
    );
    expect(migration.indexOf("this.db.exec('BEGIN IMMEDIATE')")).toBeGreaterThan(-1);
    expect(migration.indexOf("this.db.exec('BEGIN IMMEDIATE')")).toBeLessThan(
      migration.indexOf('PRAGMA table_info(operator_triggers)')
    );
  });

  it('persists the review watermark across a registry restart', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mama-trigger-watermark-')), 'triggers.db');
    const first = new TriggerRegistry(new Database(path));
    first.create(sampleInput('durable'));
    first.recordFire('durable');
    first.markReviewed('durable', 1);
    first.close();

    const restarted = new TriggerRegistry(new Database(path));
    expect(restarted.listReviewCandidates()).toEqual([]);
    restarted.recordFire('durable');
    expect(restarted.listReviewCandidates().map((trigger) => trigger.id)).toEqual(['durable']);
    restarted.close();
  });

  it('TG-06 persists failed review backoff and successful clear across restarts', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mama-trigger-review-retry-')), 'triggers.db');
    const first = new TriggerRegistry(new Database(path));
    first.create(sampleInput('retry'));
    first.recordFire('retry');
    first.recordReviewFailure('retry', 1_000);
    first.close();

    const backedOff = new TriggerRegistry(new Database(path));
    expect(backedOff.listReviewCandidates(8, 1_000 + 60 * 60 * 1000)).toEqual([]);
    expect(backedOff.listReviewCandidates(8, 1_000 + 6 * 60 * 60 * 1000)).toHaveLength(1);
    backedOff.markReviewed('retry', 1);
    backedOff.recordFire('retry');
    backedOff.close();

    const cleared = new TriggerRegistry(new Database(path));
    expect(cleared.listReviewCandidates(8, 1_001).map((trigger) => trigger.id)).toEqual(['retry']);
    cleared.close();
  });

  it('TG-05 persists author provider backoff across a registry restart', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mama-trigger-author-retry-')), 'triggers.db');
    const first = new TriggerRegistry(new Database(path));
    first.recordAuthorFailure('window-a', 1_000);
    first.close();

    const restarted = new TriggerRegistry(new Database(path));
    expect(restarted.canAttemptAuthor(1_000 + 60 * 60 * 1000)).toBe(false);
    expect(restarted.canAttemptAuthor(1_000 + 6 * 60 * 60 * 1000)).toBe(true);
    restarted.clearAuthorFailure();
    restarted.close();

    const cleared = new TriggerRegistry(new Database(path));
    expect(cleared.canAttemptAuthor(1_001)).toBe(true);
    cleared.close();
  });

  it('validates review queue boundaries and rejects inactive failure updates', () => {
    expect(() => reg.listReviewCandidates(0)).toThrow(/positive integer/);
    expect(() => reg.listReviewCandidates(1, Number.NaN)).toThrow(/finite/);
    expect(() => reg.markReviewed('missing', -1)).toThrow(/non-negative integer/);
    reg.create(sampleInput('disabled-review'));
    reg.disable('disabled-review', 'owner veto');
    expect(() => reg.recordReviewFailure('disabled-review')).toThrow(/no active trigger/);
  });
});
