/**
 * /update's daemon side on a temp install (tests/helpers/update-install.ts): what it refuses,
 * what it records, the job files it writes and the service-manager calls it makes. launchctl and
 * systemd-run go through a recording runner; nothing here may start a real child process.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireInstallLock } from '../../src/cli/runtime/daemon-control.js';
import {
  readUpdateRequest,
  requestUpdate,
  updateRequestPath,
  type UpdateJobOptions,
} from '../../src/cli/runtime/update-request.js';
import { releaseCheckPath } from '../../src/cli/runtime/release-check.js';
import { startScript } from '../../src/cli/launch-files.js';
import { fixture, roots } from '../helpers/update-install.js';

// This Mac's live daemon has the global LaunchAgent label; nothing here may reach launchctl.
vi.mock('node:child_process', async (original) => {
  const refuse = () => {
    throw new Error('a test reached a child process');
  };
  return {
    ...(await original<typeof import('node:child_process')>()),
    spawnSync: vi.fn(refuse),
    spawn: vi.fn(refuse),
    execFile: vi.fn(refuse),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SECRET = 'fixture-bot-secret';

function done(status: number, stdout = '', stderr = ''): SpawnSyncReturns<string> {
  return { pid: 1, output: [], stdout, stderr, status, signal: null };
}

/**
 * The update job as `launchctl print` shows it. `starting`: just bootstrapped, loaded with no pid
 * and never exited, which a second /update answered at the same moment sees.
 */
type Job = 'none' | 'finished' | 'running' | 'starting';
const PRINTED: Record<Exclude<Job, 'none'>, string> = {
  running: '\tstate = running\n\tpid = 4242\n\tlast exit code = (never exited)\n',
  starting: '\tstate = spawn scheduled\n\tlast exit code = (never exited)\n',
  finished: '\tstate = not running\n\tlast exit code = 0\n',
};

/** An npm install with auth.env, a carried secret export in start.sh, and a recording runner. */
function install(options: { job?: Job; platform?: NodeJS.Platform } = {}) {
  const f = fixture();
  vi.stubEnv('HOME', f.home);
  writeFileSync(join(f.root, 'auth.env'), `MAMA_TELEGRAM_TOKEN='${SECRET}'\n`, { mode: 0o600 });
  // A start.sh that carries a credential export over from an older one: the job takes none of it.
  writeFileSync(
    f.startPath,
    startScript({
      home: f.home,
      nodePath: f.nodePath,
      cliPath: f.cliPath,
      executablePaths: ['/fixture/bin/codex'],
      viewer: { MAMA_API_PORT: '3999' },
      logLevel: 'info',
      carried: [`export MAMA_AUTH_TOKEN='${SECRET}-viewer'`],
    }),
    { mode: 0o700 }
  );
  const calls: string[][] = [];
  let job: Job = options.job ?? 'none';
  const logged: string[] = [];
  const run: UpdateJobOptions['run'] = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'launchctl' && args[0] === 'print') {
      if (job === 'none') return done(113);
      return done(0, PRINTED[job]);
    }
    if (command === 'systemctl')
      return done(job === 'running' ? 0 : 3, job === 'running' ? 'active\n' : 'inactive\n');
    if (command === 'launchctl' && args[0] === 'bootstrap') job = 'starting';
    return done(0);
  };
  const request = (messageId: number, chatId = '7101') =>
    requestUpdate({
      mamaRoot: f.root,
      home: f.home,
      origin: { chatId, messageId },
      version: '1.0.0',
      platform: options.platform ?? 'darwin',
      run,
      uid: 501,
      log: (line) => logged.push(line),
      now: () => new Date('2026-10-30T00:00:00.000Z'),
    });
  return {
    f,
    calls,
    logged,
    request,
    finish: () => {
      job = 'finished';
    },
  };
}

const mode = (path: string) => statSync(path).mode & 0o777;

describe('/update, the daemon side', () => {
  it('records the request, writes the job files and bootstraps the job', () => {
    const { f, calls, request } = install();
    writeFileSync(
      releaseCheckPath(f.root),
      JSON.stringify({
        checkedAt: '2026-10-30T00:00:00.000Z',
        current: '1.0.0',
        latest: '1.1.0',
        error: null,
      })
    );
    expect(request(31)).toEqual({ kind: 'started', from: '1.0.0', to: '1.1.0' });
    expect(readUpdateRequest(updateRequestPath(f.root))).toEqual({
      chatId: '7101',
      messageId: 31,
      receivedAt: '2026-10-30T00:00:00.000Z',
    });
    expect(mode(updateRequestPath(f.root))).toBe(0o600);
    const plist = join(f.root, 'runtime', 'update.plist');
    expect(mode(plist)).toBe(0o600);
    expect(mode(join(f.root, 'runtime', 'update.sh'))).toBe(0o700);
    expect(calls).toEqual([
      ['launchctl', 'print', 'gui/501/com.mama.update'],
      ['launchctl', 'bootstrap', 'gui/501', plist],
    ]);
    const agent = readFileSync(plist, 'utf8');
    expect(agent).toContain('<key>Label</key><string>com.mama.update</string>');
    expect(agent).toContain(`<string>${join(f.root, 'runtime', 'update.sh')}</string>`);
    expect(agent).toContain(
      `<key>StandardOutPath</key><string>${join(f.root, 'logs', 'update.log')}</string>`
    );
    expect(agent).not.toContain('KeepAlive');
    // The origin travels in the file, never in the job's arguments.
    expect(agent).not.toContain('7101');
  });

  it("gives update.sh start.sh's PATH, cd, Node and command, and no secret", () => {
    const { f, request } = install();
    request(31);
    const script = readFileSync(join(f.root, 'runtime', 'update.sh'), 'utf8');
    const start = readFileSync(f.startPath, 'utf8').split('\n');
    const lines = script.split('\n');
    expect(lines).toContain(start.find((line) => line.startsWith('export PATH='))!);
    expect(lines).toContain(start.find((line) => line.startsWith('cd '))!);
    expect(lines).toContain(`exec '${f.nodePath}' '${f.cliPath}' update`);
    expect(lines).toContain('export MAMA_UPDATE_PROGRESS=telegram');
    expect(script).not.toContain(SECRET);
    expect(script).not.toContain('auth.env');
    expect(script).not.toMatch(/TOKEN|KEY|SECRET|PASSWORD/);
    expect(script).not.toContain('7101');
  });

  it('boots out a finished job before bootstrapping it again, and words the reply without a cache', () => {
    const { f, calls, request, finish } = install({ job: 'finished' });
    expect(request(31)).toEqual({ kind: 'started', from: '1.0.0', to: null });
    expect(calls.map((call) => call.slice(0, 2).join(' '))).toEqual([
      'launchctl print',
      'launchctl bootout',
      'launchctl bootstrap',
    ]);
    expect(calls[1]).toEqual(['launchctl', 'bootout', 'gui/501/com.mama.update']);
    // A cache that names nothing newer leaves the target to the updater's own npm view.
    writeFileSync(
      releaseCheckPath(f.root),
      JSON.stringify({
        checkedAt: '2026-10-30T00:00:00.000Z',
        current: '1.0.0',
        latest: '1.0.0',
        error: null,
      })
    );
    finish();
    expect(request(32)).toEqual({ kind: 'started', from: '1.0.0', to: null });
  });

  it('leaves a running update alone: update.lock held, or the job still running', () => {
    const held = install();
    const lock = acquireInstallLock(held.f.paths.lock, 'update');
    try {
      const busy = held.request(31);
      expect(busy).toEqual({ kind: 'busy', source: 'lock', since: lock.owner.startedAt });
    } finally {
      lock.release();
    }
    // Nothing asked, nothing written: the running updater keeps its chat.
    expect(held.calls).toEqual([]);
    expect(existsSync(updateRequestPath(held.f.root))).toBe(false);

    const running = install();
    expect(running.request(31).kind).toBe('started');
    const recorded = readFileSync(updateRequestPath(running.f.root), 'utf8');
    running.calls.length = 0;
    // A second /update answered at the same moment: the job is loaded and has no pid yet.
    expect(running.request(32)).toEqual({
      kind: 'busy',
      source: 'job',
      since: Date.parse('2026-10-30T00:00:00.000Z'),
    });
    expect(running.calls).toEqual([['launchctl', 'print', 'gui/501/com.mama.update']]);
    expect(readFileSync(updateRequestPath(running.f.root), 'utf8')).toBe(recorded);
  });

  it('boots out only a job that has exited; any other loaded state is a run starting', () => {
    for (const printed of [
      PRINTED.starting,
      // Loaded, never run yet: launchd has not spawned it.
      '\tstate = not running\n\tlast exit code = (never exited)\n',
      // Neither an exit code nor a terminating signal.
      '\tstate = not running\n\truns = 1\n',
      // Only a nested section says not running; the job's own state is xpcproxy.
      '\tstate = xpcproxy\n\tpid = 4243\n\tlast exit code = (never exited)\n\t\tstate = not running\n\t\tlast exit code = 0\n',
      PRINTED.running,
    ]) {
      const f = fixture();
      vi.stubEnv('HOME', f.home);
      const calls: string[][] = [];
      const result = requestUpdate({
        mamaRoot: f.root,
        home: f.home,
        origin: { chatId: '7101', messageId: 31 },
        version: '1.0.0',
        platform: 'darwin',
        run: (command, args) => {
          calls.push([command, ...args]);
          return done(0, printed);
        },
        uid: 501,
        log: () => {},
      });
      expect(result).toMatchObject({ kind: 'busy', source: 'job' });
      expect(calls).toEqual([['launchctl', 'print', 'gui/501/com.mama.update']]);
      expect(existsSync(updateRequestPath(f.root))).toBe(false);
    }
  });

  it.each([
    ['exited', '\tstate = not running\n\truns = 1\n\tlast exit code = 0\n'],
    // As launchctl print shows a one-shot job sent kill -9 (no exit code line at all).
    ['killed', '\tstate = not running\n\truns = 1\n\tlast terminating signal = Killed: 9\n'],
  ])('boots out a job that %s and starts the update again', (_how, printed) => {
    const f = fixture();
    vi.stubEnv('HOME', f.home);
    const calls: string[][] = [];
    const result = requestUpdate({
      mamaRoot: f.root,
      home: f.home,
      origin: { chatId: '7101', messageId: 31 },
      version: '1.0.0',
      platform: 'darwin',
      run: (command, args) => {
        calls.push([command, ...args]);
        return done(0, args[0] === 'print' ? printed : '');
      },
      uid: 501,
      log: () => {},
    });
    expect(result.kind).toBe('started');
    expect(calls.map((call) => call.slice(0, 2).join(' '))).toEqual([
      'launchctl print',
      'launchctl bootout',
      'launchctl bootstrap',
    ]);
  });

  it('starts with a release check it cannot read, and logs why the reply names no target', () => {
    const { f, calls, logged, request } = install();
    writeFileSync(releaseCheckPath(f.root), '{ not json');
    expect(request(31)).toEqual({ kind: 'started', from: '1.0.0', to: null });
    expect(calls.at(-1)?.slice(0, 2)).toEqual(['launchctl', 'bootstrap']);
    expect(logged).toEqual([
      expect.stringContaining('update request: the cached release check cannot be read'),
    ]);
  });

  it('refuses a message already recorded, as a restarted daemon receives it again', () => {
    const { f, calls, request, finish } = install();
    expect(request(31).kind).toBe('started');
    finish();
    calls.length = 0;
    expect(request(31)).toEqual({ kind: 'repeated' });
    expect(calls).toEqual([['launchctl', 'print', 'gui/501/com.mama.update']]);
    // The same message id in another chat is another message.
    expect(request(31, '-7001').kind).toBe('started');
    expect(readUpdateRequest(updateRequestPath(f.root))?.chatId).toBe('-7001');
  });

  it('answers a checkout with its steps and starts nothing', () => {
    const { f, calls, request } = install();
    // A checkout: core named as workspace:*, inside a pnpm workspace.
    const manifest = join(f.packageRoot, 'package.json');
    const value = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
    const workspace = join(f.home, 'checkout');
    const packageRoot = join(workspace, 'packages', 'standalone');
    mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
    writeFileSync(join(workspace, 'pnpm-workspace.yaml'), 'packages: []\n');
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ ...value, dependencies: { '@jungjaehoon/mama-core': 'workspace:*' } })
    );
    const cli = join(packageRoot, 'dist', 'cli', 'index.js');
    writeFileSync(cli, '');
    writeFileSync(
      f.startPath,
      startScript({
        home: f.home,
        nodePath: f.nodePath,
        cliPath: cli,
        executablePaths: [],
        viewer: {},
        logLevel: 'info',
      })
    );
    const result = request(31);
    expect(result.kind).toBe('checkout');
    expect(result.kind === 'checkout' && result.steps[1]).toContain('git pull --ff-only');
    expect(calls).toEqual([]);
    expect(existsSync(updateRequestPath(f.root))).toBe(false);
    expect(existsSync(join(f.root, 'runtime', 'update.sh'))).toBe(false);
  });

  it('runs the job as a transient systemd unit on Linux', () => {
    const { f, calls, request } = install({ platform: 'linux' });
    expect(request(31).kind).toBe('started');
    const log = join(f.root, 'logs', 'update.log');
    expect(calls).toEqual([
      ['systemctl', '--user', 'is-active', 'mama-update.service'],
      [
        'systemd-run',
        '--user',
        '--unit=mama-update',
        '--collect',
        `--property=StandardOutput=append:${log}`,
        `--property=StandardError=append:${log}`,
        join(f.root, 'runtime', 'update.sh'),
      ],
    ]);
    expect(existsSync(join(f.root, 'runtime', 'update.plist'))).toBe(false);
    calls.length = 0;
    // The unit still runs: a second /update leaves it alone.
    const running = install({ platform: 'linux', job: 'running' });
    expect(running.request(32).kind).toBe('busy');
    expect(running.calls).toEqual([['systemctl', '--user', 'is-active', 'mama-update.service']]);
  });

  it('fails loud when the service manager refuses the job', () => {
    const { f } = install();
    expect(() =>
      requestUpdate({
        mamaRoot: f.root,
        home: f.home,
        origin: { chatId: '7101', messageId: 31 },
        version: '1.0.0',
        platform: 'darwin',
        run: (_command, args) =>
          args[0] === 'print' ? done(113) : done(5, '', 'Bootstrap failed: 5: Input/output error'),
        uid: 501,
        log: () => {},
      })
    ).toThrow('launchctl bootstrap gui/501');
    // The request stays recorded: a new /update is a new message, and this one is not retried.
    expect(readUpdateRequest(updateRequestPath(f.root))?.messageId).toBe(31);
  });
});
