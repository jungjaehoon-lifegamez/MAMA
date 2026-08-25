import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OwnerEventBoardRefreshLedger,
  resolveInitialBoardRepairGeneration,
} from '../../src/operator/owner-event-board-refresh.js';
import { OwnerEventInbox } from '../../src/operator/owner-event-inbox.js';
import { boardRepairKey } from '../../src/operator/workorder-publishers.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import Database from '../../src/sqlite.js';

describe('TG-06 owner-event Board refresh intents', () => {
  let db: Database;
  let inbox: OwnerEventInbox;
  let tasks: TaskLedger;
  let ledger: OwnerEventBoardRefreshLedger;
  let now: number;

  beforeEach(() => {
    now = 1_000;
    db = new Database(':memory:');
    tasks = new TaskLedger(db, { now: () => now, timeZone: 'UTC' });
    inbox = new OwnerEventInbox(db, () => now);
    ledger = new OwnerEventBoardRefreshLedger(db, tasks, () => now);
  });

  afterEach(() => {
    db.close();
  });

  function enqueueBatch(eventIds: string[]): number {
    const id = inbox.enqueue({
      channelKey: 'chatwork:feedback',
      eventIds,
      lines: eventIds.map((eventId) => `line:${eventId}`),
      activations: [],
    });
    if (id === null) throw new Error('test batch unexpectedly deduplicated');
    return id;
  }

  it('atomically binds one exact batch to one shared non-force Board workorder', () => {
    const batchId = enqueueBatch(['evt-b', 'evt-a']);

    const accepted = ledger.accept({
      batchId,
      eventIds: ['evt-b', 'evt-a'],
      repair: { repairGeneration: 11, noUpdateScope: 'full:11' },
    });

    expect(accepted).toEqual({
      batchId,
      batchKey: 'owner-event:board:02b6fa63682561df',
      repairGeneration: 11,
      workOrderId: accepted.workOrderId,
      appliedAt: null,
    });
    expect(accepted.workOrderId).toBeGreaterThan(0);
    expect(tasks.countPendingWorkOrders()).toBe(1);
    expect(tasks.findWorkOrderByOccurrence('board', boardRepairKey())).toMatchObject({
      id: accepted.workOrderId,
      payload: {
        mode: 'full',
        force: false,
        repairGeneration: 11,
        noUpdateScope: 'full:11',
        attempts: 1,
      },
    });
  });

  it('returns the same acceptance for one batch without enqueueing again', () => {
    const batchId = enqueueBatch(['evt-1']);
    const input = {
      batchId,
      eventIds: ['evt-1'],
      repair: { repairGeneration: 12, noUpdateScope: 'full:12' },
    } as const;

    const first = ledger.accept(input);
    const second = ledger.accept(input);

    expect(second).toEqual(first);
    expect(tasks.countPendingWorkOrders()).toBe(1);
  });

  it('refuses reuse of one inbox batch with different event identity', () => {
    const batchId = enqueueBatch(['evt-1']);
    ledger.accept({
      batchId,
      eventIds: ['evt-1'],
      repair: { repairGeneration: 12, noUpdateScope: 'full:12' },
    });

    expect(() =>
      ledger.accept({
        batchId,
        eventIds: ['evt-2'],
        repair: { repairGeneration: 13, noUpdateScope: 'full:13' },
      })
    ).toThrow(/conflicts with its stored event identity/);
  });

  it('coalesces twenty distinct batches onto one open workorder', () => {
    const accepted = Array.from({ length: 20 }, (_, index) => {
      const eventId = `evt-${index + 1}`;
      return ledger.accept({
        batchId: enqueueBatch([eventId]),
        eventIds: [eventId],
        repair: {
          repairGeneration: 20 + index,
          noUpdateScope: `full:${20 + index}`,
        },
      });
    });

    expect(new Set(accepted.map((row) => row.workOrderId)).size).toBe(1);
    expect(tasks.countPendingWorkOrders()).toBe(1);
    expect(ledger.maxPendingGeneration()).toBe(39);
  });

  it('rolls back the newly enqueued workorder when intent persistence fails', () => {
    const batchId = enqueueBatch(['evt-rollback']);
    db.exec(`
      CREATE TRIGGER fail_owner_event_board_intent
      BEFORE INSERT ON owner_event_board_refresh_intents
      BEGIN
        SELECT RAISE(ABORT, 'forced intent failure');
      END;
    `);

    expect(() =>
      ledger.accept({
        batchId,
        eventIds: ['evt-rollback'],
        repair: { repairGeneration: 30, noUpdateScope: 'full:30' },
      })
    ).toThrow(/forced intent failure/);
    expect(tasks.countPendingWorkOrders()).toBe(0);
    expect(ledger.findAcceptance(batchId)).toBeNull();
  });

  it('applies only captured generations and emits one post-terminal follow-up signal', () => {
    const accepted = Array.from({ length: 10 }, (_, index) => {
      const eventId = `evt-${index + 1}`;
      return ledger.accept({
        batchId: enqueueBatch([eventId]),
        eventIds: [eventId],
        repair: {
          repairGeneration: 20 + index,
          noUpdateScope: `full:${20 + index}`,
        },
      });
    });
    const workOrderId = accepted[0].workOrderId;

    expect(ledger.markVerified(workOrderId, 25)).toEqual({
      applied: 6,
      followupPending: true,
    });
    expect(ledger.findAcceptance(accepted[0].batchId)?.appliedAt).toBe(now);
    expect(ledger.findAcceptance(accepted[9].batchId)?.appliedAt).toBeNull();
    expect(ledger.consumePostTerminalFollowup(workOrderId)).toBe(true);
    expect(ledger.consumePostTerminalFollowup(workOrderId)).toBe(false);
    expect(ledger.maxPendingGeneration()).toBe(29);
  });

  it('reattaches only pending intents to a replacement workorder', () => {
    const firstBatch = enqueueBatch(['evt-first']);
    const secondBatch = enqueueBatch(['evt-second']);
    const first = ledger.accept({
      batchId: firstBatch,
      eventIds: ['evt-first'],
      repair: { repairGeneration: 20, noUpdateScope: 'full:20' },
    });
    ledger.accept({
      batchId: secondBatch,
      eventIds: ['evt-second'],
      repair: { repairGeneration: 21, noUpdateScope: 'full:21' },
    });
    ledger.markVerified(first.workOrderId, 20);
    expect(tasks.claimNextWorkOrder()?.id).toBe(first.workOrderId);
    tasks.completeWorkOrder(first.workOrderId);
    const replacement = tasks.enqueueWorkOrder({
      workKind: 'board',
      idempotencyKey: boardRepairKey(),
      input: {
        mode: 'full',
        force: false,
        repairGeneration: 21,
        noUpdateScope: 'full:21',
      },
    });

    expect(ledger.attachPendingToWorkOrder(replacement.id)).toBe(1);
    expect(ledger.findAcceptance(firstBatch)?.workOrderId).toBe(first.workOrderId);
    expect(ledger.findAcceptance(secondBatch)?.workOrderId).toBe(replacement.id);
  });

  it('deletes an intent with its retained owner-event inbox row', () => {
    const batchId = enqueueBatch(['evt-delete']);
    ledger.accept({
      batchId,
      eventIds: ['evt-delete'],
      repair: { repairGeneration: 40, noUpdateScope: 'full:40' },
    });

    db.prepare('DELETE FROM owner_event_inbox WHERE id = ?').run(batchId);

    expect(ledger.findAcceptance(batchId)).toBeNull();
  });

  it('chooses a boot generation above both wall time and pending intent generations', () => {
    expect(resolveInitialBoardRepairGeneration(100, null)).toBe(100);
    expect(resolveInitialBoardRepairGeneration(100, 150)).toBe(151);
    expect(resolveInitialBoardRepairGeneration(200, 150)).toBe(200);
    expect(() => resolveInitialBoardRepairGeneration(-1, null)).toThrow(/non-negative/);
    expect(() => resolveInitialBoardRepairGeneration(100, Number.MAX_SAFE_INTEGER)).toThrow(
      /generation exhausted/
    );
  });
});
