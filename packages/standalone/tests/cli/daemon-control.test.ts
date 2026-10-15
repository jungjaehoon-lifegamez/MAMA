import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as egressProxy from '../../src/runtime/egress-proxy.js';
import {
  acquireInstallLock,
  daemonControlPaths,
  holderLive,
  InstallBusyError,
  lockHolder,
  requestDaemonControl,
  startDaemonControl,
  type HolderProbe,
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
  it('is taken once, refused while its process lives, and released only by its holder', () => {
    const paths = daemonControlPaths(root());
    const first = acquireInstallLock(paths, 'daemon');
    expect(statSync(paths.lockPath).mode & 0o777).toBe(0o600);
    expect(() => acquireInstallLock(paths, 'replay')).toThrow(InstallBusyError);
    expect(() => acquireInstallLock(paths, 'replay')).toThrow(/daemon, pid \d+.*mama stop/);
    expect(lockHolder(paths)?.nonce).toBe(first.owner.nonce);

    // A holder that is not the current owner does not remove the current lock.
    const stale = { ...first.owner, nonce: 'other-holder' };
    writeFileSync(paths.lockPath, JSON.stringify(stale));
    first.release();
    expect(existsSync(paths.lockPath)).toBe(true);
    rmSync(paths.lockPath);
  });

  it('replaces a lock whose process is gone or whose content is unreadable', () => {
    const paths = daemonControlPaths(root());
    mkdirSync(join(paths.lockPath, '..'), { recursive: true });
    writeFileSync(
      paths.lockPath,
      JSON.stringify({ pid: 999_999, command: 'daemon', startedAt: 1, nonce: 'dead' })
    );
    const probe: HolderProbe = {
      alive: (pid) => pid === process.pid,
      startTime: () => null,
      bootTime: () => 1_000_000,
    };
    const taken = acquireInstallLock(paths, 'daemon', probe);
    expect(JSON.parse(readFileSync(paths.lockPath, 'utf8')).nonce).toBe(taken.owner.nonce);
    taken.release();
    expect(existsSync(paths.lockPath)).toBe(false);

    writeFileSync(paths.lockPath, 'not json');
    const again = acquireInstallLock(paths, 'daemon');
    expect(again.owner.command).toBe('daemon');
    again.release();
  });
});

describe('a lock holder', () => {
  const owner = {
    pid: 77,
    command: 'daemon',
    startedAt: 5_000_000,
    nonce: 'n',
    bootTime: 1_000_000,
  };
  const probe = (overrides: Partial<HolderProbe> = {}): HolderProbe => ({
    alive: () => true,
    startTime: () => 4_000_000,
    bootTime: () => 1_000_000,
    ...overrides,
  });

  it('counts only the process that wrote the lock in this machine boot', () => {
    expect(holderLive(owner, probe())).toBe(true);
    // Unknown start time: the boot time and the pid decide.
    expect(holderLive(owner, probe({ startTime: () => null }))).toBe(true);
    expect(holderLive(owner, probe({ alive: () => false }))).toBe(false);
    // A lock from before a reboot, whatever now runs under that pid.
    expect(holderLive(owner, probe({ bootTime: () => 9_000_000 }))).toBe(false);
    // The pid now belongs to a process that started after the lock was written.
    expect(holderLive(owner, probe({ startTime: () => 5_000_000 + 60_000 }))).toBe(false);
    // A lock written before boot times were recorded is judged by pid and start time.
    const { bootTime: _bootTime, ...legacy } = owner;
    expect(holderLive(legacy, probe({ bootTime: () => 9_000_000 }))).toBe(true);
  });

  it('replaces a lock whose pid was reused after a reboot', () => {
    const paths = daemonControlPaths(root());
    mkdirSync(join(paths.lockPath, '..'), { recursive: true });
    writeFileSync(paths.lockPath, JSON.stringify({ ...owner, pid: process.pid }));
    const taken = acquireInstallLock(paths, 'daemon', probe({ bootTime: () => 9_000_000 }));
    expect(taken.owner.bootTime).toBe(9_000_000);
    taken.release();
  });
});

describe('control socket', () => {
  it('answers status and stop with the boot token and refuses without it', async () => {
    const paths = daemonControlPaths(root());
    const lock = acquireInstallLock(paths, 'daemon');
    const stop = vi.fn();
    const server = await startDaemonControl(paths, {
      status: () => ({ stage: 'running' }),
      stop,
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
    process.emit('SIGTERM');
    await running;
    expect(lockHolder(daemonControlPaths(home))).toBeNull();

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
