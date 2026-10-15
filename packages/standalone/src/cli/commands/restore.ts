import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CodexThreadRegistry } from '@jungjaehoon/mama-core/runtime/drivers/codex-thread-registry';
import { defaultConfigPath, loadConfig, type W1Config } from '../../runtime/config.js';
import { CliInputError } from '../prompt.js';
import { acquireInstallLock, daemonControlPaths } from '../runtime/daemon-control.js';
import {
  applyModes,
  destinationOf,
  extractVerified,
  finishSwitch,
  hostJobsInFlight,
  journalPath,
  newRestoreId,
  pathPairs,
  PATH_COLUMNS,
  prefixesIn,
  readManifest,
  removeTree,
  restoredConfigText,
  rewriteDatabase,
  rollBack,
  switchUnits,
  targetPaths,
  unitsFor,
} from '../runtime/restore.js';

export interface RestoreOptions {
  home?: string;
  configPath?: string;
  write?: (line: string) => void;
}

const USAGE = 'Usage: mama restore <archive> | mama restore --rollback';

/**
 * `mama restore <archive>`: put a `mama backup` archive onto this stopped install. The restored
 * config is the backup's settings with this install's places, and every part goes where that
 * config puts it; the old roots in stored attachment paths are rewritten to the new ones. Each
 * destination goes aside while its copy takes its place, under a journal that puts everything
 * back if any step fails. Credentials and start.sh the archive does not hold stay as they are.
 */
export async function runRestore(
  args: readonly string[],
  options: RestoreOptions = {}
): Promise<void> {
  if (args.length !== 1) throw new CliInputError(USAGE);
  const home = options.home ?? homedir();
  const configPath = options.configPath ?? defaultConfigPath(home);
  const write = options.write ?? ((line: string) => console.log(line));
  if (!existsSync(configPath)) {
    throw new CliInputError(`Restore needs an installed target: ${configPath} does not exist`);
  }
  const config = loadConfig({ home, path: configPath, onIgnored: () => {} });
  const root = resolve(dirname(configPath));
  const backups = join(root, 'backups');
  // Nothing may run while files are switched under it.
  const lock = acquireInstallLock(daemonControlPaths(root), 'restore');
  let staging: string | null = null;
  try {
    if (args[0] === '--rollback') {
      const undone = rollBack(root);
      write(
        undone === null
          ? 'the interrupted restore had finished; what it set aside is cleared'
          : undone > 0
            ? `put back ${undone} path(s) from the interrupted restore`
            : 'nothing to roll back'
      );
      return;
    }
    if (existsSync(journalPath(root))) {
      throw new CliInputError(
        'An earlier restore was interrupted; mama restore --rollback resolves it first'
      );
    }
    const archive = resolve(args[0]);
    if (!existsSync(archive) || !statSync(archive).isFile()) {
      throw new CliInputError(`${archive} is not a file`);
    }
    mkdirSync(backups, { recursive: true, mode: 0o700 });
    // An interrupted run leaves its staging; holding the install, nothing else is using it.
    for (const name of readdirSync(backups)) {
      if (name.startsWith('.restore-') && name !== '.restore-journal.json') {
        removeTree(join(backups, name));
      }
    }
    const manifest = await readManifest(archive);
    const id = newRestoreId();
    staging = join(backups, `.restore-${id}`);
    await extractVerified(archive, manifest, staging);

    // The backup's settings with this install's places: files and config then agree.
    const stagedConfig = join(staging, 'root', 'config.yaml');
    const configFromBackup = existsSync(stagedConfig);
    let restored: W1Config = config;
    if (configFromBackup) {
      writeFileSync(
        stagedConfig,
        restoredConfigText(readFileSync(stagedConfig, 'utf8'), readFileSync(configPath, 'utf8'))
      );
      try {
        restored = loadConfig({ home, path: stagedConfig, onIgnored: () => {} });
      } catch (error) {
        throw new CliInputError(
          `The backup's config does not load with this install's places: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    const target = targetPaths(restored, configPath, home);
    const prefixes = prefixesIn(manifest);
    for (const prefix of prefixes) destinationOf(prefix, target);
    const stagedDatabase = join(staging, 'database');
    let rows = 0;
    if (existsSync(stagedDatabase)) {
      const jobs = hostJobsInFlight(stagedDatabase);
      if (jobs > 0) {
        throw new CliInputError(
          `The backup holds ${jobs} host job(s) in progress (a person's export or erasure); their paths and file snapshots cannot move, so restore refuses this backup`
        );
      }
      rows = rewriteDatabase(stagedDatabase, PATH_COLUMNS, pathPairs(manifest.configured, target));
    }
    applyModes(staging, manifest.entries);

    const units = prefixes.flatMap((prefix) =>
      unitsFor(prefix, staging!, destinationOf(prefix, target), manifest)
    );
    switchUnits(root, units, id);
    finishSwitch(root);

    // The owner's Codex threads belong to the state before the restore.
    let threads = 0;
    const threadRoot = join(root, 'codex-runtime', 'threads');
    if (existsSync(threadRoot)) {
      const registry = new CodexThreadRegistry({ rootDir: threadRoot });
      for (const key of ['owner:runtime', 'owner:replay']) {
        if (registry.load(key)) {
          registry.remove(key);
          threads += 1;
        }
      }
    }

    write(`restored: ${archive}`);
    write(
      `  ${units.length} path(s) put in place; ${rows} stored attachment path(s) moved to this install's roots`
    );
    write(
      `  backup taken ${manifest.createdAt} by mama-os ${manifest.mama}; database schema version ${manifest.schemaVersion ?? 'none'}`
    );
    if (configFromBackup) {
      write("  config.yaml is the backup's settings with this install's paths (comments dropped)");
    }
    if (!manifest.includesSecrets && !existsSync(join(target.root!, 'auth.env'))) {
      write('  no auth.env: run mama secret set for each secret before starting');
    } else if (!manifest.includesSecrets) {
      write("  this install's own credentials were kept (the backup held none)");
    }
    write(
      `  start.sh was kept; mama service install writes it for this machine's paths; ${threads} Codex thread(s) cleared`
    );
    write('  anything erased after this backup was taken is back');
    write('Check it with mama doctor, then start it with mama service start.');
  } catch (error) {
    if (error instanceof CliInputError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliInputError(
      existsSync(journalPath(root))
        ? `Restore failed and could not be fully put back: ${reason}`
        : `Restore failed and this install was put back as it was: ${reason}`
    );
  } finally {
    if (staging) removeTree(staging);
    lock.release();
  }
}
