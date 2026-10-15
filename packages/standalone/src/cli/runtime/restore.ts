import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import * as tar from 'tar';
import type { W1Config } from '../../runtime/config.js';
import { pathsFor } from '../commands/daemon.js';
import type { BackupEntry, BackupManifest, ConfiguredPath } from './backup.js';

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

/**
 * Stored paths that MAMA reads back to open a file: attachments in mailbox payloads, the
 * connector event index and the chat raw store. Evidence (observation versions) and history
 * (tool traces) keep the paths they recorded.
 */
export const CORE_PATH_COLUMNS: [string, string][] = [
  ['mailbox_inputs', 'payload_json'],
  ['connector_event_index', 'metadata_json'],
];
export const RAW_PATH_COLUMNS: [string, string][] = [
  ['raw_items', 'metadata'],
  ['pending_core_projections', 'payload_json'],
];

export type TargetPaths = Record<string, string | null>;

/** Where the target install keeps each configured path; destinations come only from here. */
export function targetPaths(config: W1Config, configPath: string, home: string): TargetPaths {
  const paths = pathsFor(configPath, config);
  return {
    home: resolve(home),
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
  };
}

function safeArchivePath(path: string): boolean {
  if (path === '' || isAbsolute(path) || path.includes('\0') || path.includes('\\')) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function prefixOf(path: string): string | null {
  const prefixes = Object.keys(PREFIX_KEYS).sort((left, right) => right.length - left.length);
  return prefixes.find((prefix) => path === prefix || path.startsWith(`${prefix}/`)) ?? null;
}

/**
 * The manifest is the archive's first entry. An archive can be replaced by anyone who can write
 * the backups folder, so it is checked as untrusted: known format, safe relative paths under
 * known prefixes, and nothing else.
 */
export async function readManifest(archive: string): Promise<BackupManifest> {
  let first: string | null = null;
  let text = '';
  await tar.t({
    file: archive,
    onReadEntry: (entry) => {
      first ??= entry.path;
      if (entry.path === 'manifest.json' && first === 'manifest.json' && text === '') {
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

export function validateManifest(manifest: BackupManifest): void {
  if (manifest?.format !== 'mama-backup' || manifest.version !== 1) {
    throw new Error('not a MAMA backup this version can read');
  }
  if (!Array.isArray(manifest.entries) || !Array.isArray(manifest.databases)) {
    throw new Error('the archive manifest has no entry list');
  }
  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    if (!safeArchivePath(entry.path) || prefixOf(entry.path) === null || seen.has(entry.path)) {
      throw new Error(
        `the archive manifest names an entry it may not: ${JSON.stringify(entry.path)}`
      );
    }
    if (!['file', 'dir', 'symlink'].includes(entry.type)) {
      throw new Error(`the archive manifest gives ${entry.path} an unknown type`);
    }
    if (entry.type === 'file' && !/^[0-9a-f]{64}$/.test(entry.sha256 ?? '')) {
      throw new Error(`the archive manifest gives ${entry.path} no hash`);
    }
    seen.add(entry.path);
  }
  for (const [key, value] of Object.entries(manifest.configured ?? {})) {
    if (value !== null && (!isAbsolute(value.configured) || !isAbsolute(value.physical))) {
      throw new Error(`the archive manifest gives ${key} a relative path`);
    }
  }
}

/** Old configured paths (both forms) and the target's, longest first, for rewriting text. */
export function pathPairs(
  configured: Record<string, ConfiguredPath | null>,
  target: TargetPaths
): [string, string][] {
  const pairs = new Map<string, string>();
  for (const [key, old] of Object.entries(configured)) {
    const next = target[key];
    if (!old || !next) continue;
    for (const form of [old.configured, old.physical]) {
      if (form !== next && !pairs.has(form)) pairs.set(form, next);
    }
  }
  return [...pairs].sort((left, right) => right[0].length - left[0].length);
}

/** Replace each old path, where it starts a JSON or YAML string or stands alone, by its new one. */
export function rewriteText(text: string, pairs: readonly [string, string][]): string {
  let result = text;
  for (const [old, next] of pairs) {
    for (const quote of ['"', "'", ' ']) {
      result = result.split(`${quote}${old}/`).join(`${quote}${next}/`);
      result = result
        .split(`${quote}${old}${quote === ' ' ? '\n' : quote}`)
        .join(`${quote}${next}${quote === ' ' ? '\n' : quote}`);
    }
  }
  return result;
}

/**
 * Rewrite stored file paths in one database copy. Update triggers on these tables would treat a
 * changed row as a new event (connector_event_index renumbers its ingest sequence), so they are
 * dropped and recreated from their own text around the update, in one transaction.
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
        for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
        for (const [old, next] of pairs) {
          changed += db
            .prepare(
              `UPDATE "${table}" SET "${column}" = REPLACE(REPLACE("${column}", ?, ?), ?, ?)
                WHERE instr("${column}", ?) > 0`
            )
            .run(`"${old}/`, `"${next}/`, `"${old}"`, `"${next}"`, `"${old}`).changes;
        }
        for (const trigger of triggers) db.exec(trigger.sql);
      }
    })();
  } finally {
    db.close();
  }
  return changed;
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

/** Extract into a fresh folder and hold every entry to the manifest: types, links, contents. */
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
    // Only what the manifest lists; the manifest itself is already read.
    filter: (path) => expected.has(path.replace(/\/+$/, '')),
  });
  const problems: string[] = [];
  for (const entry of manifest.entries) {
    const path = join(staging, ...entry.path.split('/'));
    if (!lstatExists(path)) {
      problems.push(`${entry.path} is missing`);
      continue;
    }
    const stat = lstatSync(path);
    const type = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'dir' : 'file';
    if (type !== entry.type) problems.push(`${entry.path} is a ${type}, not a ${entry.type}`);
    else if (type === 'symlink' && readlinkSync(path) !== entry.target) {
      problems.push(`${entry.path} links elsewhere`);
    } else if (type === 'file' && (await hashFile(path)) !== entry.sha256) {
      problems.push(`${entry.path} does not match its hash`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `the archive does not match its manifest (${problems.length}: ${problems.slice(0, 5).join('; ')})`
    );
  }
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
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

/** Remove a tree whose folders may be sealed read-only, without following links. */
export function removeTree(path: string): void {
  if (!lstatExists(path)) return;
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
  /** Files that belong with the destination and go aside with it (a database's -wal). */
  readonly companions?: string[];
}

interface JournalStep {
  destination: string;
  sibling: string;
  aside: string;
  companions: string[];
  state: 'staged' | 'aside' | 'switched';
}

export interface RestoreJournal {
  readonly id: string;
  readonly steps: JournalStep[];
}

export function journalPath(root: string): string {
  return join(root, 'backups', '.restore-journal.json');
}

function writeJournal(path: string, journal: RestoreJournal): void {
  const staged = `${path}.${process.pid}.tmp`;
  writeFileSync(staged, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
  renameSync(staged, path);
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

/**
 * Put every staged copy in place: each destination goes aside, its copy takes its name, and a
 * journal records each step so a failure, or a later `mama restore --rollback`, puts every
 * destination back.
 */
export function switchUnits(root: string, units: readonly SwitchUnit[], id: string): void {
  const path = journalPath(root);
  const journal: RestoreJournal = {
    id,
    steps: units.map((unit) => ({
      destination: unit.destination,
      sibling: join(dirname(unit.destination), `.mama-restore-${id}-${basename(unit.destination)}`),
      aside: join(
        dirname(unit.destination),
        `.mama-restore-${id}-old-${basename(unit.destination)}`
      ),
      companions: unit.companions ?? [],
      state: 'staged' as const,
    })),
  };
  writeJournal(path, journal);
  try {
    units.forEach((unit, index) => {
      const step = journal.steps[index];
      moveBeside(unit.staged, step.sibling);
      if (lstatExists(step.destination)) renameSync(step.destination, step.aside);
      // Recorded at once, so a failure from here on puts the destination back.
      step.state = 'aside';
      writeJournal(path, journal);
      for (const companion of step.companions) {
        if (lstatExists(companion)) {
          renameSync(companion, `${step.aside}${companion.slice(step.destination.length)}`);
        }
      }
      renameSync(step.sibling, step.destination);
      step.state = 'switched';
      writeJournal(path, journal);
    });
  } catch (error) {
    rollBack(root);
    throw error;
  }
}

/** Undo a switch from its journal, then drop the journal; what is left aside is restored. */
export function rollBack(root: string): number {
  const path = journalPath(root);
  if (!existsSync(path)) return 0;
  const journal = JSON.parse(readFileSync(path, 'utf8')) as RestoreJournal;
  let undone = 0;
  for (const step of [...journal.steps].reverse()) {
    if (step.state === 'switched') {
      renameSync(step.destination, step.sibling);
      step.state = 'aside';
    }
    if (step.state === 'aside') {
      if (lstatExists(step.aside)) renameSync(step.aside, step.destination);
      for (const companion of step.companions) {
        const aside = `${step.aside}${companion.slice(step.destination.length)}`;
        if (lstatExists(aside)) renameSync(aside, companion);
      }
      step.state = 'staged';
      undone += 1;
    }
    removeTree(step.sibling);
  }
  rmSync(path, { force: true });
  return undone;
}

/** After a switch that held: drop what went aside, and the journal. */
export function finishSwitch(root: string): void {
  const path = journalPath(root);
  const journal = JSON.parse(readFileSync(path, 'utf8')) as RestoreJournal;
  for (const step of journal.steps) {
    removeTree(step.aside);
    for (const companion of step.companions) {
      rmSync(`${step.aside}${companion.slice(step.destination.length)}`, { force: true });
    }
  }
  rmSync(path, { force: true });
}

/** Each archive prefix's destination, from the target's configuration by key. */
export function destinationOf(prefix: string, target: TargetPaths): string {
  const key = PREFIX_KEYS[prefix];
  const base = target[key];
  if (!base) {
    throw new Error(
      `the archive holds ${prefix}, but the target install has no ${key} configured; set it in config.yaml first`
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

export function newRestoreId(): string {
  return randomUUID().slice(0, 8);
}
