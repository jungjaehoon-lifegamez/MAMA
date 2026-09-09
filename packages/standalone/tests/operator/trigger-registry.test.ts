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

  it('TG-05/TG-06 preserves procedure references and deduplicates terminal receipts', () => {
    reg.create({ ...sampleInput(), procedureRef: { id: 'p1', revision: 2 } });
    expect(reg.getById('t1')?.procedureRef).toEqual({ id: 'p1', revision: 2 });
    reg.recordOutcome('t1', 'succeeded', 'owner-event:1');
    reg.recordOutcome('t1', 'succeeded', 'owner-event:1');
    expect(reg.getById('t1')?.stats.succeeded).toBe(1);
  });

  it('TG-06 rejects a stale revision and preserves owner disable', () => {
    const original = reg.create(sampleInput());
    reg.disable('t1', 'owner stop');
    expect(() => reg.refine('t1', 'agent review', sampleInput('new'), original.revision)).toThrow();
    expect(reg.getById('new')).toBeNull();
    expect(reg.getById('t1')?.disabledReason).toBe('owner stop');
  });

  it('TG-06 rejects review after an active procedure revision changed', () => {
    const original = reg.create(sampleInput());
    db.prepare('UPDATE operator_triggers SET revision = revision + 1 WHERE id = ?').run('t1');
    expect(() => reg.retireActive('t1', 'stale review', original.revision)).toThrow();
    expect(() => reg.markReviewed('t1', 1, original.revision)).toThrow();
    expect(() => reg.refine('t1', 'stale review', sampleInput('new'), original.revision)).toThrow();
    expect(reg.getById('t1')?.status).toBe('active');
    expect(reg.getById('new')).toBeNull();
  });

  it('TG-05 preserves scoped canonical bindings across safe refinement and rejects body divergence', () => {
    reg.create(sampleInput());
    db.exec(
      `CREATE TABLE operator_trigger_procedure_bindings (trigger_id TEXT,owner_scope TEXT,project_id TEXT,channel_id TEXT,procedure_id TEXT,procedure_revision INTEGER,scope_key TEXT,snapshot_hash TEXT)`
    );
    db.prepare('INSERT INTO operator_trigger_procedure_bindings VALUES (?,?,?,?,?,?,?,?)').run(
      't1',
      'owner',
      'project',
      'channel',
      'p',
      1,
      'scope',
      'hash'
    );
    expect(() =>
      reg.refine(
        't1',
        'change body',
        { ...sampleInput('bad'), procedure: [{ action: 'bad', description: 'bad' }] },
        1
      )
    ).toThrow(/canonical/);
    reg.refine('t1', 'safe match refinement', sampleInput('new'), 1);
    expect(reg.hasProcedureBindings('new')).toBe(true);
    expect(
      db
        .prepare(
          'SELECT procedure_id FROM operator_trigger_procedure_bindings WHERE trigger_id = ?'
        )
        .get('new')
    ).toEqual({ procedure_id: 'p' });
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
