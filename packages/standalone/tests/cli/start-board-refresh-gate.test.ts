import { describe, expect, it, vi } from 'vitest';
import Database from '../../src/sqlite.js';
import { BoardRefreshGate } from '../../src/operator/board-refresh-gate.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import { buildOwnerWorkOrderRequestHandler } from '../../src/cli/commands/start.js';

describe('TG-06 owner board workorder repair generation', () => {
  it.each(['board', 'wiki', 'memory-curation'] as const)(
    'dedupes a receipted owner-event %s handoff even after the first workorder is terminal',
    (kind) => {
      const db = new Database(':memory:');
      const ledger = new TaskLedger(db);
      let now = 1_000;
      const handler = buildOwnerWorkOrderRequestHandler({
        taskLedger: ledger,
        boardRefreshGate: null,
        now: () => now,
        log: vi.fn(),
        logError: vi.fn(),
      });

      expect(handler(kind, ['evt-owner-1'])).toEqual({ accepted: true });
      const first = ledger.claimNextWorkOrder();
      if (!first) throw new Error('owner-event workorder expected');
      expect(first.idempotencyKey).toMatch(new RegExp(`^owner-event:${kind}:`));
      ledger.completeWorkOrder(first.id);

      now = 9_000;
      expect(handler(kind, ['evt-owner-1'])).toEqual({ accepted: true });
      expect(ledger.claimNextWorkOrder()).toBeNull();
      expect(
        (
          db.prepare(`SELECT COUNT(*) AS n FROM operator_tasks WHERE kind = 'system'`).get() as {
            n: number;
          }
        ).n
      ).toBe(1);
      db.close();
    }
  );

  it('marks eventless and event-backed owner full requests dirty before enqueue and carries exact scopes', () => {
    const db = new Database(':memory:');
    const ledger = new TaskLedger(db);
    const gate = new BoardRefreshGate({ initialGeneration: 100 });
    const handler = buildOwnerWorkOrderRequestHandler({
      taskLedger: ledger,
      boardRefreshGate: gate,
      now: () => 1_000,
      log: vi.fn(),
      logError: vi.fn(),
    });

    expect(handler('board')).toEqual({ accepted: true });
    const eventless = ledger.claimNextWorkOrder();
    expect(eventless?.payload).toEqual({
      attempts: 1,
      mode: 'full',
      force: true,
      repairGeneration: 101,
      noUpdateScope: 'full:101',
    });
    if (!eventless) throw new Error('eventless owner board workorder expected');
    ledger.completeWorkOrder(eventless.id);

    expect(handler('board', ['evt-host-1'])).toEqual({ accepted: true });
    expect(ledger.claimNextWorkOrder()?.payload).toEqual({
      attempts: 1,
      mode: 'full',
      force: true,
      eventIds: ['evt-host-1'],
      repairGeneration: 102,
      noUpdateScope: 'full:102',
    });
    db.close();
  });

  it('leaves synthetic dirt when owner board enqueue fails', () => {
    const db = new Database(':memory:');
    const ledger = new TaskLedger(db);
    const gate = new BoardRefreshGate({ initialGeneration: 200 });
    const logError = vi.fn();
    const handler = buildOwnerWorkOrderRequestHandler({
      taskLedger: ledger,
      boardRefreshGate: gate,
      now: () => 2_000,
      log: vi.fn(),
      logError,
    });
    db.close();

    expect(handler('board')).toEqual({ accepted: false, reason: 'enqueue-failed' });
    expect(gate.captureFullRepair()).toEqual({
      repairGeneration: 201,
      noUpdateScope: 'full:201',
    });
    expect(gate.needsFullRepair()).toBe(true);
    expect(logError).toHaveBeenCalledOnce();
  });

  it('preserves legacy owner board payloads when reconcile is disabled', () => {
    const db = new Database(':memory:');
    const ledger = new TaskLedger(db);
    const handler = buildOwnerWorkOrderRequestHandler({
      taskLedger: ledger,
      boardRefreshGate: null,
      now: () => 3_000,
      log: vi.fn(),
      logError: vi.fn(),
    });

    expect(handler('board')).toEqual({ accepted: true });
    expect(ledger.claimNextWorkOrder()?.payload).toEqual({
      attempts: 1,
      mode: 'full',
      force: true,
    });
    db.close();
  });
});
