import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootoutLaunchdService, launchdServiceLoaded } from '../../src/cli/commands/daemon.js';
import { runStatus, runStop, STATUS_STOPPED_EXIT } from '../../src/cli/commands/control.js';
import {
  acquireInstallLock,
  daemonControlPaths,
  startDaemonControl,
} from '../../src/cli/runtime/daemon-control.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawnSync: vi.fn(),
}));

const platform = process.platform;
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', { value: platform });
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function onPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value });
}

function launchctl(status: number, stdout = '') {
  vi.mocked(spawnSync).mockReturnValue({
    status,
    stdout,
    stderr: '',
    signal: null,
    pid: 1,
    output: [null, stdout, ''],
  });
}

describe('launchd service on macOS', () => {
  it('reads whether this user LaunchAgent is loaded and never calls launchctl elsewhere', () => {
    onPlatform('darwin');
    launchctl(0, 'service = {\n state = running\n}');
    expect(launchdServiceLoaded()).toBe(true);
    expect(spawnSync).toHaveBeenLastCalledWith(
      'launchctl',
      ['print', `gui/${process.getuid!()}/com.mama.server`],
      { encoding: 'utf8' }
    );
    launchctl(113);
    expect(launchdServiceLoaded()).toBe(false);
    launchctl(5);
    expect(() => launchdServiceLoaded()).toThrow('launchctl print failed');

    vi.mocked(spawnSync).mockClear();
    onPlatform('linux');
    expect(launchdServiceLoaded()).toBe(false);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('unloads the LaunchAgent and surfaces a failed bootout', () => {
    launchctl(0);
    bootoutLaunchdService();
    expect(spawnSync).toHaveBeenLastCalledWith(
      'launchctl',
      ['bootout', `gui/${process.getuid!()}/com.mama.server`],
      { encoding: 'utf8' }
    );
    launchctl(5);
    expect(() => bootoutLaunchdService()).toThrow('launchctl bootout failed');
  });
});

describe('mama status and mama stop without a service manager', () => {
  it('reports stopped with exit 3, and running with its turns and connectors', async () => {
    onPlatform('linux');
    const home = mkdtempSync(join(tmpdir(), 'mama-status-'));
    roots.push(home);
    const configPath = join(home, 'config.yaml');
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);
    expect(await runStatus([], { configPath, write })).toBe(STATUS_STOPPED_EXIT);
    expect(lines).toEqual(['stopped']);

    const paths = daemonControlPaths(home);
    const lock = acquireInstallLock(paths, 'daemon');
    let stopRequested = false;
    const server = await startDaemonControl(paths, {
      status: () => ({
        pid: 42,
        command: 'daemon',
        version: '0.0.0-fixture',
        startedAt: 0,
        stage: 'running',
        runningTurns: [{ session: 'owner:runtime', count: 1 }],
        inputs: [{ status: 'claimed', count: 1 }],
        connectors: [{ name: 'chatwork', healthy: false, lastPoll: null, error: 'room failed' }],
        lastError: null,
      }),
      stop: () => {
        stopRequested = true;
        void server.close().then(() => lock.release());
      },
    });
    lines.length = 0;
    expect(await runStatus([], { configPath, write })).toBe(0);
    expect(lines[0]).toMatch(/^running: daemon \(pid 42, version 0\.0\.0-fixture/);
    expect(lines).toContain('turns running: owner:runtime 1');
    expect(lines).toContain('inputs waiting: claimed 1');
    expect(lines).toContain('connector chatwork: failing, last poll not yet, error: room failed');

    lines.length = 0;
    expect(await runStop([], { configPath, write, pollMs: 10 })).toBe(0);
    expect(stopRequested).toBe(true);
    expect(lines).toEqual([
      '1 turn(s) running; they end with the stop and are requeued at the next start',
      'stopping',
      'stopped',
    ]);
    lines.length = 0;
    expect(await runStop([], { configPath, write })).toBe(0);
    expect(lines).toEqual(['already stopped']);
  });

  it('names the process holding the install when it is not a daemon', async () => {
    onPlatform('linux');
    const home = mkdtempSync(join(tmpdir(), 'mama-status-held-'));
    roots.push(home);
    const configPath = join(home, 'config.yaml');
    const lock = acquireInstallLock(daemonControlPaths(home), 'register-owner');
    const lines: string[] = [];
    expect(await runStatus([], { configPath, write: (line) => lines.push(line) })).toBe(
      STATUS_STOPPED_EXIT
    );
    expect(lines[0]).toMatch(/^stopped; register-owner \(pid \d+\) holds the install$/);
    lines.length = 0;
    expect(await runStop([], { configPath, write: (line) => lines.push(line) })).toBe(1);
    expect(lines[0]).toMatch(/^not stopped: register-owner \(pid \d+\) holds the install/);
    lock.release();
  });
});
