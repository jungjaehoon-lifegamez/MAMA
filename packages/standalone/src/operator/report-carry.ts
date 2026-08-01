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
  closeSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 20;
const STALE_LOCK_MS = 30_000;
const UNAVAILABLE_REASONS = new Set(['no_run_handle', 'commit_failed', 'legacy_record']);

export function defaultCarryPath(): string {
  return join(homedir(), '.mama', 'operator', 'last-full-report.json');
}

export function buildCarryTemporaryPath(path: string): string {
  return join(dirname(path), `.last-full-report.${process.pid}.${randomUUID()}.tmp`);
}

export function buildCarryLockPath(path: string): string {
  return `${path}.lock`;
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

function sleepSynchronously(milliseconds: number): void {
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function processOwnsLock(pid: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) {
    return false;
  }
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    return !isErrno(error, 'ESRCH');
  }
}

function recoverStaleLock(lockPath: string): boolean {
  let before;
  try {
    before = lstatSync(lockPath);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return true;
    }
    throw new Error(`Unable to inspect report carry lock: ${formatError(error)}`);
  }
  if (!before.isFile() || Date.now() - before.mtimeMs < STALE_LOCK_MS) {
    return false;
  }

  let ownerPid: unknown;
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));
    ownerPid = isRecord(parsed) ? parsed.pid : undefined;
  } catch {
    // A stale malformed lock has no trustworthy live owner claim.
  }
  if (processOwnsLock(ownerPid)) {
    return false;
  }

  const current = lstatSync(lockPath);
  if (
    current.dev !== before.dev ||
    current.ino !== before.ino ||
    current.mtimeMs !== before.mtimeMs
  ) {
    return false;
  }
  try {
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return true;
    }
    throw new Error(`Unable to recover stale report carry lock: ${formatError(error)}`);
  }
}

function acquireLock(path: string): string {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = buildCarryLockPath(path);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
      fchmodSync(descriptor, 0o600);
      writeFileSync(
        descriptor,
        JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }),
        'utf8'
      );
      return lockPath;
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        descriptor = undefined;
        try {
          unlinkSync(lockPath);
        } catch (cleanupError) {
          if (!isErrno(cleanupError, 'ENOENT')) {
            throw new Error(
              `Unable to clean failed report carry lock after ${formatError(error)}: ${formatError(cleanupError)}`
            );
          }
        }
        throw new Error(`Unable to create report carry lock: ${formatError(error)}`);
      }
      if (!isErrno(error, 'EEXIST')) {
        throw new Error(`Unable to acquire report carry lock: ${formatError(error)}`);
      }
      if (recoverStaleLock(lockPath)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for report carry lock: ${lockPath}`);
      }
      sleepSynchronously(LOCK_RETRY_MS);
    } finally {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
    }
  }
}

function withReportCarryLock<T>(path: string, operation: () => T): T {
  const lockPath = acquireLock(path);
  let result: T | undefined;
  let operationError: unknown;
  let releaseError: unknown;
  try {
    result = operation();
  } catch (error) {
    operationError = error;
  } finally {
    try {
      unlinkSync(lockPath);
    } catch (error) {
      releaseError = error;
    }
  }
  if (releaseError !== undefined) {
    throw new Error(
      `Unable to release report carry lock after ${
        operationError === undefined ? 'operation' : formatError(operationError)
      }: ${formatError(releaseError)}`
    );
  }
  if (operationError !== undefined) {
    throw operationError;
  }
  return result as T;
}

/** @internal Atomic publisher used only while FileReportCarryStore owns its per-path lock. */
export function writeReportCarryAtomically(path: string, record: ReportCarryV2): void {
  if (!isReportCarryV2(record)) {
    throw new Error('Refusing to persist invalid report carry state');
  }
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = buildCarryTemporaryPath(path);
  let published = false;
  let operationError: unknown;
  let cleanupError: unknown;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
    published = true;
    chmodSync(path, 0o600);
  } catch (error) {
    operationError = error;
  } finally {
    if (!published) {
      try {
        unlinkSync(temporaryPath);
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) {
          cleanupError = error;
        }
      }
    }
  }
  if (cleanupError !== undefined) {
    throw new Error(
      `Unable to clean report carry temporary file after ${
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
    withReportCarryLock(this.path, () => {
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
    return withReportCarryLock(this.path, () => {
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
