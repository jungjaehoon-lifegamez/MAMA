import { execFile } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { backendEnvironment } from '../../runtime/backend-security.js';
import type { TimeZoneSetting } from '../../runtime/timezone.js';
import { stableNodePath } from '../launch-files.js';
import { installKind, PACKAGE_NAME, updateSteps, type PackageKind } from './install-kind.js';

/**
 * What the daemon's daily release check found (docs/development/work/update.md, PR 2). `mama
 * status` and `mama doctor` read only this file, so neither makes a network call.
 */
export interface ReleaseCheckState {
  /** When the check ran (ISO time); a later boot the same day makes no call. */
  readonly checkedAt: string;
  /** The version of the daemon that checked. */
  readonly current: string;
  /** The registry's `latest` tag; null when the check failed. */
  readonly latest: string | null;
  /** npm's error code (or the process's) when the check failed. */
  readonly error: string | null;
}

/** Under runtime/, which the agents' native reads deny with the rest of the credential paths. */
export function releaseCheckPath(mamaRoot: string): string {
  return join(mamaRoot, 'runtime', 'release-check.json');
}

/** The file as the daemon wrote it, or null when no check has run yet. */
export function readReleaseCheck(path: string): ReleaseCheckState | null {
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const text = (name: string, nullable: boolean) =>
    typeof value[name] === 'string' || (nullable && value[name] === null);
  if (
    value === null ||
    typeof value !== 'object' ||
    !text('checkedAt', false) ||
    Number.isNaN(Date.parse(value.checkedAt as string)) ||
    !text('current', false) ||
    !text('latest', true) ||
    !text('error', true)
  ) {
    throw new Error(`${path} is not a release check the daemon wrote`);
  }
  return value as unknown as ReleaseCheckState;
}

/** One npm call: its stdout, or a rejection carrying npm's or the process's error. */
export type NpmRun = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal
) => Promise<string>;

const NPM_TIMEOUT_MS = 60_000;

export const defaultNpmRun: NpmRun = async (command, args, env, signal) =>
  (
    await promisify(execFile)(command, args, {
      env,
      signal,
      timeout: NPM_TIMEOUT_MS,
      encoding: 'utf8',
    })
  ).stdout;

/**
 * A failed npm call reduced to a code. npm's own (`npm error code E404`) comes first; then a
 * spawn error's (ENOENT), a timeout, the exit status. Only a code's characters pass: PR 4 sends
 * it to a chat a group reads, and stderr is npm's text.
 */
export function npmErrorCode(error: unknown): string {
  const failure = (error ?? {}) as {
    stderr?: unknown;
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
  };
  const npm = /^npm (?:error|ERR!) code (\S+)/m.exec(String(failure.stderr ?? ''))?.[1];
  const code =
    npm ??
    (typeof failure.code === 'string'
      ? failure.code
      : failure.killed === true
        ? 'ETIMEDOUT'
        : typeof failure.code === 'number'
          ? `EXIT_${failure.code}`
          : typeof failure.signal === 'string'
            ? failure.signal
            : 'UNKNOWN');
  return /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : 'UNKNOWN';
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Two releases in semver precedence (semver.org, rule 11): major, minor, patch, then a version
 * without a prerelease above one with it, then the prerelease's identifiers one by one (numbers
 * numerically and below words, words in ASCII order, a longer list above its prefix). Build
 * metadata does not count. A version that is not semver throws: there is no order to guess.
 */
export function compareReleases(left: string, right: string): number {
  const parse = (version: string) => {
    const match = SEMVER.exec(version);
    if (!match) throw new Error(`${version} is not a semver version`);
    return {
      core: [match[1], match[2], match[3]].map(Number),
      pre: match[4] === undefined ? null : match[4].split('.'),
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (a.pre === null || b.pre === null) return a.pre === b.pre ? 0 : a.pre === null ? 1 : -1;
  for (let index = 0; index < Math.min(a.pre.length, b.pre.length); index += 1) {
    const [x, y] = [a.pre[index], b.pre[index]];
    if (x === y) continue;
    const [xNumber, yNumber] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (xNumber && yNumber) return Number(x) - Number(y);
    if (xNumber !== yNumber) return xNumber ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return a.pre.length - b.pre.length;
}

/**
 * Whether a Node version (no `v`) is inside a package's `engines.node` range: comparators
 * (`>=`, `>`, `<=`, `<`, `=`, bare), `^` and `~` on full or partial versions, `*` and `x`, joined
 * by spaces (all hold) and `||` (any holds). Any other form throws with the range, so a target
 * whose range cannot be read is refused rather than passed.
 */
export function nodeSatisfies(range: string, version: string): boolean {
  const cannot = (): never => {
    throw new Error(`cannot read the engines range ${JSON.stringify(range)}`);
  };
  const at = (core: number[]) => core.join('.');
  const compare = (op: string, core: number[]) => {
    const order = compareReleases(version, at(core));
    return op === '>='
      ? order >= 0
      : op === '>'
        ? order > 0
        : op === '<='
          ? order <= 0
          : op === '<'
            ? order < 0
            : order === 0;
  };
  /** Whether `version` meets one comparator. */
  const holds = (token: string): boolean => {
    if (token === '*' || token === 'x' || token === 'X') return true;
    const match = /^(>=|<=|>|<|=|\^|~)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(
      token
    );
    if (!match) return cannot();
    const [, op = '', ...raw] = match;
    const parts = raw.filter((part) => part !== undefined && !/^[xX*]$/.test(part)).map(Number);
    // A wildcard is the end of the version: 22.x.5 is not a range.
    const given = raw.findIndex((part) => part === undefined || /^[xX*]$/.test(part));
    if (given !== -1 && raw.slice(given).some((part) => part !== undefined && /^\d+$/.test(part)))
      return cannot();
    const full = [...parts, 0, 0, 0].slice(0, 3);
    const bump = (index: number) =>
      full.map((part, at) => (at < index ? part : at === index ? part + 1 : 0));
    if (op === '^') {
      if (parts.length === 0) return true;
      // The first part given that is not 0 may not change; with none, the last part given.
      const first = parts.findIndex((part) => part !== 0);
      return compare('>=', full) && compare('<', bump(first === -1 ? parts.length - 1 : first));
    }
    if (op === '~') {
      if (parts.length === 0) return true;
      return compare('>=', full) && compare('<', bump(parts.length === 1 ? 0 : 1));
    }
    if (parts.length === 3) return compare(op === '' ? '=' : op, full);
    // A partial version: bare and = mean any version under it; the others compare its bounds.
    if (parts.length === 0) return op === '' || op === '=' || op === '>=' || op === '<=';
    const next = bump(parts.length - 1);
    if (op === '' || op === '=') return compare('>=', full) && compare('<', next);
    if (op === '>=') return compare('>=', full);
    if (op === '<') return compare('<', full);
    if (op === '>') return compare('>=', next);
    return compare('<', next);
  };
  const alternatives = range.split('||').map((part) => part.trim());
  if (alternatives.some((part) => part === '')) return cannot();
  // Every comparator is read, so a form this cannot read refuses even beside one that fails.
  return alternatives
    .map((part) =>
      part
        // `>= 22.13.0` is one comparator.
        .replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1')
        .split(/\s+/)
        .map((token) => holds(token))
        .every(Boolean)
    )
    .some(Boolean);
}

function day(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export interface ReleaseCheckOptions {
  statePath: string;
  /** The running daemon's version. */
  current: string;
  /** The daemon's own package: an npm install's calls name its prefix. */
  packageKind: PackageKind;
  /** The npm beside the Node that runs the daemon. */
  npmPath: string;
  timeZone: TimeZoneSetting;
  log: (line: string) => void;
  onError: (error: unknown) => void;
  run?: NpmRun;
  /** The daemon's environment; npm gets it without credential-shaped names (start.sh exports auth.env). */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Boot's own work goes first; the daemon's other schedules also start a minute in. */
  firstTickDelayMs?: number;
}

/**
 * Once a day, ask the registry for MAMA OS's `latest` tag and write what it said. The day is the
 * configured time zone's, read from the file, so a restart the same day makes no call; a daemon
 * on a version other than the file's checks again, since the file then describes an older one.
 * A failed check counts as the day's check: its code is shown until the next day's.
 */
export function createReleaseCheck(options: ReleaseCheckOptions) {
  const run = options.run ?? defaultNpmRun;
  const env = backendEnvironment(options.env ?? process.env);
  const prefix = options.packageKind.kind === 'npm' ? ['--prefix', options.packageKind.prefix] : [];
  const stopping = new AbortController();
  const timers: Array<() => void> = [];

  const tick = async (): Promise<void> => {
    const now = options.now?.() ?? new Date();
    const zone = options.timeZone.get();
    const previous = readReleaseCheck(options.statePath);
    if (
      previous !== null &&
      previous.current === options.current &&
      day(new Date(previous.checkedAt), zone) === day(now, zone)
    ) {
      return;
    }
    let latest: string | null = null;
    let error: string | null = null;
    try {
      const registry = (
        await run(
          options.npmPath,
          ['config', 'get', 'registry', '--no-update-notifier', ...prefix],
          env,
          stopping.signal
        )
      ).trim();
      const answer = (
        await run(
          options.npmPath,
          [
            'view',
            PACKAGE_NAME,
            'dist-tags.latest',
            '--registry',
            registry,
            // npm's own update notice asks the registry again and writes ~/.npm, TTY or not.
            '--no-update-notifier',
            ...prefix,
          ],
          env,
          stopping.signal
        )
      ).trim();
      if (!/^\d+\.\d+\.\d+\S*$/.test(answer)) {
        throw Object.assign(new Error('npm view printed no version'), { code: 'ENOVERSION' });
      }
      latest = answer;
    } catch (failure) {
      // A stop cut the call off; that is not what the registry said.
      if (stopping.signal.aborted) return;
      error = npmErrorCode(failure);
    }
    const state: ReleaseCheckState = {
      checkedAt: now.toISOString(),
      current: options.current,
      latest,
      error,
    };
    const staged = `${options.statePath}.${process.pid}.tmp`;
    writeFileSync(staged, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(staged, options.statePath);
    options.log(
      error === null
        ? `release check: latest=${latest} running=${options.current}`
        : `release check: failed code=${error} running=${options.current}`
    );
  };

  const tickReported = (): void => {
    tick().catch(options.onError);
  };

  return {
    tick,
    start: () => {
      const first = setTimeout(tickReported, options.firstTickDelayMs ?? 60_000);
      // Hourly: the first tick of a new day checks again.
      const every = setInterval(tickReported, 60 * 60_000);
      first.unref();
      every.unref();
      timers.push(
        () => clearTimeout(first),
        () => clearInterval(every)
      );
    },
    stop: () => {
      for (const cancel of timers.splice(0)) cancel();
      stopping.abort();
    },
  };
}

export type ReleaseCheck = ReturnType<typeof createReleaseCheck>;

/**
 * The npm beside the Node start.sh pins (stableNodePath): Homebrew's running Node is its Cellar
 * folder, which `brew upgrade node` removes while the daemon runs; the opt link stays.
 */
export function npmBesideNode(
  execPath: string = process.execPath,
  exists: (path: string) => boolean = existsSync
): string {
  return join(dirname(stableNodePath(execPath, exists)), 'npm');
}

function localTime(iso: string): string {
  return new Date(Date.parse(iso)).toLocaleString('sv-SE');
}

export interface ReleaseReport {
  readonly status: 'ok' | 'warn';
  readonly detail: string;
  /** What could not be read (a path, an error message); never in a shared report. */
  readonly context?: string;
  readonly fix?: string;
  /** The service package's update path when a newer release is out. */
  readonly steps?: string[];
  readonly state: ReleaseCheckState | null;
}

/**
 * What `mama status` and the doctor check `release` say, from the file alone; null when no check
 * has run. A newer release names the update path of the kind the service runs.
 */
export function releaseReport(mamaRoot: string, home: string): ReleaseReport | null {
  let state: ReleaseCheckState | null;
  try {
    state = readReleaseCheck(releaseCheckPath(mamaRoot));
  } catch (error) {
    return {
      status: 'warn',
      detail: 'the last release check cannot be read',
      context: error instanceof Error ? error.message : String(error),
      fix: 'remove runtime/release-check.json; the daemon checks again within the hour',
      state: null,
    };
  }
  if (state === null) return null;
  const at = localTime(state.checkedAt);
  if (state.latest === null) {
    return { status: 'warn', detail: `last check failed at ${at}: ${state.error}`, state };
  }
  if (compareReleases(state.latest, state.current) > 0) {
    return {
      status: 'warn',
      detail: `newer release ${state.latest} (checked ${at}); the daemon runs ${state.current}`,
      steps: updateSteps(installKind(mamaRoot, home)),
      state,
    };
  }
  return { status: 'ok', detail: `${state.current} is current (checked ${at})`, state };
}
