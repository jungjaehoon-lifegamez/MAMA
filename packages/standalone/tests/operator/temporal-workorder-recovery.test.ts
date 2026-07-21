import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TaskLedger, type TemporalWorkContext } from '../../src/operator/task-ledger.js';
import type { TemporalReconcileInput } from '../../src/operator/temporal-effect.js';
import { occurrenceKeyForTask } from '../../src/operator/task-temporal.js';
import {
  WorkOrderConsumer,
  type WorkOrderConsumerEvent,
  type WorkOrderHook,
} from '../../src/operator/workorder-consumer.js';
import { buildTemporalWorkOrderHook } from '../../src/operator/workorder-hooks.js';

describe('Story A2 Task 9: authoritative temporal workorder recovery', () => {
  let db: SQLiteDatabase;
  let ledger: TaskLedger;
  let context: TemporalWorkContext | null;
  let events: WorkOrderConsumerEvent[];
  let alarms: string[];

  beforeEach(() => {
    db = new Database(':memory:');
    ledger = new TaskLedger(db, {
      now: () => Date.parse('2026-07-21T15:00:00Z'),
      timeZone: 'Asia/Seoul',
    });
    context = null;
    events = [];
    alarms = [];
  });

  afterEach(() => db.close());

  function applyEffect(contextValue: TemporalWorkContext, input: TemporalReconcileInput) {
    return ledger.applyTemporalEffect(contextValue, input, {
      contextPacketId: 'ctxp_temporal_recovery_test',
      contextPacketSha256: 'b'.repeat(64),
    });
  }

  function enqueueTemporalAttempt(): number {
    const task = ledger.create({
      title: 'Confirm the elapsed meeting outcome',
      due_at: '2026-07-21T14:00:00+09:00',
      source_channel: 'trello:board-148',
      source_event_id: 'card-131',
    });
    const occurrenceKey = occurrenceKeyForTask(task)!;
    const generationKey = `task:${task.id}:${occurrenceKey}:check:${task.dueAt}`;
    return ledger.enqueueTemporalGeneration({
      generationKey,
      taskId: task.id,
      temporalEpoch: task.temporalEpoch,
      occurrenceKey,
      checkAt: task.dueAt!,
      sourceChannel: task.sourceChannel,
      sourceEventId: task.sourceEventId,
    }).workOrder.id;
  }

  function createConsumer(
    run: () => Promise<{ response: string }>,
    hook?: WorkOrderHook,
    onRun?: () => void
  ): WorkOrderConsumer {
    const consumer = new WorkOrderConsumer({
      ledger,
      runner: {
        runWithContent: async () => {
          onRun?.();
          return run();
        },
      },
      loadBrief: () => 'Reconcile the temporal task using the trusted tool.',
      runOptionsFor: (workOrder) => {
        context = ledger.loadTemporalWorkContext(workOrder.id);
        return { workorderAttemptId: workOrder.id };
      },
      noticeOwner: () => {},
      opsAlarm: {
        configured: true,
        send: async (line) => void alarms.push(line),
      },
      onEvent: (event) => events.push(event),
      log: () => {},
    });
    consumer.registerHook(
      'temporal',
      hook ??
        buildTemporalWorkOrderHook({
          loadTemporalWorkContext: (attemptId) => ledger.loadTemporalWorkContext(attemptId),
          getTemporalEffect: (attemptId) => ledger.getTemporalEffect(attemptId),
          getTask: (taskId) => ledger.getById(taskId),
          getTemporalGeneration: (generationKey) => ledger.getTemporalGeneration(generationKey),
          getScopedNoteMaxId: (scope) => ledger.maxNoUpdateId(scope),
        })
    );
    return consumer;
  }

  it('keeps the committed effect authoritative when the runner rejects afterward', async () => {
    const attemptId = enqueueTemporalAttempt();
    const consumer = createConsumer(async () => {
      if (!context) throw new Error('trusted context was not loaded');
      applyEffect(context, {
        expected_revision: context.revision,
        outcome: 'resolved',
        status: 'done',
        reason: 'The source confirms the meeting completed',
      });
      throw new Error('transport closed after the effect committed');
    });

    await expect(consumer.tick()).resolves.toBe('drained');

    expect(ledger.getTemporalEffect(attemptId)).not.toBeNull();
    expect(db.prepare(`SELECT status FROM operator_tasks WHERE id = ?`).get(attemptId)).toEqual({
      status: 'done',
    });
    expect(events).toContainEqual({
      type: 'complete',
      workKind: 'temporal',
      workOrderId: attemptId,
    });
    expect(events.some((event) => event.type === 'requeued')).toBe(false);
    expect(events.some((event) => event.type === 'exhausted')).toBe(false);
    expect(alarms).toHaveLength(0);
  });

  it.each([
    [
      'audit throws',
      {
        verdictRequired: true,
        before: () => ({ captured: true }),
        after: () => {
          throw new Error('audit storage unavailable');
        },
      } satisfies WorkOrderHook,
    ],
    [
      'audit returns a malformed verdict',
      {
        verdictRequired: true,
        before: () => ({ captured: true }),
        after: () => null as never,
      } satisfies WorkOrderHook,
    ],
  ])('keeps the committed effect authoritative when the %s', async (_label, hook) => {
    const attemptId = enqueueTemporalAttempt();
    const consumer = createConsumer(async () => {
      if (!context) throw new Error('trusted context was not loaded');
      applyEffect(context, {
        expected_revision: context.revision,
        outcome: 'resolved',
        status: 'done',
        reason: 'The source confirms completion',
      });
      return { response: 'untrusted prose' };
    }, hook);

    await expect(consumer.tick()).resolves.toBe('drained');

    expect(ledger.inspectTemporalAttempt(attemptId).workOrder.status).toBe('done');
    expect(events.some((event) => event.type === 'complete')).toBe(true);
    expect(events.some((event) => event.type === 'requeued')).toBe(false);
  });

  it.each([
    ['explanation only', 'I inspected the source and would leave it unchanged.'],
    ['empty response', ''],
  ])('retries an in-progress attempt after a runner returns %s', async (_label, response) => {
    const attemptId = enqueueTemporalAttempt();
    let inspections = 0;
    const inspect = ledger.inspectTemporalAttempt.bind(ledger);
    ledger.inspectTemporalAttempt = (id) => {
      inspections++;
      return inspect(id);
    };
    const consumer = createConsumer(async () => ({ response }));

    await expect(consumer.tick()).resolves.toBe('drained');

    expect(inspections).toBeGreaterThan(0);
    expect(ledger.getTemporalEffect(attemptId)).toBeNull();
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'failed', workOrderId: attemptId })
    );
    expect(events.some((event) => event.type === 'requeued')).toBe(true);
    expect(events.some((event) => event.type === 'complete')).toBe(false);
  });

  it('mutates nothing on a state-read failure and blocks later claims until rechecked', async () => {
    const attemptId = enqueueTemporalAttempt();
    const board = ledger.enqueueWorkOrder({
      workKind: 'board',
      idempotencyKey: 'board:must-wait',
      input: { mode: 'full' },
      priority: 'low',
    });
    const inspect = ledger.inspectTemporalAttempt.bind(ledger);
    let failRead = true;
    ledger.inspectTemporalAttempt = (id) => {
      if (failRead) throw new Error('synthetic state read failure');
      return inspect(id);
    };
    let runs = 0;
    const consumer = createConsumer(async () => {
      runs++;
      return { response: 'explanation without an effect' };
    });

    await consumer.tick();
    expect(runs).toBe(1);
    expect(inspect(attemptId).workOrder.status).toBe('in_progress');
    expect(db.prepare(`SELECT status FROM operator_tasks WHERE id = ?`).get(board.id)).toEqual({
      status: 'pending',
    });

    failRead = false;
    await consumer.tick();
    expect(runs).toBe(1);
    expect(events.some((event) => event.type === 'requeued')).toBe(true);
    expect(db.prepare(`SELECT status FROM operator_tasks WHERE id = ?`).get(board.id)).toEqual({
      status: 'pending',
    });
  });

  it('retries a stale in-progress attempt with no receipt after a crash', () => {
    const attemptId = enqueueTemporalAttempt();
    expect(ledger.claimNextWorkOrder()?.id).toBe(attemptId);
    const consumer = createConsumer(async () => ({ response: 'unused' }));

    consumer.bootRecover();

    expect(events).toContainEqual({
      type: 'stale-claim',
      workKind: 'temporal',
      workOrderId: attemptId,
    });
    expect(events.some((event) => event.type === 'requeued')).toBe(true);
    expect(ledger.getTemporalEffect(attemptId)).toBeNull();
  });

  it('does not recover or rerun an effect committed before a crash', async () => {
    const attemptId = enqueueTemporalAttempt();
    expect(ledger.claimNextWorkOrder()?.id).toBe(attemptId);
    const trusted = ledger.loadTemporalWorkContext(attemptId);
    applyEffect(trusted, {
      expected_revision: trusted.revision,
      outcome: 'resolved',
      status: 'done',
      reason: 'Committed immediately before process exit',
    });
    let runs = 0;
    const consumer = createConsumer(async () => {
      runs++;
      return { response: 'must not run' };
    });

    consumer.bootRecover();
    await consumer.tick();

    expect(runs).toBe(0);
    expect(events.some((event) => event.type === 'stale-claim')).toBe(false);
    expect(events.some((event) => event.type === 'requeued')).toBe(false);
    expect(ledger.inspectTemporalAttempt(attemptId).workOrder.status).toBe('done');
  });

  it('stops without retry or alarm when a newer owner edit supersedes the generation', async () => {
    const attemptId = enqueueTemporalAttempt();
    const consumer = createConsumer(async () => {
      if (!context) throw new Error('trusted context was not loaded');
      ledger.update(context.taskId, { due_at: '2026-07-22T14:00:00+09:00' });
      throw new Error('runner observed stale ownership');
    });

    await expect(consumer.tick()).resolves.toBe('drained');

    expect(events).toContainEqual({
      type: 'superseded',
      workKind: 'temporal',
      workOrderId: attemptId,
    });
    expect(events.some((event) => event.type === 'requeued')).toBe(false);
    expect(events.some((event) => event.type === 'failed')).toBe(false);
    expect(alarms).toHaveLength(0);
  });

  it('clears the barrier when a retry committed before its caller observed an error', async () => {
    const attemptId = enqueueTemporalAttempt();
    const fail = ledger.failTemporalWorkOrder.bind(ledger);
    let throwAfterCommit = true;
    ledger.failTemporalWorkOrder = (id, reason) => {
      const result = fail(id, reason);
      if (throwAfterCommit) {
        throwAfterCommit = false;
        throw new Error('synthetic ambiguous retry return');
      }
      return result;
    };
    let runs = 0;
    const consumer = createConsumer(async () => {
      runs++;
      return { response: 'no durable effect' };
    });

    await consumer.tick();
    await consumer.tick();
    const generation = ledger.inspectTemporalAttempt(attemptId).generation;

    expect(generation.disposition).toBe('active');
    expect(generation.lastWorkOrderId).not.toBe(attemptId);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'requeued', workOrderId: generation.lastWorkOrderId })
    );
    await consumer.tick();
    expect(runs).toBe(2);
  });

  it('clears the barrier when exhaustion committed before its caller observed an error', async () => {
    const attemptId = enqueueTemporalAttempt();
    const consumer = createConsumer(async () => ({ response: 'no durable effect' }));
    await consumer.tick();
    await consumer.tick();

    const fail = ledger.failTemporalWorkOrder.bind(ledger);
    ledger.failTemporalWorkOrder = (id, reason) => {
      const result = fail(id, reason);
      throw new Error(`synthetic ambiguous ${result.disposition} return`);
    };
    await consumer.tick();
    await consumer.tick();

    expect(ledger.inspectTemporalAttempt(attemptId).generation.disposition).toBe('exhausted');
    const exhausted = events.find((event) => event.type === 'exhausted');
    expect(exhausted).toBeDefined();
    expect(alarms.some((line) => line.includes('retries exhausted'))).toBe(true);
  });

  it('does not accept a semantically invalid receipt as authoritative completion', async () => {
    const attemptId = enqueueTemporalAttempt();
    const consumer = createConsumer(async () => {
      if (!context) throw new Error('trusted context was not loaded');
      applyEffect(context, {
        expected_revision: context.revision,
        outcome: 'resolved',
        status: 'done',
        reason: 'The source confirms completion',
      });
      db.prepare(
        `UPDATE operator_temporal_effects SET changed_fields = '[]'
         WHERE workorder_attempt_id = ?`
      ).run(context.attemptId);
      throw new Error('runner closed after corrupted durable state');
    });

    await consumer.tick();

    expect(events.some((event) => event.type === 'complete')).toBe(false);
    expect(events.some((event) => event.type === 'requeued')).toBe(false);
    expect(alarms.some((line) => line.includes('effect state unresolved'))).toBe(true);
    expect(() => ledger.inspectTemporalAttempt(attemptId)).toThrow(/receipt|invariant/);
  });

  it('does not let a transient state-read alarm suppress the exhaustion alarm', async () => {
    enqueueTemporalAttempt();
    const consumer = createConsumer(async () => ({ response: 'no durable effect' }));
    await consumer.tick();
    await consumer.tick();

    const inspect = ledger.inspectTemporalAttempt.bind(ledger);
    let failRead = true;
    ledger.inspectTemporalAttempt = (id) => {
      if (failRead) {
        failRead = false;
        throw new Error('synthetic final-attempt read outage');
      }
      return inspect(id);
    };
    await consumer.tick();
    await consumer.tick();

    expect(alarms.some((line) => line.includes('effect state unresolved'))).toBe(true);
    expect(alarms.some((line) => line.includes('retries exhausted'))).toBe(true);
  });

  it('does not let a boot stale-claim alarm suppress the exhaustion alarm', async () => {
    enqueueTemporalAttempt();
    const consumer = createConsumer(async () => ({ response: 'no durable effect' }));
    await consumer.tick();
    await consumer.tick();
    const thirdAttempt = ledger.claimNextWorkOrder();
    expect(thirdAttempt?.payload.attempts).toBe(3);

    consumer.bootRecover();

    expect(alarms.some((line) => line.includes('stale claim'))).toBe(true);
    expect(alarms.some((line) => line.includes('retries exhausted'))).toBe(true);
  });
});
