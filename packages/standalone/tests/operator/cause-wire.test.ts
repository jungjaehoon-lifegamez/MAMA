/**
 * The hop between a published work order and the cause on a durable effect.
 *
 * `tests/operator/bounded-run-cause.test.ts` proves the ledger attributes a change to the
 * batch it is handed. It hands the batch over directly, which leaves the part that actually
 * broke in production untested: the payload -> runOptions -> execution context -> ledger
 * wire. Review found `causeEventIds` in exactly two test files, both calling the ledger
 * straight, so a rename or a payload-shape drift on `wo.payload.eventIds` would have taken
 * attribution back to 32% with the whole suite green - the same shape as the `code_act` /
 * `mcp__code-act__code_act` defect that survived months of green tests.
 *
 * Synthetic data only; in-memory sqlite.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import { listEffects } from '../../src/evidence/effects.js';
import { causeEventIdsFromPayload } from '../../src/cli/commands/start.js';
import {
  boardFullKey,
  boardReconcileKey,
  validateWorkOrderPayload,
} from '../../src/operator/workorder-publishers.js';

describe('a published batch reaches the effect row', () => {
  let db: SQLiteDatabase;
  let ledger: TaskLedger;
  const adapter = () => db as never;

  beforeEach(() => {
    db = new Database(':memory:');
    ledger = new TaskLedger(db);
  });

  /** Publish through the real publisher validation, then claim it back. */
  function publishAndClaim(payload: Record<string, unknown>) {
    validateWorkOrderPayload('board', payload);
    ledger.enqueueWorkOrder({
      workKind: 'board',
      idempotencyKey:
        payload.mode === 'reconcile'
          ? boardReconcileKey(String(payload.channelKey), 1)
          : boardFullKey(1),
      input: payload,
    });
    const claimed = ledger.claimNextWorkOrder();
    expect(claimed).not.toBeNull();
    return claimed!;
  }

  it('carries a reconcile batch from the published payload onto what the run changes', () => {
    const batch = ['evt_a', 'evt_b'];
    const wo = publishAndClaim({
      mode: 'reconcile',
      channelKey: 'chat:C001',
      deltaLines: ['- [id:evt_a] someone: a thing'],
      eventIds: batch,
    });

    // The hop under test: the payload the consumer claimed becomes the run's cause.
    const causeEventIds = causeEventIdsFromPayload(wo.payload);
    expect(causeEventIds).toEqual(batch);

    const task = ledger.create({ title: 'follow up' });
    ledger.update(task.id, { status: 'done' }, { runId: 'mr_1', causeEventIds });

    expect(listEffects(adapter()).find((e) => e.kind === 'task_update')).toMatchObject({
      causeState: 'attributed',
      sourceEventIds: batch,
    });
  });

  // board:full is the 539-run lane that still has no batch. It must produce an honest
  // unattributed change rather than an invented cause.
  it('leaves a full-board run unattributed, because it was published without a batch', () => {
    const wo = publishAndClaim({ mode: 'full' });

    expect(causeEventIdsFromPayload(wo.payload)).toEqual([]);

    const task = ledger.create({ title: 'from a full run' });
    ledger.update(task.id, { status: 'done' }, { runId: 'mr_2' });

    expect(listEffects(adapter()).find((e) => e.kind === 'task_update')).toMatchObject({
      causeState: 'unattributed',
      sourceEventIds: [],
    });
  });

  // The shapes a drifting publisher could produce. None of them may become a cause.
  it.each([
    ['a missing field', {}],
    ['a non-array', { eventIds: 'evt_a' }],
    ['blank entries', { eventIds: ['', '   '] }],
    ['non-strings', { eventIds: [1, null, true] }],
  ])('refuses %s rather than inventing a batch', (_label, payload) => {
    expect(causeEventIdsFromPayload(payload)).toEqual([]);
  });

  it('keeps the usable ids when a batch is partly malformed', () => {
    expect(causeEventIdsFromPayload({ eventIds: ['evt_a', '', 42, 'evt_b'] })).toEqual([
      'evt_a',
      'evt_b',
    ]);
  });
});
