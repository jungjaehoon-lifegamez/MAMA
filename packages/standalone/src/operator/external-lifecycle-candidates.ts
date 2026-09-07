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

const KAGEMUSHA_METADATA_REQUIRED_KEYS = ['taskId', 'status', 'rawConnector'] as const;
const KAGEMUSHA_METADATA_OPTIONAL_KEYS = [
  'priority',
  'deadline',
  'sourceRoom',
  'autoCreated',
] as const;
const KAGEMUSHA_METADATA_KEYS = new Set<string>([
  ...KAGEMUSHA_METADATA_REQUIRED_KEYS,
  ...KAGEMUSHA_METADATA_OPTIONAL_KEYS,
]);
const KAGEMUSHA_TASK_PRIORITIES: readonly string[] = ['urgent', 'high', 'normal', 'low'];

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
  readonly candidate_id: string;
  readonly decision: 'bind' | 'decline' | 'apply' | 'retain';
  readonly reason: string;
  readonly expected_revision: number;
}

export interface ClassifiedKagemushaObservation {
  readonly observation: ExternalObservationSnapshot | null;
  readonly diagnostic: ExternalLifecycleDiagnostic | null;
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
  return classifyKagemushaObservation(row).observation;
}

/**
 * Classifies one untrusted database row once, so callers can preserve a
 * bounded per-event diagnostic without re-parsing connector content.
 */
export function classifyKagemushaObservation(
  row: RawExternalObservation
): ClassifiedKagemushaObservation {
  const eventId = diagnosticEventId(row.event_index_id);
  const contentSha256 = normalizeContentSha256(row.content_hash);
  if (row.source_connector !== 'kagemusha') {
    return classified(null, { eventId, code: 'unsupported_connector' });
  }
  if (row.source_type !== 'kanban_card') {
    return classified(null, { eventId, code: 'unsupported_source_type' });
  }
  if (
    !isBoundedString(row.event_index_id) ||
    !isBoundedString(row.source_id) ||
    !isBoundedString(row.channel) ||
    contentSha256 === null ||
    !isIsoRenderableTimestamp(row.source_timestamp_ms) ||
    !isPositiveSafeInteger(row.operator_ingest_seq) ||
    !isPositiveSafeInteger(row.operator_observation_seq)
  ) {
    return classified(null, { eventId, code: 'malformed_metadata' });
  }
  const metadata = parseStrictKagemushaMetadata(row.metadata_json);
  if (!metadata || parseKagemushaExternalSourceId(row.source_id) !== metadata.taskId) {
    return classified(null, { eventId, code: 'malformed_metadata' });
  }
  if (!mapKagemushaLifecycle(metadata.status)) {
    return classified(null, { eventId, code: 'unknown_status' });
  }
  const evidenceSummary = kagemushaEvidenceSummary(
    metadata.taskId,
    metadata.status,
    row.source_timestamp_ms
  );
  if (evidenceSummary === null) {
    return classified(null, { eventId, code: 'malformed_metadata' });
  }

  return classified(
    Object.freeze({
      eventId,
      connector: 'kagemusha',
      sourceType: 'kanban_card',
      externalSourceId: row.source_id,
      channelPartition: row.channel,
      contentSha256,
      sourceTimestampMs: row.source_timestamp_ms,
      operatorIngestSeq: row.operator_ingest_seq,
      operatorObservationSeq: row.operator_observation_seq,
      observedStatus: metadata.status,
      evidenceSummary,
    })
  );
}

function normalizeContentSha256(value: unknown): string | null {
  if (typeof value === 'string') {
    return HEX_SHA256.test(value) ? value.toLowerCase() : null;
  }
  if (value instanceof Uint8Array && value.byteLength === 32) {
    return Buffer.from(value).toString('hex');
  }
  return null;
}

/** Parses the only source identity accepted for private Kagemusha card evidence. */
export function parseKagemushaExternalSourceId(value: unknown): number | null {
  if (!isBoundedString(value)) return null;
  const match = /^task:([1-9][0-9]*)$/.exec(value);
  if (!match) return null;
  const taskId = Number(match[1]);
  return isPositiveSafeInteger(taskId) ? taskId : null;
}

/** Returns the sole permitted summary; malformed inputs cannot render arbitrary prose. */
export function kagemushaEvidenceSummary(
  taskId: unknown,
  observedStatus: unknown,
  sourceTimestampMs: unknown
): string | null {
  if (
    !isPositiveSafeInteger(taskId) ||
    typeof observedStatus !== 'string' ||
    !mapKagemushaLifecycle(observedStatus) ||
    !isIsoRenderableTimestamp(sourceTimestampMs)
  ) {
    return null;
  }
  return `Kagemusha task ${taskId} reported ${observedStatus} at ${new Date(sourceTimestampMs).toISOString()}`;
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

const OBSERVATION_KEYS = [
  'eventId',
  'connector',
  'sourceType',
  'externalSourceId',
  'channelPartition',
  'contentSha256',
  'sourceTimestampMs',
  'operatorIngestSeq',
  'operatorObservationSeq',
  'observedStatus',
  'evidenceSummary',
] as const;
const BINDING_CANDIDATE_KEYS = [
  ...OBSERVATION_KEYS,
  'kind',
  'candidateId',
  'taskId',
  'taskRevision',
];
const LIFECYCLE_CANDIDATE_KEYS = [
  ...BINDING_CANDIDATE_KEYS,
  'bindingId',
  'bindingRevision',
  'proposedStatus',
];

/**
 * Canonical bytes for one host-built candidate: sorted keys, no extras. The
 * attestation store keeps exactly these bytes and their sha256.
 */
export function canonicalExternalLifecycleCandidateJson(
  candidate: BindingCandidate | LifecycleCandidate
): string {
  const keys = candidate.kind === 'binding' ? BINDING_CANDIDATE_KEYS : LIFECYCLE_CANDIDATE_KEYS;
  const ordered: Record<string, unknown> = {};
  for (const key of [...keys].sort()) {
    ordered[key] = (candidate as unknown as Record<string, unknown>)[key];
  }
  return JSON.stringify(ordered);
}

/**
 * Strictly re-validate a candidate that came from storage or from a caller.
 *
 * Bytes are not a capability because they sit in a database: the exact key
 * set, every field type, the Kagemusha status mapping, the fixed evidence
 * summary and the content-derived candidate id are all recomputed. A
 * model-authored or edited snapshot fails here before any decision runs.
 */
export function parseHostBuiltExternalLifecycleCandidate(
  kind: 'binding' | 'lifecycle',
  value: unknown
): BindingCandidate | LifecycleCandidate {
  if (!isPlainObject(value)) {
    throw new Error(`external lifecycle ${kind} candidate must be an object`);
  }
  const keys = kind === 'binding' ? BINDING_CANDIDATE_KEYS : LIFECYCLE_CANDIDATE_KEYS;
  if (!exactKeys(value, keys)) {
    throw new Error(`external lifecycle ${kind} candidate has unknown or missing fields`);
  }
  if (value.kind !== kind) {
    throw new Error(`external lifecycle candidate has the wrong kind (expected ${kind})`);
  }
  if (
    value.connector !== 'kagemusha' ||
    value.sourceType !== 'kanban_card' ||
    !isBoundedString(value.eventId) ||
    !isBoundedString(value.externalSourceId) ||
    !isBoundedString(value.channelPartition) ||
    typeof value.contentSha256 !== 'string' ||
    !HEX_SHA256.test(value.contentSha256) ||
    value.contentSha256 !== value.contentSha256.toLowerCase() ||
    !isIsoRenderableTimestamp(value.sourceTimestampMs) ||
    !isPositiveSafeInteger(value.operatorIngestSeq) ||
    !isPositiveSafeInteger(value.operatorObservationSeq) ||
    !isBoundedString(value.observedStatus) ||
    typeof value.candidateId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.candidateId) ||
    !isPositiveSafeInteger(value.taskId) ||
    !Number.isSafeInteger(value.taskRevision) ||
    (value.taskRevision as number) < 0
  ) {
    throw new Error(`external lifecycle ${kind} candidate has malformed host fields`);
  }
  const taskId = parseKagemushaExternalSourceId(value.externalSourceId);
  if (taskId === null || !mapKagemushaLifecycle(value.observedStatus)) {
    throw new Error(`external lifecycle ${kind} candidate has malformed source identity`);
  }
  const evidenceSummary = kagemushaEvidenceSummary(
    taskId,
    value.observedStatus,
    value.sourceTimestampMs
  );
  if (evidenceSummary === null || value.evidenceSummary !== evidenceSummary) {
    throw new Error(`external lifecycle ${kind} candidate evidence summary is not host-derived`);
  }
  const observation: ExternalObservationSnapshot = {
    eventId: value.eventId,
    connector: 'kagemusha',
    sourceType: 'kanban_card',
    externalSourceId: value.externalSourceId,
    channelPartition: value.channelPartition,
    contentSha256: value.contentSha256,
    sourceTimestampMs: value.sourceTimestampMs,
    operatorIngestSeq: value.operatorIngestSeq,
    operatorObservationSeq: value.operatorObservationSeq,
    observedStatus: value.observedStatus,
    evidenceSummary,
  };
  let candidate: BindingCandidate | LifecycleCandidate;
  if (kind === 'binding') {
    candidate = Object.freeze({
      ...observation,
      kind: 'binding',
      candidateId: value.candidateId,
      taskId: value.taskId,
      taskRevision: value.taskRevision as number,
    });
  } else {
    if (
      !isPositiveSafeInteger(value.bindingId) ||
      !isPositiveSafeInteger(value.bindingRevision) ||
      typeof value.proposedStatus !== 'string' ||
      !(EXTERNAL_LIFECYCLE_STATUS_SET as ReadonlySet<string>).has(value.proposedStatus) ||
      mapKagemushaLifecycle(value.observedStatus) !== value.proposedStatus
    ) {
      throw new Error('external lifecycle candidate has malformed binding or status fields');
    }
    candidate = Object.freeze({
      ...observation,
      kind: 'lifecycle',
      candidateId: value.candidateId,
      taskId: value.taskId,
      taskRevision: value.taskRevision as number,
      bindingId: value.bindingId,
      bindingRevision: value.bindingRevision,
      proposedStatus: value.proposedStatus as ExternalLifecycleStatus,
    });
  }
  const expectedId = externalLifecycleCandidateId(
    candidate.kind === 'binding'
      ? {
          kind: 'binding',
          eventId: candidate.eventId,
          externalSourceId: candidate.externalSourceId,
          channelPartition: candidate.channelPartition,
          contentSha256: candidate.contentSha256,
          operatorObservationSeq: candidate.operatorObservationSeq,
          taskId: candidate.taskId,
          taskRevision: candidate.taskRevision,
        }
      : {
          kind: 'lifecycle',
          eventId: candidate.eventId,
          externalSourceId: candidate.externalSourceId,
          channelPartition: candidate.channelPartition,
          contentSha256: candidate.contentSha256,
          operatorObservationSeq: candidate.operatorObservationSeq,
          taskId: candidate.taskId,
          taskRevision: candidate.taskRevision,
          bindingId: candidate.bindingId,
          bindingRevision: candidate.bindingRevision,
          proposedStatus: candidate.proposedStatus,
        }
  );
  if (expectedId !== candidate.candidateId) {
    throw new Error(
      `external lifecycle ${kind} candidate id does not derive from its content (not host-built)`
    );
  }
  return candidate;
}

const EXTERNAL_LIFECYCLE_STATUS_SET: ReadonlySet<ExternalLifecycleStatus> = new Set([
  'pending',
  'in_progress',
  'review',
  'done',
  'cancelled',
]);

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
  if (!isPlainObject(parsed)) {
    return null;
  }
  const keys = Object.keys(parsed);
  if (
    !KAGEMUSHA_METADATA_REQUIRED_KEYS.every((key) => hasOwn(parsed, key)) ||
    !keys.every((key) => KAGEMUSHA_METADATA_KEYS.has(key))
  ) {
    return null;
  }
  if (
    !isPositiveSafeInteger(parsed.taskId) ||
    !isBoundedString(parsed.status) ||
    parsed.rawConnector !== 'kagemusha'
  ) {
    return null;
  }
  if (
    hasOwn(parsed, 'priority') &&
    (typeof parsed.priority !== 'string' || !KAGEMUSHA_TASK_PRIORITIES.includes(parsed.priority))
  ) {
    return null;
  }
  if (
    hasOwn(parsed, 'deadline') &&
    parsed.deadline !== null &&
    !isIsoRenderableTimestamp(parsed.deadline)
  ) {
    return null;
  }
  if (
    hasOwn(parsed, 'sourceRoom') &&
    parsed.sourceRoom !== null &&
    !isBoundedString(parsed.sourceRoom)
  ) {
    return null;
  }
  if (hasOwn(parsed, 'autoCreated') && typeof parsed.autoCreated !== 'boolean') {
    return null;
  }
  return { taskId: parsed.taskId, status: parsed.status };
}

function classified(
  observation: ExternalObservationSnapshot | null,
  diagnostic: ExternalLifecycleDiagnostic | null = null
): ClassifiedKagemushaObservation {
  return Object.freeze({
    observation,
    diagnostic: diagnostic === null ? null : Object.freeze(diagnostic),
  });
}

function diagnosticEventId(value: unknown): string {
  return isBoundedString(value) ? value : 'invalid_event';
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

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 1000;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isIsoRenderableTimestamp(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) > 0 &&
    (value as number) <= 8_640_000_000_000_000
  );
}

function uniquePositiveTaskIds(ids: readonly number[] | undefined): Set<number> {
  return new Set((ids ?? []).filter((id) => Number.isSafeInteger(id) && id > 0));
}

function sameSet(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}
