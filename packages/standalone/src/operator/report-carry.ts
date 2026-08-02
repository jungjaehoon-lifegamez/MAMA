/**
 * TG-06 one-shot owner-report carry.
 *
 * The report itself is durable data, but this derived context must only reach
 * the Telegram chat that received it and only until its first durable owner
 * turn acknowledgement. Invalid state is deliberately not repaired here: it
 * cannot safely be attributed to a target or delivery.
 */

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { wrapUntrustedContent } from '../utils/untrusted-content.js';
import { withFileCoordinationTransaction } from './file-coordination.js';

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
const STAGING_DIRECTORY_ATTEMPTS = 8;
const UNAVAILABLE_REASONS = new Set(['no_run_handle', 'commit_failed', 'legacy_record']);

export function defaultCarryPath(): string {
  return join(homedir(), '.mama', 'operator', 'last-full-report.json');
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

/** Exact persisted provenance contract shared by report composition and outbox recovery. */
export function isArtifactProvenance(value: unknown): value is ArtifactProvenance {
  if (!isRecord(value)) {
    return false;
  }
  if (value.status === 'available') {
    return (
      hasOnlyKeys(value, ['status', 'modelRunId']) &&
      isNonEmptyString(value.modelRunId) &&
      value.modelRunId.trim() === value.modelRunId &&
      value.modelRunId.length <= 512
    );
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
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ['deliveryId', 'target', 'deliveredAt', 'text', 'provenance'])
  ) {
    throw new Error('Report carry persist input must contain exact fields');
  }
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
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ['deliveryId', 'target', 'consumingChannelKey', 'consumedAtIso'])
  ) {
    throw new Error('Report carry acknowledgement input must contain exact fields');
  }
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

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function createStagingDirectory(path: string): string {
  const directory = dirname(path);
  const stem = basename(path);
  for (let attempt = 0; attempt < STAGING_DIRECTORY_ATTEMPTS; attempt += 1) {
    const stagingDirectory = join(directory, `.${stem}.${process.pid}.${randomUUID()}.stage`);
    try {
      mkdirSync(stagingDirectory, { mode: 0o700 });
      chmodSync(stagingDirectory, 0o700);
      return stagingDirectory;
    } catch (error) {
      if (isErrno(error, 'EEXIST')) {
        continue;
      }
      throw new Error(`Unable to create report carry staging directory: ${formatError(error)}`);
    }
  }
  throw new Error('Unable to allocate unique report carry staging directory');
}

/** @internal Atomic publisher used only while FileReportCarryStore owns its SQLite transaction. */
export function writeReportCarryAtomically(path: string, record: ReportCarryV2): void {
  if (!isReportCarryV2(record)) {
    throw new Error('Refusing to persist invalid report carry state');
  }
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let stagingDirectory: string | undefined;
  let payloadPath: string | undefined;
  let ownsPayload = false;
  let published = false;
  let operationError: unknown;
  let cleanupError: unknown;
  try {
    stagingDirectory = createStagingDirectory(path);
    payloadPath = join(stagingDirectory, `${randomUUID()}.json`);
    writeFileSync(payloadPath, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    ownsPayload = true;
    chmodSync(payloadPath, 0o600);
    renameSync(payloadPath, path);
    published = true;
    chmodSync(path, 0o600);
  } catch (error) {
    operationError = error;
  } finally {
    if (ownsPayload && !published && payloadPath !== undefined) {
      try {
        unlinkSync(payloadPath);
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) {
          cleanupError = error;
        }
      }
    }
    if (stagingDirectory !== undefined) {
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
      `Unable to clean report carry staging directory after ${
        operationError === undefined ? 'publish' : formatError(operationError)
      }: ${formatError(cleanupError)}`
    );
  }
  if (operationError !== undefined) {
    throw operationError;
  }
}

export class FileReportCarryStore implements ReportCarryPort {
  constructor(private readonly path: string = defaultCarryPath()) {}

  persistDelivered(input: PersistDeliveredInput): void {
    assertPersistInput(input);
    withFileCoordinationTransaction(this.path, 'report carry', () => {
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

      writeReportCarryAtomically(this.path, {
        version: 2,
        deliveryId: input.deliveryId,
        target: { ...input.target },
        deliveredAt: input.deliveredAt,
        text: input.text,
        provenance: { ...input.provenance },
      });
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
    return withFileCoordinationTransaction(this.path, 'report carry', () => {
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
      writeReportCarryAtomically(this.path, {
        ...current.record,
        consumedAt: input.consumedAtIso,
        consumingChannelKey: input.consumingChannelKey,
      });
      return true;
    });
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
  private warn(message: string): void {
    console.warn(`[report-carry] ${message}; refusing to inject ${this.path}`);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
