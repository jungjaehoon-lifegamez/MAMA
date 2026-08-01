import { afterEach, describe, expect, it } from 'vitest';
import type {
  BindingCandidate,
  LifecycleCandidate,
} from '../../src/operator/external-lifecycle.js';
import {
  bindingCandidateFor,
  enqueueAndClaimBindingAttempt,
  seedBindingCandidateAttempt,
  seedLifecycleCandidateAttempt,
  type SeededExternalLifecycleAttempt,
} from './external-lifecycle-fixtures.js';
import { listEffects } from '../../src/evidence/effects.js';
import { occurrenceKeyForTask, temporalGenerationKey } from '../../src/operator/task-temporal.js';
import { externalLifecycleCandidateId } from '../../src/operator/external-lifecycle-candidates.js';

const origin = (eventId: string, workOrderAttemptId: number) => ({
  runId: 'mr_1',
  workOrderAttemptId,
  causeEventIds: [eventId],
});

describe('Story EL3: receipted external task binding', () => {
  const databases: SeededExternalLifecycleAttempt[] = [];
  afterEach(() => {
    while (databases.length > 0) databases.pop()!.db.close();
  });

  function seeded(): SeededExternalLifecycleAttempt {
    const value = seedBindingCandidateAttempt();
    databases.push(value);
    return value;
  }

  it('binds only the validated host candidate and persists its exact evidence atomically', () => {
    const { ledger, task, attempt, candidate, db } = seeded();
    if (candidate.kind !== 'binding') throw new Error('binding fixture required');

    const receipt = ledger.applyExternalBindingDecision(
      attempt.id,
      {
        candidate_id: candidate.candidateId,
        decision: 'bind',
        reason: 'exact task identity confirmed',
        expected_revision: candidate.taskRevision,
      },
      origin(candidate.eventId, attempt.id)
    );

    expect(receipt).toMatchObject({
      kind: 'binding',
      outcome: 'bound',
      taskId: task.id,
      bindingId: expect.any(Number),
    });
    expect(ledger.getExternalBinding(task.id)).toMatchObject({
      taskId: task.id,
      externalSourceId: candidate.externalSourceId,
      lastObservationSeq: candidate.operatorObservationSeq,
      createdByAttemptId: attempt.id,
    });
    expect(
      db
        .prepare(
          'SELECT event_id, content_sha256, source_timestamp_ms, operator_ingest_seq, operator_observation_seq, task_revision FROM operator_external_binding_receipts'
        )
        .get()
    ).toEqual({
      event_id: candidate.eventId,
      content_sha256: candidate.contentSha256,
      source_timestamp_ms: candidate.sourceTimestampMs,
      operator_ingest_seq: candidate.operatorIngestSeq,
      operator_observation_seq: candidate.operatorObservationSeq,
      task_revision: candidate.taskRevision,
    });
  });

  it('loads a binding candidate only from its claimed board attempt and exact opaque ID', () => {
    const { ledger, attempt, candidate } = seeded();
    if (candidate.kind !== 'binding') throw new Error('binding fixture required');
    expect(ledger.loadBoardCandidate(attempt.id, candidate.candidateId, 'binding')).toEqual(
      candidate
    );
    expect(() => ledger.loadBoardCandidate(attempt.id, 'd'.repeat(64), 'binding')).toThrow(
      /candidate/i
    );
    const unclaimed = ledger.enqueueWorkOrder({
      workKind: 'board',
      idempotencyKey: 'unclaimed',
      input: { mode: 'full' },
    });
    expect(() => ledger.loadBoardCandidate(unclaimed.id, candidate.candidateId, 'binding')).toThrow(
      /claimed|in_progress/i
    );
  });

  it('refuses a mismatched binding attempt origin before binding or receipt mutation', () => {
    const { ledger, task, attempt, candidate } = seeded();
    if (candidate.kind !== 'binding') throw new Error('binding fixture required');

    expect(() =>
      ledger.applyExternalBindingDecision(
        attempt.id,
        {
          candidate_id: candidate.candidateId,
          decision: 'bind',
          reason: 'exact task identity confirmed',
          expected_revision: candidate.taskRevision,
        },
        {
          runId: 'mr_other',
          workOrderAttemptId: attempt.id + 1,
          causeEventIds: [candidate.eventId],
        }
      )
    ).toThrow(/trusted attempt origin/i);
    expect(ledger.getExternalBinding(task.id)).toBeNull();
    expect(ledger.getExternalCandidateReceipt(candidate.candidateId)).toBeNull();
  });

  it('refuses an exact candidate from a different multi-event attempt instead of pairing by task or event', () => {
    const { ledger, task, candidate } = seeded();
    if (candidate.kind !== 'binding') throw new Error('binding fixture required');
    const wrong: BindingCandidate = bindingCandidateFor({
      task,
      eventId: 'evt_binding_2',
      externalSourceId: 'task:43',
      operatorObservationSeq: 10,
    });
    const other = enqueueAndClaimBindingAttempt(ledger, wrong, 'wrong-pair');
    expect(() =>
      ledger.applyExternalBindingDecision(
        other.id,
        {
          candidate_id: candidate.candidateId,
          decision: 'bind',
          reason: 'cross-event substitution',
          expected_revision: candidate.taskRevision,
        },
        origin(candidate.eventId, other.id)
      )
    ).toThrow(/candidate/i);
    expect(ledger.getExternalBinding(task.id)).toBeNull();
  });

  it('refuses an origin event that does not exactly match the host candidate in a multi-event batch', () => {
    const value = seedBindingCandidateAttempt({
      eventIds: ['evt_binding_1', 'evt_other_member_of_batch'],
    });
    databases.push(value);
    const { ledger, task, attempt, candidate } = value;
    if (candidate.kind !== 'binding') throw new Error('binding fixture required');
    expect(attempt.payload.eventIds).toEqual([candidate.eventId, 'evt_other_member_of_batch']);
    expect(() =>
      ledger.applyExternalBindingDecision(
        attempt.id,
        {
          candidate_id: candidate.candidateId,
          decision: 'bind',
          reason: 'exact task identity confirmed',
          expected_revision: candidate.taskRevision,
        },
        origin('evt_other_member_of_batch', attempt.id)
      )
    ).toThrow(/origin|event/i);
    expect(ledger.getExternalBinding(task.id)).toBeNull();
    expect(
      ledger.applyExternalBindingDecision(
        attempt.id,
        {
          candidate_id: candidate.candidateId,
          decision: 'bind',
          reason: 'exact task identity confirmed',
          expected_revision: candidate.taskRevision,
        },
        origin(candidate.eventId, attempt.id)
      )
    ).toMatchObject({ outcome: 'bound' });
  });

  it('declines and supersedes stale revisions without binding', () => {
    const declined = seeded();
    if (declined.candidate.kind !== 'binding') throw new Error('binding fixture required');
    expect(
      declined.ledger.applyExternalBindingDecision(
        declined.attempt.id,
        {
          candidate_id: declined.candidate.candidateId,
          decision: 'decline',
          reason: 'identity remains ambiguous',
          expected_revision: declined.candidate.taskRevision,
        },
        origin(declined.candidate.eventId, declined.attempt.id)
      )
    ).toMatchObject({ outcome: 'declined' });
    expect(declined.ledger.getExternalBinding(declined.task.id)).toBeNull();

    const stale = seeded();
    if (stale.candidate.kind !== 'binding') throw new Error('binding fixture required');
    stale.ledger.update(stale.task.id, { title: 'updated before review' });
    expect(
      stale.ledger.applyExternalBindingDecision(
        stale.attempt.id,
        {
          candidate_id: stale.candidate.candidateId,
          decision: 'bind',
          reason: 'exact task identity confirmed',
          expected_revision: stale.candidate.taskRevision,
        },
        origin(stale.candidate.eventId, stale.attempt.id)
      )
    ).toMatchObject({ outcome: 'superseded' });
    expect(() =>
      stale.ledger.applyExternalBindingDecision(
        stale.attempt.id,
        {
          candidate_id: stale.candidate.candidateId,
          decision: 'decline',
          reason: 'exact task identity confirmed',
          expected_revision: stale.candidate.taskRevision,
        },
        origin(stale.candidate.eventId, stale.attempt.id)
      )
    ).toThrow(/receipt|decision/i);
    expect(stale.ledger.getExternalBinding(stale.task.id)).toBeNull();
  });

  it('returns an identical receipt across attempts but fails changed decision or reason loudly', () => {
    const { ledger, task, attempt, candidate } = seeded();
    if (candidate.kind !== 'binding') throw new Error('binding fixture required');
    const input = {
      candidate_id: candidate.candidateId,
      decision: 'decline' as const,
      reason: 'identity remains ambiguous',
      expected_revision: candidate.taskRevision,
    };
    const first = ledger.applyExternalBindingDecision(
      attempt.id,
      input,
      origin(candidate.eventId, attempt.id)
    );
    expect(
      ledger.applyExternalBindingDecision(attempt.id, input, origin(candidate.eventId, attempt.id))
    ).toEqual(first);
    const replay = enqueueAndClaimBindingAttempt(ledger, candidate, 'cross-attempt-replay');
    expect(
      ledger.applyExternalBindingDecision(replay.id, input, origin(candidate.eventId, replay.id))
    ).toEqual(first);
    expect(() =>
      ledger.applyExternalBindingDecision(
        replay.id,
        { ...input, decision: 'bind' },
        origin(candidate.eventId, replay.id)
      )
    ).toThrow(/receipt|decision/i);
    expect(() =>
      ledger.applyExternalBindingDecision(
        replay.id,
        { ...input, reason: 'changed reason' },
        origin(candidate.eventId, replay.id)
      )
    ).toThrow(/receipt|reason/i);
    expect(ledger.getExternalBinding(task.id)).toBeNull();
  });

  it('rolls back a binding when the receipt insert fails and never backfills legacy tasks', () => {
    const { ledger, task, attempt, candidate, db } = seeded();
    if (candidate.kind !== 'binding') throw new Error('binding fixture required');
    db.exec(`CREATE TRIGGER reject_binding_receipt BEFORE INSERT ON operator_external_binding_receipts
      BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END`);
    expect(() =>
      ledger.applyExternalBindingDecision(
        attempt.id,
        {
          candidate_id: candidate.candidateId,
          decision: 'bind',
          reason: 'exact task identity confirmed',
          expected_revision: candidate.taskRevision,
        },
        origin(candidate.eventId, attempt.id)
      )
    ).toThrow(/receipt unavailable/);
    expect(ledger.getExternalBinding(task.id)).toBeNull();
    expect(ledger.getExternalCandidateReceipt(candidate.candidateId)).toBeNull();
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM operator_external_task_bindings').get()
    ).toEqual({ count: 0 });
  });

  it('does not auto-backfill a binding for an existing task', () => {
    const lifecycle = seedLifecycleCandidateAttempt();
    databases.push(lifecycle);
    expect(lifecycle.ledger.getExternalBinding(lifecycle.task.id)).not.toBeNull();
    const untouched = lifecycle.ledger.create({
      title: 'legacy native task',
      source_channel: 'kagemusha:room-a',
      source_event_id: 'task:999',
    });
    expect(lifecycle.ledger.getExternalBinding(untouched.id)).toBeNull();
  });
});

describe('Story EL4: receipted external lifecycle transitions (TG-01/TG-05/TG-06)', () => {
  const databases: SeededExternalLifecycleAttempt[] = [];
  afterEach(() => {
    while (databases.length > 0) databases.pop()!.db.close();
  });

  it('applies a host-built status and latest event together in one receipted revision', () => {
    const seeded = seedLifecycleCandidateAttempt();
    databases.push(seeded);
    if (seeded.candidate.kind !== 'lifecycle') {
      throw new Error('lifecycle fixture required');
    }

    const receipt = seeded.ledger.applyExternalLifecycleDecision(
      seeded.attempt.id,
      {
        candidate_id: seeded.candidate.candidateId,
        decision: 'apply',
        reason: 'external completion matches the exact bound card',
        expected_revision: seeded.candidate.taskRevision,
      },
      origin(seeded.candidate.eventId, seeded.attempt.id)
    );

    expect(receipt).toMatchObject({
      kind: 'lifecycle',
      outcome: 'applied',
      taskRevisionBefore: seeded.candidate.taskRevision,
      taskRevisionAfter: seeded.candidate.taskRevision + 1,
    });
    expect(seeded.ledger.getById(seeded.task.id)).toMatchObject({
      status: seeded.candidate.proposedStatus,
      latestEvent: seeded.candidate.evidenceSummary,
      revision: seeded.candidate.taskRevision + 1,
    });
    expect(
      listEffects(seeded.db as never).filter((effect) => effect.kind === 'task_update')
    ).toEqual([
      expect.objectContaining({
        sourceEventIds: [seeded.candidate.eventId],
        targetId: String(seeded.task.id),
      }),
    ]);
  });

  it('retains an observation without an effect while consuming its connector-wide watermark', () => {
    const seeded = seedLifecycleCandidateAttempt();
    databases.push(seeded);
    if (seeded.candidate.kind !== 'lifecycle') throw new Error('lifecycle fixture required');

    const receipt = seeded.ledger.applyExternalLifecycleDecision(
      seeded.attempt.id,
      {
        candidate_id: seeded.candidate.candidateId,
        decision: 'retain',
        reason: 'native task intentionally remains open',
        expected_revision: seeded.candidate.taskRevision,
      },
      origin(seeded.candidate.eventId, seeded.attempt.id)
    );

    expect(receipt).toMatchObject({
      outcome: 'retained',
      taskRevisionBefore: seeded.task.revision,
      taskRevisionAfter: seeded.task.revision,
    });
    expect(seeded.ledger.getById(seeded.task.id)).toMatchObject({
      status: seeded.task.status,
      revision: seeded.task.revision,
    });
    expect(seeded.ledger.getExternalBinding(seeded.task.id)?.lastObservationSeq).toBe(
      seeded.candidate.operatorObservationSeq
    );
    expect(
      listEffects(seeded.db as never).filter((effect) => effect.kind === 'task_update')
    ).toEqual([]);
  });

  it.each(['status', 'latest_event'] as const)(
    'blocks candidate task_update(%s) before mutation while allowing unrelated fields and tasks',
    (field) => {
      const seeded = seedLifecycleCandidateAttempt();
      databases.push(seeded);
      if (seeded.candidate.kind !== 'lifecycle') throw new Error('lifecycle fixture required');
      const patch = field === 'status' ? { status: 'done' as const } : { latest_event: 'forged' };
      expect(() =>
        seeded.ledger.update(seeded.candidate.taskId, patch, {
          workOrderAttemptId: seeded.attempt.id,
          causeEventIds: [seeded.candidate.eventId],
        })
      ).toThrow(/candidate-bound lifecycle/i);
      expect(seeded.ledger.getById(seeded.candidate.taskId)?.revision).toBe(
        seeded.candidate.taskRevision
      );
      expect(
        seeded.ledger.update(
          seeded.candidate.taskId,
          { title: 'operator note', priority: 'high' },
          { workOrderAttemptId: seeded.attempt.id }
        )
      ).toMatchObject({ title: 'operator note', priority: 'high' });
      const unrelated = seeded.ledger.create({ title: 'other task' });
      expect(
        seeded.ledger.update(
          unrelated.id,
          { status: 'done' },
          { workOrderAttemptId: seeded.attempt.id }
        )
      ).toMatchObject({ status: 'done' });
    }
  );

  it('rolls task state and watermark back when its lifecycle receipt cannot commit', () => {
    const seeded = seedLifecycleCandidateAttempt();
    databases.push(seeded);
    if (seeded.candidate.kind !== 'lifecycle') throw new Error('lifecycle fixture required');
    seeded.db.exec(`CREATE TRIGGER reject_lifecycle_receipt
      BEFORE INSERT ON operator_external_lifecycle_receipts
      BEGIN SELECT RAISE(ABORT, 'lifecycle receipt unavailable'); END`);

    expect(() =>
      seeded.ledger.applyExternalLifecycleDecision(
        seeded.attempt.id,
        {
          candidate_id: seeded.candidate.candidateId,
          decision: 'apply',
          reason: 'external completion matches the exact bound card',
          expected_revision: seeded.candidate.taskRevision,
        },
        origin(seeded.candidate.eventId, seeded.attempt.id)
      )
    ).toThrow(/lifecycle receipt unavailable/);
    expect(seeded.ledger.getById(seeded.task.id)).toMatchObject({
      status: 'pending',
      revision: seeded.candidate.taskRevision,
    });
    expect(seeded.ledger.getExternalBinding(seeded.task.id)?.lastObservationSeq).toBeLessThan(
      seeded.candidate.operatorObservationSeq
    );
    expect(seeded.ledger.getExternalCandidateReceipt(seeded.candidate.candidateId)).toBeNull();
  });

  it('replays an identical lifecycle receipt but rejects a changed decision or reason', () => {
    const seeded = seedLifecycleCandidateAttempt();
    databases.push(seeded);
    if (seeded.candidate.kind !== 'lifecycle') throw new Error('lifecycle fixture required');
    const input = {
      candidate_id: seeded.candidate.candidateId,
      decision: 'apply' as const,
      reason: 'external completion matches the exact bound card',
      expected_revision: seeded.candidate.taskRevision,
    };
    const trustedOrigin = origin(seeded.candidate.eventId, seeded.attempt.id);
    const first = seeded.ledger.applyExternalLifecycleDecision(
      seeded.attempt.id,
      input,
      trustedOrigin
    );
    expect(
      seeded.ledger.applyExternalLifecycleDecision(seeded.attempt.id, input, trustedOrigin)
    ).toEqual(first);
    expect(() =>
      seeded.ledger.applyExternalLifecycleDecision(
        seeded.attempt.id,
        { ...input, decision: 'retain' },
        trustedOrigin
      )
    ).toThrow(/receipt|decision/i);
    expect(() =>
      seeded.ledger.applyExternalLifecycleDecision(
        seeded.attempt.id,
        { ...input, reason: 'changed reason' },
        trustedOrigin
      )
    ).toThrow(/receipt|decision/i);
  });

  it('records a superseded receipt without applying an observation after task revision drift', () => {
    const seeded = seedLifecycleCandidateAttempt();
    databases.push(seeded);
    if (seeded.candidate.kind !== 'lifecycle') throw new Error('lifecycle fixture required');
    seeded.ledger.update(seeded.task.id, { title: 'owner edited before lifecycle review' });

    const receipt = seeded.ledger.applyExternalLifecycleDecision(
      seeded.attempt.id,
      {
        candidate_id: seeded.candidate.candidateId,
        decision: 'apply',
        reason: 'external completion matches the exact bound card',
        expected_revision: seeded.candidate.taskRevision,
      },
      origin(seeded.candidate.eventId, seeded.attempt.id)
    );

    expect(receipt).toMatchObject({
      outcome: 'superseded',
      taskRevisionBefore: seeded.candidate.taskRevision + 1,
      taskRevisionAfter: seeded.candidate.taskRevision + 1,
    });
    expect(seeded.ledger.getById(seeded.task.id)).toMatchObject({
      title: 'owner edited before lifecycle review',
      status: 'pending',
    });
    expect(seeded.ledger.getExternalBinding(seeded.task.id)?.lastObservationSeq).toBeLessThan(
      seeded.candidate.operatorObservationSeq
    );
  });

  it.each([
    ['open-to-terminal', 'pending', 'done'],
    ['terminal-to-open', 'done', 'pending'],
  ] as const)(
    'uses the canonical temporal generation transition for %s lifecycle apply',
    (_name, initialStatus, proposedStatus) => {
      const seeded = seedLifecycleCandidateAttempt({
        taskInput: {
          title: 'scheduled native task',
          status: initialStatus,
          due_at: '2026-08-03T09:00:00+09:00',
        },
        proposedStatus,
      });
      databases.push(seeded);
      if (seeded.candidate.kind !== 'lifecycle') throw new Error('lifecycle fixture required');
      const scheduled = seeded.ledger.getById(seeded.task.id);
      if (!scheduled || !scheduled.dueAt) throw new Error('scheduled lifecycle task required');
      const generation =
        initialStatus === 'pending'
          ? seeded.ledger.enqueueTemporalGeneration({
              generationKey: temporalGenerationKey(
                scheduled.id,
                occurrenceKeyForTask(scheduled)!,
                scheduled.dueAt
              ),
              taskId: scheduled.id,
              temporalEpoch: scheduled.temporalEpoch,
              occurrenceKey: occurrenceKeyForTask(scheduled)!,
              checkAt: scheduled.dueAt,
              sourceChannel: scheduled.sourceChannel,
              sourceEventId: scheduled.sourceEventId,
            })
          : null;

      const updated = seeded.ledger.applyExternalLifecycleDecision(
        seeded.attempt.id,
        {
          candidate_id: seeded.candidate.candidateId,
          decision: 'apply',
          reason: 'exact external lifecycle observation',
          expected_revision: seeded.candidate.taskRevision,
        },
        origin(seeded.candidate.eventId, seeded.attempt.id)
      );

      expect(updated.outcome).toBe('applied');
      if (generation) {
        expect(
          seeded.ledger.getTemporalGeneration(generation.generation.generationKey)
        ).toMatchObject({
          disposition: 'superseded',
        });
        expect(seeded.ledger.getWorkOrderById(generation.workOrder.id)).toMatchObject({
          status: 'cancelled',
        });
      }
      if (initialStatus === 'done') {
        expect(seeded.ledger.getById(seeded.task.id)?.temporalEpoch).toBe(
          scheduled.temporalEpoch + 1
        );
      }
    }
  );

  it('uses connector-wide ordinals for equal-timestamp cross-channel observations', () => {
    const seeded = seedLifecycleCandidateAttempt();
    databases.push(seeded);
    if (seeded.candidate.kind !== 'lifecycle') throw new Error('lifecycle fixture required');
    const newerOrigin = origin(seeded.candidate.eventId, seeded.attempt.id);
    seeded.ledger.applyExternalLifecycleDecision(
      seeded.attempt.id,
      {
        candidate_id: seeded.candidate.candidateId,
        decision: 'apply',
        reason: 'newer room-b observation',
        expected_revision: seeded.candidate.taskRevision,
      },
      newerOrigin
    );
    const afterNewer = seeded.ledger.getById(seeded.task.id)!;
    const binding = seeded.ledger.getExternalBinding(seeded.task.id)!;
    const olderObservationSeq = seeded.candidate.operatorObservationSeq - 1;
    const older: LifecycleCandidate = {
      ...seeded.candidate,
      candidateId: externalLifecycleCandidateId({
        kind: 'lifecycle',
        eventId: 'evt_room_a_older',
        externalSourceId: binding.externalSourceId,
        channelPartition: 'room-a',
        contentSha256: 'c'.repeat(64),
        operatorObservationSeq: olderObservationSeq,
        bindingId: binding.id,
        bindingRevision: binding.revision,
        taskId: afterNewer.id,
        taskRevision: afterNewer.revision,
        proposedStatus: 'pending',
      }),
      eventId: 'evt_room_a_older',
      channelPartition: 'room-a',
      contentSha256: 'c'.repeat(64),
      // Both rooms reported at the exact same source timestamp. Only the
      // connector-wide ordinal establishes their durable observation order.
      sourceTimestampMs: seeded.candidate.sourceTimestampMs,
      operatorIngestSeq: 1,
      operatorObservationSeq: olderObservationSeq,
      observedStatus: 'pending',
      evidenceSummary: `Kagemusha task 42 reported pending at ${new Date(seeded.candidate.sourceTimestampMs).toISOString()}`,
      bindingId: binding.id,
      bindingRevision: binding.revision,
      taskId: afterNewer.id,
      taskRevision: afterNewer.revision,
      proposedStatus: 'pending',
    };
    const staleOrder = seeded.ledger.enqueueWorkOrder({
      workKind: 'board',
      idempotencyKey: `lifecycle:${older.candidateId}`,
      input: {
        mode: 'reconcile',
        channelKey: 'kagemusha:room-a',
        deltaLines: ['host-authored older observation'],
        eventIds: [older.eventId],
        candidates: { bindingCandidates: [], lifecycleCandidates: [older] },
      },
    });
    const staleAttempt = seeded.ledger.claimNextWorkOrder();
    expect(staleAttempt?.id).toBe(staleOrder.id);

    expect(
      seeded.ledger.applyExternalLifecycleDecision(
        staleOrder.id,
        {
          candidate_id: older.candidateId,
          decision: 'apply',
          reason: 'older room-a observation',
          expected_revision: older.taskRevision,
        },
        origin(older.eventId, staleOrder.id)
      )
    ).toMatchObject({ outcome: 'superseded' });
    expect(seeded.ledger.getById(seeded.task.id)).toMatchObject({
      status: 'done',
      revision: afterNewer.revision,
    });
    expect(seeded.ledger.getExternalBinding(seeded.task.id)?.lastObservationSeq).toBe(
      seeded.candidate.operatorObservationSeq
    );
  });
});
