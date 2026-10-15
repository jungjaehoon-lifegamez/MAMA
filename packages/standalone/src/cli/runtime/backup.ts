import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  type Stats,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import * as yaml from 'js-yaml';
import * as tar from 'tar';
import type { W1Config } from '../../runtime/config.js';
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
  /** Each archive prefix and the absolute path it came from; restore maps them to its own. */
  readonly roots: Record<string, string>;
  /** SQLite files in the archive, each checked with integrity_check before it was written. */
  readonly databases: string[];
  readonly entries: BackupEntry[];
}

/** A tree or file to archive under `prefix`, and which of its paths to keep. */
export interface BackupSource {
  readonly prefix: string;
  readonly path: string;
  readonly keep: (relativePath: string, stat: Stats) => boolean;
}

export interface BackupPlan {
  readonly sources: BackupSource[];
  /** The database file boot opens; the archive holds a copy taken with SQLite's backup. */
  readonly database: string;
  /** Top-level names in the MAMA root that this version does not read, so they stay out. */
  readonly leftOut: string[];
  /** Credentials left out because the backup was not asked to carry them. */
  readonly secretsLeftOut: string[];
}

/** runtime/ files the current code reads back; the rest of runtime/ is per boot or per run. */
const RUNTIME_FILES = new Set([
  'owner-message-ledger.json',
  'report-schedule-state.json',
  'mama-mcp-config.json',
  'client-journal.jsonl',
  'september-import-manifest.json',
  'september-replay-cursor.json',
  'september-replay-ledger.jsonl',
]);
/** Written per boot or per turn, and owner-only: never archived. */
const EPHEMERAL_NAMES = new Set(['session-credential', 'web-fetch-turn.json']);
const SECRET_KEY =
  /(^|[_-])(token|secret|password|passwd|credential|api[_-]?key|app[_-]?key|private[_-]?key)s?($|[_-])/i;

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep);
}

/**
 * Setting paths in config.yaml that look like they hold a credential: a string value under a
 * token, secret, password, credential or API-key name. Older installs kept tokens there.
 */
export function secretShapedKeys(configPath: string): string[] {
  const found: string[] = [];
  const visit = (value: unknown, path: string[]): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, String(index)]));
    } else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (typeof child === 'string' && child.trim() !== '' && SECRET_KEY.test(key)) {
          found.push([...path, key].join('.'));
        } else {
          visit(child, [...path, key]);
        }
      }
    }
  };
  visit(yaml.load(readFileSync(configPath, 'utf8')), []);
  return found;
}

/**
 * What a backup holds, from what the current code reads and writes (not from what a root happens
 * to contain): the MAMA root's state, the database, the workspace, every person's tree under
 * member_root, the published common skills, the wiki MAMA writes and Jev's files. Credentials
 * come only with `includeSecrets`; logs only with `includeLogs`.
 */
export function planBackup(
  config: W1Config,
  configPath: string,
  options: { includeSecrets: boolean; includeLogs: boolean }
): BackupPlan {
  const paths = pathsFor(configPath, config);
  const root = paths.mamaRoot;
  const workspace = resolve(paths.workspaceDir);
  const database = resolve(config.database.path);
  const databaseFiles = new Set(['', '-wal', '-shm', '-journal'].map((end) => database + end));
  const secretConfig = secretShapedKeys(configPath);
  const secretsLeftOut: string[] = [];
  if (!options.includeSecrets) {
    secretsLeftOut.push('auth.env', 'the Codex logins (.codex/auth.json)', 'the Jev key');
    if (secretConfig.length > 0) {
      secretsLeftOut.push(
        `config.yaml (it holds ${secretConfig.length} credential-shaped value(s))`
      );
    }
  }
  const rootFiles = new Set([
    'connectors.json',
    'owner-policy.md',
    'report-slots.json',
    'start.sh',
    ...(secretConfig.length === 0 || options.includeSecrets ? ['config.yaml'] : []),
    ...(options.includeSecrets ? ['auth.env'] : []),
  ]);
  const workspaceTop = inside(root, workspace) ? relative(root, workspace).split(sep)[0] : null;
  const rootDirs = new Set([
    'connectors',
    'downloads',
    'codex-runtime',
    '.codex',
    'runtime',
    ...(options.includeLogs ? ['logs'] : []),
    ...(workspaceTop ? [workspaceTop] : []),
  ]);
  // Every tree: no sockets, no scratch, no per-boot credentials, Codex logins only when asked.
  const common = (relativePath: string, stat: Stats): boolean => {
    if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) return false;
    const parts = relativePath.split(sep);
    const name = parts[parts.length - 1];
    if (stat.isDirectory() && name === '.tmp') return false;
    if (EPHEMERAL_NAMES.has(name)) return false;
    if (!options.includeSecrets && name === 'auth.json' && parts[parts.length - 2] === '.codex') {
      return false;
    }
    return true;
  };
  const keepRoot = (relativePath: string, stat: Stats): boolean => {
    if (relativePath === '') return true;
    if (databaseFiles.has(join(root, relativePath))) return false;
    const [top, ...rest] = relativePath.split(sep);
    if (rest.length === 0 && !rootFiles.has(top) && !rootDirs.has(top)) return false;
    if (top === 'runtime' && rest.length > 0) {
      if (rest[0] !== 'backfill' && !(rest.length === 1 && RUNTIME_FILES.has(rest[0]))) {
        return false;
      }
    }
    return common(relativePath, stat);
  };
  const sources: BackupSource[] = [{ prefix: 'root', path: root, keep: keepRoot }];
  if (!workspaceTop) sources.push({ prefix: 'workspace', path: workspace, keep: common });
  if (config.member_root) {
    sources.push({ prefix: 'members', path: resolve(config.member_root), keep: common });
  }
  if (config.tools_root) {
    // The toolkit is rebuilt by mama tools install; the published skills are not.
    sources.push({
      prefix: 'skills',
      path: join(resolve(config.tools_root), 'skills'),
      keep: common,
    });
  }
  if (config.wiki?.enabled && config.wiki.vaultPath && config.wiki.wikiDir) {
    const wiki = resolve(config.wiki.vaultPath, config.wiki.wikiDir);
    if (!inside(root, wiki) && !inside(workspace, wiki)) {
      sources.push({ prefix: 'wiki', path: wiki, keep: common });
    }
  }
  sources.push({ prefix: 'jev/vocab', path: resolve(config.jev.vocabFile), keep: () => true });
  if (options.includeSecrets) {
    sources.push({ prefix: 'jev/key', path: resolve(config.jev.keyFile), keep: () => true });
  }

  const covered = new Set([
    ...[...databaseFiles].filter((path) => inside(root, path)).map((path) => relative(root, path)),
    ...[config.jev.vocabFile, config.jev.keyFile]
      .map((path) => resolve(path))
      .filter((path) => inside(root, path))
      .map((path) => relative(root, path).split(sep)[0]),
    'auth.env',
    'config.yaml',
    'backups',
  ]);
  const leftOut = existsSync(root)
    ? readdirSync(root)
        .filter((name) => !rootFiles.has(name) && !rootDirs.has(name) && !covered.has(name))
        .filter((name) => {
          const stat = lstatSync(join(root, name));
          return stat.isFile() || stat.isDirectory() || stat.isSymbolicLink();
        })
        .sort()
    : [];
  return {
    sources: sources.filter((source) => existsSync(source.path)),
    database,
    leftOut,
    secretsLeftOut,
  };
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

/** The entries each source keeps, in the order tar will write them. */
export async function collectEntries(sources: readonly BackupSource[]): Promise<BackupEntry[]> {
  const entries: BackupEntry[] = [];
  const visit = async (source: BackupSource, relativePath: string): Promise<void> => {
    const absolute = relativePath === '' ? source.path : join(source.path, relativePath);
    const stat = lstatSync(absolute);
    if (!source.keep(relativePath, stat)) return;
    const path =
      relativePath === '' ? source.prefix : `${source.prefix}/${relativePath.split(sep).join('/')}`;
    const mode = stat.mode & 0o7777;
    if (stat.isSymbolicLink()) {
      entries.push({ path, type: 'symlink', mode, target: readlinkSync(absolute) });
    } else if (stat.isDirectory()) {
      entries.push({ path, type: 'dir', mode });
      for (const name of readdirSync(absolute).sort()) {
        await visit(source, relativePath === '' ? name : join(relativePath, name));
      }
    } else {
      entries.push({ path, type: 'file', mode, size: stat.size, sha256: await hashFile(absolute) });
    }
  };
  for (const source of sources) await visit(source, '');
  return entries;
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

/** integrity_check must answer ok; also read the highest applied migration when there is one. */
export function checkDatabase(path: string): { schemaVersion: number | null } {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const result = db.pragma('integrity_check', { simple: true });
    if (result !== 'ok') throw new Error(`${path} failed integrity_check: ${String(result)}`);
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

/** SQLite files among the kept entries, by their header. */
export function sqliteFiles(
  sources: readonly BackupSource[],
  entries: readonly BackupEntry[]
): string[] {
  const header = Buffer.from('SQLite format 3\0');
  return entries
    .filter((entry) => entry.type === 'file' && (entry.size ?? 0) >= header.length)
    .map((entry) => ({ entry, absolute: absolutePath(sources, entry.path) }))
    .filter(({ absolute }) => {
      const buffer = Buffer.alloc(header.length);
      const fd = openSync(absolute, 'r');
      try {
        readSync(fd, buffer, 0, buffer.length, 0);
      } finally {
        closeSync(fd);
      }
      return buffer.equals(header);
    })
    .map(({ entry }) => entry.path);
}

/** The absolute path an archive entry came from. */
export function absolutePath(sources: readonly BackupSource[], archivePath: string): string {
  const source = [...sources]
    .sort((left, right) => right.prefix.length - left.prefix.length)
    .find(
      (candidate) =>
        archivePath === candidate.prefix || archivePath.startsWith(`${candidate.prefix}/`)
    );
  if (!source) throw new Error(`no source for ${archivePath}`);
  const rest = archivePath.slice(source.prefix.length + 1);
  return rest === '' ? source.path : join(source.path, ...rest.split('/'));
}

/**
 * Write the archive: the manifest first, then every kept entry under its prefix, with modes and
 * symlinks as they are. The file is created 0600 before tar writes into it.
 */
export async function writeArchive(
  file: string,
  manifestPath: string,
  sources: readonly BackupSource[]
): Promise<void> {
  closeSync(openSync(file, 'wx', 0o600));
  const all: BackupSource[] = [
    { prefix: 'manifest.json', path: manifestPath, keep: () => true },
    ...sources,
  ];
  const owner = (absolute: string): { source: BackupSource; relativePath: string } => {
    const path = absolute.replace(/\/+$/, '');
    const source = [...all]
      .sort((left, right) => right.path.length - left.path.length)
      .find((candidate) => path === candidate.path || path.startsWith(`${candidate.path}/`));
    if (!source) throw new Error(`tar reached ${path}, outside every backup source`);
    return { source, relativePath: path === source.path ? '' : relative(source.path, path) };
  };
  await tar.c(
    {
      file,
      gzip: true,
      preservePaths: true,
      filter: (path, stat) => {
        const { source, relativePath } = owner(path);
        return source.keep(relativePath, stat as Stats);
      },
      onWriteEntry: (entry) => {
        const directory = entry.path.endsWith('/');
        const { source, relativePath } = owner(entry.path);
        const path =
          relativePath === ''
            ? source.prefix
            : `${source.prefix}/${relativePath.split(sep).join('/')}`;
        entry.path = directory ? `${path}/` : path;
      },
    },
    all.map((source) => source.path)
  );
}

/**
 * Read the archive back: the manifest comes first, every entry it lists is present with its type,
 * and every file's content hashes to what the manifest recorded.
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
      first ??= path;
      if (path === 'manifest.json') {
        entry.resume();
        return;
      }
      const want = expected.get(path);
      seen.add(path);
      if (!want) {
        problems.push(`${path} is not in the manifest`);
        entry.resume();
        return;
      }
      if (entry.type === 'Link') {
        // A hard link: tar stored it once; the other name must hash the same.
        const target = expected.get(String(entry.linkpath).replace(/\/+$/, ''));
        if (want.type !== 'file' || target?.sha256 !== want.sha256) {
          problems.push(`${path} is a hard link to different content`);
        }
        entry.resume();
        return;
      }
      const type =
        entry.type === 'Directory' ? 'dir' : entry.type === 'SymbolicLink' ? 'symlink' : 'file';
      if (type !== want.type) problems.push(`${path} is a ${type}, not a ${want.type}`);
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
  if (problems.length > 0) {
    throw new Error(`the archive does not match its manifest: ${problems.slice(0, 5).join('; ')}`);
  }
}

export function archiveName(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return `mama-backup-${stamp}.tar.gz`;
}
