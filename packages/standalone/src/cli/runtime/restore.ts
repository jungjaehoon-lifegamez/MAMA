import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  cpSync,
  createReadStream,
  existsSync,
  lstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { CodexThreadRegistry } from '@jungjaehoon/mama-core/runtime/drivers/codex-thread-registry';
import Database from 'better-sqlite3';
import * as yaml from 'js-yaml';
import * as tar from 'tar';
import type { W1Config } from '../../runtime/config.js';
import { pathsFor } from '../commands/daemon.js';
import {
  ROOT_DIRS,
  ROOT_FILES,
  RUNTIME_DIRS,
  RUNTIME_FILES,
  type BackupEntry,
  type BackupManifest,
  type ConfiguredPath,
} from './backup.js';
import { restoreJournalPath } from './daemon-control.js';

/** Every archive prefix a backup writes, and the configured key its destination comes from. */
const PREFIX_KEYS: Record<string, string> = {
  root: 'root',
  workspace: 'workspace',
  members: 'member_root',
  skills: 'tools_root',
  wiki: 'wiki',
  'jev-vocab': 'jev_vocab',
  'log-file': 'log_file',
  database: 'database',
  'credentials/auth.env': 'root',
  'credentials/jev-key': 'jev_key',
  'credentials/codex-auth.json': 'codex_home',
  'credentials/mcp-config.json': 'mcp_config',
};
/** Prefixes whose entry is a folder; the rest are single files. */
const FOLDER_PREFIXES = new Set(['root', 'workspace', 'members', 'skills', 'wiki']);
/**
 * Stored paths MAMA reads back to open a file: attachments in mailbox payloads (turn orders) and
 * in the connector event index (deferred deliveries). The raw stores' content hash covers their
 * metadata, so they, observation versions (evidence) and tool traces (history) keep the paths
 * they recorded.
 */
export const PATH_COLUMNS: [string, string][] = [
  ['mailbox_inputs', 'payload_json'],
  ['connector_event_index', 'metadata_json'],
];
/** The folder roots that stored attachment paths sit under. */
const REWRITTEN_KEYS = ['root', 'workspace', 'member_root', 'tools_root', 'wiki'];
/**
 * Config keys that name a place. A restored config keeps the backup's settings with this
 * install's values for these, so the files and the config agree.
 */
const PATH_KEYS: string[][] = [
  ['member_root'],
  ['tools_root'],
  ['database', 'path'],
  ['logging', 'file'],
  ['jev', 'keyFile'],
  ['jev', 'vocabFile'],
  ['wiki', 'vaultPath'],
  ['wiki', 'wikiDir'],
  ['agent', 'codex_home'],
  ['agent', 'codex_cwd'],
  ['agent', 'tools', 'mcp_config'],
];

export type TargetPaths = Record<string, string | null>;

/** Where an install keeps each configured path. */
export function targetPaths(config: W1Config, configPath: string, home: string): TargetPaths {
  const paths = pathsFor(configPath, config);
  return {
    root: resolve(paths.mamaRoot),
    workspace: resolve(paths.workspaceDir),
    database: resolve(config.database.path),
    member_root: config.member_root ? resolve(config.member_root) : null,
    tools_root: config.tools_root ? resolve(config.tools_root) : null,
    codex_home: resolve(config.agent.codex_home ?? join(paths.mamaRoot, '.codex')),
    mcp_config: resolve(paths.mcpConfigPath),
    log_file: resolve(config.logging.file),
    jev_vocab: resolve(config.jev.vocabFile),
    jev_key: resolve(config.jev.keyFile),
    wiki:
      config.wiki?.enabled && config.wiki.vaultPath && config.wiki.wikiDir
        ? resolve(config.wiki.vaultPath, config.wiki.wikiDir)
        : null,
    home: resolve(home),
  };
}

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function prefixOf(path: string): string | null {
  const prefixes = Object.keys(PREFIX_KEYS).sort((left, right) => right.length - left.length);
  return prefixes.find((prefix) => path === prefix || path.startsWith(`${prefix}/`)) ?? null;
}

function safeArchivePath(path: string): boolean {
  if (path === '' || isAbsolute(path) || path.includes('\0') || path.includes('\\')) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** The archive reads its first entry as the manifest and checks it as untrusted. */
export async function readManifest(archive: string): Promise<BackupManifest> {
  let first: string | null = null;
  let text = '';
  await tar.t({
    file: archive,
    onReadEntry: (entry) => {
      const isFirst = first === null;
      first ??= entry.path;
      if (isFirst && entry.path === 'manifest.json') {
        entry.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      } else {
        entry.resume();
      }
    },
  });
  if (first !== 'manifest.json') throw new Error('the archive does not start with a manifest');
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(text) as BackupManifest;
  } catch {
    throw new Error('the archive manifest cannot be parsed');
  }
  validateManifest(manifest);
  return manifest;
}

/**
 * Hold a manifest to what `mama backup` writes. Anyone who can write the backups folder can
 * replace an archive, and an archive can come from elsewhere, so the rules are structural:
 * known prefixes and safe relative paths, only the root names a backup keeps, nothing beneath a
 * link (a backup never walks through one), credentials only in a backup that says it has them.
 */
export function validateManifest(manifest: BackupManifest): void {
  if (manifest?.format !== 'mama-backup' || manifest.version !== 1) {
    throw new Error('not a MAMA backup this version can read');
  }
  if (!Array.isArray(manifest.entries) || !Array.isArray(manifest.databases)) {
    throw new Error('the archive manifest has no entry list');
  }
  const refuse = (path: string, why: string): never => {
    throw new Error(`the archive manifest names ${JSON.stringify(path)}, which ${why}`);
  };
  const configured = manifest.configured ?? {};
  for (const [key, value] of Object.entries(configured)) {
    if (value !== null && (!isAbsolute(value.configured) || !isAbsolute(value.physical))) {
      throw new Error(`the archive manifest gives ${key} a relative path`);
    }
  }
  const workspaceTop = workspaceInRoot(manifest);
  const rootNames = new Set<string>([
    ...ROOT_FILES,
    ...ROOT_DIRS,
    ...(workspaceTop ? [workspaceTop] : []),
  ]);
  const runtimeNames = new Set<string>([...RUNTIME_FILES, ...RUNTIME_DIRS]);
  // Agents make links in workspaces, and published skills are links; nothing else a daemon
  // writes through may be one (a planted downloads/ link would take the next attachment).
  const linkAllowed = (parts: string[]): boolean => {
    const inWorkspace = parts.indexOf('workspace');
    return (
      (parts[0] === 'workspace' && parts.length >= 2) ||
      (parts[0] === 'root' &&
        workspaceTop !== null &&
        parts[1] === workspaceTop &&
        parts.length >= 3) ||
      (parts[0] === 'skills' && parts.length === 2) ||
      (parts[0] === 'members' && inWorkspace >= 2 && inWorkspace < parts.length - 1)
    );
  };
  if (workspaceTop && manifest.entries.some((entry) => prefixOf(entry.path) === 'workspace')) {
    throw new Error('the archive manifest holds the workspace both inside the root and on its own');
  }
  const links: string[] = [];
  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    const path = entry.path;
    if (typeof path !== 'string' || !safeArchivePath(path) || seen.has(path)) {
      refuse(String(path), 'is not a safe archive path');
    }
    const prefix = prefixOf(path);
    if (prefix === null) return refuse(path, 'is under no known prefix');
    if (!['file', 'dir', 'symlink'].includes(entry.type)) refuse(path, 'has an unknown type');
    if (entry.type === 'file' && !/^[0-9a-f]{64}$/.test(entry.sha256 ?? '')) {
      refuse(path, 'has no hash');
    }
    if (prefix.startsWith('credentials/') && !manifest.includesSecrets) {
      refuse(path, 'is a credential in a backup that says it holds none');
    }
    const folder = FOLDER_PREFIXES.has(prefix);
    if (path === prefix && entry.type !== (folder ? 'dir' : 'file')) {
      refuse(path, `is not a ${folder ? 'folder' : 'file'}`);
    }
    if (!folder && path !== prefix) refuse(path, 'sits beneath a single-file prefix');
    const parts = path.split('/');
    if (prefix === 'root' && parts.length >= 2 && !rootNames.has(parts[1])) {
      refuse(path, 'is not a name a backup keeps in the MAMA root');
    }
    if (prefix === 'root' && parts[1] === 'runtime' && parts.length >= 3) {
      if (!runtimeNames.has(parts[2])) refuse(path, 'is not a runtime file a backup keeps');
    }
    if (entry.type === 'symlink') {
      if (typeof entry.target !== 'string' || entry.target === '') refuse(path, 'links nowhere');
      if (!linkAllowed(parts)) refuse(path, 'is a link where a backup holds none');
      links.push(path);
    }
    seen.add(path);
  }
  for (const link of links) {
    if (manifest.entries.some((entry) => entry.path.startsWith(`${link}/`))) {
      refuse(link, 'is a link with entries beneath it');
    }
  }
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolvePromise(hash.digest('hex')))
      .on('error', reject);
  });
}

/**
 * Extract the listed files and folders into a fresh folder and hold each to the manifest; links
 * are made afterwards from the manifest itself (tar refuses absolute link targets, which a
 * workspace can hold, and making them last means nothing is ever written through one).
 */
export async function extractVerified(
  archive: string,
  manifest: BackupManifest,
  staging: string
): Promise<void> {
  const expected = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  mkdirSync(staging, { recursive: false, mode: 0o700 });
  await tar.x({
    file: archive,
    cwd: staging,
    strict: true,
    // Each entry's tar type must be what the manifest says: a hard link listed as a file could
    // tie a restored path to a file outside the archive.
    filter: (path, entry) => {
      const want = expected.get(path.replace(/\/+$/, ''));
      const type = (entry as { type?: string }).type;
      if (want?.type === 'file') return type === 'File' || type === 'OldFile';
      if (want?.type === 'dir') return type === 'Directory';
      return false;
    },
  });
  const problems: string[] = [];
  for (const entry of manifest.entries) {
    if (entry.type === 'symlink') continue;
    const path = join(staging, ...entry.path.split('/'));
    if (!lexists(path)) {
      problems.push(`${entry.path} is missing`);
      continue;
    }
    const stat = lstatSync(path);
    const type = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'dir' : 'file';
    if (type !== entry.type) problems.push(`${entry.path} is a ${type}, not a ${entry.type}`);
    else if (type === 'file' && (await hashFile(path)) !== entry.sha256) {
      problems.push(`${entry.path} does not match its hash`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `the archive does not match its manifest (${problems.length}: ${problems.slice(0, 5).join('; ')})`
    );
  }
  for (const entry of manifest.entries) {
    if (entry.type !== 'symlink') continue;
    const path = join(staging, ...entry.path.split('/'));
    // The validator refused anything beneath a link, so the parent is a real staged folder.
    if (!lstatSync(dirname(path)).isDirectory()) throw new Error(`${entry.path} has no folder`);
    symlinkSync(entry.target!, path);
  }
}

/** Set every entry's recorded mode: files first, then folders from the deepest up. */
export function applyModes(staging: string, entries: readonly BackupEntry[]): void {
  const at = (entry: BackupEntry) => join(staging, ...entry.path.split('/'));
  for (const entry of entries) if (entry.type === 'file') chmodSync(at(entry), entry.mode);
  const folders = entries
    .filter((entry) => entry.type === 'dir')
    .sort((left, right) => right.path.split('/').length - left.path.split('/').length);
  for (const entry of folders) chmodSync(at(entry), entry.mode);
}

/**
 * The backup's config with this install's places: every path key takes the value this install's
 * config gives it, or is removed so this install's default applies. Comments do not survive.
 */
export function restoredConfigText(backupText: string, targetText: string): string {
  const backup = (yaml.load(backupText) ?? {}) as Record<string, unknown>;
  const target = (yaml.load(targetText) ?? {}) as Record<string, unknown>;
  const read = (object: Record<string, unknown>, keys: string[]): unknown =>
    keys.reduce<unknown>(
      (node, key) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined,
      object
    );
  for (const keys of PATH_KEYS) {
    const value = read(target, keys);
    const last = keys[keys.length - 1];
    if (value !== undefined) {
      // Create the parents a target value needs (a wiki the backup did not configure).
      let node = backup;
      for (const key of keys.slice(0, -1)) {
        if (!node[key] || typeof node[key] !== 'object') node[key] = {};
        node = node[key] as Record<string, unknown>;
      }
      node[last] = value;
    } else {
      const holder = keys.length === 1 ? backup : read(backup, keys.slice(0, -1));
      if (holder && typeof holder === 'object') delete (holder as Record<string, unknown>)[last];
    }
  }
  return yaml.dump(backup, { lineWidth: -1, noRefs: true });
}

/** Old folder roots (both recorded forms) and their new places, longest first. */
export function pathPairs(
  configured: Record<string, ConfiguredPath | null>,
  target: TargetPaths
): [string, string][] {
  const pairs = new Map<string, string>();
  for (const key of REWRITTEN_KEYS) {
    const old = configured[key];
    const next = target[key];
    if (!old || !next) continue;
    for (const form of [old.configured, old.physical]) {
      if (form !== next && !pairs.has(form)) pairs.set(form, next);
    }
  }
  return [...pairs].sort((left, right) => right[0].length - left[0].length);
}

/** Replace, in one pass, each JSON string that starts with an old root by the new root. */
export function rewritePaths(text: string, pairs: readonly [string, string][]): string {
  if (pairs.length === 0) return text;
  const next = new Map(pairs);
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`"(${pairs.map(([old]) => escape(old)).join('|')})(?=[/"])`, 'g');
  return text.replace(pattern, (_match, old: string) => `"${next.get(old)}`);
}

/**
 * Rewrite stored attachment paths in a staged database. Update triggers on these tables would
 * treat a changed row as a new event (connector_event_index renumbers its ingest sequence), so
 * they are dropped and recreated from their own text around the update, in one transaction.
 */
export function rewriteDatabase(
  path: string,
  columns: readonly [string, string][],
  pairs: readonly [string, string][]
): number {
  const db = new Database(path, { fileMustExist: true });
  let changed = 0;
  try {
    db.transaction(() => {
      for (const [table, column] of columns) {
        const exists = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table);
        if (!exists) continue;
        const triggers = db
          .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?")
          .all(table) as { name: string; sql: string }[];
        // The staged database came from the archive: its schema text is data, run one
        // statement at a time and only as what it claims to be.
        for (const trigger of triggers) {
          if (!/^\s*CREATE\s+TRIGGER\b/i.test(trigger.sql ?? '')) {
            throw new Error(`trigger ${JSON.stringify(trigger.name)} has no CREATE TRIGGER text`);
          }
          db.prepare(`DROP TRIGGER "${trigger.name.replace(/"/g, '""')}"`).run();
        }
        const update = db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE rowid = ?`);
        const rows = db
          .prepare(
            `SELECT rowid AS id, "${column}" AS value FROM "${table}" WHERE instr("${column}", '"/') > 0`
          )
          .all() as { id: number; value: string }[];
        for (const row of rows) {
          const value = rewritePaths(row.value, pairs);
          if (value !== row.value) changed += update.run(value, row.id).changes;
        }
        // prepare() compiles exactly one statement and refuses a string with more.
        for (const trigger of triggers) db.prepare(trigger.sql).run();
      }
    })();
  } finally {
    db.close();
  }
  return changed;
}

/** Host jobs in flight hold absolute paths and inode snapshots that cannot survive a move. */
export function hostJobsInFlight(path: string): number {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const exists = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mailbox_host_checkpoints'"
      )
      .get();
    if (!exists) return 0;
    // A finished or abandoned job keeps its row until its input is pruned; only open ones count.
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM mailbox_host_checkpoints c
             JOIN mailbox_inputs m ON m.id = c.input_id
            WHERE m.status IN ('pending', 'claimed')`
        )
        .get() as { n: number }
    ).n;
  } finally {
    db.close();
  }
}

/** Remove a tree whose folders may be sealed read-only, without following links. */
export function removeTree(path: string): void {
  if (!lexists(path)) return;
  const open = (current: string): void => {
    const stat = lstatSync(current);
    if (!stat.isDirectory()) return;
    chmodSync(current, 0o700);
    for (const name of readdirSync(current)) open(join(current, name));
  };
  open(path);
  rmSync(path, { recursive: true, force: true });
}

/** One path to replace: the staged copy goes where the destination is. */
export interface SwitchUnit {
  readonly staged: string;
  readonly destination: string;
  /** Files that belong with the destination and move with it (a database's -wal). */
  readonly companions?: string[];
}

type StepState = 'planned' | 'moving-aside' | 'switching' | 'switched' | 'rolled-back';

interface JournalStep {
  destination: string;
  sibling: string;
  aside: string;
  companionEnds: string[];
  existed: boolean;
  state: StepState;
}

export interface RestoreJournal {
  readonly id: string;
  committed: boolean;
  readonly steps: JournalStep[];
}

export function journalPath(root: string): string {
  return restoreJournalPath(root);
}

/** Write the journal so it survives a power cut: whole, flushed, then renamed into place. */
function writeJournal(root: string, journal: RestoreJournal): void {
  const path = journalPath(root);
  const staged = `${path}.${process.pid}.tmp`;
  const fd = openSync(staged, 'w', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(journal)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(staged, path);
  const folder = openSync(dirname(path), 'r');
  try {
    fsyncSync(folder);
  } finally {
    closeSync(folder);
  }
}

/** Move a staged tree beside its destination, so the switch is a rename on one filesystem. */
function moveBeside(staged: string, sibling: string): void {
  mkdirSync(dirname(sibling), { recursive: true });
  try {
    renameSync(staged, sibling);
  } catch (error) {
    // Another filesystem (a Docker volume, a separate disk): copy, keeping links and modes.
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    cpSync(staged, sibling, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      errorOnExist: true,
      force: false,
    });
    removeTree(staged);
  }
}

function moveWith(from: string, to: string, ends: readonly string[]): void {
  for (const end of ends) if (lexists(from + end)) renameSync(from + end, to + end);
}

/**
 * Put every staged copy in place. For each unit the copy moves beside its destination, the
 * destination goes aside, and the copy takes its name. The journal records each step before it
 * happens; a failure, or a later `mama restore --rollback`, puts every destination back from what
 * is on disk. Nothing set aside is deleted until the journal says the whole switch held.
 */
export function switchUnits(
  root: string,
  units: readonly SwitchUnit[],
  id: string,
  rename: (from: string, to: string) => void = renameSync
): void {
  // Two units with one destination, or one inside another, would set aside each other's copy.
  const destinations = units.map((unit) => resolve(unit.destination)).sort();
  destinations.forEach((destination, index) => {
    const next = destinations[index + 1];
    if (next !== undefined && (next === destination || next.startsWith(`${destination}/`))) {
      throw new Error(`two parts of the archive go to ${next}`);
    }
  });
  const journal: RestoreJournal = {
    id,
    committed: false,
    steps: units.map((unit) => ({
      destination: unit.destination,
      sibling: join(dirname(unit.destination), `.mama-restore-${id}-${basename(unit.destination)}`),
      aside: join(
        dirname(unit.destination),
        `.mama-restore-${id}-old-${basename(unit.destination)}`
      ),
      companionEnds: (unit.companions ?? []).map((path) => path.slice(unit.destination.length)),
      existed: lexists(unit.destination),
      state: 'planned' as const,
    })),
  };
  writeJournal(root, journal);
  try {
    units.forEach((unit, index) => {
      const step = journal.steps[index];
      moveBeside(unit.staged, step.sibling);
      step.state = 'moving-aside';
      writeJournal(root, journal);
      if (step.existed) rename(step.destination, step.aside);
      moveWith(step.destination, step.aside, step.companionEnds);
      step.state = 'switching';
      writeJournal(root, journal);
      rename(step.sibling, step.destination);
      step.state = 'switched';
      writeJournal(root, journal);
    });
  } catch (error) {
    try {
      rollBack(root);
    } catch (rollbackError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; putting it back also failed (${
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        }), so the journal at ${journalPath(root)} is kept for mama restore --rollback`
      );
    }
    throw error;
  }
  journal.committed = true;
  writeJournal(root, journal);
}

/**
 * Undo an uncommitted switch from what is on disk, then drop the journal. A committed switch
 * held: its leftovers are cleared instead. Returns how many destinations were put back, or null
 * when the switch had committed.
 */
export function rollBack(
  root: string,
  rename: (from: string, to: string) => void = renameSync
): number | null {
  const path = journalPath(root);
  if (!existsSync(path)) return 0;
  const journal = JSON.parse(readFileSync(path, 'utf8')) as RestoreJournal;
  if (journal.committed) {
    finishSwitch(root);
    return null;
  }
  let undone = 0;
  for (const step of [...journal.steps].reverse()) {
    // Each step's undoing is recorded as it is done, so a rollback that stops can run again.
    if (step.state === 'rolled-back') continue;
    const reached = step.state === 'switching' || step.state === 'switched';
    // The copy is in place only if it left its sibling name: move it back out first.
    if (reached && !lexists(step.sibling) && lexists(step.destination)) {
      rename(step.destination, step.sibling);
      for (const end of step.companionEnds) {
        if (lexists(step.destination + end)) rename(step.destination + end, step.sibling + end);
      }
    }
    if (lexists(step.aside)) {
      if (lexists(step.destination)) {
        throw new Error(`${step.destination} and its set-aside copy both exist; resolve by hand`);
      }
      rename(step.aside, step.destination);
      for (const end of step.companionEnds) {
        if (lexists(step.aside + end)) rename(step.aside + end, step.destination + end);
      }
      undone += 1;
    } else if (step.existed && !lexists(step.destination)) {
      throw new Error(`${step.destination} is missing and nothing was set aside for it`);
    }
    removeTree(step.sibling);
    for (const end of step.companionEnds) rmSync(step.sibling + end, { force: true });
    step.state = 'rolled-back';
    writeJournal(root, journal);
  }
  rmSync(path, { force: true });
  return undone;
}

/** After a committed switch: drop what went aside, then the journal. */
export function finishSwitch(root: string): void {
  const path = journalPath(root);
  const journal = JSON.parse(readFileSync(path, 'utf8')) as RestoreJournal;
  if (!journal.committed) throw new Error('the restore journal is not committed');
  // A committed switch put every copy in place; a missing one means something moved it, and
  // the set-aside copy may then be the only one left.
  const missing = journal.steps.filter((step) => !lexists(step.destination) && lexists(step.aside));
  if (missing.length > 0) {
    throw new Error(
      `${missing.map((step) => step.destination).join(', ')} is missing while its set-aside copy remains; resolve by hand`
    );
  }
  for (const step of journal.steps) {
    removeTree(step.aside);
    for (const end of step.companionEnds) rmSync(step.aside + end, { force: true });
  }
  rmSync(path, { force: true });
}

/** Each archive prefix's destination, from the restored install's configuration by key. */
export function destinationOf(prefix: string, target: TargetPaths): string {
  const key = PREFIX_KEYS[prefix];
  const base = target[key];
  if (!base) {
    throw new Error(
      `the archive holds ${prefix}, but this install has no ${key} configured; set it in config.yaml first`
    );
  }
  if (prefix === 'skills') return join(base, 'skills');
  if (prefix === 'credentials/auth.env') return join(base, 'auth.env');
  if (prefix === 'credentials/codex-auth.json') return join(base, 'auth.json');
  return base;
}

/** The archive prefixes present, in the manifest's order. */
export function prefixesIn(manifest: BackupManifest): string[] {
  const found: string[] = [];
  for (const entry of manifest.entries) {
    const prefix = prefixOf(entry.path);
    if (prefix && !found.includes(prefix)) found.push(prefix);
  }
  return found;
}

/** The workspace's folder name when the backup kept it inside the MAMA root. */
export function workspaceInRoot(manifest: BackupManifest): string | null {
  const root = manifest.configured?.root?.physical;
  const workspace = manifest.configured?.workspace?.physical;
  return root && workspace && dirname(workspace) === root ? basename(workspace) : null;
}

/** The units a prefix switches: a folder's children one by one, never the folder itself. */
export function unitsFor(
  prefix: string,
  staging: string,
  destination: string,
  manifest: BackupManifest,
  workspace?: string
): SwitchUnit[] {
  const staged = join(staging, ...prefix.split('/'));
  if (!FOLDER_PREFIXES.has(prefix)) {
    return [
      {
        staged,
        destination,
        // A WAL left beside the old database would be applied to the new one.
        ...(prefix === 'database'
          ? { companions: ['-wal', '-shm', '-journal'].map((end) => destination + end) }
          : {}),
      },
    ];
  }
  const folder = manifest.entries.find((entry) => entry.path === prefix);
  if (!lexists(destination)) {
    mkdirSync(destination, { recursive: true, mode: folder?.mode ?? 0o700 });
  }
  const units: SwitchUnit[] = [];
  for (const name of readdirSync(staged)) {
    // start.sh names this machine's Node and paths; mama service install writes it.
    if (prefix === 'root' && name === 'start.sh') continue;
    // A workspace the backup kept inside the root goes where this install keeps its own.
    if (prefix === 'root' && workspace && name === workspaceInRoot(manifest)) {
      if (!lexists(workspace)) mkdirSync(workspace, { recursive: true, mode: 0o700 });
      for (const child of readdirSync(join(staged, name))) {
        units.push({ staged: join(staged, name, child), destination: join(workspace, child) });
      }
      continue;
    }
    // runtime/ holds the install lock, so its files are switched one by one.
    if (prefix === 'root' && name === 'runtime') {
      const runtime = join(destination, 'runtime');
      if (!lexists(runtime)) mkdirSync(runtime, { recursive: true, mode: 0o700 });
      for (const child of readdirSync(join(staged, 'runtime'))) {
        units.push({ staged: join(staged, 'runtime', child), destination: join(runtime, child) });
      }
      continue;
    }
    units.push({ staged: join(staged, name), destination: join(destination, name) });
  }
  return units;
}

/** The owner's Codex threads belong to the state before the restore; they start over. */
export function clearOwnerThreads(root: string): number {
  const threadRoot = join(root, 'codex-runtime', 'threads');
  if (!existsSync(threadRoot)) return 0;
  const registry = new CodexThreadRegistry({ rootDir: threadRoot });
  let cleared = 0;
  for (const key of ['owner:runtime', 'owner:replay']) {
    if (registry.load(key)) {
      registry.remove(key);
      cleared += 1;
    }
  }
  return cleared;
}

export function newRestoreId(): string {
  return randomUUID().slice(0, 8);
}
