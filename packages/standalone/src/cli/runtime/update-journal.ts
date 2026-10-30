import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { shellQuote } from '../secrets.js';
import type { LockPaths } from './daemon-control.js';

/**
 * `mama update`'s journal (docs/development/work/update.md, PR 3). The parent (the old CLI) writes
 * it before it stops anything; the child (the new CLI) carries it on; a rollback, from either or
 * from `mama update --rollback` after a killed updater, reads only it. Under runtime/, which the
 * agents' native reads deny and a backup does not archive.
 */

/**
 * prepare: the parent's steps 6-9; candidate: the new version boots with its claims held;
 * committed: it runs at the new version and is never rolled back; rollback: the old version is
 * being put back, and boots without a hold.
 */
export type UpdatePhase = 'prepare' | 'candidate' | 'committed' | 'rollback';

export interface UpdateJournal {
  readonly format: 'mama-update';
  phase: UpdatePhase;
  /** The step last begun (the step table's numbers). */
  step: number;
  readonly from: string;
  readonly to: string;
  /** npm's prefix, from the package's path. */
  readonly prefix: string;
  /** What `npm config get registry` answered at step 2. */
  readonly registry: string;
  /** start.sh's pinned Node. */
  readonly nodePath: string;
  /** The MAMA command inside the package (`dist/cli/index.js`). */
  readonly packageCli: string;
  /** The previous CLI's absolute path once the old package is set aside at step 8. */
  readonly previousCli: string;
  /** Step 3's doctor failures, which step 11 compares with its own. */
  readonly failuresBefore: readonly DoctorFailure[];
  /**
   * The snapshot's archive, named before step 7's backup starts so an update cut off mid-backup
   * still finds what it left; it is a complete snapshot only once `schemaBefore` is set.
   */
  snapshot: string | null;
  /** That backup's staging folder, removed with the archive and its partial file. */
  snapshotStaging: string | null;
  /** Each migration source's stored version when the snapshot was taken. */
  schemaBefore: readonly { name: string; stored: number }[] | null;
  /** The newest mailbox input when the snapshot was taken; a restore drops those after it. */
  lastInputId: number | null;
  /** The installed toolkit's requirementsSha256 at step 7; null without a toolkit. */
  toolkitBefore: string | null;
  /** Step 12 ran `mama tools install`; a rollback runs the previous version's. */
  toolkitInstalled: boolean;
  /** start.sh and the service file, copied at step 7, which a rollback copies back. */
  copies: readonly { path: string; copy: string }[];
  /** The step that failed and its message, for the rollback's report. */
  failure: { step: number; message: string } | null;
  readonly startedAt: string;
}

/** A doctor failure as `mama update` compares them: its name and its stable code (or detail). */
export interface DoctorFailure {
  readonly name: string;
  readonly code: string;
}

export interface UpdatePaths {
  readonly journal: string;
  readonly hold: string;
  /** Where step 7 copies start.sh and the service file. */
  readonly copies: string;
  /** `update.lock`: one updater per install, CLI or chat (PR 4 reads its holder). */
  readonly lock: LockPaths;
  /**
   * Held by the continuation child (`--continue`, `--rollback --continue`) for its life. A parent
   * killed while its child runs frees update.lock; this one tells `--rollback` the child still
   * writes the journal.
   */
  readonly continuation: LockPaths;
}

export function updatePaths(mamaRoot: string): UpdatePaths {
  const runtime = join(mamaRoot, 'runtime');
  return {
    journal: join(runtime, 'update.json'),
    // start.sh tests it relative to the MAMA root (UPDATE_HOLD_LINE).
    hold: join(runtime, 'update.hold'),
    copies: join(runtime, 'update'),
    lock: {
      lockPath: join(runtime, 'update.lock'),
      holderPath: join(runtime, 'update.holder.json'),
    },
    continuation: {
      lockPath: join(runtime, 'update.continue.lock'),
      holderPath: join(runtime, 'update.continue.holder.json'),
    },
  };
}

export const PACKAGE_SCOPE = '@jungjaehoon';
export const PACKAGE_BASENAME = 'mama-os';
/** The staging prefix's name, in the scope folder: same filesystem, so the swap is two renames. */
export const STAGING_PREFIX = '.mama-update-';
/** The previous package, set aside beside it; npm skips dot folders. */
export const ASIDE_PREFIX = '.mama-os-';

export interface PackagePlaces {
  /** `<prefix>/lib/node_modules/@jungjaehoon`. */
  readonly scope: string;
  /** Where the service's package lives: the old one before the swap, the new one after. */
  readonly package: string;
  /** The previous package once set aside. */
  readonly aside: string;
  /** The staging prefix npm installs `<to>` into. */
  readonly staging: string;
  /** The package npm installed under the staging prefix. */
  readonly staged: string;
}

export function packagePlaces(prefix: string, from: string, to: string): PackagePlaces {
  const scope = join(prefix, 'lib', 'node_modules', PACKAGE_SCOPE);
  const staging = join(scope, `${STAGING_PREFIX}${to}`);
  return {
    scope,
    package: join(scope, PACKAGE_BASENAME),
    aside: join(scope, `${ASIDE_PREFIX}${from}`),
    staging,
    staged: join(staging, 'lib', 'node_modules', PACKAGE_SCOPE, PACKAGE_BASENAME),
  };
}

/** Staging prefixes left in a scope folder by an updater killed before its journal. */
export function leftoverStaging(scope: string): string[] {
  if (!existsSync(scope)) return [];
  return readdirSync(scope)
    .filter((name) => name.startsWith(STAGING_PREFIX))
    .map((name) => join(scope, name));
}

const PHASES = new Set<string>(['prepare', 'candidate', 'committed', 'rollback']);

/** The open journal, or null when no update is unfinished. */
export function readUpdateJournal(path: string): UpdateJournal | null {
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<UpdateJournal> | null;
  if (
    value === null ||
    typeof value !== 'object' ||
    value.format !== 'mama-update' ||
    !PHASES.has(String(value.phase)) ||
    typeof value.step !== 'number' ||
    typeof value.from !== 'string' ||
    typeof value.to !== 'string' ||
    typeof value.prefix !== 'string' ||
    typeof value.nodePath !== 'string' ||
    typeof value.previousCli !== 'string' ||
    typeof value.packageCli !== 'string'
  ) {
    throw new Error(`${path} is not a journal mama update wrote`);
  }
  return value as UpdateJournal;
}

function syncFile(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Write the journal durably: a staged file, synced, renamed over the old one, and the folder
 * synced, so a power cut leaves the old journal or the new one. `committed` must be on disk before
 * the candidate is released (step 14).
 */
export function writeUpdateJournal(path: string, journal: UpdateJournal): void {
  const staged = `${path}.${process.pid}.tmp`;
  writeFileSync(staged, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  syncFile(staged);
  renameSync(staged, path);
  syncFile(dirname(path));
}

export function removeUpdateJournal(path: string): void {
  rmSync(path, { force: true });
  syncFile(dirname(path));
}

/** The snapshot's archive, its partial file and its backup's staging folder, whatever exists. */
export function removeSnapshot(journal: UpdateJournal): void {
  if (journal.snapshot !== null) {
    rmSync(journal.snapshot, { force: true });
    rmSync(`${journal.snapshot}.partial`, { force: true });
  }
  if (journal.snapshotStaging !== null) {
    rmSync(journal.snapshotStaging, { recursive: true, force: true });
  }
}

/**
 * What an unfinished update leaves for `mama status` and doctor to name: an open journal and the
 * command that resolves it, or a hold file with no journal, which start.sh exits on.
 */
export function unfinishedUpdate(
  mamaRoot: string
): { journal: UpdateJournal; command: string } | { hold: string } | null {
  const paths = updatePaths(mamaRoot);
  const journal = readUpdateJournal(paths.journal);
  if (journal !== null) return { journal, command: rollbackCommand(journal) };
  return existsSync(paths.hold) ? { hold: paths.hold } : null;
}

/**
 * The command that resolves an open journal, with absolute paths: the previous CLI where it is
 * now (set aside after step 8, in place before it or once a rollback put it back).
 */
export function rollbackCommand(journal: UpdateJournal): string {
  const places = packagePlaces(journal.prefix, journal.from, journal.to);
  const cli = existsSync(places.aside)
    ? journal.previousCli
    : join(places.package, journal.packageCli);
  return `${shellQuote(journal.nodePath)} ${shellQuote(cli)} update --rollback`;
}
