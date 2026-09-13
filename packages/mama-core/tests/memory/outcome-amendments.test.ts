import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter, updateDecisionOutcome } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';

function seedDecision(id: string): void {
  getAdapter()
    .prepare(
      `INSERT INTO decisions (id, topic, decision, status, confidence, created_at, updated_at)
       VALUES (?, 'outcome-topic', 'initial decision', 'active', 0.5, 1000, 1000)`
    )
    .run(id);
}

describe('PR4B outcome history: append-only amendments with a maintained projection', () => {
  let dbPath = '';

  beforeAll(async () => {
    dbPath = await initTestDB('outcome-amendments');
  });

  beforeEach(() => {
    const db = getAdapter();
    db.prepare('DELETE FROM judgment_commands').run();
    db.prepare('DELETE FROM command_bindings').run();
    db.prepare('DELETE FROM twin_edges').run();
    db.prepare('DELETE FROM memory_events').run();
    db.prepare('DELETE FROM memory_scope_bindings').run();
    db.prepare('DELETE FROM decisions').run();
  });

  afterAll(async () => cleanupTestDB(dbPath));

  it('appends a judgment record and moves the outcome projection in one transaction', async () => {
    seedDecision('decision-target-1');
    await updateDecisionOutcome('decision-target-1', {
      outcome: 'SUCCESS',
      confidence: 0.9,
      duration_days: 3,
    });

    const db = getAdapter();
    const row = db
      .prepare('SELECT outcome, confidence, duration_days, record_kind FROM decisions WHERE id = ?')
      .get('decision-target-1') as Record<string, unknown>;
    expect(row.outcome).toBe('SUCCESS');
    expect(row.confidence).toBe(0.9);
    expect(row.duration_days).toBe(3);

    // The amendment record is a new decisions row authored by the command.
    const amendments = db
      .prepare(
        `SELECT id, record_kind, payload_json FROM decisions
         WHERE record_kind IS NOT NULL AND id <> 'decision-target-1'`
      )
      .all() as Array<{ id: string; record_kind: string; payload_json: string }>;
    expect(amendments).toHaveLength(1);
    expect(amendments[0].record_kind).toBe('judgment');
    expect(JSON.parse(amendments[0].payload_json)).toMatchObject({
      amended: 'decision-target-1',
      outcome: 'SUCCESS',
    });
  });

  it('keeps prior outcome history when a second update lands', async () => {
    seedDecision('decision-target-2');
    await updateDecisionOutcome('decision-target-2', { outcome: 'FAILED', failure_reason: 'oops' });
    await updateDecisionOutcome('decision-target-2', { outcome: 'SUCCESS' });

    const db = getAdapter();
    const row = db
      .prepare('SELECT outcome, failure_reason FROM decisions WHERE id = ?')
      .get('decision-target-2') as { outcome: string; failure_reason: string | null };
    expect(row.outcome).toBe('SUCCESS');
    // failure_reason was not part of the second update's payload → cleared by
    // the amendment (parity with the legacy UPDATE that wrote NULL).
    expect(row.failure_reason).toBeNull();

    const history = db
      .prepare(
        `SELECT payload_json FROM decisions
         WHERE record_kind = 'judgment' AND id <> 'decision-target-2'
         ORDER BY created_at, rowid`
      )
      .all() as Array<{ payload_json: string }>;
    expect(history).toHaveLength(2);
    expect(JSON.parse(history[0].payload_json).outcome).toBe('FAILED');
    expect(JSON.parse(history[1].payload_json).outcome).toBe('SUCCESS');
  });

  it('replays an identical update instead of appending a second record', async () => {
    seedDecision('decision-target-3');
    await updateDecisionOutcome('decision-target-3', { outcome: 'PARTIAL' });
    await updateDecisionOutcome('decision-target-3', { outcome: 'PARTIAL' });

    const count = getAdapter()
      .prepare(
        `SELECT COUNT(*) AS n FROM decisions
         WHERE record_kind = 'judgment' AND id <> 'decision-target-3'`
      )
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('fails when the target decision does not exist', async () => {
    await expect(updateDecisionOutcome('missing-id', { outcome: 'SUCCESS' })).rejects.toThrow(
      /Decision not found/
    );
    expect(getAdapter().prepare('SELECT COUNT(*) AS n FROM decisions').get()).toEqual({ n: 0 });
  });
});
