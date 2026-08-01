import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import {
  TaskLedger,
  type CreateTaskInput,
  type TaskRecord,
  type WorkOrderRecord,
} from '../../src/operator/task-ledger.js';
import type {
  BindingCandidate,
  LifecycleCandidate,
} from '../../src/operator/external-lifecycle.js';
import { externalLifecycleCandidateId } from '../../src/operator/external-lifecycle-candidates.js';

export interface SeededExternalLifecycleAttempt {
  db: SQLiteDatabase;
  ledger: TaskLedger;
  task: TaskRecord;
  attempt: WorkOrderRecord;
  candidate: BindingCandidate | LifecycleCandidate;
}

export function bindingCandidateFor(input: {
  task: TaskRecord;
  eventId?: string;
  externalSourceId?: string;
  operatorObservationSeq?: number;
}): BindingCandidate {
  const eventId = input.eventId ?? 'evt_binding_1';
  const externalSourceId = input.externalSourceId ?? 'task:42';
  const operatorObservationSeq = input.operatorObservationSeq ?? 9;
  const sourceTimestampMs = Date.parse('2026-08-02T00:00:00.000Z');
  const contentSha256 = 'a'.repeat(64);
  return {
    kind: 'binding',
    candidateId: externalLifecycleCandidateId({
      kind: 'binding',
      eventId,
      externalSourceId,
      channelPartition: 'room-a',
      contentSha256,
      operatorObservationSeq,
      taskId: input.task.id,
      taskRevision: input.task.revision,
    }),
    eventId,
    connector: 'kagemusha',
    sourceType: 'kanban_card',
    externalSourceId,
    channelPartition: 'room-a',
    contentSha256,
    sourceTimestampMs,
    operatorIngestSeq: 3,
    operatorObservationSeq,
    observedStatus: 'pending',
    evidenceSummary: `Kagemusha task ${externalSourceId.slice(5)} reported pending at ${new Date(sourceTimestampMs).toISOString()}`,
    taskId: input.task.id,
    taskRevision: input.task.revision,
  };
}

export function enqueueAndClaimBindingAttempt(
  ledger: TaskLedger,
  candidate: BindingCandidate,
  key = `binding:${candidate.candidateId}`,
  eventIds: readonly string[] = [candidate.eventId]
): WorkOrderRecord {
  const attempt = ledger.enqueueWorkOrder({
    workKind: 'board',
    idempotencyKey: key,
    input: {
      mode: 'reconcile',
      channelKey: 'kagemusha:room-a',
      deltaLines: ['host-authored candidate context'],
      eventIds: [...eventIds],
      candidates: { bindingCandidates: [candidate], lifecycleCandidates: [] },
    },
  });
  const claimed = ledger.claimNextWorkOrder();
  if (!claimed || claimed.id !== attempt.id)
    throw new Error('fixture must claim its binding attempt');
  return claimed;
}

export function seedBindingCandidateAttempt(
  input: { eventIds?: readonly string[]; taskInput?: CreateTaskInput } = {}
): SeededExternalLifecycleAttempt {
  const db = new Database(':memory:');
  const ledger = new TaskLedger(db, { now: () => Date.parse('2026-08-02T00:00:00.000Z') });
  const task = ledger.create(input.taskInput ?? { title: 'native task' });
  const candidate = bindingCandidateFor({ task });
  const attempt = enqueueAndClaimBindingAttempt(
    ledger,
    candidate,
    undefined,
    input.eventIds ?? [candidate.eventId]
  );
  return { db, ledger, task, attempt, candidate };
}

export function seedLifecycleCandidateAttempt(
  input: { taskInput?: CreateTaskInput; proposedStatus?: LifecycleCandidate['proposedStatus'] } = {}
): SeededExternalLifecycleAttempt {
  const seeded = seedBindingCandidateAttempt({ taskInput: input.taskInput });
  if (seeded.candidate.kind !== 'binding')
    throw new Error('fixture must create a binding candidate');
  seeded.ledger.applyExternalBindingDecision(
    seeded.attempt.id,
    {
      candidate_id: seeded.candidate.candidateId,
      decision: 'bind',
      reason: 'exact task identity confirmed',
      expected_revision: seeded.candidate.taskRevision,
    },
    {
      runId: 'fixture_bind',
      workOrderAttemptId: seeded.attempt.id,
      causeEventIds: [seeded.candidate.eventId],
    }
  );
  const binding = seeded.ledger.getExternalBinding(seeded.task.id);
  if (!binding) throw new Error('fixture must create its binding');
  const sourceTimestampMs = Date.parse('2026-08-02T00:01:00.000Z');
  const contentSha256 = 'b'.repeat(64);
  const candidate: LifecycleCandidate = {
    kind: 'lifecycle',
    candidateId: externalLifecycleCandidateId({
      kind: 'lifecycle',
      eventId: 'evt_lifecycle_2',
      externalSourceId: binding.externalSourceId,
      channelPartition: 'room-b',
      contentSha256,
      operatorObservationSeq: binding.lastObservationSeq + 1,
      bindingId: binding.id,
      bindingRevision: binding.revision,
      taskId: seeded.task.id,
      taskRevision: seeded.task.revision,
      proposedStatus: input.proposedStatus ?? 'done',
    }),
    eventId: 'evt_lifecycle_2',
    connector: 'kagemusha',
    sourceType: 'kanban_card',
    externalSourceId: binding.externalSourceId,
    channelPartition: 'room-b',
    contentSha256,
    sourceTimestampMs,
    operatorIngestSeq: 4,
    operatorObservationSeq: binding.lastObservationSeq + 1,
    observedStatus: input.proposedStatus ?? 'done',
    evidenceSummary: `Kagemusha task 42 reported ${input.proposedStatus ?? 'done'} at ${new Date(sourceTimestampMs).toISOString()}`,
    bindingId: binding.id,
    bindingRevision: binding.revision,
    taskId: seeded.task.id,
    taskRevision: seeded.task.revision,
    proposedStatus: input.proposedStatus ?? 'done',
  };
  const attempt = seeded.ledger.enqueueWorkOrder({
    workKind: 'board',
    idempotencyKey: `lifecycle:${candidate.candidateId}`,
    input: {
      mode: 'reconcile',
      channelKey: 'kagemusha:room-b',
      deltaLines: ['host-authored lifecycle candidate context'],
      eventIds: [candidate.eventId],
      candidates: { bindingCandidates: [], lifecycleCandidates: [candidate] },
    },
  });
  const claimed = seeded.ledger.claimNextWorkOrder();
  if (!claimed || claimed.id !== attempt.id)
    throw new Error('fixture must claim its lifecycle attempt');
  return { ...seeded, attempt: claimed, candidate };
}
