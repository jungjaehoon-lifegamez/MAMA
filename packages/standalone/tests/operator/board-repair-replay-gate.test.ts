/**
 * Stage 0 reproduction: the stable board-repair occurrence key
 * (`board:full:repair`) is sealed forever once any confirmed effect lands on it,
 * so every later non-forced full board run fails at claim without running and
 * the owner-visible summary slots never refresh.
 *
 * The consumer deps mirror how start.ts wires the ledger:
 *   hasUnsafeReplayEffects: (wo) =>
 *     ledger.hasUnsafeReplayEffects(`workorder:${wo.idempotencyKey}`)
 *
 * Plan: .superpowers/plans/2026-09-08-intent-v4-owner-flow.md (Stage 0).
 */
import { describe, it, expect } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import {
  OwnerActionEffectLedger,
  type OwnerActionContext,
} from '../../src/operator/owner-action-effects.js';
import { boardRepairKey } from '../../src/operator/workorder-publishers.js';
import {
  WorkOrderConsumer,
  type WorkOrderConsumerDeps,
  type WorkOrderConsumerEvent,
} from '../../src/operator/workorder-consumer.js';

const REPAIR_OCCURRENCE = `workorder:${boardRepairKey()}`;

function makeContext(): OwnerActionContext {
  return {
    ownerScope: 'owner:runtime',
    occurrenceKey: REPAIR_OCCURRENCE,
    modelRunId: 'mr-board-repair',
    envelopeHash: 'envelope-hash',
  };
}

function makeHarness(): {
  db: SQLiteDatabase;
  ledger: TaskLedger;
  effects: OwnerActionEffectLedger;
  deps: WorkOrderConsumerDeps;
  events: WorkOrderConsumerEvent[];
  runs: () => number;
} {
  const db: SQLiteDatabase = new Database(':memory:');
  const ledger = new TaskLedger(db);
  const effects = new OwnerActionEffectLedger(db);
  const events: WorkOrderConsumerEvent[] = [];
  let runs = 0;
  const deps: WorkOrderConsumerDeps = {
    ledger,
    runner: {
      runWithContent: async () => {
        runs++;
        return { response: 'board refreshed' };
      },
    },
    loadOwnerBrief: () => 'You are a test worker. Do the work.',
    noticeOwner: () => {},
    opsAlarm: { configured: true, send: async () => {} },
    onEvent: (event) => events.push(event),
    log: () => {},
    hasUnsettledEffects: (wo) => effects.hasUnsettledEffects(`workorder:${wo.idempotencyKey}`),
    hasUnsafeReplayEffects: (wo) => effects.hasUnsafeReplayEffects(`workorder:${wo.idempotencyKey}`),
  };
  return { db, ledger, effects, deps, events, runs: () => runs };
}

function enqueueBoardRepair(ledger: TaskLedger): number {
  return ledger.enqueueWorkOrder({
    workKind: 'board',
    idempotencyKey: boardRepairKey(),
    input: { mode: 'full' },
  }).id;
}

const BLOCKED_REASON = 'owner effect requires reconciliation before replay';

describe('board repair occurrence: replay gate', () => {
  it('runs again after a confirmed task_create on the stable repair occurrence', async () => {
    const ctx = makeHarness();
    try {
      ctx.effects.atomic(
        makeContext(),
        'task:weekly-note',
        'task_create',
        { title: 'draft the weekly note', completion_criteria: 'note published' },
        () => ({ taskId: 1 })
      );
      const id = enqueueBoardRepair(ctx.ledger);

      await new WorkOrderConsumer(ctx.deps).tick();

      expect(ctx.runs()).toBe(1);
      expect(
        ctx.events.filter((event) => event.type === 'failed' && event.workOrderId === id)
      ).toHaveLength(0);
    } finally {
      ctx.db.close();
    }
  });

  it('still blocks after a confirmed gateway Bash effect on the same occurrence', async () => {
    const ctx = makeHarness();
    try {
      ctx.effects.atomic(
        makeContext(),
        'Bash:deadbeef',
        'Bash',
        { inputSha256: 'deadbeef' },
        () => ({ success: true })
      );
      const id = enqueueBoardRepair(ctx.ledger);

      await new WorkOrderConsumer(ctx.deps).tick();

      expect(ctx.runs()).toBe(0);
      expect(ctx.events).toContainEqual({
        type: 'failed',
        workKind: 'board',
        workOrderId: id,
        reason: BLOCKED_REASON,
      });
    } finally {
      ctx.db.close();
    }
  });

  it('still blocks after a confirmed native_tool effect on the same occurrence', async () => {
    const ctx = makeHarness();
    try {
      ctx.effects.atomic(
        makeContext(),
        'native:abc123',
        'native_tool',
        { toolName: 'commandExecution' },
        () => ({ success: true })
      );
      const id = enqueueBoardRepair(ctx.ledger);

      await new WorkOrderConsumer(ctx.deps).tick();

      expect(ctx.runs()).toBe(0);
      expect(ctx.events).toContainEqual({
        type: 'failed',
        workKind: 'board',
        workOrderId: id,
        reason: BLOCKED_REASON,
      });
    } finally {
      ctx.db.close();
    }
  });

  it('still blocks while a task_create effect is unsettled (transmitting)', async () => {
    const ctx = makeHarness();
    try {
      const reservation = ctx.effects.begin(makeContext(), 'task:in-flight', 'task_create', {
        title: 'draft the weekly note',
      });
      expect(reservation.state).toBe('execute');
      const id = enqueueBoardRepair(ctx.ledger);

      await new WorkOrderConsumer(ctx.deps).tick();

      expect(ctx.runs()).toBe(0);
      expect(ctx.events).toContainEqual({
        type: 'failed',
        workKind: 'board',
        workOrderId: id,
        reason: BLOCKED_REASON,
      });
    } finally {
      ctx.db.close();
    }
  });
});
