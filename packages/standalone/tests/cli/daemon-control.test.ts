import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as egressProxy from '../../src/runtime/egress-proxy.js';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import {
  acquireInstallLock,
  daemonControlPaths,
  drainDaemon,
  InstallBusyError,
  lockHolder,
  requestDaemonControl,
  startDaemonControl,
} from '../../src/cli/runtime/daemon-control.js';
import {
  bootDaemon,
  StopDuringBootError,
  askDaemon,
  runDaemon,
  upkeepCloseSince,
} from '../../src/cli/commands/daemon.js';
import type { W1Config } from '../../src/runtime/config.js';

const roots: string[] = [];
function root(prefix = 'mama-control-'): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

beforeEach(() => {
  vi.stubEnv('MAMA_TELEGRAM_TOKEN', 'fixture-env-telegram');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('install lock', () => {
  it('is held once, names its holder while held, and is free after release', () => {
    const paths = daemonControlPaths(root());
    const first = acquireInstallLock(paths, 'daemon');
    expect(statSync(paths.lockPath).mode & 0o777).toBe(0o600);
    expect(statSync(paths.holderPath).mode & 0o777).toBe(0o600);
    expect(() => acquireInstallLock(paths, 'replay', { busyTimeoutMs: 0 })).toThrow(
      InstallBusyError
    );
    expect(() => acquireInstallLock(paths, 'replay', { busyTimeoutMs: 0 })).toThrow(
      /daemon, pid \d+; .*daemon\.lock\).*mama stop/
    );
    expect(lockHolder(paths)?.nonce).toBe(first.owner.nonce);
    first.release();
    expect(lockHolder(paths)).toBeNull();
    expect(existsSync(paths.holderPath)).toBe(false);
    const second = acquireInstallLock(paths, 'replay', { busyTimeoutMs: 0 });
    expect(lockHolder(paths)?.command).toBe('replay');
    second.release();
  });

  it('is let go by the operating system when its process is killed', async () => {
    const paths = daemonControlPaths(root());
    mkdirSync(join(paths.lockPath, '..'), { recursive: true });
    // A process that takes the lock the same way and never releases it.
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const D = require('better-sqlite3');
         const db = new D(process.argv[1]);
         db.pragma('locking_mode = EXCLUSIVE');
         db.exec('BEGIN EXCLUSIVE');
         process.stdout.write('held\\n');
         setInterval(() => {}, 1000);`,
        paths.lockPath,
      ],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit'] }
    );
    await new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()));
    expect(() => acquireInstallLock(paths, 'daemon', { busyTimeoutMs: 0 })).toThrow(
      InstallBusyError
    );
    expect(lockHolder(paths)).toEqual(expect.objectContaining({ command: 'unknown' }));
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    const taken = acquireInstallLock(paths, 'daemon', { busyTimeoutMs: 0 });
    expect(taken.owner.command).toBe('daemon');
    taken.release();
  });
});

describe('control socket', () => {
  it('answers status and stop with the boot token and refuses without it', async () => {
    const paths = daemonControlPaths(root());
    const lock = acquireInstallLock(paths, 'daemon');
    const stop = vi.fn();
    let probeFails = false;
    const server = await startDaemonControl(paths, {
      status: () => ({ stage: 'running' }),
      stop,
      probe: async () => {
        if (probeFails) throw new Error('Not logged in · fixture backend');
        return { ms: 3 };
      },
    });
    expect(statSync(paths.socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(paths.tokenPath).mode & 0o777).toBe(0o600);

    const status = await requestDaemonControl(paths, 'status');
    expect(status).toEqual({ state: 'running', reply: { ok: true, status: { stage: 'running' } } });
    expect(await requestDaemonControl(paths, 'stop')).toEqual({
      state: 'running',
      reply: { ok: true },
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(await requestDaemonControl(paths, 'probe')).toEqual({
      state: 'running',
      reply: { ok: true, probe: { ms: 3 } },
    });
    probeFails = true;
    expect(await requestDaemonControl(paths, 'probe')).toEqual({
      state: 'running',
      reply: { ok: false, error: 'Not logged in · fixture backend' },
    });

    writeFileSync(paths.tokenPath, 'wrong-token\n');
    expect(await requestDaemonControl(paths, 'status')).toEqual({
      state: 'running',
      reply: { ok: false, error: 'unauthorized' },
    });

    await server.close();
    expect(existsSync(paths.socketPath)).toBe(false);
    expect(existsSync(paths.tokenPath)).toBe(false);
    const stopped = await requestDaemonControl(paths, 'status');
    expect(stopped).toEqual({
      state: 'stopped',
      holder: expect.objectContaining({ command: 'daemon' }),
    });
    lock.release();
    expect(await requestDaemonControl(paths, 'status')).toEqual({ state: 'stopped', holder: null });
  });

  it('waits for a probe longer than a request may take to arrive', async () => {
    const paths = daemonControlPaths(root());
    const lock = acquireInstallLock(paths, 'daemon');
    const server = await startDaemonControl(
      paths,
      {
        status: () => ({}),
        stop: () => {},
        probe: async () => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          return { ms: 150 };
        },
      },
      50
    );
    try {
      expect(await requestDaemonControl(paths, 'probe', 1_000)).toEqual({
        state: 'running',
        reply: { ok: true, probe: { ms: 150 } },
      });
    } finally {
      await server.close();
      lock.release();
    }
  });

  it('holds claims while a drain stays open, and lets go on its bound, its close or the server close', async () => {
    const paths = daemonControlPaths(root());
    const lock = acquireInstallLock(paths, 'daemon');
    const counts = { running: 1, claimed: 1 };
    const events: string[] = [];
    let boundMs = 60_000;
    let refuse = false;
    const server = await startDaemonControl(
      paths,
      {
        status: () => ({}),
        stop: () => {},
        probe: async () => ({}),
        hold: () => {
          if (refuse) throw new Error('MAMA is stopping');
          events.push('hold');
          return { boundMs, counts: () => ({ ...counts }), release: () => events.push('release') };
        },
      },
      5_000,
      5
    );
    try {
      // Counts go out as they change; idle keeps the hold until the client lets go.
      const progress: unknown[] = [];
      const drain = (await drainDaemon(paths, (line) => progress.push(line)))!;
      await vi.waitFor(() => expect(progress).toHaveLength(1));
      counts.running = 0;
      counts.claimed = 0;
      expect(await drain.outcome).toEqual({ kind: 'idle' });
      expect(progress).toEqual([
        { running: 1, claimed: 1, bound: 60_000, idle: false },
        { running: 0, claimed: 0, bound: 60_000, idle: true },
      ]);
      expect(events).toEqual(['hold']);
      drain.release();
      await vi.waitFor(() => expect(events).toEqual(['hold', 'release']));

      // Past its bound the daemon ends the drain with the counts and lets go.
      counts.running = 1;
      boundMs = 20;
      const bounded = (await drainDaemon(paths, () => {}))!;
      expect(await bounded.outcome).toEqual({ kind: 'bound', bound: 20, running: 1, claimed: 0 });
      await vi.waitFor(() => expect(events).toEqual(['hold', 'release', 'hold', 'release']));

      // A daemon that stops ends an open drain, so its server closes.
      boundMs = 60_000;
      const open = (await drainDaemon(paths, () => {}))!;
      await vi.waitFor(() => expect(events).toHaveLength(5));
      refuse = true;
      const refused = (await drainDaemon(paths, () => {}))!;
      expect(await refused.outcome).toEqual({ kind: 'refused', error: 'MAMA is stopping' });
      await server.close();
      expect(await open.outcome).toEqual({ kind: 'closed' });
      expect(events.at(-1)).toBe('release');
    } finally {
      lock.release();
    }
    expect(await drainDaemon(paths, () => {})).toBeNull();
  });

  it('gives up on a daemon that does not answer a drain, goes quiet, or outlives its bound', async () => {
    const paths = daemonControlPaths(root());
    mkdirSync(join(paths.tokenPath, '..'), { recursive: true });
    writeFileSync(paths.tokenPath, 'fixture-token\n');
    // A wedged daemon: it takes the connection and sends what the test says, then nothing.
    let lines: string[] = [];
    const sockets = new Set<import('node:net').Socket>();
    const wedged = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.once('data', () => {
        for (const line of lines) socket.write(`${line}\n`);
      });
    });
    await new Promise<void>((resolve) => wedged.listen(paths.socketPath, resolve));
    const progress = (running: number, bound: number) =>
      JSON.stringify({ ok: true, drain: { running, claimed: 0, bound, idle: false } });
    try {
      lines = [];
      const silentFirst = (await drainDaemon(paths, () => {}, { firstMs: 20 }))!;
      expect(await silentFirst.outcome).toEqual({
        kind: 'silent',
        error: 'the daemon did not answer the drain within 20 ms',
      });

      lines = [progress(1, 60_000)];
      const quiet = (await drainDaemon(paths, () => {}, { firstMs: 1_000, silenceMs: 30 }))!;
      expect(await quiet.outcome).toEqual({
        kind: 'silent',
        error: 'the daemon sent nothing on the drain for 30 ms',
      });

      lines = [progress(1, 10)];
      const overdue = (await drainDaemon(paths, () => {}, { silenceMs: 60_000, graceMs: 20 }))!;
      expect(await overdue.outcome).toEqual({
        kind: 'silent',
        error: 'the daemon did not end the drain at its bound of 10 ms',
      });
      // Each one let go of its connection, which is what ends a hold.
      await vi.waitFor(() => expect(sockets.size).toBe(0));
    } finally {
      await new Promise<void>((resolve) => wedged.close(() => resolve()));
    }
  });

  it('reports stopped when a dead holder left its token behind', async () => {
    const paths = daemonControlPaths(root());
    mkdirSync(join(paths.tokenPath, '..'), { recursive: true });
    writeFileSync(paths.tokenPath, 'left-behind\n');
    expect(await requestDaemonControl(paths, 'status')).toEqual({ state: 'stopped', holder: null });
  });
});

function config(home: string): W1Config {
  return {
    version: 1,
    agent: {
      backend: 'codex',
      model: 'fixture-model',
      effort: 'medium',
      max_turns: 20,
      timeout: 1_000,
      run_token_budget: 100,
    },
    jev: { keyFile: join(home, 'replay-key'), vocabFile: join(home, 'vocab.json') },
    database: { path: join(home, 'memory.db') },
    logging: { level: 'info', file: join(home, 'daemon.log') },
    telegram: {
      enabled: true,
      owner_chat_id: 'chat',
      allowed_chats: ['chat'],
      owner_user_ids: ['owner'],
      polling: false,
    },
  } as W1Config;
}

function boot(home: string, logs: string[], extra: Partial<Parameters<typeof bootDaemon>[0]> = {}) {
  const createOwnerRuntime = vi.fn(async () => ({
    database: {
      adapter: {
        prepare: vi.fn(() => ({ get: vi.fn(), all: vi.fn(() => []), run: vi.fn() })),
      },
    },
    intake: { recordOwnerReply: () => {}, acceptOwnerMessage: vi.fn() },
    surface: { dispatch: vi.fn(), ownerAccess: { scopes: [{ kind: 'user', id: 'owner' }] } },
    acceptSourceDelta: vi.fn(),
    probeBackend: vi.fn(async () => ({ modelRunId: 'fixture-run', ms: 7 })),
    stop: vi.fn(async () => {}),
  }));
  const run = bootDaemon({
    home,
    configPath: join(home, 'config.yaml'),
    config: config(home),
    logger: { info: (line) => logs.push(line), error: (line) => logs.push(line) },
    dependencies: {
      ensureIsolation: () => {},
      createOwnerRuntime: createOwnerRuntime as never,
      createViewerServer: () =>
        ({ port: 3847, server: null, start: async () => {}, stop: async () => {} }) as never,
      startConnectorRuntime: async () =>
        ({
          stop: async () => {},
          enabledConnectorNames: ['chatwork'],
          channelCounts: {},
          registry: {
            healthCheckAll: async () => ({
              chatwork: {
                healthy: true,
                lastPollTime: new Date(0),
                lastPollCount: 0,
              },
            }),
          },
        }) as never,
      createTelegramGateway: () =>
        ({
          start: async () => {},
          stop: async () => {},
          deliverResponse: async () => {},
          sendToOwner: async () => {},
          sendFile: async () => ({ sentAs: 'document', size: 0 }),
        }) as never,
    },
    ...extra,
  });
  return { run, createOwnerRuntime };
}

describe('daemon boot holds the install', () => {
  beforeEach(() => {
    vi.spyOn(egressProxy, 'startEgressProxy').mockResolvedValue({
      httpProxyPort: 1,
      socksProxyPort: 2,
      close: async () => {},
    } as never);
  });

  it('refuses a second boot before it reaches config, and serves status while running', async () => {
    const home = root('mama-boot-lock-');
    const firstLogs: string[] = [];
    const requestStop = vi.fn();
    const booted = boot(home, firstLogs, { requestStop });
    const first = await booted.run;

    const secondLogs: string[] = [];
    const second = boot(home, secondLogs);
    await expect(second.run).rejects.toThrow(InstallBusyError);
    expect(second.createOwnerRuntime).not.toHaveBeenCalled();
    expect(secondLogs).toEqual([]);

    const status = await askDaemon('status', { configPath: join(home, 'config.yaml') });
    expect(status.state).toBe('running');
    expect(status.state === 'running' && status.reply.status).toEqual(
      expect.objectContaining({
        command: 'daemon',
        stage: 'running',
        runningTurns: [],
        inputs: [],
        connectors: [
          { name: 'chatwork', healthy: true, lastPoll: new Date(0).toISOString(), error: null },
        ],
      })
    );
    // A running daemon answers a probe with one turn of its own backend, and logs it.
    const probe = await askDaemon('probe', { configPath: join(home, 'config.yaml') });
    expect(probe.state === 'running' && probe.reply).toEqual({
      ok: true,
      probe: expect.objectContaining({ modelRunId: 'fixture-run', ms: 7 }),
    });
    expect(firstLogs).toContainEqual(expect.stringMatching(/^backend probe: .* answered in 7 ms/));
    // A failed probe names what failed beneath the dispatch layer's wrapper.
    const owner = (await booted.createOwnerRuntime.mock.results[0].value) as {
      probeBackend: ReturnType<typeof vi.fn>;
    };
    owner.probeBackend.mockRejectedValueOnce(
      new Error('Native input dispatch began', {
        cause: new Error('Not logged in · fixture backend'),
      })
    );
    const failed = await askDaemon('probe', { configPath: join(home, 'config.yaml') });
    expect(failed.state === 'running' && failed.reply).toEqual({
      ok: false,
      error: expect.stringContaining('Not logged in · fixture backend'),
    });
    expect(firstLogs).toContainEqual(
      expect.stringMatching(/^backend probe: .* failed: .*Not logged in · fixture backend/)
    );
    await askDaemon('stop', { configPath: join(home, 'config.yaml') });
    expect(requestStop).toHaveBeenCalledTimes(1);

    await first.stop();
    expect((await askDaemon('status', { configPath: join(home, 'config.yaml') })).state).toBe(
      'stopped'
    );
    const again = await boot(home, []).run;
    await again.stop();
  });

  it('refuses a stop over the socket when the booted command stops on its own', async () => {
    const home = root('mama-boot-replay-');
    const daemon = await boot(home, [], { command: 'replay' }).run;
    const reply = await askDaemon('stop', { configPath: join(home, 'config.yaml') });
    expect(reply).toEqual({
      state: 'running',
      reply: { ok: false, error: 'replay stops when it finishes' },
    });
    await daemon.stop();
  });

  it('stops on a signal after boot and on one during boot, releasing the install each time', async () => {
    const home = root('mama-run-signal-');
    const configPath = join(home, 'config.yaml');
    const owner = () => ({
      database: { adapter: { prepare: () => ({ all: () => [] }) } },
      intake: { recordOwnerReply: () => {}, acceptOwnerMessage: vi.fn() },
      surface: { dispatch: vi.fn(), ownerAccess: { scopes: [] } },
      acceptSourceDelta: vi.fn(),
      stop: async () => {},
    });
    const options = (createOwnerRuntime: () => Promise<unknown>) => ({
      home,
      configPath,
      config: config(home),
      logger: { info: () => {}, error: () => {} },
      dependencies: {
        ensureIsolation: () => {},
        createOwnerRuntime: createOwnerRuntime as never,
        createViewerServer: () =>
          ({ port: 3847, server: null, start: async () => {}, stop: async () => {} }) as never,
        startConnectorRuntime: async () =>
          ({
            stop: async () => {},
            enabledConnectorNames: [],
            channelCounts: {},
            registry: { healthCheckAll: async () => ({}) },
          }) as never,
        createTelegramGateway: () =>
          ({
            start: async () => {},
            stop: async () => {},
            deliverResponse: async () => {},
            sendToOwner: async () => {},
            sendFile: async () => ({ sentAs: 'document', size: 0 }),
          }) as never,
      },
    });

    const running = runDaemon(options(async () => owner()));
    await vi.waitFor(async () =>
      expect((await askDaemon('status', { configPath })).state).toBe('running')
    );
    const previousExit = process.exitCode;
    process.emit('SIGTERM');
    await running;
    expect(lockHolder(daemonControlPaths(home))).toBeNull();
    // A daemon stopped by a signal exits as a killed one would, so its service restarts it.
    expect(process.exitCode).toBe(143);
    process.exitCode = previousExit;

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const during = runDaemon(
      options(async () => {
        await held;
        return owner();
      })
    );
    await vi.waitFor(async () =>
      expect((await askDaemon('status', { configPath })).state).toBe('running')
    );
    process.emit('SIGINT');
    release();
    await expect(during).resolves.toBeUndefined();
    expect(lockHolder(daemonControlPaths(home))).toBeNull();
    expect(process.exitCode).toBe(130);
    process.exitCode = previousExit;
  });

  it('unwinds a boot stopped before its first stage and releases the install', async () => {
    const home = root('mama-boot-abort-');
    const controller = new AbortController();
    controller.abort();
    const logs: string[] = [];
    const aborted = boot(home, logs, { signal: controller.signal });
    await expect(aborted.run).rejects.toThrow(StopDuringBootError);
    expect(aborted.createOwnerRuntime).not.toHaveBeenCalled();
    expect(lockHolder(daemonControlPaths(home))).toBeNull();
    const daemon = await boot(home, []).run;
    await daemon.stop();
  });
});

describe('upkeep start', () => {
  it('writes the instant closing summaries start once, and keeps it after a restart', () => {
    const path = join(root(), 'runtime', 'upkeep-state.json');
    expect(upkeepCloseSince(path, 1_000)).toBe(1_000);
    expect(upkeepCloseSince(path, 2_000)).toBe(1_000);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('publishes the state through a rename: no temporary sibling is left and the target is whole', () => {
    const runtimeDir = join(root(), 'runtime');
    const path = join(runtimeDir, 'upkeep-state.json');
    expect(upkeepCloseSince(path, 3_000)).toBe(3_000);
    // The write lands on a temporary file and is renamed onto the target, so a later boot never
    // reads a partial file and no `.tmp` sibling survives the call.
    expect(readdirSync(runtimeDir)).toEqual(['upkeep-state.json']);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ closeSince: 3_000 });
  });
});
