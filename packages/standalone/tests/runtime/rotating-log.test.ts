/**
 * Logs rotate by size: no line is lost or repeated across a rotation, archives are compressed and
 * capped in number, and every file stays owner-only.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  archivePath,
  openRotatingLog,
  rotateBeforeWrite,
  takeOverOutput,
} from '../../src/runtime/rotating-log.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function logPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'mama-rotating-log-'));
  roots.push(root);
  return join(root, 'daemon.log');
}

/** Every line the archives and the file hold, oldest first. */
function allLines(path: string, keep: number): string[] {
  const parts: string[] = [];
  for (let n = keep; n >= 1; n -= 1) {
    if (existsSync(archivePath(path, n))) {
      parts.push(gunzipSync(readFileSync(archivePath(path, n))).toString('utf8'));
    }
  }
  if (existsSync(path)) parts.push(readFileSync(path, 'utf8'));
  return parts.join('').split('\n').filter(Boolean);
}

const line = (n: number) => `line ${String(n).padStart(4, '0')} ${'x'.repeat(40)}\n`;

describe('a rotating log', () => {
  it('keeps every line, in order, across rotations, compressed and owner-only', () => {
    const path = logPath();
    const limits = { maxBytes: 1000, keep: 10 };
    const log = openRotatingLog(path, limits);
    // About three times the limit: three rotations.
    for (let n = 0; n < 60; n += 1) log.write(line(n));
    log.close();

    expect(existsSync(archivePath(path, 1))).toBe(true);
    expect(existsSync(archivePath(path, 2))).toBe(true);
    expect(allLines(path, limits.keep)).toEqual(
      Array.from({ length: 60 }, (_, n) => line(n).trimEnd())
    );
    expect(statSync(path).size).toBeLessThanOrEqual(limits.maxBytes);
    for (const file of [path, archivePath(path, 1), archivePath(path, 2)]) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps only the newest archives', () => {
    const path = logPath();
    const log = openRotatingLog(path, { maxBytes: 500, keep: 2 });
    for (let n = 0; n < 100; n += 1) log.write(line(n));
    log.close();

    expect(existsSync(archivePath(path, 3))).toBe(false);
    const kept = allLines(path, 2);
    // The newest lines, contiguous and ending with the last one written.
    expect(kept.at(-1)).toBe(line(99).trimEnd());
    const first = Number(kept[0]!.split(' ')[1]);
    expect(kept).toEqual(Array.from({ length: 100 - first }, (_, n) => line(first + n).trimEnd()));
  });

  it('rotates a file that is already past the limit when it opens, tightening it', () => {
    const path = logPath();
    writeFileSync(path, 'y'.repeat(2000), { mode: 0o644 });
    const log = openRotatingLog(path, { maxBytes: 1000, keep: 3 });
    log.write('after\n');
    log.close();
    expect(gunzipSync(readFileSync(archivePath(path, 1))).toString('utf8')).toBe('y'.repeat(2000));
    expect(readFileSync(path, 'utf8')).toBe('after\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('rotates an appended file before a line would take it past the limit', () => {
    const path = logPath();
    writeFileSync(path, 'z'.repeat(900));
    rotateBeforeWrite(path, 50, { maxBytes: 1000, keep: 3 });
    expect(existsSync(archivePath(path, 1))).toBe(false);
    rotateBeforeWrite(path, 200, { maxBytes: 1000, keep: 3 });
    expect(existsSync(path)).toBe(false);
    expect(gunzipSync(readFileSync(archivePath(path, 1))).toString('utf8')).toBe('z'.repeat(900));
  });

  it("sends a process's stream writes to the log", () => {
    const path = logPath();
    const log = openRotatingLog(path, { maxBytes: 10_000, keep: 2 });
    const stdout = { write: (() => false) as (...args: never[]) => boolean };
    const stderr = { write: (() => false) as (...args: never[]) => boolean };
    takeOverOutput(log, [stdout, stderr]);
    let called = 0;
    const out = stdout.write as unknown as (
      chunk: string | Uint8Array,
      encoding?: unknown,
      done?: () => void
    ) => boolean;
    const err = stderr.write as unknown as (chunk: string | Uint8Array) => boolean;
    expect(out('first\n', 'utf8', () => (called += 1))).toBe(true);
    err(Buffer.from('second\n'));
    out('third\n', () => (called += 1));
    log.close();
    expect(readFileSync(path, 'utf8')).toBe('first\nsecond\nthird\n');
    expect(called).toBe(2);
  });
});
