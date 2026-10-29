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
  takeUpdateLock,
  type UpdateDeps,
  type UpdateOptions,
} from '../../src/cli/commands/update.js';
import type { Check } from '../../src/cli/runtime/diagnostics.js';
import { readUpdateJournal, updatePaths } from '../../src/cli/runtime/update-journal.js';

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
  } = {}
) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mama-update-')));
  const tools = realpathSync(mkdtempSync(join(tmpdir(), 'mama-update-tools-')));
  roots.push(base, tools);
  const home = join(base, 'home');
  const root = join(home, '.mama');
  mkdirSync(join(root, 'runtime'), { recursive: true });
  mkdirSync(join(root, 'logs'));
  const prefix = join(base, 'prefix');
  const scope = join(prefix, 'lib', 'node_modules', '@jungjaehoon');
  const packageRoot = join(scope, 'mama-os');
  const nodePath = options.realNpm?.nodePath ?? join(base, 'node', 'bin', 'node');
  if (!options.realNpm) {
    mkdirSync(dirname(nodePath), { recursive: true });
    writeFileSync(nodePath, '');
  }
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
  const childEnvs: NodeJS.ProcessEnv[] = [];
  const state = {
    /** The version the daemon runs, or null. */
    running: from as string | null,
    /** The running daemon booted as a held candidate and was not released yet. */
    held: false,
    heldAtBoot: [] as string[],
    stopFails: false,
    stagingFails: false,
    backupFails: false,
    /** `name#n`: the n-th call of that dep never returns; the updater was killed there. */
    killAt: null as string | null,
    /** The previous version's start fails during a rollback. */
    rollbackStartFails: false,
    checks: [] as Check[],
    journalModes: [] as number[],
  };
  const paths = updatePaths(root);
  const locks: Array<{ release(): void }> = [];
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
      // A killed process's lock goes with it.
      for (const lock of locks.splice(0)) lock.release();
      return new Promise<T>(() => {});
    }
    return Promise.resolve().then(run);
  };

  const fakeNpm: UpdateDeps['npm'] = async (args, node, env) => {
    npmEnvs.push(env);
    expect(node).toBe(nodePath);
    if (args[0] === 'config') return 'http://registry.fixture.test/\n';
    if (args[0] === 'view') {
      const asked = args[1].slice(NAME.length + 1);
      const answer = asked === 'latest' ? (options.latest ?? '1.1.0') : asked;
      if (!(answer in releases)) {
        throw Object.assign(new Error('npm failed'), { stderr: 'npm error code E404\n' });
      }
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
      return JSON.stringify({ dependencies: { [NAME]: { version: packageVersion() } } });
    }
    throw new Error(`unexpected npm ${args.join(' ')}`);
  };
  const deps = (version: string): Partial<UpdateDeps> => ({
    ...(options.realNpm ? {} : { npm: fakeNpm }),
    stop: (now) =>
      step(now ? 'stop --now' : 'stop', () => {
        if (state.stopFails) return 1;
        state.running = null;
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
        const db = new Database(databasePath);
        try {
          if (release.migrates) db.exec(`INSERT INTO schema_version VALUES (107, 'core')`);
          if (release.crash) return;
          state.running = booting;
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
    backup: (prefix) =>
      step('backup', () => {
        if (state.backupFails) throw new Error('Backup failed and nothing was kept: disk full');
        state.journalModes.push(statSync(paths.journal).mode & 0o777);
        mkdirSync(join(root, 'backups'), { recursive: true, mode: 0o700 });
        const archive = join(root, 'backups', `${prefix}-20261030-000000.tar.gz`);
        copyFileSync(databasePath, archive);
        return archive;
      }),
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
          reply: { ok: true, status: { stage: 'running', version: state.running } },
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
      const code = await runUpdate(
        args.slice(1),
        settings(packageVersion(dirname(dirname(dirname(cli)))))
      );
      return { code, signal: null };
    },
    lock: (lockPaths) => {
      const lock = takeUpdateLock(lockPaths);
      locks.push(lock);
      return lock;
    },
    version: () => version,
    runningPackage: () => packageRoot,
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
