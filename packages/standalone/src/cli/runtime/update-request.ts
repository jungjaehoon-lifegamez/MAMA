import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UpdateOrigin } from '../../gateways/telegram-commands.js';
import { UPDATE_JOB_LABEL, updateAgent, updateScript } from '../launch-files.js';
import type { ServiceRun } from './systemd-service.js';
import { lockHolder } from './daemon-control.js';
import { installKind, updateSteps } from './install-kind.js';
import { compareReleases, readReleaseCheck, releaseCheckPath } from './release-check.js';
import { updatePaths } from './update-journal.js';

/*
 * /update, the daemon's side (docs/development/work/update.md, PR 4): it starts `mama update` as
 * a job of its own, which outlives the daemon's stop, and records where its progress goes.
 */

/** The systemd unit the update job runs as on Linux. */
export const UPDATE_JOB_UNIT = 'mama-update';

/** The /update an update job reports to; kept after the run, so a repeat of it is refused. */
export interface UpdateRequest {
  readonly chatId: string;
  readonly messageId: number;
  readonly receivedAt: string;
}

/** Under runtime/, which the agents' native reads deny. */
export function updateRequestPath(mamaRoot: string): string {
  return join(mamaRoot, 'runtime', 'update-request.json');
}

export function readUpdateRequest(path: string): UpdateRequest | null {
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<UpdateRequest> | null;
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof value.chatId !== 'string' ||
    typeof value.messageId !== 'number' ||
    typeof value.receivedAt !== 'string'
  ) {
    throw new Error(`${path} is not an update request MAMA wrote`);
  }
  return value as UpdateRequest;
}

function writeStaged(path: string, content: string, mode: number): void {
  const staged = `${path}.${process.pid}.tmp`;
  writeFileSync(staged, content, { mode });
  chmodSync(staged, mode);
  renameSync(staged, path);
}

export type UpdateJobResult =
  | { readonly kind: 'started'; readonly from: string; readonly to: string | null }
  /**
   * `lock`: an updater holds update.lock, a terminal's `mama update` or an /update's; `job`: the
   * update job runs (it reports to its request's chat). `since`: when the lock was taken, or the
   * request's time; null when unknown.
   */
  | { readonly kind: 'busy'; readonly source: 'lock' | 'job'; readonly since: number | null }
  | { readonly kind: 'repeated' }
  | { readonly kind: 'checkout'; readonly steps: readonly string[] }
  | { readonly kind: 'not_updatable'; readonly reason: string };

export interface UpdateJobOptions {
  readonly mamaRoot: string;
  readonly home: string;
  readonly origin: UpdateOrigin;
  /** The running daemon's version. */
  readonly version: string;
  readonly platform: NodeJS.Platform;
  /** launchctl and systemd-run go through it; tests record them. */
  readonly run: ServiceRun;
  readonly uid: number;
  /** The daemon's log: what the reply leaves out is named there. */
  readonly log: (line: string) => void;
  readonly now?: () => Date;
}

/**
 * The update job as `launchctl print` shows it: not loaded; finished (`state = not running` with
 * a `last exit code`), which a new /update boots out; or anything else loaded, which runs or is
 * starting. Two /update messages are answered concurrently, and right after a bootstrap the job
 * can be loaded with no pid yet; booting that out would kill the update the first one started.
 */
function launchdJob(run: ServiceRun, uid: number): 'none' | 'finished' | 'running' {
  const result = run('launchctl', ['print', `gui/${uid}/${UPDATE_JOB_LABEL}`]);
  if (result.error) throw result.error;
  if (result.status === 113) return 'none';
  if (result.status !== 0) {
    throw new Error(`launchctl print ${UPDATE_JOB_LABEL} failed: exit ${String(result.status)}`);
  }
  const state = /^\s*state = (.+?)\s*$/m.exec(result.stdout)?.[1];
  const exited = /^\s*last exit code = (?!\(never exited\))\S/m.test(result.stdout);
  return state === 'not running' && exited ? 'finished' : 'running';
}

/** Run launchctl or systemd-run; a failure throws with the command and its own words. */
function check(run: ServiceRun, command: string, args: string[]): void {
  const result = run(command, args);
  if (result.error) throw new Error(`${command} ${args[0]} could not run: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}`.trim() || `exit ${String(result.status)}`;
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`);
  }
}

/** systemd states in which the update unit still runs. */
const SYSTEMD_RUNNING = new Set(['active', 'activating', 'deactivating', 'reloading']);

/** Whether the update job still runs: the request file must not change under it. */
function jobRuns(options: UpdateJobOptions): { loaded: boolean; running: boolean } {
  if (options.platform === 'darwin') {
    const job = launchdJob(options.run, options.uid);
    return { loaded: job !== 'none', running: job === 'running' };
  }
  if (options.platform === 'linux') {
    // `is-active` exits non-zero for a unit that does not run; its word says which state.
    const result = options.run('systemctl', ['--user', 'is-active', `${UPDATE_JOB_UNIT}.service`]);
    if (result.error) throw result.error;
    return { loaded: false, running: SYSTEMD_RUNNING.has(`${result.stdout ?? ''}`.trim()) };
  }
  throw new Error('/update runs the updater as a launchd or systemd job: macOS and Linux only');
}

/**
 * Start `mama update` for an /update. In order: the install kind (a checkout gets its git
 * steps); an updater holding update.lock, or the job still running, is left alone; a message
 * already recorded is refused, since a daemon killed before it confirmed its offset receives it
 * again; then the request is recorded, the job's files written, and the job started.
 */
export function requestUpdate(options: UpdateJobOptions): UpdateJobResult {
  const { mamaRoot, home } = options;
  const install = installKind(mamaRoot, home);
  if (install.kind === 'checkout') return { kind: 'checkout', steps: updateSteps(install) };
  if (install.kind === 'other') return { kind: 'not_updatable', reason: install.reason };

  const holder = lockHolder(updatePaths(mamaRoot).lock);
  if (holder !== null) return { kind: 'busy', source: 'lock', since: holder.startedAt || null };
  const requestPath = updateRequestPath(mamaRoot);
  const previous = readUpdateRequest(requestPath);
  const job = jobRuns(options);
  if (job.running) {
    return {
      kind: 'busy',
      source: 'job',
      since: previous === null ? null : Date.parse(previous.receivedAt),
    };
  }
  if (previous?.chatId === options.origin.chatId && previous.messageId === options.origin.messageId)
    return { kind: 'repeated' };

  const now = options.now?.() ?? new Date();
  const request: UpdateRequest = {
    chatId: options.origin.chatId,
    messageId: options.origin.messageId,
    receivedAt: now.toISOString(),
  };
  writeStaged(requestPath, `${JSON.stringify(request)}\n`, 0o600);
  const script = join(mamaRoot, 'runtime', 'update.sh');
  writeStaged(
    script,
    updateScript({
      home,
      start: readFileSync(join(mamaRoot, 'start.sh'), 'utf8'),
      nodePath: install.nodePath,
      cliPath: install.cliPath,
    }),
    0o700
  );
  // Before the job starts: nothing that can throw runs after it.
  const to = cachedNewer(mamaRoot, options.version, options.log);
  const log = join(mamaRoot, 'logs', 'update.log');
  if (options.platform === 'darwin') {
    const plist = join(mamaRoot, 'runtime', 'update.plist');
    writeStaged(plist, updateAgent(home), 0o600);
    const domain = `gui/${options.uid}`;
    // A finished job stays loaded without a pid; its label bootstraps again once booted out.
    if (job.loaded) check(options.run, 'launchctl', ['bootout', `${domain}/${UPDATE_JOB_LABEL}`]);
    check(options.run, 'launchctl', ['bootstrap', domain, plist]);
  } else {
    check(options.run, 'systemd-run', [
      '--user',
      `--unit=${UPDATE_JOB_UNIT}`,
      '--collect',
      `--property=StandardOutput=append:${log}`,
      `--property=StandardError=append:${log}`,
      script,
    ]);
  }
  return { kind: 'started', from: options.version, to };
}

/**
 * The cached release check's newer version, for the reply only: the updater asks npm itself
 * (step 2), so a cache that is a day old, failed or unreadable leaves the reply without one.
 */
function cachedNewer(
  mamaRoot: string,
  running: string,
  log: (line: string) => void
): string | null {
  try {
    const latest = readReleaseCheck(releaseCheckPath(mamaRoot))?.latest ?? null;
    return latest !== null && compareReleases(latest, running) > 0 ? latest : null;
  } catch (error) {
    // /update repairs installs (R7): a release check it cannot read leaves only the reply short.
    log(
      `update request: the cached release check cannot be read (${error instanceof Error ? error.message : String(error)}); the reply names no target`
    );
    return null;
  }
}
