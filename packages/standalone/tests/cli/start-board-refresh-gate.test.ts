import { describe, expect, it, vi } from 'vitest';

import { buildOwnerWorkOrderRequestHandler } from '../../src/cli/commands/start.js';
import { BoardRefreshGate } from '../../src/operator/board-refresh-gate.js';
import { OwnerEventBoardRefreshLedger } from '../../src/operator/owner-event-board-refresh.js';
import { OwnerEventInbox } from '../../src/operator/owner-event-inbox.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import Database from '../../src/sqlite.js';

describe('TG-03/TG-04/TG-06 owner Board workorder coordination', () => {
  function createHarness(initialGeneration = 100) {
    const db = new Database(':memory:');
    const taskLedger = new TaskLedger(db, { now: () => 1_000, timeZone: 'UTC' });
    const inbox = new OwnerEventInbox(db, () => 1_000);
    const ownerEventBoardRefreshLedger = new OwnerEventBoardRefreshLedger(
      db,
      taskLedger,
      () => 1_000
    );
    const boardRefreshGate = new BoardRefreshGate({ initialGeneration });
    const handler = buildOwnerWorkOrderRequestHandler({
      taskLedger,
      boardRefreshGate,
      ownerEventBoardRefreshLedger,
      now: () => 1_000,
      log: vi.fn(),
      logError: vi.fn(),
    });
    const enqueueBatch = (eventId: string): number => {
      const batchId = inbox.enqueue({
        channelKey: 'chatwork:feedback',
        eventIds: [eventId],
        lines: [`line:${eventId}`],
        activations: [],
      });
      if (batchId === null) throw new Error('test batch unexpectedly deduplicated');
      return batchId;
    };
    return {
      db,
      taskLedger,
      ownerEventBoardRefreshLedger,
      boardRefreshGate,
      handler,
      enqueueBatch,
    };
  }

  it.each(['wiki', 'memory-curation'] as const)(
    'preserves permanent owner-event %s handoff identity after terminal completion',
    (kind) => {
      const ctx = createHarness();
      const origin = {
        kind: 'owner_event' as const,
        batchId: ctx.enqueueBatch('evt-owner-1'),
        eventIds: ['evt-owner-1'],
      };

      expect(ctx.handler(kind, origin)).toEqual({ accepted: true });
      const first = ctx.taskLedger.claimNextWorkOrder();
      if (!first) throw new Error('owner-event workorder expected');
      expect(first.idempotencyKey).toMatch(new RegExp(`^owner-event:${kind}:`));
      ctx.taskLedger.completeWorkOrder(first.id);

      expect(ctx.handler(kind, origin)).toEqual({ accepted: true });
      expect(ctx.taskLedger.claimNextWorkOrder()).toBeNull();
      expect(
        (
          ctx.db
            .prepare(`SELECT COUNT(*) AS n FROM operator_tasks WHERE kind = 'system'`)
            .get() as {
            n: number;
          }
        ).n
      ).toBe(1);
      ctx.db.close();
    }
  );

  it('keeps a direct owner manual Board request forced and uniquely keyed', () => {
    const ctx = createHarness(100);

    expect(ctx.handler('board', { kind: 'owner_manual' })).toEqual({ accepted: true });
    expect(ctx.taskLedger.claimNextWorkOrder()?.payload).toEqual({
      attempts: 1,
      mode: 'full',
      force: true,
      repairGeneration: 101,
      noUpdateScope: 'full:101',
    });
    ctx.db.close();
  });

  it('coalesces owner-event Board requests into one shared non-force workorder', () => {
    const ctx = createHarness(200);
    const origins = Array.from({ length: 20 }, (_, index) => {
      const eventId = `evt-${index + 1}`;
      return {
        kind: 'owner_event' as const,
        batchId: ctx.enqueueBatch(eventId),
        eventIds: [eventId],
      };
    });

    for (const origin of origins) {
      expect(ctx.handler('board', origin)).toEqual({ accepted: true });
    }

    expect(ctx.taskLedger.countPendingWorkOrders()).toBe(1);
    const workOrder = ctx.taskLedger.claimNextWorkOrder();
    expect(workOrder?.idempotencyKey).toBe('board:full:repair');
    expect(workOrder?.payload).toEqual({
      attempts: 1,
      mode: 'full',
      force: false,
      repairGeneration: 201,
      noUpdateScope: 'full:201',
    });
    expect(
      new Set(
        origins.map(
          (origin) => ctx.ownerEventBoardRefreshLedger.findAcceptance(origin.batchId)?.workOrderId
        )
      ).size
    ).toBe(1);
    expect(ctx.ownerEventBoardRefreshLedger.maxPendingGeneration()).toBe(220);
    ctx.db.close();
  });

  it('returns the same durable acceptance when one owner-event batch retries', () => {
    const ctx = createHarness(300);
    const origin = {
      kind: 'owner_event' as const,
      batchId: ctx.enqueueBatch('evt-retry'),
      eventIds: ['evt-retry'],
    };

    expect(ctx.handler('board', origin)).toEqual({ accepted: true });
    const first = ctx.ownerEventBoardRefreshLedger.findAcceptance(origin.batchId);
    expect(ctx.handler('board', origin)).toEqual({ accepted: true });

    expect(ctx.ownerEventBoardRefreshLedger.findAcceptance(origin.batchId)).toEqual(first);
    expect(ctx.taskLedger.countPendingWorkOrders()).toBe(1);
    ctx.db.close();
  });

  it('fails closed instead of restoring the forced owner-event path when coordination is absent', () => {
    const db = new Database(':memory:');
    const taskLedger = new TaskLedger(db);
    const inbox = new OwnerEventInbox(db);
    const batchId = inbox.enqueue({
      channelKey: 'chatwork:feedback',
      eventIds: ['evt-missing'],
      lines: ['line'],
      activations: [],
    });
    if (batchId === null) throw new Error('test batch unexpectedly deduplicated');
    const handler = buildOwnerWorkOrderRequestHandler({
      taskLedger,
      boardRefreshGate: null,
      ownerEventBoardRefreshLedger: undefined,
      log: vi.fn(),
      logError: vi.fn(),
    });

    expect(
      handler('board', {
        kind: 'owner_event',
        batchId,
        eventIds: ['evt-missing'],
      })
    ).toEqual({ accepted: false, reason: 'enqueue-failed' });
    expect(taskLedger.countPendingWorkOrders()).toBe(0);
    db.close();
  });

  it('leaves synthetic dirt when a manual Board enqueue fails', () => {
    const ctx = createHarness(400);
    ctx.db.close();

    expect(ctx.handler('board', { kind: 'owner_manual' })).toEqual({
      accepted: false,
      reason: 'enqueue-failed',
    });
    expect(ctx.boardRefreshGate.captureFullRepair()).toEqual({
      repairGeneration: 401,
      noUpdateScope: 'full:401',
    });
    expect(ctx.boardRefreshGate.needsFullRepair()).toBe(true);
  });
});
