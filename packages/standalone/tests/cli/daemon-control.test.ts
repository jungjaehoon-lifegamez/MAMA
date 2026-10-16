import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as egressProxy from '../../src/runtime/egress-proxy.js';
import { spawn } from 'node:child_process';
import {
  acquireInstallLock,
  daemonControlPaths,
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
    const first = await boot(home, firstLogs, { requestStop }).run;

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
