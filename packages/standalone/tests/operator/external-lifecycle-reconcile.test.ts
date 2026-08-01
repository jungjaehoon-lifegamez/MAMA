import { afterEach, describe, expect, it } from 'vitest';
import type { BindingCandidate } from '../../src/operator/external-lifecycle.js';
import {
  bindingCandidateFor,
  enqueueAndClaimBindingAttempt,
  seedBindingCandidateAttempt,
  seedLifecycleCandidateAttempt,
  type SeededExternalLifecycleAttempt,
} from './external-lifecycle-fixtures.js';

const origin = (eventId: string) => ({ runId: 'mr_1', causeEventIds: [eventId] });

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
      origin(candidate.eventId)
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
        origin(candidate.eventId)
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
        origin('evt_other_member_of_batch')
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
        origin(candidate.eventId)
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
        origin(declined.candidate.eventId)
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
        origin(stale.candidate.eventId)
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
        origin(stale.candidate.eventId)
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
    const first = ledger.applyExternalBindingDecision(attempt.id, input, origin(candidate.eventId));
    expect(
      ledger.applyExternalBindingDecision(attempt.id, input, origin(candidate.eventId))
    ).toEqual(first);
    const replay = enqueueAndClaimBindingAttempt(ledger, candidate, 'cross-attempt-replay');
    expect(
      ledger.applyExternalBindingDecision(replay.id, input, origin(candidate.eventId))
    ).toEqual(first);
    expect(() =>
      ledger.applyExternalBindingDecision(
        replay.id,
        { ...input, decision: 'bind' },
        origin(candidate.eventId)
      )
    ).toThrow(/receipt|decision/i);
    expect(() =>
      ledger.applyExternalBindingDecision(
        replay.id,
        { ...input, reason: 'changed reason' },
        origin(candidate.eventId)
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
        origin(candidate.eventId)
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
