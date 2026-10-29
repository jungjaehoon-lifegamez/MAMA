import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStatus, STATUS_STOPPED_EXIT } from '../../src/cli/commands/control.js';
import { startScript } from '../../src/cli/launch-files.js';
import {
  installKind,
  requireServicePackage,
  updateSteps,
} from '../../src/cli/runtime/install-kind.js';
import {
  createReleaseCheck,
  npmBesideNode,
  npmErrorCode,
  readReleaseCheck,
  releaseCheckPath,
  type NpmRun,
} from '../../src/cli/runtime/release-check.js';
import { isCredentialEnvName } from '../../src/runtime/backend-security.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: vi.fn(() => {
    throw new Error('no npm in this test');
  }),
}));

const platform = process.platform;
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  Object.defineProperty(process, 'platform', { value: platform });
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  // realpath: macOS's temp folder is a symlink (/var -> /private/var).
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(path);
  return path;
}

/** A MAMA OS package folder with a CLI file, its package.json naming core as given. */
function mamaPackage(root: string, core: string): string {
  mkdirSync(join(root, 'dist', 'cli'), { recursive: true });
  writeFileSync(join(root, 'dist', 'cli', 'index.js'), '');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: '@jungjaehoon/mama-os',
      dependencies: { '@jungjaehoon/mama-core': core },
    })
  );
  return root;
}

/** A home whose start.sh runs `cli` with `node`. */
function home(cli: string, node = '/fixture/node/bin/node'): { home: string; root: string } {
  const path = temp('mama-kind-home-');
  const root = join(path, '.mama');
  mkdirSync(join(root, 'runtime'), { recursive: true });
  writeFileSync(
    join(root, 'start.sh'),
    startScript({
      home: path,
      nodePath: node,
      cliPath: cli,
      executablePaths: [],
      exists: () => false,
      viewer: {},
      logLevel: 'info',
    }),
    { mode: 0o700 }
  );
  return { home: path, root };
}

function npmInstall(): { prefix: string; packageRoot: string } {
  const prefix = temp('mama-kind-prefix-');
  const packageRoot = mamaPackage(
    join(prefix, 'lib', 'node_modules', '@jungjaehoon', 'mama-os'),
    '^8.8.0'
  );
  return { prefix, packageRoot };
}

function checkout(): { workspaceRoot: string; packageRoot: string } {
  const workspaceRoot = temp('mama-kind-checkout-');
  writeFileSync(join(workspaceRoot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  const packageRoot = mamaPackage(join(workspaceRoot, 'packages', 'standalone'), 'workspace:*');
  return { workspaceRoot, packageRoot };
}

describe('install kind', () => {
  it('reads an npm global install from the package start.sh runs, after realpath', () => {
    const { prefix, packageRoot } = npmInstall();
    // start.sh may name the package through a link; the kind is the real folder's.
    const linked = join(temp('mama-kind-link-'), 'prefix');
    symlinkSync(prefix, linked);
    const cli = join(
      linked,
      'lib',
      'node_modules',
      '@jungjaehoon',
      'mama-os',
      'dist',
      'cli',
      'index.js'
    );
    const { home: path, root } = home(cli, join(prefix, 'bin', 'node'));
    const install = installKind(root, path);
    expect(install).toEqual({
      kind: 'npm',
      packageRoot,
      prefix,
      nodePath: join(prefix, 'bin', 'node'),
      cliPath: cli,
    });
    expect(updateSteps(install)).toEqual(['mama update']);
  });

  it('reads a checkout by its workspace core and prints the git steps with absolute paths', () => {
    const { workspaceRoot, packageRoot } = checkout();
    const cli = join(packageRoot, 'dist', 'cli', 'index.js');
    const { home: path, root } = home(cli);
    const install = installKind(root, path);
    expect(install).toEqual({
      kind: 'checkout',
      packageRoot,
      workspaceRoot,
      nodePath: '/fixture/node/bin/node',
      cliPath: cli,
    });
    const run = `'/fixture/node/bin/node' '${cli}'`;
    expect(updateSteps(install)).toEqual([
      `${run} stop`,
      `cd '${workspaceRoot}' && git pull --ff-only`,
      `cd '${workspaceRoot}' && pnpm install`,
      `cd '${workspaceRoot}' && pnpm build`,
      `${run} service install`,
      `${run} service start`,
    ]);
  });

  it('names anything else as other, with the path', () => {
    const packageRoot = mamaPackage(join(temp('mama-kind-other-'), 'mama-os'), '8.8.0');
    const { home: path, root } = home(join(packageRoot, 'dist', 'cli', 'index.js'));
    const install = installKind(root, path);
    expect(install).toMatchObject({ kind: 'other', packageRoot });
    expect(updateSteps(install)).toEqual([
      `no update path: ${packageRoot} is neither an npm global install nor a checkout`,
    ]);
    // Known folder or not, `other` has no update path.
    expect(() => requireServicePackage(install, packageRoot)).toThrow(
      `The service runs a package mama cannot update: ${packageRoot} is neither an npm global install nor a checkout`
    );

    const bare = temp('mama-kind-none-');
    expect(installKind(join(bare, '.mama'), bare)).toMatchObject({
      kind: 'other',
      packageRoot: null,
      reason: `no ${join(bare, '.mama', 'start.sh')}; mama service install writes it`,
    });
  });

  it('refuses a CLI that is not the package the service runs, naming both', () => {
    const service = npmInstall();
    const { home: path, root } = home(
      join(service.packageRoot, 'dist', 'cli', 'index.js'),
      join(service.prefix, 'bin', 'node')
    );
    const install = installKind(root, path);
    const stale = checkout().packageRoot;
    expect(() => requireServicePackage(install, stale)).toThrow(
      `This mama is ${stale}, but the service runs ${service.packageRoot}`
    );
    expect(() => requireServicePackage(install, service.packageRoot)).not.toThrow();
  });
});

const TODAY = new Date('2026-10-30T03:00:00.000Z');
const zone = createTimeZoneSetting('UTC');

/** npm answering the registry, then the version; records each call. */
function npm(version = '0.79.0') {
  return vi.fn<Parameters<NpmRun>, ReturnType<NpmRun>>(async (_command, args) =>
    args[0] === 'config' ? 'https://registry.fixture.test/\n' : `${version}\n`
  );
}

function checker(statePath: string, run: NpmRun, options: { current?: string; now?: Date } = {}) {
  const log: string[] = [];
  const check = createReleaseCheck({
    statePath,
    current: options.current ?? '0.78.0',
    packageKind: {
      kind: 'npm',
      packageRoot: '/p/lib/node_modules/@jungjaehoon/mama-os',
      prefix: '/p',
    },
    npmPath: '/p/bin/npm',
    timeZone: zone,
    log: (line) => log.push(line),
    onError: (error) => {
      throw error;
    },
    run,
    now: () => options.now ?? TODAY,
  });
  return { check, log };
}

describe('daily release check', () => {
  it("writes the registry's latest tag, 0600, through npm with the prefix and no credential name", async () => {
    vi.stubEnv('MAMA_TELEGRAM_TOKEN', 'fixture-telegram');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'fixture-oauth');
    vi.stubEnv('NPM_TOKEN', 'fixture-npm');
    vi.stubEnv('npm_config__authToken', 'fixture-npm-auth');
    const statePath = releaseCheckPath(temp('mama-release-'));
    mkdirSync(join(statePath, '..'), { recursive: true });
    const run = npm();
    const { check, log } = checker(statePath, run);
    await check.tick();
    expect(run.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ['/p/bin/npm', ['config', 'get', 'registry', '--no-update-notifier', '--prefix', '/p']],
      [
        '/p/bin/npm',
        [
          'view',
          '@jungjaehoon/mama-os',
          'dist-tags.latest',
          '--registry',
          'https://registry.fixture.test/',
          '--no-update-notifier',
          '--prefix',
          '/p',
        ],
      ],
    ]);
    for (const [, , env] of run.mock.calls) {
      expect(Object.keys(env).filter(isCredentialEnvName)).toEqual([]);
      expect(env.PATH).toBe(process.env.PATH);
    }
    expect(readReleaseCheck(statePath)).toEqual({
      checkedAt: TODAY.toISOString(),
      current: '0.78.0',
      latest: '0.79.0',
      error: null,
    });
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(log).toEqual(['release check: latest=0.79.0 running=0.78.0']);
  });

  it('makes no call at a second boot the same day; the next day, or another version, checks again', async () => {
    const statePath = releaseCheckPath(temp('mama-release-'));
    mkdirSync(join(statePath, '..'), { recursive: true });
    await checker(statePath, npm()).check.tick();

    const again = npm();
    await checker(statePath, again, { now: new Date('2026-10-30T23:59:00.000Z') }).check.tick();
    expect(again).not.toHaveBeenCalled();

    await checker(statePath, again, { now: new Date('2026-10-31T00:01:00.000Z') }).check.tick();
    expect(again).toHaveBeenCalledTimes(2);

    // An updated daemon: the file described the version before it.
    const updated = npm();
    await checker(statePath, updated, {
      current: '0.79.0',
      now: new Date('2026-10-31T00:02:00.000Z'),
    }).check.tick();
    expect(updated).toHaveBeenCalledTimes(2);
    expect(readReleaseCheck(statePath)).toMatchObject({ current: '0.79.0', latest: '0.79.0' });
  });

  it("records a failed check with npm's code, and counts it as the day's check", async () => {
    const statePath = releaseCheckPath(temp('mama-release-'));
    mkdirSync(join(statePath, '..'), { recursive: true });
    const offline = vi.fn<Parameters<NpmRun>, ReturnType<NpmRun>>(async () => {
      throw Object.assign(new Error('Command failed'), {
        code: 1,
        stderr:
          'npm error code ENOTFOUND\nnpm error request to https://registry.fixture.test/ failed\n',
      });
    });
    const { check, log } = checker(statePath, offline);
    await check.tick();
    expect(readReleaseCheck(statePath)).toEqual({
      checkedAt: TODAY.toISOString(),
      current: '0.78.0',
      latest: null,
      error: 'ENOTFOUND',
    });
    expect(log).toEqual(['release check: failed code=ENOTFOUND running=0.78.0']);
    await checker(statePath, offline).check.tick();
    expect(offline).toHaveBeenCalledTimes(1);

    const garbled = releaseCheckPath(temp('mama-release-'));
    mkdirSync(join(garbled, '..'), { recursive: true });
    await checker(garbled, npm('<html>')).check.tick();
    expect(readReleaseCheck(garbled)?.error).toBe('ENOVERSION');
  });

  it('writes nothing when a stop cuts the call off', async () => {
    const statePath = releaseCheckPath(temp('mama-release-'));
    mkdirSync(join(statePath, '..'), { recursive: true });
    const holder: { check?: ReturnType<typeof createReleaseCheck> } = {};
    const run = vi.fn<Parameters<NpmRun>, ReturnType<NpmRun>>(
      async (_command, _args, _env, signal) => {
        holder.check!.stop();
        expect(signal.aborted).toBe(true);
        throw Object.assign(new Error('aborted'), { code: 'ABORT_ERR' });
      }
    );
    const check = checker(statePath, run).check;
    holder.check = check;
    await check.tick();
    expect(readReleaseCheck(statePath)).toBeNull();
  });

  it('checks a minute after start, then hourly, and stops with the daemon', async () => {
    vi.useFakeTimers();
    try {
      const statePath = releaseCheckPath(temp('mama-release-'));
      mkdirSync(join(statePath, '..'), { recursive: true });
      const run = npm();
      let now = TODAY;
      const check = createReleaseCheck({
        statePath,
        current: '0.78.0',
        packageKind: { kind: 'other', packageRoot: null, reason: 'fixture' },
        npmPath: '/p/bin/npm',
        timeZone: zone,
        log: () => {},
        onError: (error) => {
          throw error;
        },
        run,
        now: () => now,
      });
      check.start();
      await vi.advanceTimersByTimeAsync(59_999);
      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(2);
      // An hour later the same day: the file says it is done.
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(run).toHaveBeenCalledTimes(2);
      now = new Date('2026-10-31T00:30:00.000Z');
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(run).toHaveBeenCalledTimes(4);
      check.stop();
      now = new Date('2026-11-01T00:30:00.000Z');
      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
      expect(run).toHaveBeenCalledTimes(4);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the npm beside start.sh's pinned Node, which a Homebrew upgrade keeps", () => {
    const exists = (path: string) => path === '/opt/homebrew/opt/node/bin/node';
    expect(npmBesideNode('/opt/homebrew/Cellar/node/25.8.0/bin/node', exists)).toBe(
      '/opt/homebrew/opt/node/bin/npm'
    );
    expect(npmBesideNode('/usr/bin/node', exists)).toBe('/usr/bin/npm');
  });

  it('reduces a failed npm call to a code and nothing else', () => {
    expect(npmErrorCode({ code: 'ENOENT' })).toBe('ENOENT');
    expect(npmErrorCode({ code: null, killed: true, signal: 'SIGTERM' })).toBe('ETIMEDOUT');
    expect(npmErrorCode({ code: 1, stderr: 'something else' })).toBe('EXIT_1');
    expect(npmErrorCode({ code: 1, stderr: 'npm ERR! code E404\n' })).toBe('E404');
    expect(npmErrorCode({ code: 1, stderr: 'npm error code <script>\n' })).toBe('UNKNOWN');
  });
});

describe('mama status release line', () => {
  it('reads only the file, with a network that throws, stopped or not', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetch);
    const { packageRoot } = npmInstall();
    const { home: path, root } = home(join(packageRoot, 'dist', 'cli', 'index.js'));
    const configPath = join(root, 'config.yaml');
    const status = async (args: string[] = []) => {
      const lines: string[] = [];
      expect(await runStatus(args, { home: path, configPath, write: (l) => lines.push(l) })).toBe(
        STATUS_STOPPED_EXIT
      );
      return lines;
    };
    expect(await status()).toEqual(['stopped']);

    const at = '2026-10-30T01:00:00.000Z';
    const local = new Date(at).toLocaleString('sv-SE');
    const write = (state: Record<string, unknown>) =>
      writeFileSync(releaseCheckPath(root), JSON.stringify(state), { mode: 0o600 });
    write({ checkedAt: at, current: '0.78.0', latest: '0.79.0', error: null });
    expect(await status()).toEqual([
      'stopped',
      `release: newer release 0.79.0 (checked ${local}); the daemon runs 0.78.0`,
      '  update: mama update',
    ]);
    expect(JSON.parse((await status(['--json']))[0]).release).toEqual({
      checkedAt: at,
      current: '0.78.0',
      latest: '0.79.0',
      error: null,
    });

    write({ checkedAt: at, current: '0.78.0', latest: null, error: 'ECONNREFUSED' });
    expect(await status()).toEqual([
      'stopped',
      `release: last check failed at ${local}: ECONNREFUSED`,
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });
});
