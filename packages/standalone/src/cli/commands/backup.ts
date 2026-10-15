import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { resolvePackageVersion } from '../../package-version.js';
import { defaultConfigPath, loadConfig } from '../../runtime/config.js';
import { CliInputError } from '../prompt.js';
import {
  archiveName,
  checkDatabase,
  collectEntries,
  copyDatabase,
  planBackup,
  rawStores,
  syncPath,
  verifyArchive,
  writeArchive,
  type BackupManifest,
} from '../runtime/backup.js';
import { acquireInstallLock, daemonControlPaths } from '../runtime/daemon-control.js';
import { pathsFor } from './daemon.js';

export interface BackupOptions {
  home?: string;
  configPath?: string;
  write?: (line: string) => void;
  now?: () => Date;
}

const USAGE = 'Usage: mama backup [--include-secrets] [--logs]';

function parse(args: readonly string[]): { includeSecrets: boolean; includeLogs: boolean } {
  let includeSecrets = false;
  let includeLogs = false;
  for (const arg of args) {
    if (arg === '--include-secrets') includeSecrets = true;
    else if (arg === '--logs') includeLogs = true;
    else throw new CliInputError(USAGE);
  }
  return { includeSecrets, includeLogs };
}

/**
 * `mama backup`: one verified archive of a stopped install. It holds the install while it works,
 * so the daemon cannot start beside it, and writes the archive 0600 under `<root>/backups/`,
 * the one folder the agents cannot read. Returns the archive's path.
 */
export async function runBackup(
  args: readonly string[],
  options: BackupOptions = {}
): Promise<string> {
  const flags = parse(args);
  const home = options.home ?? homedir();
  const configPath = options.configPath ?? defaultConfigPath(home);
  const write = options.write ?? ((line: string) => console.log(line));
  const config = loadConfig({ home, path: configPath, onIgnored: () => {} });
  const paths = pathsFor(configPath, config);
  const root = realpathSync(paths.mamaRoot);
  // Only this folder is denied to the agents, the owner's and every member's: an archive
  // anywhere else could be read by any of them, since they run as the same user.
  const folder = join(root, 'backups');
  if (existsSync(folder) && lstatSync(folder).isSymbolicLink()) {
    throw new CliInputError(
      `Refused: ${folder} is a symlink; the agents' deny covers the folder only`
    );
  }
  const plan = planBackup(config, configPath, { ...flags, home });
  // Nothing may write the install while it is read, so a running daemon refuses the backup here.
  const lock = acquireInstallLock(daemonControlPaths(root), 'backup');
  const now = options.now?.() ?? new Date();
  const final = join(folder, archiveName(now));
  const staging = join(folder, `.staging-${process.pid}-${now.getTime()}`);
  const partial = `${final}.partial`;
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    chmodSync(folder, 0o700);
    // An interrupted backup leaves these; holding the install, nothing else is using them.
    for (const name of readdirSync(folder)) {
      if (name.startsWith('.staging-') || name.endsWith('.tar.gz.partial')) {
        rmSync(join(folder, name), { recursive: true, force: true });
      }
    }
    if (existsSync(final)) throw new Error(`${final} already exists`);
    mkdirSync(staging, { mode: 0o700 });
    const databaseCopy = join(staging, 'database');
    const { schemaVersion } = await copyDatabase(plan.database, databaseCopy);
    // Checked before anything is hashed: opening a database can rewrite its side files.
    const stores = rawStores(root);
    for (const store of stores) checkDatabase(store, { schema: false });
    const sources = [{ prefix: 'database', path: databaseCopy, keep: () => true }, ...plan.sources];
    const collected = await collectEntries(sources);
    const manifest: BackupManifest = {
      format: 'mama-backup',
      version: 1,
      createdAt: now.toISOString(),
      mama: resolvePackageVersion(),
      platform: `${process.platform} ${process.arch}`,
      schemaVersion,
      includesSecrets: flags.includeSecrets,
      includesLogs: flags.includeLogs,
      roots: Object.fromEntries(
        sources.map((source) => [
          source.prefix,
          source.prefix === 'database' ? plan.database : source.path,
        ])
      ),
      configured: plan.configured,
      databases: [
        'database',
        ...stores.map((store) => `root/${relative(root, store).split(sep).join('/')}`),
      ],
      entries: collected.entries,
    };
    const manifestPath = join(staging, 'manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    await writeArchive(partial, manifestPath, collected);
    await verifyArchive(partial, manifest);
    renameSync(partial, final);
    syncPath(folder);

    const files = collected.entries.filter((entry) => entry.type === 'file');
    const bytes = files.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
    write(`backup: ${final} (copy it elsewhere yourself; the agents cannot read it here)`);
    write(
      `  ${files.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB read, ${(statSync(final).size / 1024 / 1024).toFixed(1)} MB written; verified against its manifest`
    );
    write(
      `  databases checked: ${manifest.databases.length}; schema version ${schemaVersion ?? 'none'}`
    );
    if (plan.secretsLeftOut.length > 0) {
      write(
        `  left out as credentials: ${plan.secretsLeftOut.join('; ')} (--include-secrets adds them)`
      );
    }
    if (plan.leftOut.length > 0) {
      write(`  left out, not read by this version: ${plan.leftOut.join(', ')}`);
    }
    write('  backend sessions and their logins left out; sessions start over after a restore');
    if (!flags.includeLogs) write('  logs left out (--logs adds them)');
    write('The install is still stopped; mama service start starts it.');
    return final;
  } catch (error) {
    // The reason goes to the terminal: a file that changed, a database that failed its check.
    throw new CliInputError(
      `Backup failed and nothing was kept: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(partial, { force: true });
    lock.release();
  }
}
