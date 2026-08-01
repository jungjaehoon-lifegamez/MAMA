/**
 * TG-06: a delivered owner report is injected into exactly one intended
 * Telegram owner turn, and durable carry never revives after acknowledgement.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  FileReportCarryStore,
  writeReportCarryAtomically,
  type AckInput,
  type PersistDeliveredInput,
  type ReportCarryTarget,
  type ReportCarryV2,
} from '../../src/operator/report-carry.js';

const TARGET: ReportCarryTarget = { source: 'telegram', channelId: 'C1' };
const OTHER_TARGET: ReportCarryTarget = { source: 'telegram', channelId: 'C2' };
const DELIVERED_AT = '2026-08-02T00:00:00.000Z';
const RUN = { status: 'available' as const, modelRunId: 'mr_1' };

function tempCarryPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'mama-carry-')), 'last-full-report.json');
}

function input(overrides: Partial<PersistDeliveredInput> = {}): PersistDeliveredInput {
  return {
    deliveryId: 'd1',
    target: TARGET,
    deliveredAt: DELIVERED_AT,
    text: 'owner report',
    provenance: RUN,
    ...overrides,
  };
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface ChildResult {
  type: 'result';
  value: boolean | 'persisted';
}

interface CarryChild {
  child: ChildProcess;
  ready: Promise<void>;
  result: Promise<ChildResult>;
}

interface SQLiteLockChild {
  ready: Promise<void>;
  exited: Promise<number | null>;
}

function startSQLiteLockChild(path: string, crashAfterMs: number): SQLiteLockChild {
  const tsxCli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = `
    import Database from 'better-sqlite3';
    const database = new Database(process.env.MAMA_CARRY_DB_PATH);
    database.pragma('busy_timeout = 2000');
    database.pragma('journal_mode = DELETE');
    database.exec('BEGIN IMMEDIATE');
    process.stdout.write('ready\\n');
    setTimeout(() => process.exit(17), Number(process.env.MAMA_CARRY_CRASH_AFTER_MS));
  `;
  const child = spawn(process.execPath, [tsxCli, '--eval', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MAMA_CARRY_DB_PATH: `${path}.lock.sqlite`,
      MAMA_CARRY_CRASH_AFTER_MS: String(crashAfterMs),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = new Promise<void>((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('ready')) {
        resolve();
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 17) {
        reject(new Error(`SQLite lock child exited ${code}: ${stderr}`));
      }
    });
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on('close', resolve);
  });
  return { ready, exited };
}

function startCarryChild(
  operation: 'persist' | 'ack',
  path: string,
  payload: PersistDeliveredInput | AckInput,
  delayMs: number = 0
): CarryChild {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src/operator/report-carry.ts')).href;
  const tsxCli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = `
    import { FileReportCarryStore } from ${JSON.stringify(moduleUrl)};
    const store = new FileReportCarryStore(process.env.MAMA_CARRY_PATH);
    const payload = JSON.parse(process.env.MAMA_CARRY_PAYLOAD);
    process.stdout.write(JSON.stringify({ type: 'ready' }) + '\\n');
    const delayMs = Number(process.env.MAMA_CARRY_DELAY_MS || 0);
    const perform = () => {
      if (process.env.MAMA_CARRY_OPERATION === 'persist') {
        store.persistDelivered(payload);
        process.stdout.write(JSON.stringify({ type: 'result', value: 'persisted' }) + '\\n');
      } else {
        process.stdout.write(JSON.stringify({ type: 'result', value: store.acknowledge(payload) }) + '\\n');
      }
    };
    if (delayMs > 0) setTimeout(perform, delayMs); else perform();
  `;
  const child = spawn(process.execPath, [tsxCli, '--eval', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MAMA_CARRY_OPERATION: operation,
      MAMA_CARRY_PATH: path,
      MAMA_CARRY_PAYLOAD: JSON.stringify(payload),
      MAMA_CARRY_DELAY_MS: String(delayMs),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  let resolveResult: ((result: ChildResult) => void) | undefined;
  let rejectResult: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<ChildResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  void result.catch(() => undefined);
  let stdout = '';
  let stderr = '';
  let hasResult = false;
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    const lines = stdout.split('\n');
    stdout = lines.pop() ?? '';
    for (const line of lines) {
      const message = JSON.parse(line) as { type?: unknown; value?: unknown };
      if (message.type === 'ready') {
        resolveReady?.();
      }
      if (message.type === 'result') {
        hasResult = true;
        resolveResult?.(message as ChildResult);
      }
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on('error', (error) => {
    rejectReady?.(error);
    rejectResult?.(error);
  });
  child.on('close', (code) => {
    if (!hasResult) {
      const error = new Error(`carry child exited ${code}: ${stderr || stdout}`);
      rejectReady?.(error);
      rejectResult?.(error);
    }
  });
  return { child, ready, result };
}

async function settlesWithin(result: Promise<unknown>, milliseconds: number): Promise<boolean> {
  return Promise.race([
    result.then(
      () => true,
      () => true
    ),
    pause(milliseconds).then(() => false),
  ]);
}

describe('TG-06: versioned one-shot report carry', () => {
  it('peeks once for the exact unexpired Telegram chat and then acknowledges it', () => {
    const store = new FileReportCarryStore(tempCarryPath());
    const deliveredAt = new Date().toISOString();
    store.persistDelivered(input({ deliveredAt }));

    expect(store.peek(OTHER_TARGET, Date.parse(deliveredAt))).toBeNull();
    expect(
      store.peek(
        { source: 'discord', channelId: 'C1' } as unknown as ReportCarryTarget,
        Date.parse(deliveredAt)
      )
    ).toBeNull();
    expect(store.peek(TARGET, Date.parse(deliveredAt))?.deliveryId).toBe('d1');
    expect(
      store.acknowledge({
        deliveryId: 'd1',
        target: TARGET,
        consumingChannelKey: 'telegram:C1',
        consumedAtIso: '2026-08-02T00:01:00.000Z',
      })
    ).toBe(true);
    expect(store.peek(TARGET, Date.parse(deliveredAt))).toBeNull();
  });

  it('allows exactly the inclusive 24-hour boundary and refuses later carry', () => {
    const store = new FileReportCarryStore(tempCarryPath());
    store.persistDelivered(input());

    expect(store.peek(TARGET, Date.parse(DELIVERED_AT) + 24 * 60 * 60 * 1000)).not.toBeNull();
    expect(store.peek(TARGET, Date.parse(DELIVERED_AT) + 24 * 60 * 60 * 1000 + 1)).toBeNull();
  });

  it('never acknowledges an old delivery after a newer delivery replaces it', () => {
    const path = tempCarryPath();
    const store = new FileReportCarryStore(path);
    const deliveredAt = new Date().toISOString();
    store.persistDelivered(input({ deliveredAt }));
    store.persistDelivered(input({ deliveryId: 'd2', text: 'newer owner report' }));

    expect(
      store.acknowledge({
        deliveryId: 'd1',
        target: TARGET,
        consumingChannelKey: 'telegram:C1',
        consumedAtIso: '2026-08-02T00:01:00.000Z',
      })
    ).toBe(false);
    expect(store.peek(TARGET, Date.parse(DELIVERED_AT))?.deliveryId).toBe('d2');
  });

  it('does not revive a consumed carry when the same delivery is replayed', () => {
    const path = tempCarryPath();
    const store = new FileReportCarryStore(path);
    const deliveredAt = new Date().toISOString();
    store.persistDelivered(input({ deliveredAt }));
    store.acknowledge({
      deliveryId: 'd1',
      target: TARGET,
      consumingChannelKey: 'telegram:C1',
      consumedAtIso: '2026-08-02T00:01:00.000Z',
    });
    store.persistDelivered(input({ deliveredAt: '2026-08-02T00:05:00.000Z' }));

    expect(store.peek(TARGET, Date.parse(deliveredAt))).toBeNull();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      deliveredAt,
      consumedAt: '2026-08-02T00:01:00.000Z',
      consumingChannelKey: 'telegram:C1',
    });
  });

  it.each([
    ['text', input({ text: 'changed report' })],
    ['target', input({ target: OTHER_TARGET })],
    ['provenance', input({ provenance: { status: 'unavailable', reason: 'commit_failed' } })],
  ])('rejects a same-ID %s mismatch without changing persisted bytes', (_field, changed) => {
    const path = tempCarryPath();
    const store = new FileReportCarryStore(path);
    store.persistDelivered(input());
    const before = readFileSync(path);

    expect(() => store.persistDelivered(changed)).toThrow(/same delivery ID/i);
    expect(readFileSync(path)).toEqual(before);
  });

  it('fails closed with a warning for corrupt and legacy unscoped records', () => {
    const path = tempCarryPath();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      writeFileSync(path, '{not json');
      expect(new FileReportCarryStore(path).peek(TARGET, Date.parse(DELIVERED_AT))).toBeNull();
      writeFileSync(path, JSON.stringify({ deliveredAt: DELIVERED_AT, text: 'legacy' }));
      expect(new FileReportCarryStore(path).peek(TARGET, Date.parse(DELIVERED_AT))).toBeNull();
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('validates the closed provenance reasons before storing or injecting carry', () => {
    const path = tempCarryPath();
    const store = new FileReportCarryStore(path);
    const malformed = {
      ...input(),
      provenance: { status: 'unavailable' as const, reason: 'invented_reason' },
    } as unknown as PersistDeliveredInput;

    expect(() => store.persistDelivered(malformed)).toThrow(/provenance/i);
    expect(store.peek(TARGET, Date.parse(DELIVERED_AT))).toBeNull();
  });

  it('caps and wraps report content as untrusted in the injected prefix', () => {
    const store = new FileReportCarryStore(tempCarryPath());
    store.persistDelivered(input({ text: 'x'.repeat(5_000) }));

    const prefix = store.peek(TARGET, Date.parse(DELIVERED_AT))?.prefix ?? '';
    expect(prefix.length).toBeLessThan(1_600);
    expect(prefix).toContain('<<<UNTRUSTED-CONTENT source=operator-report-carry>>>');
    expect(prefix).toContain('truncated');
  });

  it('rejects unknown persist and acknowledgement fields before preserving carry bytes', () => {
    const path = tempCarryPath();
    const store = new FileReportCarryStore(path);
    store.persistDelivered(input());
    const before = readFileSync(path);
    const untrustedPersist = {
      ...input(),
      consumedAt: '2026-08-02T00:00:01.000Z',
      consumingChannelKey: 'telegram:C1',
      arbitrary: true,
    } as PersistDeliveredInput & {
      consumedAt: string;
      consumingChannelKey: string;
      arbitrary: boolean;
    };
    const untrustedAck = {
      deliveryId: 'd1',
      target: TARGET,
      consumingChannelKey: 'telegram:C1',
      consumedAtIso: '2026-08-02T00:01:00.000Z',
      arbitrary: true,
    } as AckInput & { arbitrary: boolean };

    expect(() => store.persistDelivered(untrustedPersist)).toThrow(/exact fields/i);
    expect(() => store.acknowledge(untrustedAck)).toThrow(/exact fields/i);
    expect(readFileSync(path)).toEqual(before);
  });

  it('uses a 0600 SQLite companion lock without leaving staging directories', () => {
    const path = tempCarryPath();
    new FileReportCarryStore(path).persistDelivered(input());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}.lock.sqlite`).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(path, '..')).filter((entry) => entry.endsWith('.stage'))).toEqual([]);
    expect(existsSync(`${path}.lock.sqlite-wal`)).toBe(false);
    expect(existsSync(`${path}.lock.sqlite-shm`)).toBe(false);
  });

  it('cleans its owned private staging directory after a real atomic rename failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-carry-'));
    const destination = join(root, 'destination');
    mkdirSync(destination);
    const record: ReportCarryV2 = { version: 2, ...input() };

    expect(() => writeReportCarryAtomically(destination, record)).toThrow();
    expect(readdirSync(root).filter((entry) => entry.endsWith('.stage'))).toEqual([]);
  });

  it('never deletes a foreign adjacent path while cleaning its owned staging directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-carry-'));
    const path = join(root, 'last-full-report.json');
    const foreignDirectory = join(root, '.last-full-report.foreign.stage');
    mkdirSync(foreignDirectory, { mode: 0o700 });
    const foreignTemporary = join(foreignDirectory, 'foreign.json');
    writeFileSync(foreignTemporary, 'foreign temporary bytes', { mode: 0o600 });
    const record: ReportCarryV2 = { version: 2, ...input() };

    writeReportCarryAtomically(path, record);
    expect(readFileSync(foreignTemporary, 'utf8')).toBe('foreign temporary bytes');
    expect(readdirSync(root).filter((entry) => entry.endsWith('.stage'))).toEqual([
      '.last-full-report.foreign.stage',
    ]);
  });

  it('releases a crashed SQLite transaction and serializes stale ack behind d2 across processes', async () => {
    const path = tempCarryPath();
    const store = new FileReportCarryStore(path);
    const deliveredAt = new Date().toISOString();
    store.persistDelivered(input({ deliveredAt }));
    const lockHolder = startSQLiteLockChild(path, 500);
    await lockHolder.ready;

    const persist = startCarryChild(
      'persist',
      path,
      input({ deliveryId: 'd2', deliveredAt, text: 'replacement report' })
    );
    await persist.ready;
    expect(await settlesWithin(persist.result, 100)).toBe(false);

    const acknowledgement = startCarryChild(
      'ack',
      path,
      {
        deliveryId: 'd1',
        target: TARGET,
        consumingChannelKey: 'telegram:C1',
        consumedAtIso: new Date().toISOString(),
      },
      750
    );
    await acknowledgement.ready;
    expect(await settlesWithin(acknowledgement.result, 100)).toBe(false);

    expect(await lockHolder.exited).toBe(17);
    expect((await persist.result).value).toBe('persisted');
    expect((await acknowledgement.result).value).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      deliveryId: 'd2',
      text: 'replacement report',
    });
    expect(existsSync(`${path}.lock`)).toBe(false);
  });
});
