/**
 * Records and tasks are separate (owner policy, v0.48.1 follow-up).
 *
 * Connector observations, principles, lessons and open questions became native
 * owner rows because public task_create required only `title`, and because there
 * was no SEMANTIC terminal reason: the agent could not tell "this work finished"
 * from "this was never a task". These tests hold both halves:
 *
 *  - a new owner task carries a concrete, finite `completion_criteria`;
 *  - `task_reclassify` lets the agent recorrect existing rows with a named
 *    disposition and a durable `resolution_kind`, under the same revision /
 *    owner-row / workorder-authority rules as task_update (TG-03/TG-04/TG-06).
 *
 * Synthetic data only; in-memory sqlite.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import { listEffects } from '../../src/evidence/effects.js';

const NOW = Date.parse('2026-09-07T04:00:00Z');

describe('task ledger: completion criteria + reclassification', () => {
  let db: SQLiteDatabase;
  let ledger: TaskLedger;
  const adapter = () => db as never;

  beforeEach(() => {
    db = new Database(':memory:');
    ledger = new TaskLedger(db, { now: () => NOW, timeZone: 'Asia/Seoul' });
  });

  describe('completion_criteria persistence', () => {
    it('persists completion_criteria and exposes it on the record', () => {
      const task = ledger.create({
        title: 'send the September invoice',
        completion_criteria: 'invoice PDF delivered to the client channel',
      });
      expect(task.completionCriteria).toBe('invoice PDF delivered to the client channel');
      expect(ledger.getById(task.id)?.completionCriteria).toBe(
        'invoice PDF delivered to the client channel'
      );
    });

    it('keeps existing/system-seeded rows readable with a null criteria', () => {
      // Internal seeding stays backward compatible: the ledger does not require it.
      const task = ledger.create({ title: 'legacy row' });
      expect(task.completionCriteria).toBeNull();
      expect(task.resolutionKind).toBeNull();
    });
  });

  describe('completion dispositions', () => {
    it('closes from explicit completion evidence without requiring a deadline', () => {
      const task = ledger.create({
        title: 'send the approved asset',
        completion_criteria: 'client source reports delivery complete',
      });
      const done = ledger.reclassify(task.id, {
        disposition: 'completed_evidence',
        reason: 'the current authoritative source reports completed',
        expected_revision: task.revision,
      });
      expect(done.status).toBe('done');
      expect(done.resolutionKind).toBe('completed_evidence');
    });

    it('closes a past-deadline row, preserving the reason and resolution kind', () => {
      const task = ledger.create({
        title: 'ship the August report',
        completion_criteria: 'report link posted',
        deadline: '2026-09-01',
      });
      const done = ledger.reclassify(
        task.id,
        {
          disposition: 'completed_no_issue',
          reason: 'checked slack+chatwork through 09-07, no open issue on this item',
          expected_revision: task.revision,
        },
        { runId: 'mr_1' }
      );
      expect(done.status).toBe('done');
      expect(done.resolutionKind).toBe('completed_no_issue');
      expect(done.latestEvent).toBe(
        'checked slack+chatwork through 09-07, no open issue on this item'
      );
      expect(done.revision).toBe(task.revision + 1);
    });

    it('refuses to close a row whose deadline has not passed', () => {
      const task = ledger.create({
        title: 'future work',
        completion_criteria: 'done when shipped',
        deadline: '2026-12-01',
      });
      expect(() =>
        ledger.reclassify(task.id, {
          disposition: 'completed_no_issue',
          reason: 'looks quiet',
          expected_revision: task.revision,
        })
      ).toThrow(/deadline|due/i);
    });

    it('refuses to close a row that has no deadline at all', () => {
      const task = ledger.create({ title: 'undated', completion_criteria: 'x' });
      expect(() =>
        ledger.reclassify(task.id, {
          disposition: 'completed_no_issue',
          reason: 'nothing seen',
          expected_revision: task.revision,
        })
      ).toThrow(/deadline|due/i);
    });
  });

  describe('non_task dispositions', () => {
    it.each(['non_task_record', 'non_task_memory'] as const)(
      '%s cancels the row and preserves reason + resolution kind',
      (disposition) => {
        const task = ledger.create({ title: '열심히 살자' });
        const out = ledger.reclassify(task.id, {
          disposition,
          reason: 'an aspiration, not a finite work item; belongs in memory',
          expected_revision: task.revision,
        });
        expect(out.status).toBe('cancelled');
        expect(out.resolutionKind).toBe(disposition);
        expect(out.latestEvent).toBe('an aspiration, not a finite work item; belongs in memory');
      }
    );

    it('cancels a non-task record with no deadline (the past-deadline gate is completion-only)', () => {
      const task = ledger.create({ title: 'how should we manage X?' });
      const out = ledger.reclassify(task.id, {
        disposition: 'non_task_record',
        reason: 'an open question; it is a record, not a task',
        expected_revision: task.revision,
      });
      expect(out.status).toBe('cancelled');
    });

    it('does not rewrite the meaning of an already terminal row', () => {
      const task = ledger.create({ title: 'closed', status: 'cancelled' });
      expect(() =>
        ledger.reclassify(task.id, {
          disposition: 'non_task_record',
          reason: 'late rewrite',
          expected_revision: task.revision,
        })
      ).toThrow(/active owner row/i);
    });
  });

  describe('reopen', () => {
    it('reopens a terminal row, clearing resolution kind and the stale deadline', () => {
      const task = ledger.create({
        title: 'ship the August report',
        completion_criteria: 'report link posted',
        deadline: '2026-09-01',
      });
      const closed = ledger.reclassify(task.id, {
        disposition: 'completed_no_issue',
        reason: 'no issue found',
        expected_revision: task.revision,
      });
      const reopened = ledger.reclassify(closed.id, {
        disposition: 'reopen',
        reason: 'client replied 09-07 asking for a revision',
        expected_revision: closed.revision,
      });
      expect(reopened.status).toBe('pending');
      expect(reopened.resolutionKind).toBeNull();
      expect(reopened.deadlineIso).toBeNull();
      expect(reopened.dueAt).toBeNull();
      expect(reopened.latestEvent).toBe('client replied 09-07 asking for a revision');
      // Same row, so later feedback continues the same history.
      expect(reopened.id).toBe(task.id);
    });

    it('refuses to reopen a row that is not terminal', () => {
      const task = ledger.create({ title: 'open work', completion_criteria: 'x' });
      expect(() =>
        ledger.reclassify(task.id, {
          disposition: 'reopen',
          reason: 'still open',
          expected_revision: task.revision,
        })
      ).toThrow(/terminal/i);
    });

    it('does not let generic task_update bypass a classified reopen', () => {
      const task = ledger.create({
        title: 'ship the August report',
        completion_criteria: 'report link posted',
        deadline: '2026-09-01',
      });
      const closed = ledger.reclassify(task.id, {
        disposition: 'completed_no_issue',
        reason: 'no issue found',
        expected_revision: task.revision,
      });
      expect(() =>
        ledger.update(closed.id, {
          status: 'pending',
          latest_event: 'new feedback',
          expected_revision: closed.revision,
        })
      ).toThrow(/task_reclassify/);
    });

    it('clears an old classification on a generic terminal-to-terminal status change', () => {
      const task = ledger.create({ title: 'record-shaped row' });
      const cancelled = ledger.reclassify(task.id, {
        disposition: 'non_task_record',
        reason: 'not a task',
        expected_revision: task.revision,
      });
      const changed = ledger.update(cancelled.id, {
        status: 'done',
        latest_event: 'owner explicitly marked it complete',
        expected_revision: cancelled.revision,
      });
      expect(changed.status).toBe('done');
      expect(changed.resolutionKind).toBeNull();
    });
  });

  describe('authority and input rules (equivalent to task_update)', () => {
    it('requires revision and reason when a Board run qualifies a legacy task', () => {
      const task = ledger.create({ title: 'real legacy work' });
      const board = ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'board:qualify:1',
        input: { mode: 'full' },
      });
      ledger.claimNextWorkOrder();
      const origin = { workOrderAttemptId: board.id, requiresExpectedRevision: true };
      expect(() =>
        ledger.update(task.id, { completion_criteria: 'artifact delivered' }, origin)
      ).toThrow(/expected_revision/);
      expect(() =>
        ledger.update(
          task.id,
          { completion_criteria: 'artifact delivered', expected_revision: task.revision },
          origin
        )
      ).toThrow(/latest_event/);
      expect(
        ledger.update(
          task.id,
          {
            completion_criteria: 'artifact delivered',
            expected_revision: task.revision,
            latest_event: 'confirmed this is finite delivery work',
          },
          origin
        ).completionCriteria
      ).toBe('artifact delivered');
    });

    it('requires the exact current revision', () => {
      const task = ledger.create({ title: 'x', completion_criteria: 'y' });
      expect(() =>
        ledger.reclassify(task.id, {
          disposition: 'non_task_record',
          reason: 'record',
          expected_revision: task.revision + 5,
        })
      ).toThrow(/revision/i);
    });

    it('requires a non-empty bounded reason', () => {
      const task = ledger.create({ title: 'x', completion_criteria: 'y' });
      expect(() =>
        ledger.reclassify(task.id, {
          disposition: 'non_task_record',
          reason: '   ',
          expected_revision: task.revision,
        })
      ).toThrow(/reason/i);
      expect(() =>
        ledger.reclassify(task.id, {
          disposition: 'non_task_record',
          reason: 'x'.repeat(2001),
          expected_revision: task.revision,
        })
      ).toThrow(/reason/i);
    });

    it('rejects an unknown disposition', () => {
      const task = ledger.create({ title: 'x', completion_criteria: 'y' });
      expect(() =>
        ledger.reclassify(task.id, {
          disposition: 'archive' as never,
          reason: 'nope',
          expected_revision: task.revision,
        })
      ).toThrow(/disposition/i);
    });

    it('refuses a system workorder row (owner rows only)', () => {
      const wo = ledger.enqueueWorkOrder({
        workKind: 'wiki',
        idempotencyKey: 'wiki:1-boot',
        input: { batchId: '1-boot', events: ['boot'] },
      });
      expect(() =>
        ledger.reclassify(wo.id, {
          disposition: 'non_task_record',
          reason: 'not mine',
          expected_revision: 0,
        })
      ).toThrow(/system|owner/i);
    });

    it('refuses a terminal board attempt trying to mutate an unrelated row (TG-06)', () => {
      const task = ledger.create({ title: 'x', completion_criteria: 'y' });
      const board = ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'board:full:1',
        input: { mode: 'full' },
      });
      ledger.claimNextWorkOrder();
      ledger.completeWorkOrder(board.id); // attempt is no longer active
      expect(() =>
        ledger.reclassify(
          task.id,
          {
            disposition: 'non_task_record',
            reason: 'stale board attempt',
            expected_revision: task.revision,
          },
          { workOrderAttemptId: board.id, requiresExpectedRevision: true }
        )
      ).toThrow(/no longer active/i);
    });

    it('records one atomic effect receipt for the reclassification', () => {
      const task = ledger.create({ title: 'x', completion_criteria: 'y' });
      const before = listEffects(adapter()).length;
      ledger.reclassify(
        task.id,
        {
          disposition: 'non_task_memory',
          reason: 'a durable lesson; save it as memory instead',
          expected_revision: task.revision,
        },
        { runId: 'mr_9' }
      );
      const effects = listEffects(adapter());
      expect(effects.length).toBe(before + 1);
      const receipt = effects.find((effect) => effect.runId === 'mr_9');
      expect(receipt).toMatchObject({
        runId: 'mr_9',
        kind: 'task_update',
        targetType: 'task',
        targetId: String(task.id),
      });
    });

    it('leaves the row untouched when the transition is refused', () => {
      const task = ledger.create({ title: 'x', completion_criteria: 'y', deadline: '2026-12-01' });
      expect(() =>
        ledger.reclassify(task.id, {
          disposition: 'completed_no_issue',
          reason: 'too early',
          expected_revision: task.revision,
        })
      ).toThrow();
      const after = ledger.getById(task.id)!;
      expect(after.status).toBe('pending');
      expect(after.revision).toBe(task.revision);
      expect(after.resolutionKind).toBeNull();
    });
  });
});
