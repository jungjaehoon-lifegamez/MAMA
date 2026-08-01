/**
 * TG-06 one-shot owner-report carry.
 *
 * The report itself is durable data, but this derived context must only reach
 * the Telegram chat that received it and only until its first durable owner
 * turn acknowledgement. Invalid state is deliberately not repaired here: it
 * cannot safely be attributed to a target or delivery.
 */

import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { wrapUntrustedContent } from '../utils/untrusted-content.js';

export type ArtifactProvenance =
  | { status: 'available'; modelRunId: string }
  | { status: 'unavailable'; reason: 'no_run_handle' | 'commit_failed' | 'legacy_record' };

export interface ReportCarryTarget {
  source: 'telegram';
  channelId: string;
}

export interface ReportCarryV2 {
  version: 2;
  deliveryId: string;
  target: ReportCarryTarget;
  deliveredAt: string;
  text: string;
  provenance: ArtifactProvenance;
  consumedAt?: string;
  consumingChannelKey?: string;
}

export interface ReportCarryPeek {
  deliveryId: string;
  prefix: string;
}

export interface PersistDeliveredInput {
  deliveryId: string;
  target: ReportCarryTarget;
  deliveredAt: string;
  text: string;
  provenance: ArtifactProvenance;
}

export interface AckInput {
  deliveryId: string;
  target: ReportCarryTarget;
  consumingChannelKey: string;
  consumedAtIso: string;
}

export interface ReportCarryPort {
  peek(target: ReportCarryTarget, nowMs?: number): ReportCarryPeek | null;
  acknowledge(input: AckInput): boolean;
}

interface ReadMissing {
  kind: 'missing';
}

interface ReadInvalid {
  kind: 'invalid';
}

interface ReadRecord {
  kind: 'record';
  record: ReportCarryV2;
}

type ReadResult = ReadMissing | ReadInvalid | ReadRecord;

const CARRY_SUMMARY_MAX_CHARS = 700;
const CARRY_TTL_MS = 24 * 60 * 60 * 1000;
const UNAVAILABLE_REASONS = new Set(['no_run_handle', 'commit_failed', 'legacy_record']);

export function defaultCarryPath(): string {
  return join(homedir(), '.mama', 'operator', 'last-full-report.json');
}

export function buildCarryTemporaryPath(path: string): string {
  return join(dirname(path), `.last-full-report.${process.pid}.${randomUUID()}.tmp`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && actualKeys.every((key) => keys.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isTarget(value: unknown): value is ReportCarryTarget {
  if (!isRecord(value) || !hasOnlyKeys(value, ['source', 'channelId'])) {
    return false;
  }
  return value.source === 'telegram' && isNonEmptyString(value.channelId);
}

function isArtifactProvenance(value: unknown): value is ArtifactProvenance {
  if (!isRecord(value)) {
    return false;
  }
  if (value.status === 'available') {
    return hasOnlyKeys(value, ['status', 'modelRunId']) && isNonEmptyString(value.modelRunId);
  }
  return (
    value.status === 'unavailable' &&
    hasOnlyKeys(value, ['status', 'reason']) &&
    typeof value.reason === 'string' &&
    UNAVAILABLE_REASONS.has(value.reason)
  );
}

function isReportCarryV2(value: unknown): value is ReportCarryV2 {
  if (!isRecord(value)) {
    return false;
  }
  const consumedFieldsPresent =
    value.consumedAt !== undefined || value.consumingChannelKey !== undefined;
  const expectedKeys = consumedFieldsPresent
    ? [
        'version',
        'deliveryId',
        'target',
        'deliveredAt',
        'text',
        'provenance',
        'consumedAt',
        'consumingChannelKey',
      ]
    : ['version', 'deliveryId', 'target', 'deliveredAt', 'text', 'provenance'];
  return (
    hasOnlyKeys(value, expectedKeys) &&
    value.version === 2 &&
    isNonEmptyString(value.deliveryId) &&
    isTarget(value.target) &&
    isIsoTimestamp(value.deliveredAt) &&
    typeof value.text === 'string' &&
    isArtifactProvenance(value.provenance) &&
    (!consumedFieldsPresent ||
      (isIsoTimestamp(value.consumedAt) && isNonEmptyString(value.consumingChannelKey)))
  );
}

function sameTarget(left: ReportCarryTarget, right: ReportCarryTarget): boolean {
  return left.source === right.source && left.channelId === right.channelId;
}

function sameProvenance(left: ArtifactProvenance, right: ArtifactProvenance): boolean {
  if (left.status !== right.status) {
    return false;
  }
  if (left.status === 'available' && right.status === 'available') {
    return left.modelRunId === right.modelRunId;
  }
  if (left.status === 'unavailable' && right.status === 'unavailable') {
    return left.reason === right.reason;
  }
  return false;
}

function assertPersistInput(input: PersistDeliveredInput): void {
  if (!isNonEmptyString(input.deliveryId)) {
    throw new Error('Report carry deliveryId must be a non-empty string');
  }
  if (!isTarget(input.target)) {
    throw new Error('Report carry target must be an exact Telegram target');
  }
  if (!isIsoTimestamp(input.deliveredAt)) {
    throw new Error('Report carry deliveredAt must be an ISO timestamp');
  }
  if (typeof input.text !== 'string') {
    throw new Error('Report carry text must be a string');
  }
  if (!isArtifactProvenance(input.provenance)) {
    throw new Error('Report carry provenance is invalid');
  }
}

function assertAckInput(input: AckInput): void {
  if (!isNonEmptyString(input.deliveryId) || !isTarget(input.target)) {
    throw new Error('Report carry acknowledgement has an invalid delivery target');
  }
  if (!isNonEmptyString(input.consumingChannelKey) || !isIsoTimestamp(input.consumedAtIso)) {
    throw new Error('Report carry acknowledgement is invalid');
  }
}

function isActive(record: ReportCarryV2, nowMs: number): boolean {
  const age = nowMs - Date.parse(record.deliveredAt);
  return age >= 0 && age <= CARRY_TTL_MS;
}

function buildPrefix(record: ReportCarryV2): string {
  const summary =
    record.text.length > CARRY_SUMMARY_MAX_CHARS
      ? `${record.text.slice(0, CARRY_SUMMARY_MAX_CHARS)}\n[... truncated - full text was delivered to the owner channel]`
      : record.text;
  return (
    `[Operator context] The last FULL situation report was delivered at ${record.deliveredAt}.\n` +
    'If the owner asks for a report or current status, reference/refresh THIS instead of ' +
    `reconstructing state from memory. Content:\n${wrapUntrustedContent(
      'operator-report-carry',
      summary
    )}\n---\n`
  );
}

export class FileReportCarryStore implements ReportCarryPort {
  constructor(private readonly path: string = defaultCarryPath()) {}

  persistDelivered(input: PersistDeliveredInput): void {
    assertPersistInput(input);
    const current = this.read();
    if (current.kind === 'invalid') {
      throw new Error('Refusing to overwrite invalid report carry state');
    }
    if (current.kind === 'record' && current.record.deliveryId === input.deliveryId) {
      const record = current.record;
      if (
        !sameTarget(record.target, input.target) ||
        record.text !== input.text ||
        !sameProvenance(record.provenance, input.provenance)
      ) {
        throw new Error('Refusing same delivery ID with mismatched report carry content');
      }
      return;
    }

    this.write({
      version: 2,
      deliveryId: input.deliveryId,
      target: { ...input.target },
      deliveredAt: input.deliveredAt,
      text: input.text,
      provenance: { ...input.provenance },
    });
  }

  peek(target: ReportCarryTarget, nowMs: number = Date.now()): ReportCarryPeek | null {
    if (!isTarget(target) || !Number.isFinite(nowMs)) {
      return null;
    }
    const current = this.read();
    if (
      current.kind !== 'record' ||
      current.record.consumedAt !== undefined ||
      !sameTarget(current.record.target, target) ||
      !isActive(current.record, nowMs)
    ) {
      return null;
    }
    return { deliveryId: current.record.deliveryId, prefix: buildPrefix(current.record) };
  }

  acknowledge(input: AckInput): boolean {
    assertAckInput(input);
    const current = this.read();
    if (
      current.kind !== 'record' ||
      current.record.consumedAt !== undefined ||
      !sameTarget(current.record.target, input.target) ||
      current.record.deliveryId !== input.deliveryId ||
      !isActive(current.record, Date.now())
    ) {
      return false;
    }
    this.write({
      ...current.record,
      consumedAt: input.consumedAtIso,
      consumingChannelKey: input.consumingChannelKey,
    });
    return true;
  }

  private read(): ReadResult {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') {
        return { kind: 'missing' };
      }
      this.warn(`could not read carry state: ${formatError(error)}`);
      return { kind: 'invalid' };
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isReportCarryV2(parsed)) {
        throw new Error('carry state is not an exact version 2 record');
      }
      return { kind: 'record', record: parsed };
    } catch (error) {
      this.warn(`invalid carry state: ${formatError(error)}`);
      return { kind: 'invalid' };
    }
  }

  private write(record: ReportCarryV2): void {
    if (!isReportCarryV2(record)) {
      throw new Error('Refusing to persist invalid report carry state');
    }
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = buildCarryTemporaryPath(this.path);
    writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, this.path);
    chmodSync(this.path, 0o600);
  }

  private warn(message: string): void {
    console.warn(`[report-carry] ${message}; refusing to inject ${this.path}`);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Deprecated compatibility surfaces remain fail-closed until callers move to
 * the target-scoped ReportCarryPort in the following integration task.
 */
export interface LastFullReport {
  deliveredAt: string;
  text: string;
  provenance: ArtifactProvenance;
}

export function persistLastFullReport(
  _deliveredAtIso: string,
  _text: string,
  _provenance: ArtifactProvenance,
  _path: string = defaultCarryPath()
): never {
  throw new Error(
    'Unscoped report carry is unsupported; use FileReportCarryStore.persistDelivered'
  );
}

export function loadLastFullReport(_path: string = defaultCarryPath()): null {
  console.warn('[report-carry] unscoped legacy carry load refused');
  return null;
}

export function buildReportCarryPrefix(_path: string = defaultCarryPath()): string {
  console.warn('[report-carry] unscoped legacy carry prefix refused');
  return '';
}
