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
import { OwnerEventInbox } from '../../src/operator/owner-event-inbox.js';
import { listEffects } from '../../src/evidence/effects.js';

const NOW = Date.parse('2026-09-07T04:00:00Z');

describe('Story TASK-RECAL-1: task completion criteria and reclassification', () => {
  let db: SQLiteDatabase;
  let ledger: TaskLedger;
  const adapter = () => db as never;

  beforeEach(() => {
    db = new Database(':memory:');
    ledger = new TaskLedger(db, { now: () => NOW, timeZone: 'Asia/Seoul' });
  });

  describe('Acceptance Criteria #1: completion criteria persistence', () => {
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

  describe('Acceptance Criteria #2: evidence and no-issue completion', () => {
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

  describe('Acceptance Criteria #3: non-task dispositions', () => {
    it.each(['non_task_record', 'non_task_memory'] as const)(
      '%s cancels the row and preserves reason + resolution kind',
      (disposition) => {
        const task = ledger.create({
          title: '열심히 살자',
          completion_criteria: 'incorrectly invented forever condition',
        });
        const out = ledger.reclassify(task.id, {
          disposition,
          reason: 'an aspiration, not a finite work item; belongs in memory',
          expected_revision: task.revision,
        });
        expect(out.status).toBe('cancelled');
        expect(out.resolutionKind).toBe(disposition);
        expect(out.latestEvent).toBe('an aspiration, not a finite work item; belongs in memory');
        expect(out.completionCriteria).toBeNull();
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

  describe('Acceptance Criteria #4: later feedback reopens the same row', () => {
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

  describe('Acceptance Criteria #5: revision and source-bound authority', () => {
    it('requires revision and reason when a Board run qualifies a legacy task', () => {
      const task = ledger.create({ title: 'real legacy work' });
      const board = ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'board:qualify:1',
        input: {
          mode: 'full',
          reclassificationCandidates: [{ taskId: task.id, taskRevision: task.revision }],
        },
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

    it('qualifies a discovered owner row outside the scheduler hint page (owner authority)', () => {
      // reclassificationCandidates is a host SELECTION hint for bounded reading,
      // not the owner's authorization. A row MAMA discovered through paged
      // reads is still the owner's row: the current revision and a plain
      // reason remain required, the hint page does not.
      const hinted = ledger.create({ title: 'hinted legacy work' });
      const discovered = ledger.create({ title: 'discovered legacy work' });
      const board = ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'board:qualify:outside-hints',
        input: {
          mode: 'full',
          reclassificationCandidates: [{ taskId: hinted.id, taskRevision: hinted.revision }],
        },
      });
      ledger.claimNextWorkOrder();
      const origin = { workOrderAttemptId: board.id, requiresExpectedRevision: true };
      expect(
        ledger.update(
          discovered.id,
          {
            completion_criteria: 'discovered artifact delivered',
            expected_revision: discovered.revision,
            latest_event: 'paged read showed this is finite delivery work',
          },
          origin
        ).completionCriteria
      ).toBe('discovered artifact delivered');
      // CAS is untouched by the wider selection: a stale read still fails.
      expect(() =>
        ledger.update(
          discovered.id,
          {
            completion_criteria: 'rewritten from a stale read',
            expected_revision: discovered.revision,
            latest_event: 'stale',
          },
          origin
        )
      ).toThrow(/revision/i);
    });

    it('qualifies and reclassifies under a non-Board active attempt with the same CAS rules', () => {
      // The work kind selects scheduling metadata, not owner authority. A live
      // non-Board attempt is validated for currency exactly like a Board one.
      const legacy = ledger.create({ title: 'legacy row seen during wiki work' });
      const record = ledger.create({ title: 'record-shaped row seen during wiki work' });
      const wiki = ledger.enqueueWorkOrder({
        workKind: 'wiki',
        idempotencyKey: 'wiki:owner-decision',
        input: { batchId: 'b-1', events: ['boot'] },
      });
      ledger.claimNextWorkOrder();
      const origin = { workOrderAttemptId: wiki.id, requiresExpectedRevision: true };
      expect(() =>
        ledger.update(legacy.id, { completion_criteria: 'artifact delivered' }, origin)
      ).toThrow(/expected_revision/);
      expect(
        ledger.update(
          legacy.id,
          {
            completion_criteria: 'artifact delivered',
            expected_revision: legacy.revision,
            latest_event: 'finite delivery work',
          },
          origin
        ).completionCriteria
      ).toBe('artifact delivered');
      expect(
        ledger.reclassify(
          record.id,
          {
            disposition: 'non_task_record',
            reason: 'an open question, not a task',
            expected_revision: record.revision,
          },
          origin
        ).status
      ).toBe('cancelled');
    });

    it('refuses a terminal non-Board attempt exactly like a terminal Board attempt', () => {
      const task = ledger.create({ title: 'x', completion_criteria: 'y' });
      const wiki = ledger.enqueueWorkOrder({
        workKind: 'wiki',
        idempotencyKey: 'wiki:stale-attempt',
        input: { batchId: 'b-2', events: ['boot'] },
      });
      ledger.claimNextWorkOrder();
      ledger.completeWorkOrder(wiki.id);
      const origin = { workOrderAttemptId: wiki.id, requiresExpectedRevision: true };
      expect(() =>
        ledger.reclassify(
          task.id,
          {
            disposition: 'non_task_record',
            reason: 'stale wiki attempt',
            expected_revision: task.revision,
          },
          origin
        )
      ).toThrow(/no longer active/i);
      expect(() =>
        ledger.update(
          task.id,
          {
            completion_criteria: 'late rewrite',
            expected_revision: task.revision,
            latest_event: 'stale wiki attempt',
          },
          origin
        )
      ).toThrow(/no longer active/i);
      expect(ledger.getById(task.id)?.revision).toBe(task.revision);
    });

    it.each(['board', 'wiki'] as const)(
      'refuses a NON-lifecycle direct update (title/priority/assignee) under a terminal %s attempt',
      (workKind) => {
        // A retained attempt context outlives its workorder. Liveness is not a
        // property of the patch shape: a title rewrite carried by a stale
        // attempt is as stale as a status change carried by one.
        const task = ledger.create({ title: 'original', completion_criteria: 'y' });
        const attempt = ledger.enqueueWorkOrder({
          workKind,
          idempotencyKey: `${workKind}:stale-content-attempt`,
          input:
            workKind === 'board' ? { mode: 'full' } : { batchId: 'b-content', events: ['boot'] },
        });
        ledger.claimNextWorkOrder();
        ledger.completeWorkOrder(attempt.id);
        const origin = { workOrderAttemptId: attempt.id, requiresExpectedRevision: true };
        for (const patch of [
          { title: 'late rename' },
          { priority: 'high' as const },
          { assignee: 'someone' },
        ]) {
          expect(() => ledger.update(task.id, patch, origin)).toThrow(
            new RegExp(`${workKind} workorder ${attempt.id} is no longer active`)
          );
        }
        expect(ledger.getById(task.id)).toMatchObject({
          title: 'original',
          priority: 'normal',
          revision: task.revision,
        });
        // The same patch without a carried attempt (an ordinary owner turn)
        // still works: liveness is about the attempt, not the owner.
        expect(ledger.update(task.id, { title: 'owner rename' }).title).toBe('owner rename');
      }
    );

    it('refuses an attempt id that does not exist', () => {
      const task = ledger.create({ title: 'x', completion_criteria: 'y' });
      expect(() =>
        ledger.reclassify(
          task.id,
          {
            disposition: 'non_task_record',
            reason: 'phantom attempt',
            expected_revision: task.revision,
          },
          { workOrderAttemptId: 999_999, requiresExpectedRevision: true }
        )
      ).toThrow(/no longer active/i);
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
        input: {
          mode: 'full',
          reclassificationCandidates: [{ taskId: task.id, taskRevision: task.revision }],
        },
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

    it('treats Board reclassification candidates as hints, not owner authorization (TG-04/TG-06)', () => {
      const hinted = ledger.create({ title: 'hinted legacy row' });
      const discovered = ledger.create({ title: 'row discovered through paged reads' });
      const board = ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'board:full:candidate-hints',
        input: {
          mode: 'full',
          reclassificationCandidates: [{ taskId: hinted.id, taskRevision: hinted.revision }],
        },
      });
      ledger.claimNextWorkOrder();
      const system = ledger.enqueueWorkOrder({
        workKind: 'wiki',
        idempotencyKey: 'wiki:not-an-owner-row',
        input: { batchId: 'b-3', events: ['boot'] },
      });
      const origin = { workOrderAttemptId: board.id, requiresExpectedRevision: true };

      expect(
        ledger.reclassify(
          hinted.id,
          {
            disposition: 'non_task_record',
            reason: 'host-issued candidate is a record',
            expected_revision: hinted.revision,
          },
          origin
        ).status
      ).toBe('cancelled');
      expect(
        ledger.reclassify(
          discovered.id,
          {
            disposition: 'non_task_record',
            reason: 'a row outside the hint page is still the owner row it always was',
            expected_revision: discovered.revision,
          },
          origin
        ).status
      ).toBe('cancelled');
      // Wider selection does not widen ownership: a system workorder row is
      // still not an owner task, whatever attempt is carried.
      expect(() =>
        ledger.reclassify(
          system.id,
          {
            disposition: 'non_task_record',
            reason: 'not an owner row',
            expected_revision: 0,
          },
          origin
        )
      ).toThrow(/system|owner/i);
    });

    it('lets an owner-event decision reach a task from another visible channel (TG-03/TG-06)', () => {
      // Which channel an inbox batch arrived on is host SELECTION context. The
      // owner's grant, checked at the gateway, decides visibility; the ledger
      // keeps requiring a real causal batch so provenance stays attributable.
      const inbox = new OwnerEventInbox(db, () => NOW);
      inbox.enqueue({
        channelKey: 'slack:C001',
        eventIds: ['evt-current'],
        lines: ['current feedback'],
        activations: [],
      });
      const sameChannel = ledger.create({
        title: 'same channel',
        source_channel: 'slack:C001',
        source_event_id: 'evt-old',
      });
      const otherChannel = ledger.create({
        title: 'other channel',
        source_channel: 'chatwork:room-9',
        source_event_id: 'evt-other',
      });
      const origin = {
        causeEventIds: ['evt-current'],
        causeKind: 'owner_message' as const,
        reclassificationCauseBound: true,
      };

      expect(
        ledger.reclassify(
          sameChannel.id,
          {
            disposition: 'non_task_record',
            reason: 'current channel shows this is only a record',
            expected_revision: sameChannel.revision,
          },
          origin
        ).status
      ).toBe('cancelled');
      const crossed = ledger.reclassify(
        otherChannel.id,
        {
          disposition: 'non_task_record',
          reason: 'the slack thread confirms the chatwork item was only a question',
          expected_revision: otherChannel.revision,
        },
        origin
      );
      expect(crossed.status).toBe('cancelled');
      // Provenance is retained: the effect rests on the real inbox batch.
      const receipt = listEffects(adapter()).find(
        (effect) => effect.targetId === String(otherChannel.id)
      );
      expect(receipt?.sourceEventIds).toEqual(['evt-current']);
    });

    it('still refuses an owner-event decision with no causal events', () => {
      const task = ledger.create({ title: 'x', completion_criteria: 'y' });
      for (const causeEventIds of [undefined, [], ['   ']]) {
        expect(() =>
          ledger.reclassify(
            task.id,
            {
              disposition: 'non_task_record',
              reason: 'no cause',
              expected_revision: task.revision,
            },
            { causeEventIds, causeKind: 'owner_message', reclassificationCauseBound: true }
          )
        ).toThrow(/causal events/i);
      }
      expect(ledger.getById(task.id)?.revision).toBe(task.revision);
    });

    it('still refuses a fabricated causal event that no inbox batch carried', () => {
      const inbox = new OwnerEventInbox(db, () => NOW);
      inbox.enqueue({
        channelKey: 'slack:C001',
        eventIds: ['evt-current'],
        lines: ['current feedback'],
        activations: [],
      });
      const task = ledger.create({
        title: 'x',
        completion_criteria: 'y',
        source_channel: 'slack:C001',
        source_event_id: 'evt-old',
      });
      for (const causeEventIds of [['evt-forged'], ['evt-current', 'evt-forged']]) {
        expect(() =>
          ledger.reclassify(
            task.id,
            {
              disposition: 'non_task_record',
              reason: 'connector text invented an event',
              expected_revision: task.revision,
            },
            { causeEventIds, causeKind: 'owner_message', reclassificationCauseBound: true }
          )
        ).toThrow(/causal event/i);
      }
      expect(ledger.getById(task.id)?.status).toBe('pending');
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

  it('coalesces owner-task notifications after commit and emits nothing for rollback', async () => {
    const notifications: string[] = [];
    const observedDb = new Database(':memory:');
    const observed = new TaskLedger(observedDb, {
      now: () => NOW,
      timeZone: 'Asia/Seoul',
      onOwnerTaskChangeCommitted: (generation) => notifications.push(generation),
    });
    const task = observed.create({ title: 'first', completion_criteria: 'finite result' });
    observed.update(task.id, { title: 'second' });
    expect(notifications).toEqual([]);
    await Promise.resolve();
    expect(notifications).toEqual([observed.readGeneration()]);

    const stableGeneration = observed.readGeneration();
    expect(() =>
      observed.reclassify(task.id, {
        disposition: 'completed_no_issue',
        reason: 'must roll back without a past deadline',
        expected_revision: observed.getById(task.id)!.revision,
      })
    ).toThrow(/deadline|due/i);
    await Promise.resolve();
    expect(observed.readGeneration()).toBe(stableGeneration);
    expect(notifications).toHaveLength(1);

    const current = observed.getById(task.id)!;
    observed.reclassify(task.id, {
      disposition: 'non_task_record',
      reason: 'record rather than finite work',
      expected_revision: current.revision,
    });
    await Promise.resolve();
    expect(notifications).toEqual([stableGeneration, observed.readGeneration()]);
    observedDb.close();
  });
});
