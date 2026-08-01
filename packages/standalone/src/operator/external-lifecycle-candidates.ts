import { createHash } from 'node:crypto';
import type {
  BindingCandidate,
  BindingCandidateIdentityInput,
  CandidateTaskSnapshot,
  ExistingExternalBindingSnapshot,
  ExternalLifecycleCandidateSet,
  ExternalLifecycleDiagnostic,
  ExternalLifecycleStatus,
  ExternalObservationSnapshot,
  LifecycleCandidate,
  LifecycleCandidateIdentityInput,
  TaskHintLookup,
} from './external-lifecycle.js';

export type {
  BindingCandidateIdentityInput,
  ExistingExternalBindingSnapshot,
  ExternalObservationSnapshot,
  TaskHintLookup,
} from './external-lifecycle.js';

export const KAGEMUSHA_LIFECYCLE_OBSERVED_STATUSES = [
  'pending',
  'in_progress',
  'review',
  'done',
  'completed',
  'cancelled',
  'dismissed',
] as const;

const KAGEMUSHA_STATUS_MAP: Readonly<Record<string, ExternalLifecycleStatus>> = {
  pending: 'pending',
  in_progress: 'in_progress',
  review: 'review',
  done: 'done',
  completed: 'done',
  cancelled: 'cancelled',
  dismissed: 'cancelled',
};

const HEX_SHA256 = /^[a-fA-F0-9]{64}$/;

export interface RawExternalObservation {
  event_index_id: unknown;
  source_connector: unknown;
  source_type: unknown;
  source_id: unknown;
  channel: unknown;
  content_hash: unknown;
  source_timestamp_ms: unknown;
  operator_ingest_seq: unknown;
  operator_observation_seq: unknown;
  metadata_json: unknown;
}

export interface ExternalLifecycleDecisionInput {
  candidate_id: string;
  decision: 'bind' | 'decline' | 'apply' | 'retain';
  reason: string;
  expected_revision: number;
}

/** Exact status spellings emitted by the private Kagemusha task connector. */
export function mapKagemushaLifecycle(value: string): ExternalLifecycleStatus | null {
  return KAGEMUSHA_STATUS_MAP[value] ?? null;
}

/**
 * Validates the agent-authored half of a candidate decision. Identity, task,
 * event, and status stay host-owned and are recovered from the opaque ID.
 */
export function validateExternalLifecycleDecision(
  kind: 'binding' | 'lifecycle',
  value: unknown
): asserts value is ExternalLifecycleDecisionInput {
  if (!isPlainObject(value)) {
    throw new Error('external lifecycle decision must be an object');
  }
  if (!exactKeys(value, ['candidate_id', 'decision', 'reason', 'expected_revision'])) {
    throw new Error('external lifecycle decision has unknown or missing fields');
  }
  if (typeof value.candidate_id !== 'string' || !/^[a-f0-9]{64}$/.test(value.candidate_id)) {
    throw new Error('external lifecycle decision candidate_id must be a sha256 hex ID');
  }
  const decisions = kind === 'binding' ? ['bind', 'decline'] : ['apply', 'retain'];
  if (typeof value.decision !== 'string' || !decisions.includes(value.decision)) {
    throw new Error(`external lifecycle ${kind} decision is invalid`);
  }
  if (typeof value.reason !== 'string' || value.reason.length < 1 || value.reason.length > 500) {
    throw new Error('external lifecycle decision reason must contain 1-500 characters');
  }
  if (!isPositiveSafeInteger(value.expected_revision)) {
    throw new Error(
      'external lifecycle decision expected_revision must be a positive safe integer'
    );
  }
}

/**
 * Parses a single database row into an immutable, host-authored observation.
 * The fixed summary intentionally derives from validated structured fields only.
 */
export function parseKagemushaObservation(
  row: RawExternalObservation
): ExternalObservationSnapshot | null {
  if (row.source_connector !== 'kagemusha' || row.source_type !== 'kanban_card') return null;
  if (
    !isBoundedString(row.event_index_id) ||
    !isBoundedString(row.source_id) ||
    !isBoundedString(row.channel) ||
    typeof row.content_hash !== 'string' ||
    !HEX_SHA256.test(row.content_hash) ||
    !isPositiveSafeInteger(row.source_timestamp_ms) ||
    !isPositiveSafeInteger(row.operator_ingest_seq) ||
    !isPositiveSafeInteger(row.operator_observation_seq)
  ) {
    return null;
  }
  const metadata = parseStrictKagemushaMetadata(row.metadata_json);
  if (!metadata || row.source_id !== `task:${metadata.taskId}`) return null;
  if (!mapKagemushaLifecycle(metadata.status)) return null;

  return Object.freeze({
    eventId: row.event_index_id,
    connector: 'kagemusha',
    sourceType: 'kanban_card',
    externalSourceId: row.source_id,
    channelPartition: row.channel,
    contentSha256: row.content_hash.toLowerCase(),
    sourceTimestampMs: row.source_timestamp_ms,
    operatorIngestSeq: row.operator_ingest_seq,
    operatorObservationSeq: row.operator_observation_seq,
    observedStatus: metadata.status,
    evidenceSummary: `Kagemusha task ${metadata.taskId} reported ${metadata.status} at ${new Date(row.source_timestamp_ms).toISOString()}`,
  });
}

export function externalLifecycleCandidateId(
  input: BindingCandidateIdentityInput | LifecycleCandidateIdentityInput
): string {
  const identity =
    input.kind === 'binding'
      ? [
          input.kind,
          input.eventId,
          input.externalSourceId,
          input.channelPartition,
          input.contentSha256,
          input.operatorObservationSeq,
          input.taskId,
          input.taskRevision,
        ]
      : [
          input.kind,
          input.eventId,
          input.externalSourceId,
          input.channelPartition,
          input.contentSha256,
          input.operatorObservationSeq,
          input.bindingId,
          input.bindingRevision,
          input.taskId,
          input.taskRevision,
          input.proposedStatus,
        ];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export function buildExternalLifecycleCandidateSet(input: {
  eventIds: readonly string[];
  observations: readonly ExternalObservationSnapshot[];
  taskHints: TaskHintLookup;
  tasksById: ReadonlyMap<number, CandidateTaskSnapshot>;
  bindings: readonly ExistingExternalBindingSnapshot[];
  receiptedCandidateIds: ReadonlySet<string>;
}): ExternalLifecycleCandidateSet {
  const eventIds = new Set(input.eventIds);
  const diagnostics: ExternalLifecycleDiagnostic[] = [];
  const observationsById = new Map<string, ExternalObservationSnapshot>();
  for (const observation of input.observations) {
    if (!eventIds.has(observation.eventId) || observationsById.has(observation.eventId)) continue;
    observationsById.set(observation.eventId, observation);
  }

  for (const eventId of input.eventIds) {
    if (!observationsById.has(eventId)) diagnostics.push({ eventId, code: 'missing_event' });
  }

  const bindingsByExternalSourceId = new Map<string, ExistingExternalBindingSnapshot>();
  for (const binding of input.bindings) {
    if (
      binding.connector === 'kagemusha' &&
      binding.sourceType === 'kanban_card' &&
      !bindingsByExternalSourceId.has(binding.externalSourceId)
    ) {
      bindingsByExternalSourceId.set(binding.externalSourceId, binding);
    }
  }

  const eligible = [...observationsById.values()].filter((observation) => {
    if (observation.connector !== 'kagemusha') {
      diagnostics.push({ eventId: observation.eventId, code: 'unsupported_connector' });
      return false;
    }
    if (observation.sourceType !== 'kanban_card') {
      diagnostics.push({ eventId: observation.eventId, code: 'unsupported_source_type' });
      return false;
    }
    if (!mapKagemushaLifecycle(observation.observedStatus)) {
      diagnostics.push({ eventId: observation.eventId, code: 'unknown_status' });
      return false;
    }
    return true;
  });

  const lifecycleCandidates: LifecycleCandidate[] = [];
  const discovery: ExternalObservationSnapshot[] = [];
  for (const observation of eligible) {
    const binding = bindingsByExternalSourceId.get(observation.externalSourceId);
    if (!binding || observation.operatorObservationSeq <= binding.lastObservationSeq) {
      if (!binding) discovery.push(observation);
      continue;
    }
    const task = input.tasksById.get(binding.taskId);
    if (!task) {
      diagnostics.push({ eventId: observation.eventId, code: 'ambiguous_task_pair' });
      continue;
    }
    const candidate = lifecycleCandidate(observation, binding, task);
    if (input.receiptedCandidateIds.has(candidate.candidateId)) {
      diagnostics.push({ eventId: observation.eventId, code: 'receipt_already_exists' });
      continue;
    }
    lifecycleCandidates.push(candidate);
  }

  const discoveredTaskIdsByEventId = new Map<string, Set<number>>();
  const eventIdsByTaskId = new Map<number, Set<string>>();
  for (const observation of discovery) {
    const direct = uniquePositiveTaskIds(
      input.taskHints.directTaskIdsByEventId.get(observation.eventId)
    );
    const effect = uniquePositiveTaskIds(
      input.taskHints.effectTaskIdsByEventId.get(observation.eventId)
    );
    const candidates = new Set([...direct, ...effect]);
    const sourcesAgree =
      direct.size === 0 ||
      effect.size === 0 ||
      (direct.size === 1 && effect.size === 1 && sameSet(direct, effect));
    if (!sourcesAgree || candidates.size !== 1) {
      diagnostics.push({ eventId: observation.eventId, code: 'ambiguous_task_pair' });
      continue;
    }
    const taskId = [...candidates][0]!;
    if (!input.tasksById.has(taskId)) {
      diagnostics.push({ eventId: observation.eventId, code: 'ambiguous_task_pair' });
      continue;
    }
    discoveredTaskIdsByEventId.set(observation.eventId, candidates);
    const events = eventIdsByTaskId.get(taskId) ?? new Set<string>();
    events.add(observation.eventId);
    eventIdsByTaskId.set(taskId, events);
  }

  const bindingCandidates: BindingCandidate[] = [];
  for (const observation of discovery) {
    const taskIds = discoveredTaskIdsByEventId.get(observation.eventId);
    if (!taskIds || taskIds.size !== 1) continue;
    const taskId = [...taskIds][0]!;
    if (eventIdsByTaskId.get(taskId)?.size !== 1) {
      diagnostics.push({ eventId: observation.eventId, code: 'ambiguous_task_pair' });
      continue;
    }
    const task = input.tasksById.get(taskId)!;
    const candidate = bindingCandidate(observation, task);
    if (input.receiptedCandidateIds.has(candidate.candidateId)) {
      diagnostics.push({ eventId: observation.eventId, code: 'receipt_already_exists' });
      continue;
    }
    bindingCandidates.push(candidate);
  }

  return Object.freeze({
    bindingCandidates: Object.freeze(bindingCandidates),
    lifecycleCandidates: Object.freeze(lifecycleCandidates),
    diagnostics: Object.freeze(diagnostics),
  });
}

function bindingCandidate(
  observation: ExternalObservationSnapshot,
  task: CandidateTaskSnapshot
): BindingCandidate {
  const identity: BindingCandidateIdentityInput = {
    kind: 'binding',
    eventId: observation.eventId,
    externalSourceId: observation.externalSourceId,
    channelPartition: observation.channelPartition,
    contentSha256: observation.contentSha256,
    operatorObservationSeq: observation.operatorObservationSeq,
    taskId: task.taskId,
    taskRevision: task.revision,
  };
  return Object.freeze({
    ...observation,
    kind: 'binding',
    candidateId: externalLifecycleCandidateId(identity),
    taskId: task.taskId,
    taskRevision: task.revision,
  });
}

function lifecycleCandidate(
  observation: ExternalObservationSnapshot,
  binding: ExistingExternalBindingSnapshot,
  task: CandidateTaskSnapshot
): LifecycleCandidate {
  const proposedStatus = mapKagemushaLifecycle(observation.observedStatus);
  if (!proposedStatus) throw new Error('lifecycle candidate requires a mapped Kagemusha status');
  const identity: LifecycleCandidateIdentityInput = {
    kind: 'lifecycle',
    eventId: observation.eventId,
    externalSourceId: observation.externalSourceId,
    channelPartition: observation.channelPartition,
    contentSha256: observation.contentSha256,
    operatorObservationSeq: observation.operatorObservationSeq,
    taskId: task.taskId,
    taskRevision: task.revision,
    bindingId: binding.bindingId,
    bindingRevision: binding.bindingRevision,
    proposedStatus,
  };
  return Object.freeze({
    ...observation,
    kind: 'lifecycle',
    candidateId: externalLifecycleCandidateId(identity),
    bindingId: binding.bindingId,
    bindingRevision: binding.bindingRevision,
    taskId: task.taskId,
    taskRevision: task.revision,
    proposedStatus,
  });
}

function parseStrictKagemushaMetadata(value: unknown): { taskId: number; status: string } | null {
  if (typeof value !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 3 || !keys.every((key) => ['taskId', 'status', 'rawConnector'].includes(key)))
    return null;
  if (
    !isPositiveSafeInteger(parsed.taskId) ||
    typeof parsed.status !== 'string' ||
    parsed.rawConnector !== 'kagemusha'
  )
    return null;
  return { taskId: parsed.taskId, status: parsed.status };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 1000;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function uniquePositiveTaskIds(ids: readonly number[] | undefined): Set<number> {
  return new Set((ids ?? []).filter((id) => Number.isSafeInteger(id) && id > 0));
}

function sameSet(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}
