/**
 * `mama logs` prints the daemon log's last lines and, with --follow, keeps printing across a
 * rotation.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLogs } from '../../src/cli/commands/logs.js';
import { rotateLogFile } from '../../src/runtime/rotating-log.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function install(): { home: string; log: string } {
  const home = mkdtempSync(join(tmpdir(), 'mama-logs-'));
  roots.push(home);
  const root = join(home, '.mama');
  mkdirSync(join(root, 'logs'), { recursive: true });
  const log = join(root, 'logs', 'daemon.log');
  writeFileSync(
    join(root, 'config.yaml'),
    JSON.stringify({
      version: 1,
      agent: { backend: 'claude', model: 'fixture', max_turns: 10, timeout: 1000 },
      database: { path: join(root, 'memory.db') },
      logging: { level: 'info', file: log },
    })
  );
  return { home, log };
}

describe('mama logs', () => {
  it('prints the last lines', async () => {
    const { home, log } = install();
    writeFileSync(log, 'one\ntwo\nthree\n');
    let out = '';
    await runLogs(['-n', '2'], { home, write: (text) => (out += text) });
    expect(out).toBe('two\nthree\n');
  });

  it('follows the log across a rotation', async () => {
    const { home, log } = install();
    writeFileSync(log, 'before\n');
    let out = '';
    const controller = new AbortController();
    const following = runLogs(['-n', '0', '--follow'], {
      home,
      write: (text) => (out += text),
      signal: controller.signal,
      pollMs: 10,
    });
    appendFileSync(log, 'written\n');
    await vi.waitFor(() => expect(out).toBe('written\n'));
    rotateLogFile(log, 3);
    writeFileSync(log, 'after rotation\n');
    await vi.waitFor(() => expect(out).toBe('written\nafter rotation\n'));
    controller.abort();
    await following;
  });

  it('says when the daemon has not written its log yet', async () => {
    const { home, log } = install();
    await expect(runLogs([], { home })).rejects.toThrow(`${log} does not exist yet`);
  });

  it('shows its usage for an argument it does not take', async () => {
    const { home } = install();
    await expect(runLogs(['--lines'], { home })).rejects.toThrow('Usage: mama logs');
    await expect(runLogs(['-n', 'x'], { home })).rejects.toThrow('Usage: mama logs');
  });
});
