import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import * as yaml from 'js-yaml';
import * as tar from 'tar';
import type { W1Config } from '../../runtime/config.js';
import { isCredentialEnvName } from '../../runtime/backend-security.js';
import { readStartScript } from '../launch-files.js';
import { pathsFor } from '../commands/daemon.js';

/** One path in a backup, named by its place in the archive. */
export interface BackupEntry {
  readonly path: string;
  readonly type: 'file' | 'dir' | 'symlink';
  /** Permission bits as they were. */
  readonly mode: number;
  readonly size?: number;
  readonly sha256?: string;
  /** A symlink's target, as stored. */
  readonly target?: string;
}

export interface BackupManifest {
  readonly format: 'mama-backup';
  readonly version: 1;
  readonly createdAt: string;
  readonly mama: string;
  readonly platform: string;
  /** The highest migration applied to the database, or null when it has none. */
  readonly schemaVersion: number | null;
  readonly includesSecrets: boolean;
  readonly includesLogs: boolean;
  /** Each archive prefix and the physical path it came from. */
  readonly roots: Record<string, string>;
  /** Every path the install was configured with, as written and as it really is. */
  readonly configured: Record<string, ConfiguredPath | null>;
  /** MAMA's own databases in the archive, each checked with integrity_check. */
  readonly databases: string[];
  readonly entries: BackupEntry[];
}

/** A tree or file archived under `prefix`, and which of its paths to keep. */
export interface BackupSource {
  readonly prefix: string;
  /** Physical path. */
  readonly path: string;
  readonly keep: (relativePath: string, stat: Stats) => boolean;
}

export interface BackupPlan {
  readonly sources: BackupSource[];
  /** The database file boot opens; the archive holds a copy taken with SQLite's backup. */
  readonly database: string;
  readonly configured: Record<string, ConfiguredPath | null>;
  /** Top-level names in the MAMA root that this version does not read. */
  readonly leftOut: string[];
  /** Credentials that exist and were left out because they were not asked for. */
  readonly secretsLeftOut: string[];
}

/** runtime/ files the current code reads back; the rest of runtime/ is per boot or per run. */
/** Files directly in the MAMA root that a backup keeps; restore accepts no other root files. */
export const ROOT_FILES = [
  'config.yaml',
  'connectors.json',
  'owner-policy.md',
  'report-slots.json',
  'start.sh',
] as const;
/** Folders in the MAMA root that a backup keeps (logs only when asked), besides the workspace. */
export const ROOT_DIRS = ['connectors', 'downloads', 'runtime', 'logs'] as const;
/** Folders in runtime/ that a backup keeps. */
export const RUNTIME_DIRS = ['backfill'] as const;
export const RUNTIME_FILES = new Set([
  'owner-message-ledger.json',
  'report-schedule-state.json',
  'client-journal.jsonl',
  'september-import-manifest.json',
  'september-replay-cursor.json',
  'september-replay-ledger.jsonl',
]);
/** Written per boot or per turn: never archived. */
const EPHEMERAL_NAMES = new Set(['session-credential', 'web-fetch-turn.json']);
/**
 * Backend homes and their session stores. Sessions are a cache that MAMA starts again (a thread it
 * cannot resume is a new one), and these folders also hold the backends' logins and the logins an
 * agent makes in its shell, so they stay out; the owner's Codex login is a credential on its own.
 */
const BACKEND_STATE = new Set(['.codex', 'codex-runtime']);
/** Re-created at boot. */
const REBUILT_AT_BOOT = new Set(['.empty-plugins']);
const SECRET_NAME =
  /(^|[_-])(token|secret|password|passwd|credential|credentials|api[_-]?key|app[_-]?key|private[_-]?key)s?($|[_-])/i;
/** A name that holds where a secret lives, or what it is called, not the secret. */
const SECRET_REFERENCE = /(path|file|dir|name)$/i;

function physical(path: string): string {
  const absolute = resolve(path);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep));
}

/** Setting paths whose string value sits under a credential name. Values are never read out. */
export function secretShapedKeys(value: unknown): string[] {
  const found: string[] = [];
  const visit = (node: unknown, path: string[]): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, [...path, String(index)]));
    } else if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        const secret = SECRET_NAME.test(key) && !SECRET_REFERENCE.test(key);
        if (typeof child === 'string' && child.trim() !== '' && secret) {
          found.push([...path, key].join('.'));
        } else {
          visit(child, [...path, key]);
        }
      }
    }
  };
  visit(value, []);
  return found;
}

function readStructured(path: string): unknown {
  const text = readFileSync(path, 'utf8');
  try {
    return path.endsWith('.json') ? JSON.parse(text) : yaml.load(text);
  } catch {
    // Parser messages quote the file, which can hold a credential.
    throw new Error(`${path} cannot be parsed`);
  }
}

function relativeName(root: string, path: string): string {
  return inside(root, path) ? relative(root, path) : path;
}

/** A configured path as written and as it really is; restore rewrites both. */
export interface ConfiguredPath {
  readonly configured: string;
  readonly physical: string;
}

function both(path: string): ConfiguredPath {
  return { configured: resolve(path), physical: physical(path) };
}

/**
 * What a backup holds, from what the current code reads and writes (not from what a root happens
 * to contain): the MAMA root's state, the database, the workspace, every person's tree under
 * member_root, the published common skills, the wiki MAMA writes and Jev's vocabulary.
 * Credentials, and any file that can hold one, come only with `includeSecrets`; logs only with
 * `includeLogs`.
 */
export function planBackup(
  config: W1Config,
  configPath: string,
  options: { includeSecrets: boolean; includeLogs: boolean; home: string }
): BackupPlan {
  const paths = pathsFor(configPath, config);
  const root = physical(paths.mamaRoot);
  const workspace = physical(paths.workspaceDir);
  const database = resolve(config.database.path);
  const configured: Record<string, ConfiguredPath | null> = {
    home: both(options.home),
    root: both(paths.mamaRoot),
    workspace: both(paths.workspaceDir),
    database: both(database),
    member_root: config.member_root ? both(config.member_root) : null,
    tools_root: config.tools_root ? both(config.tools_root) : null,
    codex_home: both(config.agent.codex_home ?? join(paths.mamaRoot, '.codex')),
    mcp_config: both(paths.mcpConfigPath),
    log_file: both(config.logging.file),
    jev_vocab: both(config.jev.vocabFile),
    jev_key: both(config.jev.keyFile),
    wiki:
      config.wiki?.enabled && config.wiki.vaultPath && config.wiki.wikiDir
        ? both(resolve(config.wiki.vaultPath, config.wiki.wikiDir))
        : null,
  };
  const at = (key: string): ConfiguredPath => configured[key]!;

  // Files that are, or can hold, credentials: archived on their own, only when asked. The MCP
  // configuration lists servers besides MAMA's own (which boot writes again), with their keys.
  const credentials: [string, ConfiguredPath][] = [
    ['credentials/auth.env', both(join(paths.mamaRoot, 'auth.env'))],
    ['credentials/jev-key', at('jev_key')],
    ['credentials/codex-auth.json', both(join(at('codex_home').configured, 'auth.json'))],
    ['credentials/mcp-config.json', at('mcp_config')],
  ];
  const secretsLeftOut: string[] = [];
  if (!options.includeSecrets) {
    for (const [prefix, path] of credentials) {
      if (!existsSync(path.physical)) continue;
      if (prefix !== 'credentials/mcp-config.json') {
        secretsLeftOut.push(relativeName(root, path.physical));
      } else if (Object.keys(mcpServers(path.physical)).some((name) => name !== 'mama')) {
        secretsLeftOut.push(`${relativeName(root, path.physical)} (servers besides MAMA's)`);
      }
    }
  }
  // Files MAMA keeps that can carry a credential: archived only when they hold none.
  const scanned: [string, (path: string) => string[]][] = [
    [physical(configPath), (path) => secretShapedKeys(readStructured(path))],
    [join(root, 'connectors.json'), (path) => secretShapedKeys(readStructured(path))],
    [
      join(root, 'start.sh'),
      (path) => {
        const reading = readStartScript(readFileSync(path, 'utf8'), options.home);
        // Exported or assigned under the script's set -a, a credential reaches the daemon.
        return [...reading.carried, ...reading.notReproduced]
          .map((line) => /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1] ?? '')
          .filter((name) => name !== '' && isCredentialEnvName(name));
      },
    ],
  ];
  const withheldFiles = new Set<string>();
  if (!options.includeSecrets) {
    for (const [path, holds] of scanned) {
      if (existsSync(path) && holds(path).length > 0) {
        withheldFiles.add(path);
        secretsLeftOut.push(`${relativeName(root, path)} (it holds a credential)`);
      }
    }
  }

  // Archived on their own, or not at all: every tree leaves them out, as linked or as named.
  const separate = new Set(
    [
      ...['', '-wal', '-shm', '-journal'].map((end) => both(database + end)),
      ...credentials.map(([, path]) => path),
      at('jev_vocab'),
      at('log_file'),
    ].flatMap((path) => [path.configured, path.physical])
  );
  for (const path of withheldFiles) separate.add(path);
  const common = (absolute: string, stat: Stats): boolean => {
    if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) return false;
    if (separate.has(absolute)) return false;
    const name = absolute.slice(absolute.lastIndexOf(sep) + 1);
    if (stat.isDirectory() && (name === '.tmp' || BACKEND_STATE.has(name))) return false;
    // SQLite rebuilds a shared-memory file; a check that opens the database rewrites it.
    if (EPHEMERAL_NAMES.has(name) || name.endsWith('-shm')) return false;
    if (name === '.credentials.json' && !options.includeSecrets) return false;
    return true;
  };

  const workspaceTop =
    inside(root, workspace) && relative(root, workspace).split(sep).length === 1
      ? relative(root, workspace)
      : null;
  const rootFiles = new Set<string>(ROOT_FILES);
  const rootDirs = new Set<string>([
    ...ROOT_DIRS.filter((name) => name !== 'logs' || options.includeLogs),
    ...(workspaceTop ? [workspaceTop] : []),
  ]);
  // A kept file or folder that is a link would be archived as the link alone.
  const links = [
    // Only what the walk keeps: logs/ without --logs is never read, linked or not.
    ...[...rootFiles, ...rootDirs]
      .filter((name) => name !== workspaceTop)
      .map((name) => join(root, name)),
    ...(existsSync(join(root, 'connectors'))
      ? readdirSync(join(root, 'connectors')).map((name) => join(root, 'connectors', name))
      : []),
  ].filter((path) => existsSync(path) && lstatSync(path).isSymbolicLink());
  if (links.length > 0) {
    throw new Error(
      `${links.join(', ')} ${links.length === 1 ? 'is a symlink' : 'are symlinks'}; a backup would hold the link, not what it names`
    );
  }
  const keptByRoot = (relativePath: string): boolean => {
    const [top, ...rest] = relativePath.split(sep);
    if (rest.length === 0) return rootFiles.has(top) || rootDirs.has(top);
    if (!rootDirs.has(top)) return false;
    if (top !== 'runtime') return true;
    return (
      (RUNTIME_DIRS as readonly string[]).includes(rest[0]) ||
      (rest.length === 1 && RUNTIME_FILES.has(rest[0]))
    );
  };
  const keepRoot = (relativePath: string, stat: Stats): boolean =>
    relativePath === '' || (keptByRoot(relativePath) && common(join(root, relativePath), stat));

  const sources: BackupSource[] = [{ prefix: 'root', path: root, keep: keepRoot }];
  const add = (prefix: string, path: string | null, keep = common): void => {
    if (path === null || !existsSync(path)) return;
    sources.push({
      prefix,
      path,
      keep: (relativePath, stat) =>
        keep(relativePath === '' ? path : join(path, relativePath), stat),
    });
  };
  // A workspace kept elsewhere is archived where it really is.
  if (!workspaceTop) add('workspace', workspace);
  add('members', configured.member_root?.physical ?? null);
  // The toolkit is rebuilt by mama tools install; the published skills are not.
  add('skills', configured.tools_root ? join(configured.tools_root.physical, 'skills') : null);
  // Covered only when no folder on the way is one the trees leave out.
  const kept = (parent: string, path: string): boolean =>
    relative(parent, path)
      .split(sep)
      .every((name) => name !== '.tmp' && !BACKEND_STATE.has(name));
  const covered = (path: string): boolean =>
    (inside(root, path) && keptByRoot(relative(root, path)) && kept(root, path)) ||
    (inside(workspace, path) && kept(workspace, path));
  if (configured.wiki && !covered(configured.wiki.physical)) add('wiki', configured.wiki.physical);
  // Each tree goes back to its own root, so none may sit inside another one's kept part.
  for (const outer of sources) {
    for (const inner of sources) {
      if (inner === outer || !inside(outer.path, inner.path)) continue;
      if (!kept(outer.path, inner.path)) continue;
      if (outer.prefix === 'root' && !keptByRoot(relative(root, inner.path))) continue;
      throw new Error(`${inner.path} sits inside ${outer.path}; a backup needs them apart`);
    }
  }
  add('jev-vocab', at('jev_vocab').physical, () => true);
  if (options.includeLogs) add('log-file', at('log_file').physical, () => true);
  if (options.includeSecrets) {
    for (const [prefix, path] of credentials) add(prefix, path.physical, () => true);
  }

  const leftOut = readdirSync(root)
    .filter((name) => !keptByRoot(name) && name !== 'backups' && !REBUILT_AT_BOOT.has(name))
    .filter((name) => name !== 'logs' && !BACKEND_STATE.has(name))
    .filter((name) => !separate.has(join(root, name)))
    .filter((name) => physical(join(root, name)) !== workspace)
    .filter((name) =>
      sources.every(
        (source) => source.prefix === 'root' || source.path !== physical(join(root, name))
      )
    )
    .filter((name) => {
      const stat = lstatSync(join(root, name));
      return stat.isFile() || stat.isDirectory() || stat.isSymbolicLink();
    })
    .sort();
  return { sources, database, configured, leftOut, secretsLeftOut };
}

/** The MCP configuration's servers by name; an unreadable file is reported, not guessed. */
function mcpServers(path: string): Record<string, unknown> {
  const value = readStructured(path) as { mcpServers?: unknown } | null;
  const servers = value?.mcpServers;
  return servers && typeof servers === 'object' && !Array.isArray(servers)
    ? (servers as Record<string, unknown>)
    : {};
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

export interface CollectedEntries {
  readonly entries: BackupEntry[];
  /** Each entry's physical path, in archive order. */
  readonly absolutes: string[];
}

/**
 * The entries each source keeps, in the order tar will write them. A path reached twice (through
 * overlapping sources) is kept once, under the first source that reached it.
 */
export async function collectEntries(sources: readonly BackupSource[]): Promise<CollectedEntries> {
  const entries: BackupEntry[] = [];
  const absolutes: string[] = [];
  const seen = new Set<string>();
  const visit = async (source: BackupSource, relativePath: string): Promise<void> => {
    const absolute = relativePath === '' ? source.path : join(source.path, relativePath);
    if (seen.has(absolute)) return;
    const stat = lstatSync(absolute);
    if (!source.keep(relativePath, stat)) return;
    seen.add(absolute);
    const path =
      relativePath === '' ? source.prefix : `${source.prefix}/${relativePath.split(sep).join('/')}`;
    const mode = stat.mode & 0o7777;
    absolutes.push(absolute);
    if (stat.isSymbolicLink()) {
      entries.push({ path, type: 'symlink', mode, target: readlinkSync(absolute) });
    } else if (stat.isDirectory()) {
      entries.push({ path, type: 'dir', mode });
      for (const name of readdirSync(absolute).sort()) {
        await visit(source, relativePath === '' ? name : join(relativePath, name));
      }
    } else {
      entries.push({
        path,
        type: 'file',
        mode,
        size: stat.size,
        sha256: await hashFile(absolute),
      });
    }
  };
  for (const source of sources) await visit(source, '');
  return { entries, absolutes };
}

/** Copy a SQLite database with its backup API and confirm the copy with integrity_check. */
export async function copyDatabase(
  source: string,
  destination: string
): Promise<{ schemaVersion: number | null }> {
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destination);
  } finally {
    db.close();
  }
  return checkDatabase(destination);
}

/**
 * integrity_check must answer ok. For MAMA's main database, also read the highest applied
 * migration; another database's tables are its own.
 */
export function checkDatabase(
  path: string,
  options: { schema: boolean } = { schema: true }
): { schemaVersion: number | null } {
  let db: Database.Database;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
  } catch (error) {
    // A rollback journal left by a crash needs a writer to roll it back first.
    throw new Error(
      `${path} cannot be opened to check it (${error instanceof Error ? error.message : String(error)}); start and stop MAMA once so it recovers, then back up again`
    );
  }
  try {
    const result = db.pragma('integrity_check', { simple: true });
    if (result !== 'ok') throw new Error(`${path} failed integrity_check: ${String(result)}`);
    if (!options.schema) return { schemaVersion: null };
    const table = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
      .get();
    if (!table) return { schemaVersion: null };
    const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as {
      version: number | null;
    };
    return { schemaVersion: row.version };
  } finally {
    db.close();
  }
}

/** The raw stores under connectors/: MAMA's own databases besides the main one. */
export function rawStores(root: string): string[] {
  const connectors = join(physical(root), 'connectors');
  if (!existsSync(connectors)) return [];
  return readdirSync(connectors)
    .map((name) => join(connectors, name, 'raw.db'))
    .filter((path) => existsSync(path) && lstatSync(path).isFile());
}

/** tar's hard-link cache, told nothing: every name is stored whole, as the manifest lists it. */
class NoLinks extends Map<string, string> {
  override get(): string | undefined {
    return undefined;
  }
}

/**
 * Write exactly the collected entries, manifest first, each under its archive name, with modes
 * and symlinks as they are. The file is created 0600 and flushed to disk before it returns.
 */
export async function writeArchive(
  file: string,
  manifestPath: string,
  collected: CollectedEntries
): Promise<void> {
  const names = new Map<string, string>([[manifestPath, 'manifest.json']]);
  collected.absolutes.forEach((absolute, index) =>
    names.set(absolute, collected.entries[index].path)
  );
  closeSync(openSync(file, 'wx', 0o600));
  await tar.c(
    {
      file,
      gzip: true,
      preservePaths: true,
      noDirRecurse: true,
      linkCache: new NoLinks() as never,
      onWriteEntry: (entry) => {
        const directory = entry.path.endsWith('/');
        const name = names.get(directory ? entry.path.slice(0, -1) : entry.path);
        if (name === undefined) {
          throw new Error(`tar reached ${entry.path}, which was not collected`);
        }
        entry.path = directory ? `${name}/` : name;
      },
    },
    [manifestPath, ...collected.absolutes]
  );
  syncPath(file);
}

/** Flush a file or a folder's entries to disk. */
export function syncPath(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Read the archive back: the manifest comes first, every entry it lists is there once with its
 * type and link target, nothing else is, and every file hashes to what the manifest recorded.
 */
export async function verifyArchive(file: string, manifest: BackupManifest): Promise<void> {
  const expected = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const seen = new Set<string>();
  const pending: Promise<void>[] = [];
  let first: string | null = null;
  const problems: string[] = [];
  await tar.t({
    file,
    onReadEntry: (entry) => {
      const path = entry.path.replace(/\/+$/, '');
      const isFirst = first === null;
      first ??= path;
      if (isFirst && path === 'manifest.json') {
        entry.resume();
        return;
      }
      const want = expected.get(path);
      if (!want || seen.has(path)) {
        problems.push(want ? `${path} appears twice` : `${path} is not in the manifest`);
        entry.resume();
        return;
      }
      seen.add(path);
      const type =
        entry.type === 'Directory'
          ? 'dir'
          : entry.type === 'SymbolicLink'
            ? 'symlink'
            : entry.type === 'File' || entry.type === 'OldFile'
              ? 'file'
              : String(entry.type);
      if (type !== want.type) problems.push(`${path} is a ${type}, not a ${want.type}`);
      // tar writes a file's mode as it is and makes a readable folder listable.
      const mode = (entry.mode ?? 0) & 0o7777;
      if (type === 'file' && mode !== want.mode) problems.push(`${path} has another mode`);
      if (type === 'dir' && mode !== listable(want.mode)) problems.push(`${path} has another mode`);
      if (type === 'symlink' && entry.linkpath !== want.target) {
        problems.push(`${path} links elsewhere`);
      }
      if (type !== 'file') {
        entry.resume();
        return;
      }
      const hash = createHash('sha256');
      pending.push(
        new Promise((resolvePromise) => {
          entry.on('data', (chunk: Buffer) => hash.update(chunk));
          entry.on('end', () => {
            if (hash.digest('hex') !== want.sha256) problems.push(`${path} changed while archived`);
            resolvePromise();
          });
        })
      );
    },
  });
  await Promise.all(pending);
  if (first !== 'manifest.json') problems.push('the manifest is not the first entry');
  for (const path of expected.keys()) if (!seen.has(path)) problems.push(`${path} is missing`);
  for (const path of manifest.databases) {
    if (expected.get(path)?.type !== 'file') problems.push(`database ${path} is not a file entry`);
  }
  if (problems.length > 0) {
    throw new Error(
      `the archive does not match its manifest (${problems.length} difference(s): ${problems.slice(0, 5).join('; ')})`
    );
  }
}

function listable(mode: number): number {
  return mode | (mode & 0o400 ? 0o100 : 0) | (mode & 0o40 ? 0o10 : 0) | (mode & 0o4 ? 0o1 : 0);
}

export function archiveName(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return `mama-backup-${stamp}.tar.gz`;
}
