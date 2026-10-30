/**
 * A temp install for `mama update`: a real journal, real renames, a real database and real launch
 * files; npm (unless real), the service manager, the daemon, backup and restore are stand-ins that
 * act on the same folders. The children (`update --continue`, `update --rollback --continue`) run
 * in-process with the version of the package now at the CLI's path, as the real child would. A
 * killed updater is one whose next call never returns and whose update.lock is dropped, as the
 * operating system drops a dead process's lock.
 */
import { expect, vi } from 'vitest';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { startScript } from '../../src/cli/launch-files.js';
import { serviceFile } from '../../src/cli/commands/service.js';
import {
  runUpdate,
  takeLock,
  type UpdateDeps,
  type UpdateOptions,
} from '../../src/cli/commands/update.js';
import type { Check } from '../../src/cli/runtime/diagnostics.js';
import { readUpdateJournal, updatePaths } from '../../src/cli/runtime/update-journal.js';
import { backupFiles } from '../../src/cli/runtime/backup.js';

export const roots: string[] = [];

export const NAME = '@jungjaehoon/mama-os';

export interface Release {
  bin?: string[];
  /** The daemon exits at boot. */
  crash?: boolean;
  /** Its boot migrates the database. */
  migrates?: boolean;
  /** Doctor fails at step 11 on this check. */
  doctorFails?: string;
  /** `mama service install` fails (step 10). */
  installFails?: boolean;
  /** `mama tools install` fails (step 12). */
  toolsFail?: boolean;
  /** Its `engines.node`; none by default. */
  engines?: string;
  /** The Node its install/node.json pins (written only on a managed install). */
  nodePin?: string;
}

export type Fixture = ReturnType<typeof fixture>;

/** An npm prefix whose package `from` the service runs, with its daemon running. */
export function fixture(
  options: {
    from?: string;
    releases?: Record<string, Release>;
    latest?: string;
    toolkit?: string;
    serviceFile?: boolean;
    /** Real npm against a local registry: start.sh pins this Node, and npm beside it runs. */
    realNpm?: { nodePath: string; install: (prefix: string) => void };
    /** More of the owner's environment (npm's own settings). */
    env?: NodeJS.ProcessEnv;
    /**
     * As the install command lays it out: Node in `<root>/node`, the prefix in `<root>/npm`, at
     * this Node version.
     */
    managed?: string;
  } = {}
) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mama-update-')));
  const tools = realpathSync(mkdtempSync(join(tmpdir(), 'mama-update-tools-')));
  roots.push(base, tools);
  const home = join(base, 'home');
  const root = join(home, '.mama');
  mkdirSync(join(root, 'runtime'), { recursive: true });
  mkdirSync(join(root, 'logs'));
  const prefix = options.managed === undefined ? join(base, 'prefix') : join(root, 'npm');
  const scope = join(prefix, 'lib', 'node_modules', '@jungjaehoon');
  const packageRoot = join(scope, 'mama-os');
  const nodePath =
    options.realNpm?.nodePath ??
    join(options.managed === undefined ? base : root, 'node', 'bin', 'node');
  /**
   * A Node folder: its version file says what `bin/node --version` prints, and any other run of
   * that node (install.sh's recovery runs `node <cli> stop` and `service start`) is logged beside
   * the folder in calls.log.
   */
  const writeNode = (folder: string, version: string) => {
    mkdirSync(join(folder, 'bin'), { recursive: true });
    writeFileSync(
      join(folder, 'bin', 'node'),
      [
        '#!/bin/sh',
        'here=$(dirname "$0")',
        '[ "$1" = --version ] && { echo "v$(cat "$here/../version")"; exit 0; }',
        'shift',
        'echo "mama $* on $(cat "$here/../version")" >> "$here/../../calls.log"',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    writeFileSync(join(folder, 'bin', 'npm'), '');
    writeFileSync(join(folder, 'version'), version);
  };
  if (!options.realNpm) writeNode(dirname(dirname(nodePath)), options.managed ?? '22.23.4');
  const releases: Record<string, Release> = { '1.0.0': {}, '1.1.0': {}, ...options.releases };
  const from = options.from ?? '1.0.0';
  const writePackage = (at: string, version: string) => {
    mkdirSync(join(at, 'dist', 'cli'), { recursive: true });
    const bin = releases[version]?.bin ?? ['mama', 'mama-os'];
    writeFileSync(
      join(at, 'package.json'),
      JSON.stringify({
        name: NAME,
        version,
        bin: Object.fromEntries(bin.map((name) => [name, './dist/cli/index.js'])),
      })
    );
    writeFileSync(join(at, 'dist', 'cli', 'index.js'), `// mama-os ${version}\n`);
    if (options.managed !== undefined) {
      mkdirSync(join(at, 'install'), { recursive: true });
      writeFileSync(
        join(at, 'install', 'node.json'),
        JSON.stringify({ version: releases[version]?.nodePin ?? options.managed })
      );
    }
  };
  if (options.realNpm) options.realNpm.install(prefix);
  else writePackage(packageRoot, from);
  const cliPath = join(packageRoot, 'dist', 'cli', 'index.js');
  const startPath = join(root, 'start.sh');
  const launch = startScript({
    home,
    nodePath,
    cliPath,
    executablePaths: ['/fixture/bin/codex'],
    viewer: { MAMA_API_PORT: '3999' },
    logLevel: 'info',
  });
  writeFileSync(startPath, launch, { mode: 0o700 });
  const service = serviceFile({ home, platform: 'darwin' });
  if (options.serviceFile !== false) {
    mkdirSync(dirname(service), { recursive: true });
    writeFileSync(service, '<plist>fixture</plist>\n', { mode: 0o600 });
  }
  if (options.toolkit !== undefined) {
    const version = join(tools, 'v-fixture');
    mkdirSync(join(version, 'bin'), { recursive: true });
    for (const name of ['bin/python3', 'fonts.conf', 'pyvenv.cfg', 'soffice'])
      writeFileSync(join(version, name), 'fixture');
    writeFileSync(
      join(version, 'manifest.json'),
      JSON.stringify({
        version: 1,
        soffice: join(version, 'soffice'),
        requirementsSha256: options.toolkit,
      })
    );
    symlinkSync('v-fixture', join(tools, 'current'));
  }
  const databasePath = join(root, 'state.db');
  const seed = new Database(databasePath);
  seed.exec(`CREATE TABLE schema_version (version INTEGER, source TEXT);
    INSERT INTO schema_version VALUES (106, 'core'), (1, 'standalone');
    CREATE TABLE mailbox_inputs (id INTEGER PRIMARY KEY AUTOINCREMENT, stimulus_id TEXT);
    INSERT INTO mailbox_inputs (stimulus_id) VALUES ('telegram:1:1'), ('telegram:1:2');`);
  seed.close();
  const configPath = join(root, 'config.yaml');
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      agent: { backend: 'codex', model: 'fixture', max_turns: 10, timeout: 1000 },
      database: { path: databasePath },
      logging: { level: 'info', file: join(root, 'logs', 'daemon.log') },
      telegram: { enabled: false },
      ...(options.toolkit !== undefined ? { tools_root: tools } : {}),
    })
  );

  const lines: string[] = [];
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const npmEnvs: NodeJS.ProcessEnv[] = [];
  /** Bot API calls the /update progress made: method and parameters. */
  const telegram: Array<{
    token: string;
    method: string;
    params: Record<string, string>;
    timeoutMs: number | undefined;
  }> = [];
  const childEnvs: NodeJS.ProcessEnv[] = [];
  const state = {
    /** The version the daemon runs, or null. */
    running: from as string | null,
    /** The running daemon booted as a held candidate and was not released yet. */
    held: false,
    heldAtBoot: [] as string[],
    stopFails: false,
    /** The stop fails while this holds (checked at each stop). */
    stopFailsWhen: null as (() => boolean) | null,
    /** The daemon answers before boot read the journal: running, without its hold. */
    unheldStatus: false,
    /** The backup writes its archive somewhere other than the name it was given. */
    backupElsewhere: false,
    /** npm ls names a version that is not the one in place. */
    lsWrong: false,
    stagingFails: false,
    backupFails: false,
    /** `name#n`: the n-th call of that dep never returns; the updater was killed there. */
    killAt: null as string | null,
    /** `name#n`: the n-th call of that dep waits for `resume()`. */
    pauseAt: null as string | null,
    resume: null as (() => void) | null,
    /** The parent is killed (and its update.lock freed) once its `--continue` child starts. */
    orphanParent: false,
    /** The orphaned child's own run, which goes on. */
    child: null as Promise<number> | null,
    /** The previous version's start fails during a rollback. */
    rollbackStartFails: false,
    /** The previous version's `--rollback --continue` dies on a signal. */
    rollbackChildKilled: false,
    /** npm ls exits 1 for a problem elsewhere in the prefix, and still prints its tree. */
    lsProblems: false,
    /** `npm rebuild` fails (the Node move's step 2). */
    rebuildFails: false,
    /** Prefixes `npm rebuild` ran on, with the Node it ran beside. */
    rebuilt: [] as Array<{ prefix: string; node: string }>,
    /** Doctor's Node check fails under a Node of this version. */
    nodeCheckFailsOn: null as string | null,
    /** The daemon exits at boot under a Node of this version. */
    bootFailsOn: null as string | null,
    /** The Node version the running daemon reports. */
    runningNode: null as string | null,
    checks: [] as Check[],
    journalModes: [] as number[],
    /**
     * The Bot API refuses (a number: that error code), cannot be reached (true), or fails with an
     * error that quotes the request's URL, token included ('url').
     */
    telegramFails: null as number | true | 'url' | null,
  };
  const paths = updatePaths(root);
  const locks: Array<{ path: string; lock: { release(): void } }> = [];
  const packageVersion = (at = packageRoot) =>
    (JSON.parse(readFileSync(join(at, 'package.json'), 'utf8')) as { version: string }).version;
  const inputs = () => {
    const read = new Database(databasePath, { readonly: true });
    try {
      return (
        read.prepare('SELECT COUNT(*) AS count FROM mailbox_inputs').get() as { count: number }
      ).count;
    } finally {
      read.close();
    }
  };
  const step = <T>(name: string, run: () => Promise<T> | T): Promise<T> => {
    calls.push(name);
    const count = (counts.get(name) ?? 0) + 1;
    counts.set(name, count);
    if (state.killAt === `${name}#${count}`) {
      state.killAt = null;
      // A killed process's lock goes with it; here parent and child die together.
      for (const { lock } of locks.splice(0)) lock.release();
      return new Promise<T>(() => {});
    }
    if (state.pauseAt === `${name}#${count}`) {
      state.pauseAt = null;
      return new Promise<T>((resolve, reject) => {
        state.resume = () => {
          state.resume = null;
          Promise.resolve().then(run).then(resolve, reject);
        };
      });
    }
    return Promise.resolve().then(run);
  };

  /** The version of the Node folder a `bin/node` path is in. */
  const versionOf = (node: string) => readFileSync(join(dirname(dirname(node)), 'version'), 'utf8');
  const fakeNpm: UpdateDeps['npm'] = async (args, node, env) => {
    npmEnvs.push(env);
    if (args[0] === 'rebuild') {
      return await step('npm rebuild', () => {
        if (state.rebuildFails) {
          throw Object.assign(new Error('npm failed'), { stderr: 'npm error code ELIFECYCLE\n' });
        }
        const rebuilt = args[args.indexOf('--prefix') + 1];
        state.rebuilt.push({ prefix: rebuilt, node });
        // What the rebuild changed: the prefix it ran on is the one built for that Node.
        writeFileSync(join(rebuilt, 'built-for'), versionOf(node));
        return '';
      });
    }
    expect(node).toBe(nodePath);
    if (args[0] === 'config') return 'http://registry.fixture.test/\n';
    if (args[0] === 'view') {
      const asked = args[1].slice(NAME.length + 1);
      const answer = asked === 'latest' ? (options.latest ?? '1.1.0') : asked;
      if (!(answer in releases)) {
        throw Object.assign(new Error('npm failed'), { stderr: 'npm error code E404\n' });
      }
      if (args[2] === 'engines.node') return `${releases[answer].engines ?? ''}\n`;
      return `${answer}\n`;
    }
    if (args[0] === 'install') {
      // npm creates the prefix before it fetches anything.
      const staging = args[args.indexOf('--prefix') + 1];
      mkdirSync(staging, { recursive: true });
      return await step('npm install', () => {
        if (state.stagingFails) {
          throw Object.assign(new Error('npm failed'), { stderr: 'npm error code EACCES\n' });
        }
        const target = args[4].slice(NAME.length + 1);
        writePackage(join(staging, 'lib', 'node_modules', '@jungjaehoon', 'mama-os'), target);
        return '';
      });
    }
    if (args[0] === 'ls') {
      return await step('npm ls', () => {
        const tree = JSON.stringify({
          dependencies: { [NAME]: { version: state.lsWrong ? '9.9.9' : packageVersion() } },
        });
        if (state.lsProblems) {
          throw Object.assign(new Error('npm failed'), {
            code: 1,
            stdout: tree,
            stderr: 'npm error code ELSPROBLEMS\n',
          });
        }
        return tree;
      });
    }
    throw new Error(`unexpected npm ${args.join(' ')}`);
  };
  const deps = (version: string): Partial<UpdateDeps> => ({
    ...(options.realNpm ? {} : { npm: fakeNpm }),
    stop: (now) =>
      step(now ? 'stop --now' : 'stop', () => {
        if (state.stopFails || state.stopFailsWhen?.()) return 1;
        state.running = null;
        state.runningNode = null;
        state.held = false;
        return 0;
      }),
    start: () =>
      step('start', () => {
        // start.sh exits 0 on the hold file.
        if (existsSync(paths.hold) || state.running !== null) return;
        const journal = readUpdateJournal(paths.journal);
        if (state.rollbackStartFails && journal?.phase === 'rollback') {
          throw new Error('the fixture service did not start');
        }
        const booting = packageVersion();
        const release = releases[booting] ?? {};
        const node = options.managed === undefined ? null : versionOf(nodePath);
        const db = new Database(databasePath);
        try {
          if (release.migrates) db.exec(`INSERT INTO schema_version VALUES (107, 'core')`);
          if (release.crash || (node !== null && state.bootFailsOn === node)) return;
          state.running = booting;
          state.runningNode = node;
          state.held = journal?.phase === 'candidate';
          if (state.held) state.heldAtBoot.push(booting);
          // Accepting goes on, held or not: a message arrives.
          db.prepare('INSERT INTO mailbox_inputs (stimulus_id) VALUES (?)').run(
            `telegram:1:${booting}`
          );
        } finally {
          db.close();
        }
      }),
    installService: (node, cli) =>
      step('service install', () => {
        expect(node).toBe(nodePath);
        expect(cli).toBe(cliPath);
        if (releases[version]?.installFails) throw new Error('codex is not on this PATH');
        // The new templates, as the new version writes them.
        writeFileSync(startPath, `${launch}# ${version}\n`, { mode: 0o700 });
      }),
    backup: (prefix, now) => {
      // As mama backup does: its staging folder and the partial archive (credentials in it)
      // exist while it works, and are what a cut-off backup leaves.
      const files = backupFiles(join(root, 'backups'), now, prefix);
      mkdirSync(files.staging, { recursive: true, mode: 0o700 });
      writeFileSync(files.partial, 'partial snapshot with credentials', { mode: 0o600 });
      return step('backup', () => {
        rmSync(files.staging, { recursive: true, force: true });
        rmSync(files.partial, { force: true });
        if (state.backupFails) throw new Error('Backup failed and nothing was kept: disk full');
        state.journalModes.push(statSync(paths.journal).mode & 0o777);
        // The journal names it before it is written.
        expect(readUpdateJournal(paths.journal)?.snapshot).toBe(files.final);
        const archive = state.backupElsewhere
          ? join(root, 'backups', 'elsewhere.tar.gz')
          : files.final;
        copyFileSync(databasePath, archive);
        return archive;
      });
    },
    serviceRuns: () => state.running !== null,
    restore: (archive) =>
      step('restore', () => {
        copyFileSync(archive, databasePath);
      }),
    toolsInstall: () =>
      step(`tools install ${version}`, () => {
        if (releases[version]?.toolsFail) throw new Error('Document toolkit install failed');
      }),
    diagnostics: () =>
      step('doctor', () => {
        const fails = releases[version]?.doctorFails;
        return [
          ...state.checks,
          ...(fails ? [{ name: fails, status: 'fail', detail: 'new', code: fails } as Check] : []),
        ];
      }),
    control: (op) =>
      step(op, () => {
        if (state.running === null) return { state: 'stopped' as const, holder: null };
        if (op === 'release') {
          const held = state.held;
          state.held = false;
          return { state: 'running' as const, reply: { ok: true, held } };
        }
        return {
          state: 'running' as const,
          reply: {
            ok: true,
            status: {
              stage: 'running',
              version: state.running,
              ...(options.managed === undefined
                ? {}
                : { node: `v${state.runningNode ?? options.managed}` }),
              update: state.held && !state.unheldStatus ? { since: 1, to: state.running } : null,
            },
          },
        };
      }),
    health: async (port) => {
      expect(port).toBe(3999);
      return true;
    },
    runCli: async (node, cli, args, env) => {
      childEnvs.push(env);
      expect(node).toBe(nodePath);
      // `<node> <cli> update …`: the package now at the CLI's path is the program that runs.
      expect(args[0]).toBe('update');
      const run = () =>
        runUpdate(args.slice(1), settings(packageVersion(dirname(dirname(dirname(cli))))));
      if (state.orphanParent && args[1] === '--continue') {
        state.orphanParent = false;
        state.child = run();
        // The parent is SIGKILLed: its update.lock goes, its child goes on.
        await vi.waitFor(() =>
          expect(locks.some(({ path }) => path === paths.continuation.lockPath)).toBe(true)
        );
        for (const held of locks.filter(({ path }) => path === paths.lock.lockPath)) {
          held.lock.release();
          locks.splice(locks.indexOf(held), 1);
        }
        return await new Promise<never>(() => {});
      }
      if (state.rollbackChildKilled && args[1] === '--rollback') {
        state.rollbackChildKilled = false;
        return { code: null, signal: 'SIGKILL' };
      }
      return { code: await run(), signal: null };
    },
    lock: (lockPaths, command) => {
      const lock = takeLock(lockPaths, command);
      const entry = { path: lockPaths.lockPath, lock };
      locks.push(entry);
      return {
        owner: lock.owner,
        release: () => {
          lock.release();
          if (locks.includes(entry)) locks.splice(locks.indexOf(entry), 1);
        },
      };
    },
    nodeVersion: async (node) => versionOf(node),
    nodeCheck: (node, cli) =>
      step('node check', (): Check => {
        expect(cli).toBe(cliPath);
        const at = versionOf(node);
        return state.nodeCheckFailsOn === at
          ? {
              name: 'node',
              status: 'fail',
              detail:
                'the Node start.sh runs cannot load the SQLite module MAMA was installed with',
            }
          : { name: 'node', status: 'ok', detail: `v${at} loads SQLite` };
      }),
    version: () => version,
    runningPackage: () => packageRoot,
    telegramCall: async (token, method, params = {}, timeoutMs) => {
      telegram.push({ token, method, params, timeoutMs });
      if (state.telegramFails === true) throw new TypeError('fetch failed');
      if (state.telegramFails === 'url')
        throw new Error(`request to https://api.telegram.org/bot${token}/${method} failed`);
      if (state.telegramFails !== null) return { ok: false, error_code: state.telegramFails };
      return { ok: true, result: { message_id: telegram.length } };
    },
    bootWaitMs: 50,
    pollMs: 5,
  });
  const settings = (version: string): UpdateOptions => ({
    home,
    configPath,
    platform: 'darwin',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: home,
      MAMA_TELEGRAM_TOKEN: 'fixture-secret',
      GITHUB_TOKEN: 'fixture-secret',
      ...options.env,
    },
    write: (line) => lines.push(line),
    deps: deps(version),
  });
  return {
    home,
    root,
    base,
    writeNode,
    versionOf,
    prefix,
    scope,
    packageRoot,
    nodePath,
    cliPath,
    startPath,
    launch,
    paths,
    state,
    lines,
    calls,
    npmEnvs,
    childEnvs,
    telegram,
    run: async (args: string[]) => await runUpdate(args, settings(packageVersion())),
    /** Run the CLI at the given package folder, as the owner runs a printed command. */
    runAt: async (packageAt: string, args: string[]) =>
      await runUpdate(args, settings(packageVersion(packageAt))),
    packageVersion,
    inputs,
    output: () => lines.join('\n'),
    journal: () => readUpdateJournal(paths.journal),
    scopeEntries: () => readdirSync(scope).sort(),
    backups: () => (existsSync(join(root, 'backups')) ? readdirSync(join(root, 'backups')) : []),
  };
}

/** The install as an update leaves it: one package in place, nothing of the update left. */
export function expectClean(f: Fixture, version: string) {
  expect(f.packageVersion()).toBe(version);
  expect(f.scopeEntries()).toEqual(['mama-os']);
  expect(f.journal()).toBeNull();
  expect(existsSync(f.paths.hold)).toBe(false);
  expect(existsSync(f.paths.copies)).toBe(false);
  expect(f.backups()).toEqual([]);
}

/** Start an update that is killed at `at`, and wait until it is. */
export async function killedAt(f: Fixture, at: string, args: string[] = []) {
  f.state.killAt = at;
  void f.run(args);
  await vi.waitFor(() => expect(f.state.killAt).toBeNull());
}
