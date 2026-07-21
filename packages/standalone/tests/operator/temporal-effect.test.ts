import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import { occurrenceKeyForTask } from '../../src/operator/task-temporal.js';
import {
  temporalNoUpdateScope,
  type TemporalReconcileInput,
  type TemporalWorkContext,
} from '../../src/operator/temporal-effect.js';

describe('Story A2 Task 6: atomic temporal effect', () => {
  let db: SQLiteDatabase;
  let ledger: TaskLedger;
  let now: number;

  beforeEach(() => {
    now = Date.parse('2026-07-21T15:00:00Z');
    db = new Database(':memory:');
    ledger = new TaskLedger(db, { now: () => now, timeZone: 'Asia/Seoul' });
  });

  afterEach(() => db.close());

  const testEvidence = {
    contextPacketId: 'ctxp_temporal_effect_test',
    contextPacketSha256: 'a'.repeat(64),
  };

  function applyEffect(
    context: TemporalWorkContext,
    input: TemporalReconcileInput,
    at: number = now
  ) {
    return ledger.applyTemporalEffect(context, input, testEvidence, at);
  }

  function setup(checkAt: number = now): {
    context: TemporalWorkContext;
    generationKey: string;
    taskId: number;
  } {
    const task = ledger.create({
      title: 'due owner task',
      due_at: '2026-07-22T00:00:00+09:00',
      source_channel: 'trello:synthetic-board',
      source_event_id: 'synthetic-card',
    });
    const occurrenceKey = occurrenceKeyForTask(task)!;
    const generationKey = `task:${task.id}:${occurrenceKey}:check:${checkAt}`;
    ledger.enqueueTemporalGeneration({
      generationKey,
      taskId: task.id,
      temporalEpoch: task.temporalEpoch,
      occurrenceKey,
      checkAt,
      sourceChannel: task.sourceChannel,
      sourceEventId: task.sourceEventId,
      priority: 'high',
    });
    const claimed = ledger.claimNextWorkOrder()!;
    return {
      context: ledger.loadTemporalWorkContext(claimed.id),
      generationKey,
      taskId: task.id,
    };
  }

  it('resolves with an actual status change and atomically finalizes every record', () => {
    const { context, generationKey, taskId } = setup();
    const receipt = applyEffect(
      context,
      {
        expected_revision: context.revision,
        outcome: 'resolved',
        status: 'done',
        reason: 'Fresh source evidence confirms completion',
      },
      now
    );

    expect(receipt).toMatchObject({
      workorderAttemptId: context.attemptId,
      taskId,
      generationKey,
      outcome: 'resolved',
      beforeRevision: 1,
      afterRevision: 2,
      changedFields: expect.arrayContaining([
        'status',
        'temporal_reconciled_occurrence_key',
        'last_temporal_checked_at',
        'last_temporal_attempt_id',
      ]),
    });
    expect(ledger.getById(taskId)).toMatchObject({
      status: 'done',
      revision: 2,
      temporalReconciledOccurrenceKey: context.occurrenceKey,
      lastTemporalCheckedAt: now,
      lastTemporalAttemptId: context.attemptId,
      nextTemporalCheckAt: null,
    });
    expect(ledger.getTemporalGeneration(generationKey)?.disposition).toBe('resolved');
    expect(ledger.getTemporalEffect(context.attemptId)).toEqual(receipt);
    expect(
      db.prepare(`SELECT status FROM operator_tasks WHERE id = ?`).get(context.attemptId)
    ).toEqual({ status: 'done' });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM operator_no_update_notes`).get()).toEqual({
      count: 0,
    });
  });

  it('rejects resolved no-ops, stale revisions, and invalid owner status without writes', () => {
    const { context, taskId } = setup();
    const attempts: TemporalReconcileInput[] = [
      {
        expected_revision: context.revision,
        outcome: 'resolved',
        status: 'pending',
        reason: 'no actual change',
      },
      {
        expected_revision: context.revision + 1,
        outcome: 'resolved',
        status: 'done',
        reason: 'stale model snapshot',
      },
      {
        expected_revision: context.revision,
        outcome: 'resolved',
        status: 'failed' as 'done',
        reason: 'forbidden state',
      },
    ];
    for (const input of attempts) {
      expect(() => applyEffect(context, input, now)).toThrow();
    }
    expect(ledger.getById(taskId)).toMatchObject({ revision: 1, status: 'pending' });
    expect(ledger.getTemporalEffect(context.attemptId)).toBeNull();
  });

  it('rejects an offset-only projection change at the same due instant without committing', () => {
    const { context, generationKey, taskId } = setup();

    expect(() =>
      applyEffect(
        context,
        {
          expected_revision: context.revision,
          outcome: 'resolved',
          due_at: '2026-07-21T08:00:00-07:00',
          reason: 'Same instant expressed with another offset',
        },
        now
      )
    ).toThrow(/actual status or due_at change/);

    expect(ledger.getById(taskId)).toMatchObject({ revision: 1, deadlineIso: '2026-07-22' });
    expect(ledger.getTemporalGeneration(generationKey)?.disposition).toBe('active');
    expect(ledger.getTemporalEffect(context.attemptId)).toBeNull();
  });

  it('requires evidence for final_no_update and commits its exact-scope note atomically', () => {
    const { context, generationKey, taskId } = setup();
    expect(() =>
      applyEffect(
        context,
        {
          expected_revision: context.revision,
          outcome: 'final_no_update',
          evidence_summary: '',
          reason: 'no change',
        },
        now
      )
    ).toThrow(/evidence/);

    const receipt = applyEffect(
      context,
      {
        expected_revision: context.revision,
        outcome: 'final_no_update',
        evidence_summary: 'The source card remains explicitly open.',
        reason: 'Current pending state is still correct',
      },
      now
    );
    expect(receipt).toMatchObject({
      outcome: 'final_no_update',
      beforeRevision: 1,
      afterRevision: 2,
    });
    expect(receipt.reason).toMatch(
      /^temporal-effect-final_no_update;reason_sha256=[a-f0-9]{64};reason_length=38;evidence_sha256=[a-f0-9]{64};evidence_length=40$/
    );
    expect(receipt.reason).not.toContain('source card');
    expect(ledger.getById(taskId)).toMatchObject({
      status: 'pending',
      revision: 2,
      temporalReconciledOccurrenceKey: context.occurrenceKey,
      nextTemporalCheckAt: null,
    });
    expect(ledger.getTemporalGeneration(generationKey)?.disposition).toBe('final_no_update');
    expect(
      db
        .prepare(`SELECT scope, reason FROM operator_no_update_notes WHERE scope = ?`)
        .get(temporalNoUpdateScope(context))
    ).toMatchObject({ scope: temporalNoUpdateScope(context), reason: receipt.reason });
  });

  it('defers only to a strictly future check and forbids workflow fields', () => {
    const { context, generationKey, taskId } = setup();
    expect(() =>
      applyEffect(
        context,
        {
          expected_revision: context.revision,
          outcome: 'deferred',
          next_temporal_check_at: new Date(now).toISOString(),
          reason: 'not in the future',
        },
        now
      )
    ).toThrow(/future/);
    expect(() =>
      applyEffect(
        context,
        {
          expected_revision: context.revision,
          outcome: 'deferred',
          next_temporal_check_at: new Date(now + 60_000).toISOString(),
          reason: 'forbidden status',
          status: 'done',
        } as TemporalReconcileInput,
        now
      )
    ).toThrow(/unknown|forbidden/);

    const nextCheck = now + 60_000;
    const receipt = applyEffect(
      context,
      {
        expected_revision: context.revision,
        outcome: 'deferred',
        next_temporal_check_at: new Date(nextCheck).toISOString(),
        reason: 'Awaiting the scheduled source sync',
      },
      now
    );
    expect(receipt).toMatchObject({ outcome: 'deferred', nextTemporalCheckAt: nextCheck });
    expect(ledger.getById(taskId)).toMatchObject({
      status: 'pending',
      revision: 2,
      temporalReconciledOccurrenceKey: null,
      nextTemporalCheckAt: nextCheck,
      lastTemporalCheckedAt: now,
      lastTemporalAttemptId: context.attemptId,
    });
    expect(ledger.getTemporalGeneration(generationKey)?.disposition).toBe('deferred');
    expect(db.prepare(`SELECT COUNT(*) AS count FROM operator_no_update_notes`).get()).toEqual({
      count: 1,
    });
  });

  it('rejects forged trusted context, inactive ownership, and a second immutable write', () => {
    const { context, generationKey } = setup();
    expect(() =>
      applyEffect(
        { ...context, checkAt: context.checkAt + 1 },
        {
          expected_revision: context.revision,
          outcome: 'resolved',
          status: 'done',
          reason: 'forged context',
        },
        now
      )
    ).toThrow(/context|match/);

    const receipt = applyEffect(
      context,
      {
        expected_revision: context.revision,
        outcome: 'resolved',
        status: 'done',
        reason: 'valid once',
      },
      now
    );
    expect(() =>
      applyEffect(
        context,
        {
          expected_revision: context.revision,
          outcome: 'resolved',
          status: 'cancelled',
          reason: 'second write',
        },
        now
      )
    ).toThrow();
    expect(ledger.getTemporalEffect(context.attemptId)).toEqual(receipt);
    expect(ledger.getTemporalGeneration(generationKey)?.disposition).toBe('resolved');
  });

  it('reschedules the task, resolves its own generation, and supersedes other old work', () => {
    const { context, generationKey, taskId } = setup();
    const task = ledger.getById(taskId)!;
    const otherCheck = context.checkAt + 60_000;
    const otherKey = `task:${taskId}:${context.occurrenceKey}:check:${otherCheck}`;
    ledger.enqueueTemporalGeneration({
      generationKey: otherKey,
      taskId,
      temporalEpoch: task.temporalEpoch,
      occurrenceKey: context.occurrenceKey,
      checkAt: otherCheck,
      sourceChannel: task.sourceChannel,
      sourceEventId: task.sourceEventId,
    });

    applyEffect(
      context,
      {
        expected_revision: context.revision,
        outcome: 'resolved',
        due_at: '2026-07-23T09:00:00+09:00',
        reason: 'Fresh evidence moved the due instant',
      },
      now
    );
    expect(ledger.getById(taskId)).toMatchObject({
      revision: 2,
      temporalEpoch: context.temporalEpoch + 1,
      dueAt: Date.parse('2026-07-23T00:00:00Z'),
      temporalReconciledOccurrenceKey: context.occurrenceKey,
    });
    expect(ledger.getTemporalGeneration(generationKey)?.disposition).toBe('resolved');
    expect(ledger.getTemporalGeneration(otherKey)?.disposition).toBe('superseded');
  });

  it.each(['done', 'cancelled'] as const)(
    'supersedes sibling generations when a status-only effect closes the owner task as %s',
    (status) => {
      const { context, generationKey, taskId } = setup();
      const task = ledger.getById(taskId)!;
      const siblingCheck = context.checkAt + 60_000;
      const siblingKey = `task:${taskId}:${context.occurrenceKey}:check:${siblingCheck}`;
      const sibling = ledger.enqueueTemporalGeneration({
        generationKey: siblingKey,
        taskId,
        temporalEpoch: task.temporalEpoch,
        occurrenceKey: context.occurrenceKey,
        checkAt: siblingCheck,
        sourceChannel: task.sourceChannel,
        sourceEventId: task.sourceEventId,
      });

      applyEffect(
        context,
        {
          expected_revision: context.revision,
          outcome: 'resolved',
          status,
          reason: 'Fresh evidence closes the owner task',
        },
        now
      );

      expect(ledger.getTemporalGeneration(generationKey)?.disposition).toBe('resolved');
      expect(ledger.getTemporalGeneration(siblingKey)?.disposition).toBe('superseded');
      expect(ledger.inspectTemporalAttempt(sibling.workOrder.id).workOrder.status).toBe(
        'cancelled'
      );
      expect(ledger.countOpenWorkOrders('temporal')).toBe(0);
    }
  );

  it('rolls every table back when immutable receipt insertion fails', () => {
    const { context, generationKey, taskId } = setup();
    db.exec(`
      CREATE TRIGGER reject_temporal_effect
      BEFORE INSERT ON operator_temporal_effects
      BEGIN
        SELECT RAISE(ABORT, 'synthetic receipt failure');
      END;
    `);
    expect(() =>
      applyEffect(
        context,
        {
          expected_revision: context.revision,
          outcome: 'final_no_update',
          evidence_summary: 'Fresh evidence says unchanged.',
          reason: 'still correct',
        },
        now
      )
    ).toThrow(/synthetic/);
    expect(ledger.getById(taskId)).toMatchObject({ revision: 1, lastTemporalCheckedAt: null });
    expect(ledger.getTemporalGeneration(generationKey)?.disposition).toBe('active');
    expect(ledger.loadTemporalWorkContext(context.attemptId).attemptId).toBe(context.attemptId);
    expect(ledger.getTemporalEffect(context.attemptId)).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) AS count FROM operator_no_update_notes`).get()).toEqual({
      count: 0,
    });
  });
});
