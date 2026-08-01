import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { isArtifactProvenance } from './report-carry.js';
import type { PreparedSituationReport, SituationReporterSnapshot } from './situation-report.js';

export interface PendingReportOccurrence {
  kind: 'digest' | 'scheduled_full' | 'on_demand_full';
  hourKey?: string;
  firedAtIso?: string;
}

export interface PendingReportDelivery extends PreparedSituationReport {
  deliveryId: string;
  occurrence: PendingReportOccurrence;
}

export interface PendingReportRequest {
  mode: 'full';
  deliveryId: string;
  occurrence: PendingReportOccurrence;
  acceptedAtIso: string;
}

export interface PendingReportState {
  version: 1;
  digest: SituationReporterSnapshot;
  full: SituationReporterSnapshot;
  delivery?: PendingReportDelivery;
  request?: PendingReportRequest;
}

export interface PendingReportStore {
  load(): PendingReportState | null;
  save(state: PendingReportState): void;
}

const MAX_PENDING_REPORT_BYTES = 8 * 1024 * 1024;
const MAX_CHANNELS = 48;
const MAX_FIRES = 100;
const MAX_RECALLED = 20;
const MAX_EVENT_KEYS = 10_000;

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
  return (
    record.mode === 'full' &&
    isNonEmptyBoundedString(record.deliveryId, 512) &&
    isNonEmptyBoundedString(record.acceptedAtIso, 64) &&
    isOnDemandFullOccurrence(record.occurrence)
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

function isFullOccurrence(value: unknown): boolean {
  return isScheduledFullOccurrence(value) || isOnDemandFullOccurrence(value);
}

function isScheduledFullOccurrence(value: unknown): boolean {
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

function isOnDemandFullOccurrence(value: unknown): boolean {
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

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength;
}

function isNonEmptyBoundedString(value: unknown, maxLength: number): value is string {
  return isBoundedString(value, maxLength) && value.trim().length > 0;
}

export class FilePendingReportStore implements PendingReportStore {
  constructor(
    private readonly path: string,
    private readonly log: (line: string) => void = () => {}
  ) {}

  load(): PendingReportState | null {
    if (!existsSync(this.path)) return null;
    const size = statSync(this.path).size;
    const raw = size <= MAX_PENDING_REPORT_BYTES ? readFileSync(this.path, 'utf8') : null;
    try {
      const parsed: unknown = raw === null ? null : JSON.parse(raw);
      if (!isPendingReportState(parsed, true)) {
        throw new Error(
          size > MAX_PENDING_REPORT_BYTES
            ? 'Pending operator report state exceeds its size limit'
            : 'Pending operator report state is invalid'
        );
      }
      return normalizeLegacyFullDelivery(parsed);
    } catch (error) {
      const quarantinePath = `${this.path}.corrupt-${Date.now()}-${process.pid}`;
      renameSync(this.path, quarantinePath);
      this.log(
        `[trigger-loop] invalid pending owner-report state quarantined at ${quarantinePath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  save(state: PendingReportState): void {
    if (!isPendingReportState(state, false)) {
      throw new Error('Refusing to persist invalid pending operator report state');
    }
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, this.path);
  }
}
