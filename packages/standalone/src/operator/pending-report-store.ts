import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import { isArtifactProvenance, type ReportCarryTarget } from './report-carry.js';
import { withFileCoordinationTransaction } from './file-coordination.js';
import type { PreparedSituationReport, SituationReporterSnapshot } from './situation-report.js';

export interface PendingReportOccurrence {
  kind: 'digest' | 'scheduled_full' | 'on_demand_full';
  hourKey?: string;
  firedAtIso?: string;
}

export interface PendingReportDelivery extends PreparedSituationReport {
  deliveryId: string;
  occurrence: PendingReportOccurrence;
  target: ReportCarryTarget;
  payloadIdentity: string;
}

export interface PendingReportRequest {
  mode: 'full';
  deliveryId: string;
  occurrence: PendingReportOccurrence;
  acceptedAtIso: string;
  target: ReportCarryTarget;
  payloadIdentity: string;
}

export interface PendingReportState {
  version: 1;
  digest: SituationReporterSnapshot;
  full: SituationReporterSnapshot;
  delivery?: PendingReportDelivery;
  request?: PendingReportRequest;
}

export interface PendingReportEmptyOutcome {
  status: 'empty';
  revision: null;
}

export interface PendingReportQuarantinedOutcome {
  status: 'quarantined';
}

export interface PendingReportReadyOutcome {
  status: 'ready';
  /** SHA-256 of the exact validated source bytes used for a later CAS save. */
  revision: string;
  state: PendingReportState;
}

export type PendingReportLoadOutcome =
  | PendingReportEmptyOutcome
  | PendingReportQuarantinedOutcome
  | PendingReportReadyOutcome;

export type PendingReportSaveExpectation = PendingReportEmptyOutcome | PendingReportReadyOutcome;

export interface PendingReportStore {
  /** One transactionally consistent durable read, including any quarantine decision. */
  loadOutcome?(): PendingReportLoadOutcome;
  load(): PendingReportState | null;
  /**
   * A quarantined outbox is distinct from an absent outbox: callers must not
   * replace an operation whose persisted intent could not be safely decoded.
   */
  loadStatus?(): 'empty' | 'ready' | 'quarantined';
  save(state: PendingReportState, expected?: PendingReportSaveExpectation): void;
  /** Explicit operator/API repair for a quarantined outbox. */
  recoverWithValidState?(state: PendingReportState): void;
}

const MAX_PENDING_REPORT_BYTES = 8 * 1024 * 1024;
const MAX_CHANNELS = 48;
const MAX_FIRES = 100;
const MAX_RECALLED = 20;
const MAX_EVENT_KEYS = 10_000;

interface PendingReportRequestIdentityInput {
  mode: 'full';
  deliveryId: string;
  occurrence: PendingReportOccurrence;
  acceptedAtIso: string;
  target: ReportCarryTarget;
}

interface PendingReportDeliveryIdentityInput {
  deliveryId: string;
  text: string;
  target: ReportCarryTarget;
}

function reportTargetIdentity(target: ReportCarryTarget): string {
  return JSON.stringify([target.source, target.channelId]);
}

function occurrenceIdentity(occurrence: PendingReportOccurrence): string {
  return JSON.stringify([
    occurrence.kind,
    occurrence.hourKey ?? null,
    occurrence.firedAtIso ?? null,
  ]);
}

export function pendingReportRequestPayloadIdentity(
  request: PendingReportRequestIdentityInput
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'pending-report-request-v1',
        request.mode,
        request.deliveryId,
        request.acceptedAtIso,
        occurrenceIdentity(request.occurrence),
        reportTargetIdentity(request.target),
      ])
    )
    .digest('hex');
}

export function pendingReportDeliveryPayloadIdentity(
  delivery: PendingReportDeliveryIdentityInput
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'pending-report-delivery-v1',
        delivery.deliveryId,
        reportTargetIdentity(delivery.target),
        delivery.text,
      ])
    )
    .digest('hex');
}

function isPendingReportState(
  value: unknown,
  allowLegacyFullProvenance: boolean
): value is PendingReportState {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return false;
  for (const key of ['digest', 'full']) {
    const snapshot = record[key];
    if (!snapshot || typeof snapshot !== 'object') return false;
    const fields = snapshot as Record<string, unknown>;
    if (!isSituationSnapshot(fields)) {
      return false;
    }
  }
  if (record.delivery !== undefined && record.request !== undefined) {
    return false;
  }
  return (
    (record.delivery === undefined ||
      isPendingDelivery(record.delivery, allowLegacyFullProvenance)) &&
    (record.request === undefined || isPendingRequest(record.request))
  );
}

function isPendingRequest(value: unknown): value is PendingReportRequest {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (
    !(
      record.mode === 'full' &&
      isNonEmptyBoundedString(record.deliveryId, 512) &&
      isNonEmptyBoundedString(record.acceptedAtIso, 64) &&
      isOnDemandFullOccurrence(record.occurrence) &&
      isReportTarget(record.target) &&
      isSha256Identity(record.payloadIdentity)
    )
  ) {
    return false;
  }
  return (
    record.payloadIdentity ===
    pendingReportRequestPayloadIdentity({
      mode: 'full',
      deliveryId: record.deliveryId,
      acceptedAtIso: record.acceptedAtIso,
      occurrence: record.occurrence,
      target: record.target,
    })
  );
}

function isPendingDelivery(
  value: unknown,
  allowLegacyFullProvenance: boolean
): value is PendingReportDelivery {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const sharedValid =
    (record.mode === 'digest' || record.mode === 'full') &&
    isBoundedString(record.text, 1_000_000) &&
    isNonEmptyBoundedString(record.deliveryId, 512) &&
    isNonEmptyBoundedString(record.createdAtIso, 64) &&
    Array.isArray(record.citedTriggerIds) &&
    record.citedTriggerIds.length <= MAX_FIRES &&
    record.citedTriggerIds.every((item) => isNonEmptyBoundedString(item, 512));
  if (!sharedValid) {
    return false;
  }
  if (
    !isReportTarget(record.target) ||
    !isSha256Identity(record.payloadIdentity) ||
    record.payloadIdentity !==
      pendingReportDeliveryPayloadIdentity({
        deliveryId: record.deliveryId as string,
        text: record.text as string,
        target: record.target,
      })
  ) {
    return false;
  }
  if (record.mode === 'digest') {
    return record.provenance === undefined && isDigestOccurrence(record.occurrence);
  }
  return (
    isFullOccurrence(record.occurrence) &&
    (isArtifactProvenance(record.provenance) ||
      (allowLegacyFullProvenance && record.provenance === undefined))
  );
}

function isDigestOccurrence(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.kind === 'digest' && Object.keys(record).length === 1;
}

function isFullOccurrence(value: unknown): value is PendingReportOccurrence {
  return isScheduledFullOccurrence(value) || isOnDemandFullOccurrence(value);
}

function isScheduledFullOccurrence(value: unknown): value is PendingReportOccurrence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    record.kind === 'scheduled_full' &&
    (keys.length === 2 || keys.length === 3) &&
    keys.includes('kind') &&
    keys.includes('hourKey') &&
    isNonEmptyBoundedString(record.hourKey, 128) &&
    (record.firedAtIso === undefined || isNonEmptyBoundedString(record.firedAtIso, 64))
  );
}

function isOnDemandFullOccurrence(value: unknown): value is PendingReportOccurrence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    record.kind === 'on_demand_full' &&
    (keys.length === 2 || keys.length === 3) &&
    keys.includes('kind') &&
    keys.includes('firedAtIso') &&
    isNonEmptyBoundedString(record.firedAtIso, 64) &&
    (record.hourKey === undefined || isNonEmptyBoundedString(record.hourKey, 128))
  );
}

function normalizeLegacyFullDelivery(state: PendingReportState): PendingReportState {
  if (state.delivery?.mode === 'full' && state.delivery.provenance === undefined) {
    state.delivery.provenance = { status: 'unavailable', reason: 'legacy_record' };
  }
  return state;
}

function isSituationSnapshot(fields: Record<string, unknown>): boolean {
  if (
    fields.version !== 1 ||
    !isSafeCount(fields.windowTotal) ||
    !isSafeCount(fields.authored) ||
    !Array.isArray(fields.channels) ||
    fields.channels.length > MAX_CHANNELS ||
    !Array.isArray(fields.fires) ||
    fields.fires.length > MAX_FIRES ||
    !Array.isArray(fields.recalled) ||
    fields.recalled.length > MAX_RECALLED ||
    (fields.eventKeys !== undefined &&
      (!Array.isArray(fields.eventKeys) ||
        fields.eventKeys.length > MAX_EVENT_KEYS ||
        !fields.eventKeys.every((item) => isBoundedString(item, 1_024))))
  ) {
    return false;
  }
  return (
    fields.channels.every(isChannelSnapshot) &&
    fields.fires.every(isFireSnapshot) &&
    fields.recalled.every(isRecalledSnapshot)
  );
}

function isChannelSnapshot(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    isBoundedString(record.channelId, 512) &&
    isSafeCount(record.count) &&
    Array.isArray(record.excerpts) &&
    record.excerpts.length <= 5 &&
    record.excerpts.every((item) => isBoundedString(item, 160))
  );
}

function isFireSnapshot(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    isBoundedString(record.triggerId, 512) &&
    isBoundedString(record.kind, 512) &&
    isBoundedString(record.channelId, 512) &&
    isSafeCount(record.count) &&
    Array.isArray(record.topics) &&
    record.topics.length <= MAX_RECALLED &&
    record.topics.every((item) => isBoundedString(item, 512))
  );
}

function isRecalledSnapshot(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return isBoundedString(record.topic, 512) && isBoundedString(record.content, 160);
}

function isSafeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isReportTarget(value: unknown): value is ReportCarryTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    record.source === 'telegram' &&
    isNonEmptyBoundedString(record.channelId, 512) &&
    record.channelId.trim() === record.channelId
  );
}

function isSha256Identity(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength;
}

function isNonEmptyBoundedString(value: unknown, maxLength: number): value is string {
  return isBoundedString(value, maxLength) && value.trim().length > 0;
}

function revisionFor(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function writeTextAtomically(path: string, text: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stagingDirectory = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.stage`
  );
  let payloadPath: string | undefined;
  let ownsStagingDirectory = false;
  let published = false;
  let operationError: unknown;
  let cleanupError: unknown;
  try {
    mkdirSync(stagingDirectory, { mode: 0o700 });
    ownsStagingDirectory = true;
    chmodSync(stagingDirectory, 0o700);
    payloadPath = join(stagingDirectory, `${randomUUID()}.json`);
    writeFileSync(payloadPath, text, { mode: 0o600, flag: 'wx' });
    chmodSync(payloadPath, 0o600);
    renameSync(payloadPath, path);
    published = true;
    chmodSync(path, 0o600);
  } catch (error) {
    operationError = error;
  } finally {
    if (!published && payloadPath !== undefined) {
      try {
        unlinkSync(payloadPath);
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) {
          cleanupError = error;
        }
      }
    }
    if (ownsStagingDirectory) {
      try {
        rmdirSync(stagingDirectory);
      } catch (error) {
        if (!isErrno(error, 'ENOENT') && cleanupError === undefined) {
          cleanupError = error;
        }
      }
    }
  }
  if (cleanupError !== undefined) {
    throw new Error(
      `Unable to clean pending owner-report staging directory: ${
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      }`
    );
  }
  if (operationError !== undefined) {
    throw operationError;
  }
}

interface PendingReportStoreTestHooks {
  /** Test-only synchronous barrier after invalid bytes are read but before marker+move. */
  afterInvalidReadBeforeQuarantine?: () => void;
}

export class FilePendingReportStore implements PendingReportStore {
  constructor(
    private readonly path: string,
    private readonly log: (line: string) => void = () => {},
    private readonly testHooks?: PendingReportStoreTestHooks
  ) {}

  private quarantineMarkerPath(): string {
    return `${this.path}.quarantined`;
  }

  loadStatus(): 'empty' | 'ready' | 'quarantined' {
    return this.loadOutcome().status;
  }

  loadOutcome(): PendingReportLoadOutcome {
    return withFileCoordinationTransaction(this.path, 'pending owner-report state', () =>
      this.readOutcomeInsideTransaction()
    );
  }

  load(): PendingReportState | null {
    const outcome = this.loadOutcome();
    return outcome.status === 'ready' ? outcome.state : null;
  }

  save(state: PendingReportState, expected?: PendingReportSaveExpectation): void {
    if (!isPendingReportState(state, false)) {
      throw new Error('Refusing to persist invalid pending operator report state');
    }
    withFileCoordinationTransaction(this.path, 'pending owner-report state', () => {
      const current = this.readOutcomeInsideTransaction();
      if (current.status === 'quarantined') {
        throw new Error('Pending owner-report state is quarantined; explicit recovery is required');
      }
      if (
        expected !== undefined &&
        (current.status !== expected.status || current.revision !== expected.revision)
      ) {
        throw new Error('Pending owner-report state changed before normal save');
      }
      writeTextAtomically(this.path, `${JSON.stringify(state)}\n`);
    });
  }

  recoverWithValidState(state: PendingReportState): void {
    if (!isPendingReportState(state, false)) {
      throw new Error('Refusing to recover pending owner-report state with invalid data');
    }
    withFileCoordinationTransaction(this.path, 'pending owner-report state', () => {
      writeTextAtomically(this.path, `${JSON.stringify(state)}\n`);
      const markerPath = this.quarantineMarkerPath();
      if (existsSync(markerPath)) {
        unlinkSync(markerPath);
      }
    });
  }

  private readOutcomeInsideTransaction(): PendingReportLoadOutcome {
    if (existsSync(this.quarantineMarkerPath())) {
      this.log(
        `[trigger-loop] pending owner-report state remains quarantined at ${this.quarantineMarkerPath()}`
      );
      return { status: 'quarantined' };
    }
    if (!existsSync(this.path)) {
      return { status: 'empty', revision: null };
    }
    const size = statSync(this.path).size;
    const raw = size <= MAX_PENDING_REPORT_BYTES ? readFileSync(this.path, 'utf8') : null;
    try {
      if (raw === null) {
        throw new Error('Pending operator report state exceeds its size limit');
      }
      const parsed: unknown = JSON.parse(raw);
      if (!isPendingReportState(parsed, true)) {
        throw new Error(
          size > MAX_PENDING_REPORT_BYTES
            ? 'Pending operator report state exceeds its size limit'
            : 'Pending operator report state is invalid'
        );
      }
      return {
        status: 'ready',
        revision: revisionFor(raw),
        state: normalizeLegacyFullDelivery(parsed),
      };
    } catch (error) {
      const quarantinePath = `${this.path}.corrupt-${Date.now()}-${process.pid}-${randomUUID()}`;
      const reason = error instanceof Error ? error.message : String(error);
      this.testHooks?.afterInvalidReadBeforeQuarantine?.();
      writeTextAtomically(
        this.quarantineMarkerPath(),
        `${JSON.stringify({ version: 1, quarantinePath, reason })}\n`
      );
      renameSync(this.path, quarantinePath);
      this.log(
        `[trigger-loop] invalid pending owner-report state quarantined at ${quarantinePath}: ${reason}`
      );
      return { status: 'quarantined' };
    }
  }
}
