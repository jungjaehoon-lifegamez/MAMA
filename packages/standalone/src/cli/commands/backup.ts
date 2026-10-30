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
  backupFiles,
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
import {
  acquireInstallLock,
  daemonControlPaths,
  refuseWhileRestoring,
} from '../runtime/daemon-control.js';
import { runStop } from './control.js';
import { pathsFor } from './daemon.js';
import { serviceFile, serviceRuns, startService, type ServiceOptions } from './service.js';

export interface BackupOptions extends ServiceOptions {
  /** The archive's name before its time; `mama update` names its snapshot (default mama-backup). */
  archivePrefix?: string;
}

const USAGE = 'Usage: mama backup [--include-secrets] [--logs] [--restart]';

interface BackupFlags {
  includeSecrets: boolean;
  includeLogs: boolean;
  restart: boolean;
}

function parse(args: readonly string[]): BackupFlags {
  let includeSecrets = false;
  let includeLogs = false;
  let restart = false;
  for (const arg of args) {
    if (arg === '--include-secrets') includeSecrets = true;
    else if (arg === '--logs') includeLogs = true;
    else if (arg === '--restart') restart = true;
    else throw new CliInputError(USAGE);
  }
  return { includeSecrets, includeLogs, restart };
}

/**
 * `mama backup`: one verified archive of a stopped install. It holds the install while it works,
 * so the daemon cannot start beside it, and writes the archive 0600 under `<root>/backups/`,
 * the one folder the agents cannot read. Returns the archive's path. `--restart` drains and stops
 * the running install first and starts it again through its service afterwards, also after a
 * failed backup, since it ran before.
 */
export async function runBackup(
  args: readonly string[],
  options: BackupOptions = {}
): Promise<string> {
  const flags = parse(args);
  if (!flags.restart) return await backupStopped(flags, options);
  // Only the service starts it again; a daemon run in a terminal would stay stopped.
  if (!existsSync(serviceFile(options))) {
    throw new CliInputError(
      'mama backup --restart starts MAMA again through its service, and none is installed: run mama service install, or mama stop and mama backup'
    );
  }
  if ((await runStop([], options)) !== 0) {
    // A stop can fail after the service manager was already told to stop (a release that took
    // too long), so the install may be down now; this names which.
    throw new CliInputError(
      serviceRuns(options)
        ? 'Not backed up: MAMA did not stop and still runs'
        : 'Not backed up: MAMA did not stop cleanly and its service is not running; mama service start starts it again'
    );
  }
  let archive: string;
  try {
    archive = await backupStopped(flags, options);
  } catch (error) {
    try {
      await startService(options);
    } catch (startError) {
      // Both failures count; the backup's comes first.
      throw new CliInputError(
        `${error instanceof Error ? error.message : String(error)}; MAMA did not start again either: ${startError instanceof Error ? startError.message : String(startError)} (mama service start)`
      );
    }
    throw error;
  }
  await startService(options);
  return archive;
}

async function backupStopped(flags: BackupFlags, options: BackupOptions): Promise<string> {
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
  // Nothing may write the install while it is read, so a running daemon refuses the backup here.
  const lock = acquireInstallLock(daemonControlPaths(root), 'backup');
  try {
    refuseWhileRestoring(root);
  } catch (error) {
    lock.release();
    throw error;
  }
  const now = options.now?.() ?? new Date();
  const { final, staging, partial } = backupFiles(folder, now, options.archivePrefix);
  try {
    const plan = planBackup(config, configPath, { ...flags, home });
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
    // SQLite creates the copy under this shell's umask; it keeps the database's own mode.
    chmodSync(databaseCopy, statSync(plan.database).mode & 0o777);
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
    write('  Codex homes and their sessions left out; sessions start over after a restore');
    if (!flags.includeLogs) write('  logs left out (--logs adds them)');
    if (!flags.restart) write('The install is still stopped; mama service start starts it.');
    return final;
  } catch (error) {
    if (error instanceof CliInputError) throw error;
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
