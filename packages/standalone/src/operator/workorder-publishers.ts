/**
 * Stage-2 workorder publishers: key/payload contracts for the system run paths
 * (dashboard/wiki/promotion, plus the reconcile leg) enqueued into the ledger.
 *
 * The workorder pipeline is the ONLY run path since v0.28.0. The former
 * MAMA_STAGE2_WORKORDERS tri-state (off = legacy persona runs, shadow = board
 * dual-run against a capture store) and the legacy executeValidatedRun paths
 * it gated were removed after the 2026-07-22 production cutover to 'on'
 * (migration plan: docs/superpowers/plans/2026-07-18-stage2-workorder-ownership.md).
 */

import type { WorkOrderKind } from './task-ledger.js';
import {
  EXTERNAL_LIFECYCLE_DIAGNOSTIC_CODES,
  EXTERNAL_LIFECYCLE_STATUSES,
  type BindingCandidate,
  type ExternalLifecycleDiagnostic,
  type LifecycleCandidate,
} from './external-lifecycle.js';
import {
  externalLifecycleCandidateId,
  kagemushaEvidenceSummary,
  KAGEMUSHA_LIFECYCLE_OBSERVED_STATUSES,
  mapKagemushaLifecycle,
  parseKagemushaExternalSourceId,
} from './external-lifecycle-candidates.js';
import { createHash } from 'node:crypto';

export const STAGE2_FLAG_ENV = 'MAMA_STAGE2_WORKORDERS';

/**
 * Boot guard for the retired flag. Unset or 'on' is fine (the pipeline always
 * runs); 'off'/'shadow' request the removed legacy behavior and must fail the
 * boot loudly (no-fallback: silently running the pipeline against an explicit
 * legacy pin would mask the operator's intent).
 */
export function assertStage2FlagCompatible(env: NodeJS.ProcessEnv = process.env): void {
  const raw = (env[STAGE2_FLAG_ENV] ?? '').trim();
  if (raw === '' || raw === 'on') return;
  throw new Error(
    `${STAGE2_FLAG_ENV}='${raw}' is no longer supported: legacy persona runs and shadow ` +
      `capture were removed in v0.28.0 (workorders are the only run path). Unset the ` +
      `variable or set it to 'on'.`
  );
}

// ── Occurrence keys (plan D5/M2) ──────────────────────────────────────────
// Keys identify one OCCURRENCE: same scheduled slot dedups against itself,
// the next slot (or any manual request) mints a fresh key. Terminal rows free
// their key (ledger index predicate), so retries insert fresh rows.

const BOARD_SLOT_MS = 30 * 60 * 1000;
const PROMOTION_SLOT_MS = 6 * 60 * 60 * 1000;

export function boardFullKey(now: number): string {
  return `board:full:${Math.floor(now / BOARD_SLOT_MS)}`;
}

/**
 * Enabled reconcile mode has one repair occurrence open at a time. TaskLedger
 * dedupes this key only while pending/in-progress; terminal rows release it so
 * a later dirty generation can reuse the same key.
 */
export function boardRepairKey(): string {
  return 'board:full:repair';
}

/** Manual/forced orders get their own key (plan M2): a forced refresh must
 *  never dedup against a pending scheduled FULL that lacks force. */
export function boardManualKey(now: number): string {
  return `board:manual:${now}`;
}

/**
 * Batch-deterministic key: a MAMA owner-event judgment that delegates carries
 * its inbox batch. The key remains reserved after terminal completion so a
 * post-enqueue/pre-ACK crash cannot order the same work twice.
 */
export function boardBatchKey(causeEventIds: readonly string[]): string {
  const digest = createHash('sha256')
    .update([...causeEventIds].sort().join('\n'))
    .digest('hex')
    .slice(0, 16);
  return `owner-event:board:${digest}`;
}

export function ownerEventWorkOrderKey(
  kind: 'wiki' | 'memory-curation',
  causeEventIds: readonly string[]
): string {
  const digest = createHash('sha256')
    .update([...causeEventIds].sort().join('\n'))
    .digest('hex')
    .slice(0, 16);
  return `owner-event:${kind}:${digest}`;
}

export function boardReconcileKey(channelKey: string, now: number): string {
  // Timestamp, not slot (PR bot round): distinct reconciles for one channel
  // can fire within a 30-min window carrying DIFFERENT deltas - a slot key
  // would dedup the later one against the open earlier row and drop its
  // delta. The ReconcileScheduler's debounce is the coalescing layer; each
  // scheduler fire is its own occurrence.
  return `board:reconcile:${channelKey}:${now}`;
}

export function wikiBatchKey(trigger: string, now: number): string {
  return `wiki:${now}-${trigger}`;
}

export function promotionKey(now: number): string {
  return `promotion:${Math.floor(now / PROMOTION_SLOT_MS)}`;
}

export function promotionManualKey(now: number): string {
  return `promotion:manual:${now}`;
}

// ── Payload schemas (plan G6) ─────────────────────────────────────────────

export interface BoardPayload {
  mode: 'full' | 'reconcile';
  /** Owner-forced refresh: brief must publish even on NO_UPDATE. */
  force?: boolean;
  /** Gate generation captured before enqueue. */
  repairGeneration?: number;
  /** Exact full-run contract_no_update scope: full:<repairGeneration>. */
  noUpdateScope?: string;
  channelKey?: string;
  readonly deltaLines?: readonly string[];
  /** The delta batch this reconcile rests on; becomes the cause of what it changes. */
  readonly eventIds?: readonly string[];
  /** Host-authored immutable candidates; reconcile-only. */
  readonly candidates?: {
    readonly bindingCandidates: readonly BindingCandidate[];
    readonly lifecycleCandidates: readonly LifecycleCandidate[];
    readonly diagnostics?: readonly ExternalLifecycleDiagnostic[];
  };
}

export interface WikiPayload {
  batchId: string;
  /** Trigger provenance; the run does its own novelty check, events carry no content. */
  events: string[];
}

export interface PromotionPayload {
  scheduledAt: string;
}

export interface TemporalPayload {
  generationKey: string;
  taskId: number;
  temporalEpoch: number;
  occurrenceKey: string;
  checkAt: number;
  sourceChannel: string | null;
  sourceEventId: string | null;
}

const PAYLOAD_KEYS: Record<WorkOrderKind, readonly string[]> = {
  board: [
    'mode',
    'force',
    'repairGeneration',
    'noUpdateScope',
    'channelKey',
    'deltaLines',
    'eventIds',
    'candidates',
  ],
  wiki: ['batchId', 'events'],
  'memory-curation': ['scheduledAt'],
  temporal: [
    'generationKey',
    'taskId',
    'temporalEpoch',
    'occurrenceKey',
    'checkAt',
    'sourceChannel',
    'sourceEventId',
  ],
};

/**
 * Validate a payload at enqueue time. Unknown fields are rejected LOUDLY -
 * a misspelled field silently dropped would surface as a wrong run later.
 * `attempts` is ledger-managed and is never valid publisher input.
 */
export function validateWorkOrderPayload(
  kind: WorkOrderKind,
  payload: Record<string, unknown>
): void {
  if (Object.prototype.hasOwnProperty.call(payload, 'attempts')) {
    throw new Error(`workorder payload (${kind}): attempts is ledger-managed`);
  }
  const allowed = PAYLOAD_KEYS[kind];
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) {
      throw new Error(`workorder payload (${kind}): unknown field '${key}'`);
    }
  }
  if (kind === 'board') {
    const mode = payload.mode;
    if (mode !== 'full' && mode !== 'reconcile') {
      throw new Error(
        `workorder payload (board): mode must be 'full'|'reconcile', got: ${String(mode)}`
      );
    }
    if (payload.force !== undefined && typeof payload.force !== 'boolean') {
      throw new Error(`workorder payload (board): force must be a boolean`);
    }
    if (
      payload.repairGeneration !== undefined &&
      (!Number.isSafeInteger(payload.repairGeneration) || (payload.repairGeneration as number) < 0)
    ) {
      throw new Error(
        `workorder payload (board): repairGeneration must be a non-negative safe integer`
      );
    }
    if (
      payload.eventIds !== undefined &&
      (!Array.isArray(payload.eventIds) ||
        payload.eventIds.some((id) => !isBoundedString(id)) ||
        new Set(payload.eventIds).size !== payload.eventIds.length)
    ) {
      throw new Error(
        `workorder payload (board): eventIds[] must contain unique 1-1000 character strings`
      );
    }
    if (mode === 'reconcile') {
      if (!isBoundedString(payload.channelKey)) {
        throw new Error(`workorder payload (board reconcile): channelKey required`);
      }
      if (!Array.isArray(payload.deltaLines) || payload.deltaLines.length === 0) {
        throw new Error(`workorder payload (board reconcile): non-empty deltaLines[] required`);
      }
      // Not required: a reconcile whose batch could not be determined still has to run.
      if (payload.candidates !== undefined)
        validateLifecycleCandidates(payload.candidates, payload.eventIds);
      if (payload.noUpdateScope !== undefined) {
        throw new Error(`workorder payload (board reconcile): noUpdateScope is full-only`);
      }
    } else if (
      payload.channelKey !== undefined ||
      payload.deltaLines !== undefined ||
      payload.candidates !== undefined
    ) {
      // Reconcile-only fields on a full run signal a caller bug - loud.
      throw new Error(`workorder payload (board full): channelKey/deltaLines are reconcile-only`);
    } else if (
      payload.repairGeneration !== undefined &&
      payload.noUpdateScope !== `full:${String(payload.repairGeneration)}`
    ) {
      throw new Error(
        `workorder payload (board full): noUpdateScope must equal full:<repairGeneration>`
      );
    } else if (payload.noUpdateScope !== undefined && payload.repairGeneration === undefined) {
      throw new Error(
        `workorder payload (board full): repairGeneration is required with noUpdateScope`
      );
    }
  } else if (kind === 'wiki') {
    if (typeof payload.batchId !== 'string' || payload.batchId === '') {
      throw new Error(`workorder payload (wiki): batchId required`);
    }
    if (
      !Array.isArray(payload.events) ||
      payload.events.some((entry) => typeof entry !== 'string')
    ) {
      throw new Error(`workorder payload (wiki): events[] of strings required`);
    }
  } else if (kind === 'memory-curation') {
    if (typeof payload.scheduledAt !== 'string' || payload.scheduledAt === '') {
      throw new Error(`workorder payload (memory-curation): scheduledAt required`);
    }
  } else {
    const boundedString = (field: 'generationKey' | 'occurrenceKey', max: number): void => {
      const value = payload[field];
      if (typeof value !== 'string' || value.length < 1 || value.length > max) {
        throw new Error(`workorder payload (temporal): ${field} must contain 1-${max} characters`);
      }
    };
    boundedString('generationKey', 500);
    boundedString('occurrenceKey', 300);
    if (!Number.isSafeInteger(payload.taskId) || (payload.taskId as number) < 1) {
      throw new Error(`workorder payload (temporal): taskId must be a positive integer`);
    }
    if (!Number.isSafeInteger(payload.temporalEpoch) || (payload.temporalEpoch as number) < 0) {
      throw new Error(`workorder payload (temporal): temporalEpoch must be a non-negative integer`);
    }
    if (!Number.isSafeInteger(payload.checkAt)) {
      throw new Error(`workorder payload (temporal): checkAt must be an epoch millisecond integer`);
    }
    for (const field of ['sourceChannel', 'sourceEventId'] as const) {
      const value = payload[field];
      if (value !== null && (typeof value !== 'string' || value.length < 1 || value.length > 300)) {
        throw new Error(`workorder payload (temporal): ${field} must be null or 1-300 characters`);
      }
    }
  }
}

function validateLifecycleCandidates(value: unknown, eventIds: unknown): void {
  if (
    !isPlainObject(value) ||
    !(
      exactKeys(value, ['bindingCandidates', 'lifecycleCandidates']) ||
      exactKeys(value, ['bindingCandidates', 'lifecycleCandidates', 'diagnostics'])
    )
  ) {
    throw new Error(
      'workorder payload (board reconcile): candidates contain unknown or missing candidate fields'
    );
  }
  if (
    !Array.isArray(value.bindingCandidates) ||
    !Array.isArray(value.lifecycleCandidates) ||
    (value.diagnostics !== undefined && !Array.isArray(value.diagnostics))
  ) {
    throw new Error('workorder payload (board reconcile): candidate lists required');
  }
  const allowedEventIds = new Set(Array.isArray(eventIds) ? eventIds : []);
  const candidateIds = new Set<string>();
  for (const candidate of [...value.bindingCandidates, ...value.lifecycleCandidates]) {
    validateLifecycleCandidate(candidate, allowedEventIds, candidateIds);
  }
  const diagnostics = value.diagnostics ?? [];
  if (diagnostics.length > 100) {
    throw new Error('workorder payload (board reconcile): diagnostics are bounded to 100 entries');
  }
  for (const diagnostic of diagnostics) {
    if (!isPlainObject(diagnostic) || !exactKeys(diagnostic, ['eventId', 'code'])) {
      throw new Error(
        'workorder payload (board reconcile): diagnostic has unknown or missing fields'
      );
    }
    if (!isBoundedString(diagnostic.eventId)) {
      throw new Error('workorder payload (board reconcile): diagnostic eventId must be bounded');
    }
    if (
      typeof diagnostic.code !== 'string' ||
      !EXTERNAL_LIFECYCLE_DIAGNOSTIC_CODES.some((code) => code === diagnostic.code)
    ) {
      throw new Error('workorder payload (board reconcile): diagnostic code is invalid');
    }
  }
}

function validateLifecycleCandidate(
  value: unknown,
  eventIds: ReadonlySet<unknown>,
  candidateIds: Set<string>
): void {
  if (!isPlainObject(value))
    throw new Error('workorder payload (board reconcile): candidate must be an object');
  const kind = value.kind;
  const common = [
    'kind',
    'candidateId',
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
    'taskId',
    'taskRevision',
  ];
  const keys =
    kind === 'binding' ? common : [...common, 'bindingId', 'bindingRevision', 'proposedStatus'];
  if ((kind !== 'binding' && kind !== 'lifecycle') || !exactKeys(value, keys)) {
    throw new Error('workorder payload (board reconcile): candidate has unknown or missing fields');
  }
  for (const key of [
    'candidateId',
    'eventId',
    'externalSourceId',
    'channelPartition',
    'observedStatus',
    'evidenceSummary',
  ] as const) {
    if (!isBoundedString(value[key]))
      throw new Error(
        `workorder payload (board reconcile): candidate ${key} must contain 1-1000 characters`
      );
  }
  if (value.connector !== 'kagemusha' || value.sourceType !== 'kanban_card')
    throw new Error(
      'workorder payload (board reconcile): candidate connector/source type is invalid'
    );
  if (typeof value.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.contentSha256))
    throw new Error(
      'workorder payload (board reconcile): candidate contentSha256 must be sha256 hex'
    );
  for (const key of [
    'sourceTimestampMs',
    'operatorIngestSeq',
    'operatorObservationSeq',
    'taskId',
    'taskRevision',
  ] as const) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 1)
      throw new Error(
        `workorder payload (board reconcile): candidate ${key} must be a positive safe integer`
      );
  }
  if (
    typeof value.observedStatus !== 'string' ||
    !KAGEMUSHA_LIFECYCLE_OBSERVED_STATUSES.includes(value.observedStatus as never)
  ) {
    throw new Error('workorder payload (board reconcile): candidate observedStatus is invalid');
  }
  const externalSourceId = value.externalSourceId as string;
  const taskId = value.taskId as number;
  const taskRevision = value.taskRevision as number;
  const evidenceSummary = kagemushaEvidenceSummary(
    parseKagemushaExternalSourceId(externalSourceId),
    value.observedStatus,
    value.sourceTimestampMs
  );
  if (evidenceSummary === null || value.evidenceSummary !== evidenceSummary) {
    throw new Error(
      'workorder payload (board reconcile): candidate evidenceSummary must be host-derived'
    );
  }
  const eventId = value.eventId as string;
  const candidateId = value.candidateId as string;
  if (!eventIds.has(eventId))
    throw new Error('workorder payload (board reconcile): candidate eventId must be in eventIds');
  if (candidateIds.has(candidateId))
    throw new Error('workorder payload (board reconcile): unique candidate IDs required');
  if (kind === 'lifecycle') {
    for (const key of ['bindingId', 'bindingRevision'] as const) {
      if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 1)
        throw new Error(
          `workorder payload (board reconcile): candidate ${key} must be a positive safe integer`
        );
    }
    if (
      typeof value.proposedStatus !== 'string' ||
      !EXTERNAL_LIFECYCLE_STATUSES.includes(value.proposedStatus as never)
    )
      throw new Error('workorder payload (board reconcile): candidate proposedStatus is invalid');
    const mappedStatus = mapKagemushaLifecycle(value.observedStatus);
    if (mappedStatus === null || value.proposedStatus !== mappedStatus) {
      throw new Error(
        'workorder payload (board reconcile): candidate proposedStatus must match observedStatus'
      );
    }
  }
  const expectedCandidateId =
    kind === 'binding'
      ? externalLifecycleCandidateId({
          kind,
          eventId,
          externalSourceId,
          channelPartition: value.channelPartition as string,
          contentSha256: value.contentSha256 as string,
          operatorObservationSeq: value.operatorObservationSeq as number,
          taskId,
          taskRevision,
        })
      : externalLifecycleCandidateId({
          kind,
          eventId,
          externalSourceId,
          channelPartition: value.channelPartition as string,
          contentSha256: value.contentSha256 as string,
          operatorObservationSeq: value.operatorObservationSeq as number,
          taskId,
          taskRevision,
          bindingId: value.bindingId as number,
          bindingRevision: value.bindingRevision as number,
          proposedStatus: value.proposedStatus as (typeof EXTERNAL_LIFECYCLE_STATUSES)[number],
        });
  if (candidateId !== expectedCandidateId) {
    throw new Error(
      'workorder payload (board reconcile): candidateId does not match canonical identity'
    );
  }
  candidateIds.add(candidateId);
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
