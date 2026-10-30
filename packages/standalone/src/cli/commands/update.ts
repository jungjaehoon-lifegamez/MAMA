import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import {
  CORE_MIGRATION_SOURCE,
  MIGRATIONS_DIR,
  readSchemaState,
} from '@jungjaehoon/mama-core/db-manager';
import { resolveApiPort } from '../../api/viewer-server.js';
import { resolvePackageVersion } from '../../package-version.js';
import { backendEnvironment } from '../../runtime/backend-security.js';
import { defaultConfigPath, loadConfig } from '../../runtime/config.js';
import { STANDALONE_MIGRATION_SOURCE } from '../../storage/migrations-source.js';
import { readDocumentToolkit, TOOLKIT_ASSETS } from '../../tools/toolkit-state.js';
import { readStartScript, startExports } from '../launch-files.js';
import { CliInputError } from '../prompt.js';
import {
  acquireInstallLock,
  daemonControlPaths,
  InstallBusyError,
  lockHolder,
  refuseWhileRestoring,
  type LockPaths,
  requestDaemonControl,
  type DaemonControlReply,
  type InstallLock,
} from '../runtime/daemon-control.js';
import {
  defaultTelegramCall,
  nodeCheck,
  runDiagnostics,
  type Check,
} from '../runtime/diagnostics.js';
import { defaultProbeRun } from '../runtime/backend-probe.js';
import {
  INSTALL_COMMAND,
  managedNodePath,
  nodeMovePlaces,
  readNodeMoveJournal,
} from '../runtime/node-move-journal.js';
import {
  installKind,
  PACKAGE_NAME,
  requireServicePackage,
  runningPackageRoot,
  updateSteps,
} from '../runtime/install-kind.js';
import { compareReleases, nodeSatisfies, npmErrorCode } from '../runtime/release-check.js';
import { backupFiles } from '../runtime/backup.js';
import {
  leftoverStaging,
  packagePlaces,
  readUpdateJournal,
  removeSnapshot,
  removeUpdateJournal,
  rollbackCommand,
  updatePaths,
  writeUpdateJournal,
  type DoctorFailure,
  type UpdateJournal,
  type UpdatePaths,
} from '../runtime/update-journal.js';
import {
  NO_PROGRESS,
  progressCode,
  telegramProgress,
  type ProgressSink,
  type TelegramCall,
} from '../runtime/update-progress.js';
import { runBackup } from './backup.js';
import { moveNode, requireHoldingService } from './node-move.js';
import { runStop } from './control.js';
import { viewerHealth, waitForBoot } from './init.js';
import { runRestore } from './restore.js';
import {
  installService,
  serviceFile,
  serviceRuns,
  startService,
  type ServiceOptions,
} from './service.js';
import { runTools } from './tools.js';

/*
 * `mama update` (docs/development/work/update.md, PR 3) runs as two programs. The parent is the
 * old code: everything it uses is imported above, statically, because the CLI's commands load
 * lazily and from step 8 on its own files are renamed; from then it runs loaded code and Node's
 * built-ins only (better-sqlite3's binding is loaded when step 1 takes update.lock). The child,
 * `update --continue`, is the new code; a rollback finishes in the previous version's
 * `update --rollback --continue`.
 */

const USAGE =
  'Usage: mama update [<version>] [--dry-run] | mama update --rollback | mama update --node <folder>';

/** How long the new version may take to boot, as `mama init` waits (init.ts). */
const BOOT_WAIT_MS = 600_000;
/** `npm install` and `npm rebuild` download or build the native modules; the rest answer quickly. */
const NPM_INSTALL_TIMEOUT_MS = 15 * 60_000;
const NPM_TIMEOUT_MS = 60_000;

export interface CliResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** What `mama update` does to the world; tests replace it. */
export interface UpdateDeps {
  /** One npm call with the npm beside start.sh's Node, in the scrubbed environment. */
  npm(args: string[], nodePath: string, env: NodeJS.ProcessEnv): Promise<string>;
  /** `mama stop` (it drains first) or `mama stop --now`. */
  stop(now: boolean): Promise<number>;
  start(): Promise<void>;
  installService(nodePath: string, cliPath: string): Promise<void>;
  /** `mama backup --include-secrets` under the given name, started at `now`; the archive's path. */
  backup(prefix: string, now: Date): Promise<string>;
  /** Whether the installed service runs the daemon now. */
  serviceRuns(): boolean;
  restore(archive: string): Promise<void>;
  toolsInstall(): Promise<void>;
  /** `mama doctor --offline`'s checks. */
  diagnostics(): Promise<Check[]>;
  control(op: 'status' | 'release'): Promise<DaemonControlReply>;
  health(port: number): Promise<boolean>;
  /** Run another MAMA CLI with the terminal; its exit code or signal. */
  runCli(
    nodePath: string,
    cliPath: string,
    args: string[],
    env: NodeJS.ProcessEnv
  ): Promise<CliResult>;
  /** `update.lock`, or the continuation's lock; a test drops one to stand for a killed process. */
  lock(paths: LockPaths, command: string): InstallLock;
  /** A Node's version without the `v`, from `<node> --version`. */
  nodeVersion(nodePath: string): Promise<string>;
  /** Doctor's check of start.sh's Node and MAMA command (the Node move's step 4). */
  nodeCheck(nodePath: string, cliPath: string): Promise<Check>;
  /** This CLI's own version and package, read before anything is renamed. */
  version(): string;
  runningPackage(): string;
  /** The Bot API call the /update progress sends through. */
  telegramCall: TelegramCall;
  bootWaitMs: number;
  pollMs: number;
}

export interface UpdateOptions extends ServiceOptions {
  /** The environment npm and the children get scrubbed; this process's by default. */
  env?: NodeJS.ProcessEnv;
  deps?: Partial<UpdateDeps>;
}

interface Context {
  readonly home: string;
  readonly configPath: string;
  readonly root: string;
  readonly paths: UpdatePaths;
  readonly write: (line: string) => void;
  readonly deps: UpdateDeps;
  /** Without credential-shaped names: start.sh exports auth.env, and the owner's shell has its own. */
  readonly env: NodeJS.ProcessEnv;
  /** Where an /update's progress goes; nowhere for an owner's `mama update`. */
  readonly progress: ProgressSink;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The npm beside the pinned Node, run with that Node first on PATH: npm's `#!/usr/bin/env node`
 * and the install scripts that pick native binaries then use the Node the daemon runs. */
async function defaultNpm(
  args: string[],
  nodePath: string,
  env: NodeJS.ProcessEnv
): Promise<string> {
  const { stdout } = await promisify(execFile)(join(dirname(nodePath), 'npm'), args, {
    env: npmEnvironment(env, nodePath),
    // A rebuild (the Node move's step 2) downloads or builds the native modules as an install does.
    timeout:
      args[0] === 'install' || args[0] === 'rebuild' ? NPM_INSTALL_TIMEOUT_MS : NPM_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'utf8',
  });
  return stdout;
}

/** npm's environment: already scrubbed, with the pinned Node's folder first on PATH. */
export function npmEnvironment(env: NodeJS.ProcessEnv, nodePath: string): NodeJS.ProcessEnv {
  return {
    ...env,
    PATH: [dirname(nodePath), ...(env.PATH ?? '').split(delimiter).filter(Boolean)].join(delimiter),
  };
}

function defaultRunCli(
  nodePath: string,
  cliPath: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(nodePath, [cliPath, ...args], { stdio: 'inherit', env });
    // A Ctrl-C reaches the child as well; the child's end is what decides, and this side then
    // rolls back, so the parent does not die with it.
    const ignore = (): void => {};
    process.on('SIGINT', ignore);
    process.on('SIGTERM', ignore);
    const done = (): void => {
      process.off('SIGINT', ignore);
      process.off('SIGTERM', ignore);
    };
    child.once('error', (error) => {
      done();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      done();
      resolve({ code, signal });
    });
  });
}

async function defaultNodeVersion(nodePath: string): Promise<string> {
  const { stdout } = await promisify(execFile)(nodePath, ['--version'], {
    timeout: NPM_TIMEOUT_MS,
    encoding: 'utf8',
  });
  const version = /^v(\d+\.\d+\.\d+)$/.exec(stdout.trim())?.[1];
  if (version === undefined) {
    throw new Error(`${nodePath} --version printed ${JSON.stringify(stdout.trim().slice(0, 80))}`);
  }
  return version;
}

function defaultDeps(options: UpdateOptions, home: string, configPath: string): UpdateDeps {
  const service: ServiceOptions = { ...options, home, configPath };
  const write = options.write;
  const env = options.env ?? process.env;
  const waitSetting = env.MAMA_UPDATE_WAIT_MS;
  const wait = waitSetting === undefined ? BOOT_WAIT_MS : Number(waitSetting);
  if (!Number.isSafeInteger(wait) || wait <= 0) {
    throw new CliInputError(
      `MAMA_UPDATE_WAIT_MS must be a whole number of milliseconds above 0, not ${JSON.stringify(waitSetting)}`
    );
  }
  return {
    npm: defaultNpm,
    stop: async (now) => await runStop(now ? ['--now'] : [], service),
    start: async () => {
      await startService(service);
    },
    installService: async (nodePath, cliPath) => {
      await installService([], { ...service, nodePath, cliPath });
    },
    backup: async (prefix, now) =>
      await runBackup(['--include-secrets'], {
        ...service,
        archivePrefix: prefix,
        now: () => now,
      }),
    serviceRuns: () => serviceRuns(service),
    restore: async (archive) =>
      await runRestore([archive], { home, configPath, write, updateRollback: true }),
    toolsInstall: async () => await runTools(['install'], { home, configPath, write }),
    diagnostics: async () => await runDiagnostics({ home, configPath, offline: true }),
    control: async (op) =>
      await requestDaemonControl(daemonControlPaths(dirname(configPath)), op, 10_000),
    health: viewerHealth,
    runCli: defaultRunCli,
    lock: takeLock,
    nodeVersion: defaultNodeVersion,
    nodeCheck: async (nodePath, cliPath) =>
      nodeCheck(nodePath, cliPath, defaultProbeRun, dirname(configPath)),
    version: resolvePackageVersion,
    runningPackage: runningPackageRoot,
    telegramCall: defaultTelegramCall,
    // The release checks shorten the wait so a candidate that never boots fails in minutes.
    bootWaitMs: wait,
    pollMs: 1_000,
  };
}

type Mode =
  | { kind: 'update'; version: string | null; dryRun: boolean }
  | { kind: 'continue' }
  | { kind: 'rollback' }
  | { kind: 'rollback-continue' }
  | { kind: 'node'; folder: string };

function parse(args: readonly string[]): Mode {
  const flags = new Set(args.filter((arg) => arg.startsWith('--')));
  const words = args.filter((arg) => !arg.startsWith('--'));
  const only = (...names: string[]) =>
    flags.size === names.length && names.every((name) => flags.has(name)) && words.length === 0;
  if (only('--continue')) return { kind: 'continue' };
  if (only('--rollback')) return { kind: 'rollback' };
  if (only('--rollback', '--continue')) return { kind: 'rollback-continue' };
  if (args.length === 2 && args[0] === '--node' && !args[1].startsWith('--')) {
    return { kind: 'node', folder: args[1] };
  }
  if ([...flags].every((flag) => flag === '--dry-run') && flags.size <= 1 && words.length <= 1) {
    const version = words[0] ?? null;
    if (version !== null && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new CliInputError(`${USAGE} (a version such as 0.79.0)`);
    }
    return { kind: 'update', version, dryRun: flags.has('--dry-run') };
  }
  throw new CliInputError(USAGE);
}

export async function runUpdate(
  args: readonly string[],
  options: UpdateOptions = {}
): Promise<number> {
  const mode = parse(args);
  const home = options.home ?? homedir();
  const configPath = options.configPath ?? defaultConfigPath(home);
  const root = dirname(configPath);
  const write = options.write ?? ((line: string) => console.log(line));
  const deps = { ...defaultDeps(options, home, configPath), ...options.deps };
  const env = backendEnvironment(options.env ?? process.env);
  const context: Context = {
    home,
    configPath,
    root,
    paths: updatePaths(root),
    write,
    deps,
    env,
    progress: progressSink(env, root, write, deps.telegramCall),
  };
  try {
    if (mode.kind === 'continue') return await continueUpdate(context);
    if (mode.kind === 'rollback-continue') return await finishRollback(context);
    if (mode.kind === 'rollback') return await resolveJournal(context);
    if (mode.kind === 'node') return await moveNode(context, mode.folder, options);
    return await update(context, mode.version, mode.dryRun, options);
  } catch (error) {
    context.progress.send({ kind: 'error', code: errorCode(error) });
    throw error;
  } finally {
    await context.progress.flush();
  }
}

/**
 * An /update's job sets `MAMA_UPDATE_PROGRESS=telegram` (runtime/update.sh); the children it runs
 * inherit it, so the new version's steps and a rollback report to the same chat.
 */
function progressSink(
  env: NodeJS.ProcessEnv,
  root: string,
  write: (line: string) => void,
  call: TelegramCall
): ProgressSink {
  const setting = env.MAMA_UPDATE_PROGRESS;
  if (setting === undefined) return NO_PROGRESS;
  if (setting !== 'telegram') {
    throw new CliInputError(
      `MAMA_UPDATE_PROGRESS must be telegram or unset, not ${JSON.stringify(setting)}`
    );
  }
  return telegramProgress({ root, log: write, call });
}

/** A refusal with the stable code an /update's progress carries instead of its text. */
function refusal(code: string, text: string): CliInputError {
  return Object.assign(new CliInputError(text), { code });
}

/** What the chat is told of an error: its code, or whether it was a refusal. */
function errorCode(error: unknown): string {
  return (
    progressCode((error as { code?: unknown } | null)?.code) ??
    (error instanceof CliInputError ? 'refused' : 'error')
  );
}

/**
 * One updater per install: `update.lock` (which `/update`, PR 4, reads before it starts one), and
 * the continuation's own lock for the child's life.
 */
export function takeLock(paths: LockPaths, command: string): InstallLock {
  try {
    return acquireInstallLock(paths, command);
  } catch (error) {
    if (!(error instanceof InstallBusyError)) throw error;
    const holder = error.holder;
    throw refusal(
      'update.busy',
      holder === null
        ? `Another mama update holds ${paths.lockPath}`
        : `Already updating since ${new Date(holder.startedAt).toLocaleString('sv-SE')} (${holder.command}, pid ${holder.pid})`
    );
  }
}

/**
 * The continuation child's lock, for as long as it writes the journal. Its parent holds
 * update.lock; a parent killed meanwhile frees that one, and `--rollback` then finds this one held
 * and waits, instead of a second writer acting on the same journal.
 */
function takeContinuation(context: Context, command: string): InstallLock {
  return context.deps.lock(context.paths.continuation, command);
}

/** Refuse while a continuation child (a killed parent's) still runs. */
function refuseWhileContinuing(paths: UpdatePaths): void {
  const child = lockHolder(paths.continuation);
  if (child !== null) {
    throw new CliInputError(
      `The update's ${child.command} (pid ${child.pid}) still runs and writes the journal; wait for it to end, then run this again`
    );
  }
}

function packageManifest(packageRoot: string): { version: string; bin: string[] } {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    version?: unknown;
    name?: unknown;
    bin?: unknown;
  };
  const bin =
    typeof manifest.bin === 'string'
      ? [String(manifest.name).split('/').pop()!]
      : Object.keys((manifest.bin ?? {}) as Record<string, unknown>);
  return { version: String(manifest.version), bin: bin.sort() };
}

/** Failures as `mama update` compares them: name and code, or name and detail without one. */
export function doctorFailures(checks: readonly Check[]): DoctorFailure[] {
  return checks
    .filter((check) => check.status === 'fail')
    .map((check) => ({ name: check.name, code: check.code ?? check.detail }));
}

function schemaStored(databasePath: string): { name: string; stored: number }[] {
  return readSchemaState(databasePath, [
    { name: CORE_MIGRATION_SOURCE, dir: MIGRATIONS_DIR },
    STANDALONE_MIGRATION_SOURCE,
  ]).map(({ name, stored }) => ({ name, stored }));
}

function readOnly<T>(databasePath: string, read: (db: Database.Database) => T): T {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function lastInputId(databasePath: string): number {
  return readOnly(
    databasePath,
    (db) =>
      (db.prepare('SELECT MAX(id) AS id FROM mailbox_inputs').get() as { id: number | null }).id ??
      0
  );
}

function inputsAfter(databasePath: string, id: number): number {
  return readOnly(
    databasePath,
    (db) =>
      (
        db.prepare('SELECT COUNT(*) AS count FROM mailbox_inputs WHERE id > ?').get(id) as {
          count: number;
        }
      ).count
  );
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The installed toolkit's requirements hash, or null when none is installed. */
function toolkitHash(toolsRoot: string | undefined): string | null {
  const toolkit = readDocumentToolkit(toolsRoot);
  if (toolkit === null) return null;
  return (
    JSON.parse(readFileSync(join(toolkit.versionDir, 'manifest.json'), 'utf8')) as {
      requirementsSha256: string;
    }
  ).requirementsSha256;
}

/** Copy a file over another by a rename, so a reader sees the old one or the new one. */
function copyOver(from: string, to: string): void {
  const staged = `${to}.${process.pid}.update`;
  copyFileSync(from, staged);
  renameSync(staged, to);
}

/** Write the journal; a step it begins is the step an /update's progress reports. */
function save(context: Context, journal: UpdateJournal): void {
  writeUpdateJournal(context.paths.journal, journal);
  if (journal.phase === 'prepare' || journal.phase === 'candidate') {
    context.progress.send({ kind: 'step', from: journal.from, to: journal.to, step: journal.step });
  }
}

function statusSummary(reply: DaemonControlReply | null): string {
  if (reply === null) return 'the daemon does not answer its control socket';
  if (reply.state === 'stopped') return 'the daemon is stopped';
  if (reply.reply.ok !== true) return `the daemon refused status: ${String(reply.reply.error)}`;
  const status = reply.reply.status as {
    version?: unknown;
    stage?: unknown;
    runningTurns?: Array<{ count: number }>;
    inputs?: Array<{ status: string; count: number }>;
  };
  const turns = (status.runningTurns ?? []).reduce((sum, turn) => sum + turn.count, 0);
  const waiting = (status.inputs ?? []).map((input) => `${input.count} ${input.status}`);
  return `the daemon runs ${String(status.version)} (${String(status.stage)}); ${turns} turn${turns === 1 ? '' : 's'} running; inputs ${waiting.length === 0 ? 'none waiting' : waiting.join(', ')}`;
}

/** Steps 1-9, the parent: the old code. */
async function update(
  context: Context,
  version: string | null,
  dryRun: boolean,
  options: UpdateOptions
): Promise<number> {
  const { home, root, write, deps, env, paths } = context;
  // Step 1: the kind and the package.
  const install = installKind(root, home);
  if (install.kind === 'checkout') {
    write(
      `mama update serves npm installs; the service runs the checkout ${install.workspaceRoot}, which updates by git:`
    );
    for (const step of updateSteps(install)) write(`  ${step}`);
    return 1;
  }
  requireServicePackage(install, deps.runningPackage());
  // Nothing else would start the daemon again after the stop (decision 7), and only start.sh
  // reads the hold file.
  requireHoldingService(root, options);
  refuseWhileRestoring(root);
  const lock = deps.lock(paths.lock, 'update');
  try {
    const open = readUpdateJournal(paths.journal);
    if (open !== null) {
      throw refusal(
        'update.open',
        `An earlier update (${open.from} → ${open.to}) is unfinished; resolve it first: ${rollbackCommand(open)}`
      );
    }
    const move = readNodeMoveJournal(nodeMovePlaces(root).journal);
    if (move !== null) {
      throw refusal(
        'node_move.open',
        `A move of the managed Node (${move.from} → ${move.to}) is unfinished; run the install command again, which finishes or undoes it: ${INSTALL_COMMAND}`
      );
    }
    // Read now: from step 8 on, this package's own files are elsewhere.
    const old = packageManifest(install.packageRoot);
    const from = old.version;
    const packageCli = relative(install.packageRoot, realpathSync(install.cliPath));
    const leftovers = leftoverStaging(dirname(install.packageRoot));

    // Step 2: the target.
    const npm = (args: string[]) => deps.npm(args, install.nodePath, env);
    const prefixArgs = ['--prefix', install.prefix, '--no-update-notifier'];
    let registry = '';
    let target: string;
    try {
      registry = (await npm(['config', 'get', 'registry', ...prefixArgs])).trim();
      target = (
        await npm([
          'view',
          `${PACKAGE_NAME}@${version ?? 'latest'}`,
          'version',
          '--registry',
          registry,
          ...prefixArgs,
        ])
      ).trim();
    } catch (error) {
      throw refusal(
        `npm.${npmErrorCode(error)}`,
        `Could not ask ${registry || 'the registry'} for ${PACKAGE_NAME}@${version ?? 'latest'}: npm ${npmErrorCode(error)}; nothing changed`
      );
    }
    if (!/^\d+\.\d+\.\d+\S*$/.test(target)) {
      throw refusal(
        'npm.no_version',
        `${registry} has no single ${PACKAGE_NAME}@${version ?? 'latest'} (npm printed ${JSON.stringify(target.slice(0, 80))}); nothing changed`
      );
    }
    const order = compareReleases(target, from);
    if (order === 0) {
      write(`already on ${from}`);
      context.progress.send({ kind: 'current', version: from });
      return 0;
    }
    if (order < 0) {
      // R5: the newer version may have migrated the database past what the older one reads.
      throw refusal(
        'update.older',
        `Refused: ${target} is older than ${from}, which runs now; mama update does not go back a version`
      );
    }
    // The target runs on start.sh's Node, which the update does not change.
    let engines: string;
    try {
      engines = (
        await npm([
          'view',
          `${PACKAGE_NAME}@${target}`,
          'engines.node',
          '--registry',
          registry,
          ...prefixArgs,
        ])
      ).trim();
    } catch (error) {
      throw refusal(
        `npm.${npmErrorCode(error)}`,
        `Could not ask ${registry} for ${PACKAGE_NAME}@${target}'s engines: npm ${npmErrorCode(error)}; nothing changed`
      );
    }
    if (engines !== '') {
      const running = await deps.nodeVersion(install.nodePath);
      let fits: boolean;
      try {
        fits = nodeSatisfies(engines, running);
      } catch (error) {
        throw refusal('update.engines', `Refused: ${target}'s ${message(error)}; nothing changed`);
      }
      if (!fits) {
        throw refusal(
          'update.engines',
          `Refused: ${target} needs Node.js ${engines} (its engines), and start.sh runs ${running}; nothing changed. ${
            install.nodePath === managedNodePath(root)
              ? `Run the install command again, which moves the managed Node: ${INSTALL_COMMAND}`
              : 'Install a Node in that range, run mama service install with it, then mama update'
          }`
        );
      }
    }

    // Step 3: what doctor fails on already is not held against the new version.
    const failuresBefore = doctorFailures(await deps.diagnostics());

    // Step 4: the plan.
    const places = packagePlaces(install.prefix, from, target);
    const now = await deps.control('status').catch(() => null);
    write(`update: ${PACKAGE_NAME} ${from} → ${target} (npm install, prefix ${install.prefix})`);
    write(`registry: ${registry}`);
    write(`now: ${statusSummary(now)}`);
    if (failuresBefore.length > 0) {
      write(
        `doctor fails already on: ${failuresBefore.map((failure) => failure.name).join(', ')} (not held against ${target})`
      );
    }
    for (const leftover of leftovers) {
      write(`${dryRun ? 'would remove' : 'removing'} ${leftover}, left by an interrupted update`);
    }
    write('steps:');
    for (const line of [
      `stage ${target} in ${places.staging}; a failure changes nothing`,
      'drain: new inputs wait, running turns finish; then stop the service',
      `snapshot the install to ${join(root, 'backups', `mama-update-${from}-<time>.tar.gz`)} (credentials included)`,
      `swap: ${places.package} goes to ${places.aside}, ${target} takes its place`,
      `${target} rewrites start.sh and the service file, runs doctor, starts with its claims held, and is confirmed once it runs and its viewer answers`,
      `on any failure, ${from} is put back and started; the database is restored only if ${target} migrated it`,
    ]) {
      write(`  ${line}`);
    }
    if (dryRun) return 0;
    context.progress.send({ kind: 'plan', from, to: target });
    for (const leftover of leftovers) rmSync(leftover, { recursive: true, force: true });

    // Step 5: stage.
    write(`staging ${target}`);
    context.progress.send({ kind: 'step', from, to: target, step: 5 });
    try {
      await npm([
        'install',
        '-g',
        '--prefix',
        places.staging,
        `${PACKAGE_NAME}@${target}`,
        '--registry',
        registry,
        '--no-update-notifier',
        '--no-audit',
        '--no-fund',
      ]);
    } catch (error) {
      rmSync(places.staging, { recursive: true, force: true });
      throw refusal(
        `npm.${npmErrorCode(error)}`,
        `Staging ${target} failed: npm ${npmErrorCode(error)}; nothing else changed`
      );
    }
    const staged = existsSync(places.staged) ? packageManifest(places.staged) : null;
    // The links in <prefix>/bin name the old package's commands, and the swap keeps them.
    if (staged?.version !== target || staged.bin.join(' ') !== old.bin.join(' ')) {
      rmSync(places.staging, { recursive: true, force: true });
      throw refusal(
        staged === null || staged.version !== target ? 'update.not_staged' : 'update.bin_changed',
        staged === null || staged.version !== target
          ? `npm did not stage ${target} at ${places.staged}; nothing else changed`
          : `${target}'s commands (${staged.bin.join(', ')}) are not ${from}'s (${old.bin.join(', ')}); the swap would leave its links wrong, so install it with npm install -g ${PACKAGE_NAME}@${target}`
      );
    }

    // Step 6: the journal, the drain, the stop.
    const journal: UpdateJournal = {
      format: 'mama-update',
      phase: 'prepare',
      step: 6,
      from,
      to: target,
      prefix: install.prefix,
      registry,
      nodePath: install.nodePath,
      packageCli,
      previousCli: join(places.aside, packageCli),
      failuresBefore,
      snapshot: null,
      snapshotStaging: null,
      schemaBefore: null,
      lastInputId: null,
      toolkitBefore: null,
      toolkitInstalled: false,
      copies: [],
      failure: null,
      startedAt: new Date().toISOString(),
    };
    save(context, journal);
    if ((await deps.stop(false)) !== 0) {
      removeUpdateJournal(paths.journal);
      rmSync(places.staging, { recursive: true, force: true });
      context.progress.send({
        kind: 'not_updated',
        from,
        to: target,
        step: 6,
        code: 'stop.failed',
      });
      // A stop can fail after the service manager took it (a release that took too long), so the
      // install may be down now; this names which, as mama backup --restart does.
      write(
        deps.serviceRuns()
          ? `not updated: the stop did not finish (above); ${from} stays installed and still runs`
          : `not updated: the stop did not finish cleanly (above) and the service is not running; ${from} stays installed, and mama service start starts it again`
      );
      return 1;
    }
    // From the stop on, a start (a reboot, an owner's mama service start) finds the hold and
    // exits: a parent that dies after the stop leaves the install stopped, not half-changed.
    writeFileSync(paths.hold, `${process.pid}\n`, { mode: 0o600 });
    // Step 7: the snapshot, what the rollback compares with, and the launch files. Its files are
    // named first, so an update cut off mid-backup removes what that backup left.
    const startedBackup = new Date();
    const planned = backupFiles(
      join(realpathSync(root), 'backups'),
      startedBackup,
      `mama-update-${from}`
    );
    journal.step = 7;
    journal.snapshot = planned.final;
    journal.snapshotStaging = planned.staging;
    save(context, journal);
    try {
      // Named by the same backupFiles as the journal's planned paths; the rollback restores and
      // removes the journal's path, so any other one is an error, not a snapshot.
      const archive = await deps.backup(`mama-update-${from}`, startedBackup);
      if (archive !== planned.final) {
        rmSync(archive, { force: true });
        throw new Error(`the snapshot was written to ${archive}, not ${planned.final}`);
      }
      const config = loadConfig({ home, path: context.configPath, onIgnored: () => {} });
      journal.schemaBefore = schemaStored(config.database.path);
      journal.lastInputId = lastInputId(config.database.path);
      journal.toolkitBefore = toolkitHash(config.tools_root);
      mkdirSync(paths.copies, { recursive: true, mode: 0o700 });
      journal.copies = [join(root, 'start.sh'), serviceFile(options)].map((path) => {
        const copy = join(paths.copies, path.split('/').pop()!);
        copyFileSync(path, copy);
        return { path, copy };
      });
      save(context, journal);
    } catch (error) {
      write(`not updated: ${message(error)}`);
      context.progress.send({
        kind: 'not_updated',
        from,
        to: target,
        step: 7,
        code: progressCode((error as { code?: unknown }).code) ?? 'snapshot.failed',
      });
      removeSnapshot(journal);
      rmSync(paths.copies, { recursive: true, force: true });
      rmSync(places.staging, { recursive: true, force: true });
      // The hold goes before the journal: a cut here leaves a journal, which names its fix.
      rmSync(paths.hold, { force: true });
      removeUpdateJournal(paths.journal);
      try {
        await deps.start();
        write(`${from} started again`);
      } catch (startError) {
        write(`${from} did not start again either: ${message(startError)} (mama service start)`);
      }
      return 1;
    }

    // Step 8: the swap, on the hold written after the stop. From here a failure rolls back.
    try {
      journal.step = 8;
      save(context, journal);
      renameSync(places.package, places.aside);
      renameSync(places.staged, places.package);
    } catch (error) {
      journal.failure = { step: 8, message: message(error) };
      await rollBack(context, journal);
      return 1;
    }

    // Step 9: the new version carries on.
    journal.step = 9;
    save(context, journal);
    // The new version's own reports come after this one's.
    await context.progress.flush();
    let result: CliResult;
    try {
      result = await deps.runCli(
        journal.nodePath,
        join(places.package, packageCli),
        ['update', '--continue'],
        env
      );
    } catch (error) {
      result = { code: null, signal: null };
      journal.failure = { step: 9, message: `the new version did not start: ${message(error)}` };
      save(context, journal);
    }
    const after = readUpdateJournal(paths.journal);
    if (after === null) return result.code === 0 ? 0 : 1;
    // Committed: the candidate may have run inputs, so it is finished, never rolled back.
    if (after.phase === 'committed') return await finishCommitted(context, after);
    after.failure ??= {
      step: after.step,
      message:
        result.signal !== null
          ? `the new version's update ended on ${result.signal}`
          : `the new version's update exited ${String(result.code)} at step ${after.step}`,
    };
    await rollBack(context, after);
    return 1;
  } finally {
    lock.release();
  }
}

/**
 * Steps 10-14, the child: the new code, under the parent's update.lock. A failure records its
 * step and exits non-zero; the parent rolls back.
 */
async function continueUpdate(context: Context): Promise<number> {
  const own = takeContinuation(context, 'update --continue');
  try {
    return await continueUpdateHeld(context);
  } finally {
    own.release();
  }
}

/** What to print when the parent that would roll back is gone. */
function orphanNote(context: Context, journal: UpdateJournal): string {
  return lockHolder(context.paths.lock) === null
    ? `; the updater that started this is gone, so roll back with: ${rollbackCommand(journal)}`
    : '';
}

async function continueUpdateHeld(context: Context): Promise<number> {
  const { home, root, write, deps, paths } = context;
  const journal = readUpdateJournal(paths.journal);
  if (journal === null || journal.phase !== 'prepare' || journal.step < 9) {
    throw new CliInputError('mama update --continue runs only under mama update');
  }
  if (deps.version() !== journal.to) {
    throw new CliInputError(`This is ${deps.version()}; the update continues in ${journal.to}`);
  }
  const places = packagePlaces(journal.prefix, journal.from, journal.to);
  const step = (number: number): void => {
    journal.step = number;
    save(context, journal);
  };
  try {
    // Step 10: start.sh and the service file from this version's templates.
    step(10);
    await deps.installService(journal.nodePath, join(places.package, journal.packageCli));
    // Step 11: nothing doctor did not fail on before; this update's own journal does not count.
    step(11);
    const fresh = doctorFailures(await deps.diagnostics()).filter(
      (failure) =>
        failure.code !== 'update.open' &&
        !journal.failuresBefore.some(
          (before) => before.name === failure.name && before.code === failure.code
        )
    );
    if (fresh.length > 0) {
      throw Object.assign(
        new Error(
          `mama doctor --offline fails where it did not before: ${fresh.map((failure) => `${failure.name} (${failure.code})`).join(', ')}`
        ),
        // The first new failure's stable code, for an /update's chat; a detail is not a code.
        { code: progressCode(fresh[0].code) ?? 'doctor.failed' }
      );
    }
    // Step 12: the toolkit, when this version locks other requirements.
    step(12);
    const lock = sha256(join(TOOLKIT_ASSETS, 'requirements.lock'));
    if (journal.toolkitBefore !== null && journal.toolkitBefore !== lock) {
      journal.toolkitInstalled = true;
      save(context, journal);
      await deps.toolsInstall();
    }
    // Step 13: the candidate boots with its claims held, so its recovery runs nothing.
    journal.phase = 'candidate';
    step(13);
    rmSync(paths.hold, { force: true });
    await deps.start();
    // Step 14: running at this version, and its viewer answers.
    step(14);
    const port = resolveApiPort(
      startExports(readStartScript(readFileSync(join(root, 'start.sh'), 'utf8'), home))
        .MAMA_API_PORT
    );
    await waitForBoot({
      status: () => deps.control('status'),
      health: () => deps.health(port),
      timeoutMs: deps.bootWaitMs,
      pollMs: deps.pollMs,
      write,
      version: journal.to,
      next: `the update rolls back to ${journal.from}`,
    });
  } catch (error) {
    journal.failure = { step: journal.step, message: message(error) };
    save(context, journal);
    write(`update step ${journal.step} failed: ${message(error)}${orphanNote(context, journal)}`);
    context.progress.send({
      kind: 'failed',
      from: journal.from,
      to: journal.to,
      step: journal.step,
      code: progressCode((error as { code?: unknown } | null)?.code),
    });
    return 1;
  }
  // On disk before the release: from here the candidate claims, and nothing rolls it back.
  journal.phase = 'committed';
  save(context, journal);
  return await finishCommitted(context, journal);
}

/** Step 14's end: release the candidate's claims, delete what the rollback would have needed. */
async function finishCommitted(context: Context, journal: UpdateJournal): Promise<number> {
  const { paths, write, deps } = context;
  const reply = await deps.control('release');
  if (reply.state === 'running' && reply.reply.ok !== true) {
    throw new CliInputError(
      `${journal.to} refused the release: ${String(reply.reply.error)}; ${rollbackCommand(journal)} finishes it`
    );
  }
  const places = packagePlaces(journal.prefix, journal.from, journal.to);
  removeSnapshot(journal);
  rmSync(paths.copies, { recursive: true, force: true });
  rmSync(places.aside, { recursive: true, force: true });
  rmSync(places.staging, { recursive: true, force: true });
  rmSync(paths.hold, { force: true });
  // Last: a cleanup cut off leaves a committed journal, which --rollback finishes.
  removeUpdateJournal(paths.journal);
  context.progress.send({
    kind: 'updated',
    from: journal.from,
    to: journal.to,
    running: reply.state === 'running',
  });
  write(
    reply.state === 'running'
      ? `updated: ${journal.from} → ${journal.to}; it runs and claims again`
      : `updated: ${journal.from} → ${journal.to}; the daemon is not running now (mama service start)`
  );
  // An install the install command made: the new release's Node pin, which only that command
  // moves to (install.md, "Moving the managed Node").
  if (journal.nodePath === managedNodePath(context.root)) {
    const pin = (
      JSON.parse(readFileSync(join(places.package, 'install', 'node.json'), 'utf8')) as {
        version: string;
      }
    ).version;
    const running = await deps.nodeVersion(journal.nodePath);
    if (pin !== running) {
      write(
        `  ${journal.to} pins Node.js ${pin}, and MAMA runs on ${running}: run the install command again to move it: ${INSTALL_COMMAND}`
      );
    }
  }
  return 0;
}

/** `mama update --rollback`: resolve the journal a killed updater left. */
async function resolveJournal(context: Context): Promise<number> {
  const lock = context.deps.lock(context.paths.lock, 'update --rollback');
  try {
    refuseWhileContinuing(context.paths);
    const journal = readUpdateJournal(context.paths.journal);
    if (journal === null) {
      context.write('no update is unfinished');
      return 0;
    }
    if (journal.phase === 'committed') return await finishCommitted(context, journal);
    journal.failure ??= {
      step: journal.step,
      message: `the updater ended at step ${journal.step}`,
    };
    return (await rollBack(context, journal)) ? 0 : 1;
  } finally {
    lock.release();
  }
}

/**
 * The rollback's stop. A daemon that answers as the held candidate runs nothing, and one that does
 * not answer has nothing to drain: `--now`. One that answers without a hold claims work (the old
 * version a rollback already started, or a daemon the stop at step 6 never reached), so it drains.
 */
async function stopForRollback(context: Context, journal: UpdateJournal): Promise<number> {
  const reply = await context.deps.control('status').catch(() => null);
  const status =
    reply?.state === 'running' && reply.reply.ok === true
      ? (reply.reply.status as { version?: unknown; update?: { to?: unknown } | null })
      : null;
  // The control socket answers before boot reads the journal, so a candidate restarted under
  // KeepAlive can answer without its hold yet: at `candidate`, running at <to> is the candidate.
  const heldCandidate =
    journal.phase === 'candidate' &&
    (status?.update?.to === journal.to || status?.version === journal.to);
  return await context.deps.stop(status === null || heldCandidate);
}

/**
 * Rollback steps 1-3, in whichever CLI runs (the parent, or `--rollback`): stop, hold, put the
 * previous package back, and hand the rest to it. Only renames and the service manager's stop,
 * so it runs from loaded code. True when the previous version runs again.
 */
async function rollBack(context: Context, journal: UpdateJournal): Promise<boolean> {
  const { paths, write, deps, env } = context;
  const places = packagePlaces(journal.prefix, journal.from, journal.to);
  write(
    `rolling back to ${journal.from}: step ${journal.failure?.step ?? journal.step} failed: ${journal.failure?.message ?? 'unknown'}`
  );
  context.progress.send({ kind: 'rolling_back', from: journal.from, to: journal.to });
  try {
    if ((await stopForRollback(context, journal)) !== 0)
      throw new Error('the service did not stop');
    writeFileSync(paths.hold, `${process.pid}\n`, { mode: 0o600 });
    // The previous version boots without a hold from here.
    journal.phase = 'rollback';
    save(context, journal);
    if (existsSync(places.aside)) {
      if (existsSync(places.package)) {
        rmSync(places.staged, { recursive: true, force: true });
        mkdirSync(dirname(places.staged), { recursive: true });
        renameSync(places.package, places.staged);
      }
      renameSync(places.aside, places.package);
    }
    await context.progress.flush();
    const result = await deps.runCli(
      journal.nodePath,
      join(places.package, journal.packageCli),
      ['update', '--rollback', '--continue'],
      env
    );
    if (result.code === 0) return true;
    context.progress.send({ kind: 'rollback_stopped', from: journal.from, to: journal.to });
    // What it printed may be cut off (a signal); the failed step and the command are said here.
    writeFileSync(paths.hold, `${process.pid}\n`, { mode: 0o600 });
    const current = readUpdateJournal(paths.journal) ?? journal;
    write(
      `rollback did not finish: ${journal.from}'s update --rollback --continue ${result.signal === null ? `exited ${String(result.code)}` : `ended on ${result.signal}`}; the update had failed at step ${current.failure?.step ?? current.step}: ${current.failure?.message ?? 'unknown'}. The hold file is in place. Resolve it with: ${rollbackCommand(current)}`
    );
    return false;
  } catch (error) {
    writeFileSync(paths.hold, `${process.pid}\n`, { mode: 0o600 });
    context.progress.send({ kind: 'rollback_stopped', from: journal.from, to: journal.to });
    const current = readUpdateJournal(paths.journal) ?? journal;
    write(
      `rollback stopped: ${message(error)}. The install stays stopped on its hold file; the journal, the snapshot and both package folders are kept. Resolve it with: ${rollbackCommand(current)}`
    );
    return false;
  }
}

/** Rollback steps 4-7, in the previous version's CLI with its package back in place. */
async function finishRollback(context: Context): Promise<number> {
  const own = takeContinuation(context, 'update --rollback --continue');
  try {
    return await finishRollbackHeld(context);
  } finally {
    own.release();
  }
}

/**
 * `npm ls -g --json`'s answer for MAMA OS. npm exits 1 for problems elsewhere in the prefix
 * (ELSPROBLEMS) and still prints the tree, so the tree decides, not the exit.
 */
async function installedVersion(context: Context, journal: UpdateJournal): Promise<unknown> {
  let text: string;
  try {
    text = await context.deps.npm(
      ['ls', '-g', '--prefix', journal.prefix, '--depth=0', '--json', '--no-update-notifier'],
      journal.nodePath,
      context.env
    );
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout !== 'string' || stdout.trim() === '') throw error;
    text = stdout;
  }
  const listed = JSON.parse(text) as { dependencies?: Record<string, { version?: unknown }> };
  return listed.dependencies?.[PACKAGE_NAME]?.version;
}

async function finishRollbackHeld(context: Context): Promise<number> {
  const { home, root, write, deps, paths } = context;
  const journal = readUpdateJournal(paths.journal);
  if (journal === null || journal.phase !== 'rollback') {
    throw new CliInputError('mama update --rollback --continue runs only under a rollback');
  }
  if (deps.version() !== journal.from) {
    throw new CliInputError(
      `This is ${deps.version()}; the rollback continues in ${journal.from}: ${rollbackCommand(journal)}`
    );
  }
  const places = packagePlaces(journal.prefix, journal.from, journal.to);
  try {
    // 4: the saved launch files, not regenerated ones: a missing backend cannot block this.
    for (const { path, copy } of journal.copies) {
      if (existsSync(copy)) copyOver(copy, path);
    }
    // 5: the database only if the candidate migrated it; a held candidate ran no turn.
    let dropped: number | null = null;
    if (journal.snapshot !== null && journal.schemaBefore !== null) {
      const config = loadConfig({ home, path: context.configPath, onIgnored: () => {} });
      const now = schemaStored(config.database.path);
      const before = new Map(journal.schemaBefore.map((source) => [source.name, source.stored]));
      const moved = now.some((source) => source.stored !== (before.get(source.name) ?? 0));
      if (moved) {
        dropped = inputsAfter(config.database.path, journal.lastInputId ?? 0);
        await deps.restore(journal.snapshot);
      }
    }
    // 6: tools_root is outside the backup; this version's toolkit again.
    if (journal.toolkitInstalled) await deps.toolsInstall();
    // 7: start the previous version and check it.
    rmSync(paths.hold, { force: true });
    await deps.start();
    const port = resolveApiPort(
      startExports(readStartScript(readFileSync(join(root, 'start.sh'), 'utf8'), home))
        .MAMA_API_PORT
    );
    await waitForBoot({
      status: () => deps.control('status'),
      health: () => deps.health(port),
      timeoutMs: deps.bootWaitMs,
      pollMs: deps.pollMs,
      write,
      version: journal.from,
      next: 'the rollback stops here',
    });
    const installed = await installedVersion(context, journal);
    if (installed !== journal.from) {
      throw new Error(`npm ls -g shows ${PACKAGE_NAME} ${String(installed)}, not ${journal.from}`);
    }
    removeSnapshot(journal);
    rmSync(paths.copies, { recursive: true, force: true });
    rmSync(places.staging, { recursive: true, force: true });
    removeUpdateJournal(paths.journal);
    context.progress.send({
      kind: 'rolled_back',
      from: journal.from,
      to: journal.to,
      step: journal.failure?.step ?? journal.step,
    });
    write(
      `rolled back: ${journal.from} runs again; step ${journal.failure?.step ?? journal.step} of the update to ${journal.to} failed: ${journal.failure?.message ?? 'unknown'}`
    );
    write(
      dropped === null
        ? `  the database was kept: ${journal.to} did not migrate it`
        : `  ${journal.to} migrated the database, so the snapshot was restored: ${dropped} input(s) accepted after it were dropped, and Codex sessions start over`
    );
    return 0;
  } catch (error) {
    // Stopped on the hold file, everything kept, so this can be run again.
    let stopped: string;
    try {
      // The previous version may have started and run turns: it drains (stopForRollback).
      stopped =
        (await stopForRollback(context, journal)) === 0
          ? 'The install stays stopped on its hold file'
          : 'The hold file is in place, but the daemon did not stop (above) and may still run';
    } catch (stopError) {
      stopped = `The hold file is in place, but stopping the daemon failed (${message(stopError)}) and it may still run`;
    }
    writeFileSync(paths.hold, `${process.pid}\n`, { mode: 0o600 });
    context.progress.send({ kind: 'rollback_stopped', from: journal.from, to: journal.to });
    write(
      `rollback stopped: ${message(error)}. ${stopped}; the journal, the snapshot and both package folders are kept. Run again: ${rollbackCommand(journal)}`
    );
    return 1;
  }
}
