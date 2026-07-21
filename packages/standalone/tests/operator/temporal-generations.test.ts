import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TaskLedger, type EnqueueTemporalGenerationInput } from '../../src/operator/task-ledger.js';
import { occurrenceKeyForTask } from '../../src/operator/task-temporal.js';

describe('Story A2 Task 4: temporal generation ownership', () => {
  let db: SQLiteDatabase;
  let ledger: TaskLedger;
  let now: number;

  beforeEach(() => {
    now = Date.parse('2026-07-21T15:00:00Z');
    db = new Database(':memory:');
    ledger = new TaskLedger(db, { now: () => now, timeZone: 'Asia/Seoul' });
  });

  afterEach(() => db.close());

  function scheduledTask() {
    return ledger.create({
      title: 'temporal target',
      due_at: '2026-07-22T09:00:00+09:00',
      source_channel: 'trello:synthetic-board',
      source_event_id: 'synthetic-card',
    });
  }

  function inputFor(
    task: ReturnType<typeof scheduledTask>,
    checkAt: number = task.dueAt!
  ): EnqueueTemporalGenerationInput {
    const occurrenceKey = occurrenceKeyForTask(task)!;
    return {
      generationKey: `task:${task.id}:${occurrenceKey}:check:${checkAt}`,
      taskId: task.id,
      temporalEpoch: task.temporalEpoch,
      occurrenceKey,
      checkAt,
      sourceChannel: task.sourceChannel,
      sourceEventId: task.sourceEventId,
      priority: 'high',
    };
  }

  it('atomically creates one active generation and one pending attempt', () => {
    const task = scheduledTask();
    const input = inputFor(task);
    const first = ledger.enqueueTemporalGeneration(input);
    const duplicate = ledger.enqueueTemporalGeneration(input);

    expect(first.created).toBe(true);
    expect(first.generation).toMatchObject({
      generationKey: input.generationKey,
      disposition: 'active',
      lastWorkOrderId: first.workOrder.id,
    });
    expect(first.workOrder).toMatchObject({
      workKind: 'temporal',
      status: 'pending',
      idempotencyKey: input.generationKey,
      payload: { attempts: 1, taskId: task.id, checkAt: input.checkAt },
    });
    expect(duplicate).toEqual({ ...first, created: false });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM operator_temporal_generations`).get()).toEqual(
      {
        count: 1,
      }
    );
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM operator_tasks
           WHERE source_channel = 'workorder:temporal'`
        )
        .get()
    ).toEqual({ count: 1 });
  });

  it('rejects caller attempts and generic temporal enqueue bypasses', () => {
    for (const workKind of ['board', 'wiki', 'memory-curation'] as const) {
      expect(() =>
        ledger.enqueueWorkOrder({
          workKind,
          idempotencyKey: `${workKind}:synthetic`,
          input: { attempts: 2 },
        })
      ).toThrow(/attempts.*ledger-managed/);
    }
    expect(() =>
      ledger.enqueueWorkOrder({
        workKind: 'temporal',
        idempotencyKey: 'temporal:synthetic',
        input: {},
      })
    ).toThrow(/enqueueTemporalGeneration/);
  });

  it('keeps initial and deferred checks as distinct stable generations', () => {
    const task = scheduledTask();
    const initial = ledger.enqueueTemporalGeneration(inputFor(task));
    const deferred = ledger.enqueueTemporalGeneration(inputFor(task, task.dueAt! + 60_000));
    expect(deferred.generation.generationKey).not.toBe(initial.generation.generationKey);
    expect(deferred.workOrder.id).not.toBe(initial.workOrder.id);
  });

  it('rejects stable-key identity collisions and mismatched source provenance', () => {
    const task = scheduledTask();
    const input = inputFor(task);
    ledger.enqueueTemporalGeneration(input);
    expect(() =>
      ledger.enqueueTemporalGeneration({ ...input, checkAt: input.checkAt + 1 })
    ).toThrow(/canonical|conflicts/);

    const other = ledger.create({ title: 'other', due_at: '2026-07-22T09:00:00+09:00' });
    expect(() =>
      ledger.enqueueTemporalGeneration({
        ...inputFor(other),
        sourceChannel: 'trello:forged',
      })
    ).toThrow(/source identifiers/);
  });

  it('retries under the same generation with one attempts increment and fresh row ownership', () => {
    const task = scheduledTask();
    const first = ledger.enqueueTemporalGeneration(inputFor(task));
    const claimed = ledger.claimNextWorkOrder()!;
    const context = ledger.loadTemporalWorkContext(claimed.id);
    expect(context).toMatchObject({
      attemptId: claimed.id,
      generationKey: first.generation.generationKey,
      revision: task.revision,
    });

    now += 1;
    const retry = ledger.requeueTemporalWorkOrder(claimed.id, 'synthetic retry');
    expect(retry.id).not.toBe(claimed.id);
    expect(retry.idempotencyKey).toBe(claimed.idempotencyKey);
    expect(retry.payload.attempts).toBe(2);
    expect(ledger.getTemporalGeneration(first.generation.generationKey)?.lastWorkOrderId).toBe(
      retry.id
    );
    expect(() => ledger.loadTemporalWorkContext(claimed.id)).toThrow(/ownership|active attempt/);
  });

  it('exhausts a generation once and never rearms it from the same stable key', () => {
    const task = scheduledTask();
    const input = inputFor(task);
    const first = ledger.enqueueTemporalGeneration(input);
    const firstClaim = ledger.claimNextWorkOrder()!;
    ledger.requeueTemporalWorkOrder(firstClaim.id, 'retry one');
    const secondClaim = ledger.claimNextWorkOrder()!;
    ledger.requeueTemporalWorkOrder(secondClaim.id, 'retry two');
    const claimed = ledger.claimNextWorkOrder()!;
    expect(() => ledger.requeueTemporalWorkOrder(claimed.id, 'too many')).toThrow(/budget/);
    ledger.exhaustTemporalWorkOrder(claimed.id, 'no evidence after retries');

    const exhausted = ledger.getTemporalGeneration(input.generationKey);
    expect(exhausted).toMatchObject({
      disposition: 'exhausted',
      lastWorkOrderId: claimed.id,
    });
    expect(exhausted?.reason).toMatch(
      /^temporal-worker-failure;failure_sha256=[a-f0-9]{64};failure_length=25$/
    );
    expect(exhausted?.reason).not.toContain('no evidence after retries');
    const duplicate = ledger.enqueueTemporalGeneration(input);
    expect(duplicate.created).toBe(false);
    expect(duplicate.workOrder.id).toBe(claimed.id);
    expect(duplicate.workOrder.id).not.toBe(first.workOrder.id);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM operator_tasks`).get()).toEqual({ count: 4 });
  });

  it('bounds temporal retry and exhaustion reasons', () => {
    const task = scheduledTask();
    ledger.enqueueTemporalGeneration(inputFor(task));
    const claimed = ledger.claimNextWorkOrder()!;
    expect(() => ledger.requeueTemporalWorkOrder(claimed.id, '')).toThrow(/1-500/);
    expect(() => ledger.exhaustTemporalWorkOrder(claimed.id, 'x'.repeat(501))).toThrow(/1-500/);
    expect(() => ledger.exhaustTemporalWorkOrder(claimed.id, 'too early')).toThrow(
      /requires attempt/
    );
    expect(ledger.loadTemporalWorkContext(claimed.id).attemptId).toBe(claimed.id);
  });

  it('keeps generation creation atomic when the attempt insert fails', () => {
    const target = scheduledTask();
    db.exec(`
      CREATE TRIGGER reject_temporal_attempt
      BEFORE INSERT ON operator_tasks
      WHEN NEW.source_channel = 'workorder:temporal'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic temporal insert failure');
      END;
    `);
    expect(() => ledger.enqueueTemporalGeneration(inputFor(target))).toThrow(/synthetic/);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM operator_temporal_generations`).get()).toEqual(
      {
        count: 0,
      }
    );
    expect(db.prepare(`SELECT COUNT(*) AS count FROM operator_tasks`).get()).toEqual({ count: 1 });
  });

  it('rolls back the old row and replacement when retry ownership update fails', () => {
    const target = scheduledTask();
    const first = ledger.enqueueTemporalGeneration(inputFor(target));
    const claimed = ledger.claimNextWorkOrder()!;
    db.exec(`
      CREATE TRIGGER reject_temporal_ownership_update
      BEFORE UPDATE OF last_workorder_id ON operator_temporal_generations
      BEGIN
        SELECT RAISE(ABORT, 'synthetic ownership update failure');
      END;
    `);
    expect(() => ledger.requeueTemporalWorkOrder(claimed.id, 'retry')).toThrow(/synthetic/);
    expect(ledger.loadTemporalWorkContext(claimed.id).attemptId).toBe(claimed.id);
    expect(ledger.getTemporalGeneration(first.generation.generationKey)?.lastWorkOrderId).toBe(
      claimed.id
    );
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM operator_tasks
           WHERE source_channel = 'workorder:temporal'`
        )
        .get()
    ).toEqual({ count: 1 });
  });

  it('supersedes and cancels old ownership when a due occurrence changes', () => {
    const task = scheduledTask();
    const old = ledger.enqueueTemporalGeneration(inputFor(task));

    const moved = ledger.update(task.id, { due_at: '2026-07-23T09:00:00+09:00' });
    expect(ledger.getTemporalGeneration(old.generation.generationKey)?.disposition).toBe(
      'superseded'
    );
    expect(ledger.workOrderStats().find((row) => row.workKind === 'temporal')?.lastStatus).toBe(
      'cancelled'
    );

    const restored = ledger.update(task.id, { due_at: '2026-07-22T09:00:00+09:00' });
    const replacement = ledger.enqueueTemporalGeneration(inputFor(restored));
    expect(restored.temporalEpoch).toBe(moved.temporalEpoch + 1);
    expect(replacement.generation.generationKey).not.toBe(old.generation.generationKey);
    expect(() => ledger.loadTemporalWorkContext(old.workOrder.id)).toThrow();
  });

  it.each(['done', 'cancelled'] as const)(
    'atomically supersedes active temporal ownership when the owner task becomes %s',
    (status) => {
      const task = scheduledTask();
      const active = ledger.enqueueTemporalGeneration(inputFor(task));
      ledger.claimNextWorkOrder();

      ledger.update(task.id, { status });

      expect(ledger.getWorkOrderById(active.workOrder.id)?.status).toBe('cancelled');
      expect(ledger.getTemporalGeneration(active.generation.generationKey)?.disposition).toBe(
        'superseded'
      );
    }
  );

  it('repairs a legacy closed-task active generation instead of blocking arbitration', () => {
    const task = scheduledTask();
    const active = ledger.enqueueTemporalGeneration(inputFor(task));
    const claimed = ledger.claimNextWorkOrder()!;
    db.prepare(`UPDATE operator_tasks SET status = 'done' WHERE id = ?`).run(task.id);

    expect(ledger.failTemporalWorkOrder(claimed.id, 'legacy closed owner')).toMatchObject({
      disposition: 'superseded',
    });
    expect(ledger.getWorkOrderById(claimed.id)?.status).toBe('cancelled');
    expect(ledger.getTemporalGeneration(active.generation.generationKey)?.disposition).toBe(
      'superseded'
    );
  });

  it('reopening a closed task mints a new epoch-qualified generation', () => {
    const task = ledger.create({
      title: 'closed target',
      deadline: '2026-07-21',
      status: 'done',
    });
    const reopened = ledger.update(task.id, { status: 'pending' });
    const generation = ledger.enqueueTemporalGeneration(inputFor(reopened, now));
    expect(reopened.temporalEpoch).toBe(task.temporalEpoch + 1);
    expect(generation.generation.occurrenceKey).toContain(`epoch:${reopened.temporalEpoch}:`);
  });

  it('pauses open temporal work without closing its active generation', () => {
    const task = scheduledTask();
    const created = ledger.enqueueTemporalGeneration(inputFor(task));
    expect(ledger.claimNextWorkOrder()?.id).toBe(created.workOrder.id);

    expect(ledger.pauseActiveTemporalWork('feature-disabled')).toBe(1);

    expect(ledger.inspectTemporalAttempt(created.workOrder.id)).toMatchObject({
      workOrder: { status: 'cancelled' },
      generation: { disposition: 'active', lastWorkOrderId: created.workOrder.id },
      receipt: null,
    });
    expect(ledger.countOpenWorkOrders('temporal')).toBe(0);
  });

  it('pauses every open temporal row even when generation ownership is inconsistent', () => {
    const first = ledger.enqueueTemporalGeneration(inputFor(scheduledTask()));
    const secondTask = ledger.create({
      title: 'second temporal target',
      due_at: '2026-07-22T09:00:00+09:00',
      source_channel: 'trello:synthetic-board',
      source_event_id: 'synthetic-card-2',
    });
    const second = ledger.enqueueTemporalGeneration(inputFor(secondTask));
    db.prepare(`DELETE FROM operator_temporal_generations WHERE generation_key = ?`).run(
      second.generation.generationKey
    );

    expect(ledger.pauseActiveTemporalWork('feature-disabled')).toBe(2);

    expect(ledger.getWorkOrderById(first.workOrder.id)?.status).toBe('cancelled');
    expect(ledger.getWorkOrderById(second.workOrder.id)?.status).toBe('cancelled');
    expect(ledger.getTemporalGeneration(first.generation.generationKey)?.disposition).toBe(
      'active'
    );
    expect(ledger.getTemporalGeneration(second.generation.generationKey)).toBeNull();
    expect(ledger.countOpenWorkOrders('temporal')).toBe(0);
  });

  it('resumes one paused attempt without incrementing its retry count', () => {
    const task = scheduledTask();
    const first = ledger.enqueueTemporalGeneration(inputFor(task));
    const firstClaim = ledger.claimNextWorkOrder()!;
    const second = ledger.requeueTemporalWorkOrder(firstClaim.id, 'retry before pause');
    expect(second.payload.attempts).toBe(2);
    ledger.pauseActiveTemporalWork('feature-disabled');

    const resumed = ledger.resumePausedTemporalWork();
    const duplicate = ledger.resumePausedTemporalWork();

    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ status: 'pending', payload: { attempts: 2 } });
    expect(resumed[0].id).not.toBe(first.workOrder.id);
    expect(duplicate).toEqual([]);
    expect(ledger.getTemporalGeneration(first.generation.generationKey)?.lastWorkOrderId).toBe(
      resumed[0].id
    );
    expect(ledger.countOpenWorkOrders('temporal')).toBe(1);
  });
});
