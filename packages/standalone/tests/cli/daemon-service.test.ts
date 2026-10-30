import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootoutLaunchdService, launchdService } from '../../src/cli/commands/daemon.js';
import { runStatus, runStop, STATUS_STOPPED_EXIT } from '../../src/cli/commands/control.js';
import {
  acquireInstallLock,
  daemonControlPaths,
  lockHolder,
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
        drain: { holds: 1, since: 0 },
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
    expect(lines).toContain(
      `claims held for a drain since ${new Date(0).toLocaleString('sv-SE')}: new inputs wait`
    );
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

/** A drain handler whose counts the test sets; it records each hold and release. */
function drainFixture(boundMs = 60_000) {
  const counts = { running: 0, claimed: 0 };
  const events: string[] = [];
  return {
    counts,
    events,
    hold: () => {
      events.push('hold');
      return {
        boundMs,
        counts: () => ({ ...counts }),
        release: () => events.push('release'),
      };
    },
  };
}

describe('mama stop', () => {
  async function servedDaemon(
    root: string,
    onStop: (lock: InstallLock) => void,
    drain = drainFixture()
  ) {
    const paths = daemonControlPaths(root);
    const lock = acquireInstallLock(paths, 'daemon');
    const server = await startDaemonControl(
      paths,
      { status: () => ({}), stop: () => onStop(lock), hold: drain.hold },
      5_000,
      5
    );
    return { paths, lock, server, drain };
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
    expect(lines).toEqual(['drained: nothing runs; stopping', 'stopping', 'stopped']);
    // The daemon's own stop ended the drain; the hold was let go once.
    expect(daemon.drain.events).toEqual(['hold', 'release']);
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
    expect(lines[2]).toMatch(/^stopped, but daemon \(pid \d+\) holds the install now/);
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
    expect(lines[2]).toMatch(/^not stopped yet: daemon \(pid \d+\) holds the install/);
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
    // The LaunchAgent's daemon serves its socket too; it is drained before the bootout.
    const launchdServer = await startDaemonControl(paths, {
      status: () => ({}),
      stop: () => {},
      hold: drainFixture().hold,
    } as never);
    expect(
      await runStop([], { configPath, write: (line) => lines.push(line), pollMs: 5, settleMs: 5 })
    ).toBe(0);
    expect(lines).toEqual([
      'drained: nothing runs; stopping',
      'stopped (launchd service unloaded); mama service start starts it again',
    ]);
    expect(vi.mocked(spawnSync).mock.calls.some(([, args]) => args?.[0] === 'bootout')).toBe(true);
    await launchdServer.close();

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
      hold: drainFixture().hold,
    } as never);
    lines.length = 0;
    expect(
      await runStop([], { configPath, write: (line) => lines.push(line), pollMs: 5, settleMs: 5 })
    ).toBe(0);
    expect(lines).toEqual([
      'drained: nothing runs; stopping',
      'stopping',
      'stopped (launchd service unloaded)',
    ]);
    expect(vi.mocked(spawnSync).mock.calls.some(([, args]) => args?.[0] === 'bootout')).toBe(true);
  });

  /** launchctl print reports this process as the LaunchAgent's daemon; bootout releases it. */
  function launchdRuns(lock: InstallLock, events: string[]) {
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
        events.push('bootout');
        lock.release();
      }
      return { status: 0, stdout: '', stderr: '', signal: null, pid: 1, output: [] };
    }) as never);
  }

  it('waits for what runs and stops through launchd only once it is idle, holding claims throughout', async () => {
    onPlatform('darwin');
    const { home: root, configPath } = home('mama-stop-drain-');
    const drain = drainFixture();
    drain.counts.running = 1;
    drain.counts.claimed = 2;
    const daemon = await servedDaemon(root, () => {}, drain);
    launchdRuns(daemon.lock, drain.events);
    const lines: string[] = [];
    const stopping = runStop([], {
      configPath,
      write: (line) => lines.push(line),
      pollMs: 5,
      settleMs: 5,
    });
    await vi.waitFor(() =>
      expect(lines).toContain(
        'draining: new inputs wait; waiting for 1 turn running, 2 inputs claimed (at most 1 min)'
      )
    );
    drain.counts.running = 0;
    drain.counts.claimed = 1;
    await vi.waitFor(() =>
      expect(lines).toContain('still draining: 0 turns running, 1 input claimed')
    );
    expect(drain.events).toEqual(['hold']);
    drain.counts.claimed = 0;
    expect(await stopping).toBe(0);
    expect(lines.slice(-2)).toEqual([
      'drained: nothing runs; stopping',
      'stopped (launchd service unloaded); mama service start starts it again',
    ]);
    // The bootout came while claims were held, and the hold ended after it.
    await vi.waitFor(() => expect(drain.events).toEqual(['hold', 'bootout', 'release']));
    await daemon.server.close();
  });

  it('ends the hold past its bound, changes nothing and names the counts', async () => {
    onPlatform('darwin');
    const { home: root, configPath } = home('mama-stop-bound-');
    const drain = drainFixture(30);
    drain.counts.running = 1;
    drain.counts.claimed = 1;
    const stop = vi.fn();
    const daemon = await servedDaemon(root, stop, drain);
    launchdRuns(daemon.lock, drain.events);
    const lines: string[] = [];
    expect(await runStop([], { configPath, write: (line) => lines.push(line) })).toBe(1);
    expect(lines.at(-1)).toBe(
      'not stopped: still 1 turn running, 1 input claimed after 1 min; nothing changed, new inputs are claimed again (mama stop --now interrupts them)'
    );
    await vi.waitFor(() => expect(drain.events).toEqual(['hold', 'release']));
    expect(stop).not.toHaveBeenCalled();
    expect(lockHolder(daemon.paths)?.command).toBe('daemon');
    await daemon.server.close();
    daemon.lock.release();
  });

  it('keeps the old stop with --now: no drain, launchd unloads at once', async () => {
    onPlatform('darwin');
    const { home: root, configPath } = home('mama-stop-now-');
    const drain = drainFixture();
    drain.counts.running = 1;
    const daemon = await servedDaemon(root, () => {}, drain);
    launchdRuns(daemon.lock, drain.events);
    const lines: string[] = [];
    expect(
      await runStop(['--now'], {
        configPath,
        write: (line) => lines.push(line),
        pollMs: 5,
        settleMs: 5,
      })
    ).toBe(0);
    expect(lines).toEqual([
      'stopped (launchd service unloaded); mama service start starts it again',
    ]);
    expect(drain.events).toEqual(['bootout']);
    await expect(runStop(['--later'], { configPath })).rejects.toThrow('Usage: mama stop [--now]');
    await daemon.server.close();
  });

  it('refuses to stop a daemon that cannot be drained, and names --now', async () => {
    onPlatform('linux');
    const { home: root, configPath } = home('mama-stop-silent-');
    const lock = acquireInstallLock(daemonControlPaths(root), 'daemon');
    const lines: string[] = [];
    // Past the wait for a booting daemon's socket.
    expect(
      await runStop([], {
        configPath,
        write: (line) => lines.push(line),
        pollMs: 5,
        controlWaitMs: 30,
      })
    ).toBe(1);
    expect(lines).toEqual([
      expect.stringMatching(
        /^not stopped: daemon \(pid \d+\) holds the install does not answer on its control socket; mama stop --now stops it without draining$/
      ),
    ]);
    lock.release();
  });

  /**
   * A daemon booting as the stop reads: it takes the install's lock, writes its holder file and
   * opens its control socket in that order (daemon.ts, bootDaemon). The stop's first read comes
   * before the socket, and the boot finishes before its next one. As the install command's
   * recovery meets a daemon a cut Node move started, on macOS.
   */
  async function bootingDaemon(root: string, holderFile: boolean) {
    const paths = daemonControlPaths(root);
    const lock = acquireInstallLock(paths, 'daemon');
    const holder = readFileSync(paths.holderPath, 'utf8');
    if (!holderFile) rmSync(paths.holderPath);
    const drain = drainFixture();
    launchdRuns(lock, drain.events);
    return {
      drain,
      finishBoot: async () => {
        if (!holderFile) writeFileSync(paths.holderPath, holder);
        return await startDaemonControl(
          paths,
          { status: () => ({}), stop: () => {}, hold: drain.hold },
          5_000,
          5
        );
      },
    };
  }

  it('drains a daemon that holds the install before its control socket opens', async () => {
    onPlatform('darwin');
    const { home: root, configPath } = home('mama-stop-booting-');
    const daemon = await bootingDaemon(root, true);
    const lines: string[] = [];
    const stopping = runStop([], {
      configPath,
      write: (line) => lines.push(line),
      pollMs: 5,
      settleMs: 5,
    });
    // The stop's first read is done: it found the daemon with no socket.
    await new Promise((resolve) => setImmediate(resolve));
    const server = await daemon.finishBoot();
    expect(await stopping).toBe(0);
    expect(lines).toEqual([
      'drained: nothing runs; stopping',
      'stopped (launchd service unloaded); mama service start starts it again',
    ]);
    await vi.waitFor(() => expect(daemon.drain.events).toEqual(['hold', 'bootout', 'release']));
    await server.close();
  });

  it('reads again while the lock is held before its holder file is written (pid 0)', async () => {
    onPlatform('darwin');
    const { home: root, configPath } = home('mama-stop-unnamed-');
    const daemon = await bootingDaemon(root, false);
    const lines: string[] = [];
    const stopping = runStop([], {
      configPath,
      write: (line) => lines.push(line),
      pollMs: 5,
      settleMs: 5,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const server = await daemon.finishBoot();
    expect(await stopping).toBe(0);
    expect(lines).toEqual([
      'drained: nothing runs; stopping',
      'stopped (launchd service unloaded); mama service start starts it again',
    ]);
    await server.close();
  });

  it('names a holder that never writes its holder file once the wait is over', async () => {
    onPlatform('linux');
    const { home: root, configPath } = home('mama-stop-unnamed-bound-');
    const paths = daemonControlPaths(root);
    const lock = acquireInstallLock(paths, 'daemon');
    rmSync(paths.holderPath);
    const lines: string[] = [];
    expect(
      await runStop([], {
        configPath,
        write: (line) => lines.push(line),
        pollMs: 5,
        controlWaitMs: 30,
      })
    ).toBe(1);
    expect(lines).toEqual([
      'not stopped: unknown (pid 0) holds the install and stops when it finishes',
    ]);
    lock.release();
  });

  it('names --now when a daemon older than the drain refuses it, or one stops answering', async () => {
    onPlatform('linux');
    const { home: root, configPath } = home('mama-stop-old-');
    const paths = daemonControlPaths(root);
    const lock = acquireInstallLock(paths, 'daemon');
    mkdirSync(join(paths.tokenPath, '..'), { recursive: true });
    writeFileSync(paths.tokenPath, 'fixture-token\n');
    let reply: string | null = JSON.stringify({ ok: false, error: 'unknown op' });
    const old = createServer((socket) => {
      socket.once('data', () => {
        if (reply !== null) socket.end(`${reply}\n`);
      });
    });
    await new Promise<void>((resolve) => old.listen(paths.socketPath, resolve));
    try {
      const lines: string[] = [];
      expect(await runStop([], { configPath, write: (line) => lines.push(line) })).toBe(1);
      expect(lines).toEqual([
        'not stopped: the daemon refused the drain: unknown op; mama stop --now stops it without draining',
      ]);
      reply = null;
      lines.length = 0;
      expect(
        await runStop([], {
          configPath,
          write: (line) => lines.push(line),
          drainDeadlines: { firstMs: 20 },
        })
      ).toBe(1);
      expect(lines).toEqual([
        'not stopped: the daemon did not answer the drain within 20 ms; mama stop --now stops it without draining',
      ]);
    } finally {
      await new Promise<void>((resolve) => old.close(() => resolve()));
      lock.release();
    }
  });
});
