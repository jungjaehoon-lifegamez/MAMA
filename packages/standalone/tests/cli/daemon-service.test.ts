import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootoutLaunchdService, launchdService } from '../../src/cli/commands/daemon.js';
import { runStatus, runStop, STATUS_STOPPED_EXIT } from '../../src/cli/commands/control.js';
import {
  acquireInstallLock,
  daemonControlPaths,
  startDaemonControl,
  type InstallLock,
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

function home(prefix: string): { home: string; configPath: string } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return { home: path, configPath: join(path, 'config.yaml') };
}

describe('launchd service on macOS', () => {
  it('reads the LaunchAgent and its pid, and never calls launchctl elsewhere', () => {
    onPlatform('darwin');
    launchctl(0, 'service = {\n\tstate = running\n\tpid = 4242\n}');
    expect(launchdService()).toEqual({ loaded: true, pid: 4242 });
    expect(spawnSync).toHaveBeenLastCalledWith(
      'launchctl',
      ['print', `gui/${process.getuid!()}/com.mama.server`],
      { encoding: 'utf8' }
    );
    launchctl(0, 'service = {\n\tstate = waiting\n}');
    expect(launchdService()).toEqual({ loaded: true, pid: null });
    launchctl(113);
    expect(launchdService()).toEqual({ loaded: false, pid: null });
    launchctl(5);
    expect(() => launchdService()).toThrow('launchctl print failed');

    vi.mocked(spawnSync).mockClear();
    onPlatform('linux');
    expect(launchdService()).toEqual({ loaded: false, pid: null });
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

describe('mama status', () => {
  it('reports stopped with exit 3, and running with its turns and connectors', async () => {
    onPlatform('linux');
    const { home: root, configPath } = home('mama-status-');
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);
    expect(await runStatus([], { configPath, write })).toBe(STATUS_STOPPED_EXIT);
    expect(lines).toEqual(['stopped']);

    const paths = daemonControlPaths(root);
    const lock = acquireInstallLock(paths, 'daemon');
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
      stop: () => {},
    });
    lines.length = 0;
    expect(await runStatus([], { configPath, write })).toBe(0);
    expect(lines[0]).toMatch(/^running: daemon \(pid 42, version 0\.0\.0-fixture/);
    expect(lines).toContain('turns running: owner:runtime 1');
    expect(lines).toContain('inputs waiting: claimed 1');
    expect(lines).toContain('connector chatwork: failing, last poll not yet, error: room failed');
    await server.close();
    lock.release();
  });

  it('names a non-daemon command that holds the install', async () => {
    onPlatform('linux');
    const { home: root, configPath } = home('mama-status-held-');
    const lock = acquireInstallLock(daemonControlPaths(root), 'register-owner');
    const lines: string[] = [];
    expect(await runStatus([], { configPath, write: (line) => lines.push(line) })).toBe(
      STATUS_STOPPED_EXIT
    );
    expect(lines[0]).toMatch(/^stopped; register-owner \(pid \d+\) holds the install$/);
    lock.release();
  });
});

describe('mama stop', () => {
  async function servedDaemon(root: string, onStop: (lock: InstallLock) => void) {
    const paths = daemonControlPaths(root);
    const lock = acquireInstallLock(paths, 'daemon');
    const server = await startDaemonControl(paths, {
      status: () => ({}),
      stop: () => onStop(lock),
    });
    return { paths, lock, server };
  }

  it('asks the daemon through its socket and waits for its lock to go', async () => {
    onPlatform('linux');
    const { home: root, configPath } = home('mama-stop-');
    const daemon = await servedDaemon(root, (lock) => {
      void daemon.server.close().then(() => lock.release());
    });
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);
    expect(await runStop([], { configPath, write, pollMs: 10, settleMs: 5 })).toBe(0);
    expect(lines).toEqual(['stopping', 'stopped']);
    lines.length = 0;
    expect(await runStop([], { configPath, write })).toBe(0);
    expect(lines).toEqual(['already stopped']);
  });

  it('says so when something takes the install in place of the stopped daemon', async () => {
    onPlatform('linux');
    const { home: root, configPath } = home('mama-stop-replaced-');
    let next: InstallLock | undefined;
    const daemon = await servedDaemon(root, (lock) => {
      lock.release();
      next = acquireInstallLock(daemonControlPaths(root), 'daemon');
    });
    const lines: string[] = [];
    expect(
      await runStop([], { configPath, write: (line) => lines.push(line), pollMs: 10, settleMs: 5 })
    ).toBe(1);
    expect(lines[1]).toMatch(/^stopped, but daemon \(pid \d+\) holds the install now/);
    await daemon.server.close();
    next?.release();
  });

  it('stops waiting after its limit and names the holder', async () => {
    onPlatform('linux');
    const { home: root, configPath } = home('mama-stop-timeout-');
    const daemon = await servedDaemon(root, () => {});
    const lines: string[] = [];
    expect(
      await runStop([], {
        configPath,
        write: (line) => lines.push(line),
        pollMs: 5,
        timeoutMs: 30,
        settleMs: 5,
      })
    ).toBe(1);
    expect(lines[1]).toMatch(/^not stopped yet: daemon \(pid \d+\) holds the install/);
    await daemon.server.close();
    daemon.lock.release();
  });

  it('leaves a replay, backfill or register-owner to finish', async () => {
    onPlatform('linux');
    const { home: root, configPath } = home('mama-stop-held-');
    const lock = acquireInstallLock(daemonControlPaths(root), 'backfill');
    const lines: string[] = [];
    expect(await runStop([], { configPath, write: (line) => lines.push(line) })).toBe(1);
    expect(lines[0]).toMatch(/^not stopped: backfill \(pid \d+\) holds the install and stops/);
    lock.release();
  });

  it('unloads the LaunchAgent when it runs the daemon, and uses the socket for one it does not', async () => {
    onPlatform('darwin');
    const { home: root, configPath } = home('mama-stop-launchd-');
    const paths = daemonControlPaths(root);
    const lock = acquireInstallLock(paths, 'daemon');
    vi.mocked(spawnSync).mockImplementation(((command: string, args: string[]) => {
      if (command === 'launchctl' && args[0] === 'print') {
        return {
          status: 0,
          stdout: `service = {\n\tstate = running\n\tpid = ${process.pid}\n}`,
          stderr: '',
          signal: null,
          pid: 1,
          output: [],
        };
      }
      if (command === 'launchctl' && args[0] === 'bootout') {
        lock.release();
        return { status: 0, stdout: '', stderr: '', signal: null, pid: 1, output: [] };
      }
      return { status: 1, stdout: '', stderr: '', signal: null, pid: 1, output: [] };
    }) as never);
    const lines: string[] = [];
    expect(
      await runStop([], { configPath, write: (line) => lines.push(line), pollMs: 5, settleMs: 5 })
    ).toBe(0);
    expect(lines).toEqual([
      'stopped (launchd service unloaded; launchctl bootstrap starts it again)',
    ]);
    expect(vi.mocked(spawnSync).mock.calls.some(([, args]) => args?.[0] === 'bootout')).toBe(true);

    // A daemon started in a terminal while the LaunchAgent runs another pid: the agent is unloaded
    // so it cannot start a replacement, and the terminal daemon is asked directly.
    vi.mocked(spawnSync).mockReset();
    vi.mocked(spawnSync).mockImplementation(((command: string, args: string[]) =>
      command === 'launchctl' && args[0] === 'print'
        ? {
            status: 0,
            stdout: 'service = {\n\tstate = running\n\tpid = 1\n}',
            stderr: '',
            signal: null,
            pid: 1,
            output: [],
          }
        : { status: 0, stdout: '', stderr: '', signal: null, pid: 1, output: [] }) as never);
    const terminal = acquireInstallLock(paths, 'daemon');
    const server = await startDaemonControl(paths, {
      status: () => ({}),
      stop: () => {
        void server.close().then(() => terminal.release());
      },
    });
    lines.length = 0;
    expect(
      await runStop([], { configPath, write: (line) => lines.push(line), pollMs: 5, settleMs: 5 })
    ).toBe(0);
    expect(lines).toEqual(['stopping', 'stopped (launchd service unloaded)']);
    expect(vi.mocked(spawnSync).mock.calls.some(([, args]) => args?.[0] === 'bootout')).toBe(true);
  });
});
