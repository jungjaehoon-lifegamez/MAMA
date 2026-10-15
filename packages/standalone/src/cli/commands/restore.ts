import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { defaultConfigPath, loadConfig } from '../../runtime/config.js';
import { CliInputError } from '../prompt.js';
import { acquireInstallLock, daemonControlPaths } from '../runtime/daemon-control.js';
import {
  applyModes,
  CORE_PATH_COLUMNS,
  destinationOf,
  extractVerified,
  finishSwitch,
  journalPath,
  newRestoreId,
  pathPairs,
  prefixesIn,
  RAW_PATH_COLUMNS,
  readManifest,
  removeTree,
  rewriteDatabase,
  rewriteText,
  rollBack,
  switchUnits,
  targetPaths,
  type SwitchUnit,
} from '../runtime/restore.js';

export interface RestoreOptions {
  home?: string;
  configPath?: string;
  write?: (line: string) => void;
}

const USAGE = 'Usage: mama restore <archive> | mama restore --rollback';

/**
 * `mama restore <archive>`: put a `mama backup` archive onto this stopped install. Destinations
 * come from this install's config; paths the archive recorded are rewritten to them in config and
 * in the stored attachment paths. Each destination goes aside while its copy takes its place, and
 * a journal puts every one back if any switch fails. Credentials and start.sh the archive does
 * not hold stay as they are.
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
  // Nothing may run while files are switched under it.
  const lock = acquireInstallLock(daemonControlPaths(root), 'restore');
  let staging: string | null = null;
  try {
    if (args[0] === '--rollback') {
      const undone = rollBack(root);
      write(
        undone > 0
          ? `put back ${undone} path(s) from the interrupted restore`
          : 'nothing to roll back'
      );
      return;
    }
    if (existsSync(journalPath(root))) {
      throw new CliInputError(
        'An earlier restore was interrupted; mama restore --rollback puts this install back first'
      );
    }
    const archive = resolve(args[0]);
    if (!existsSync(archive) || !statSync(archive).isFile()) {
      throw new CliInputError(`${archive} is not a file`);
    }
    const manifest = await readManifest(archive);
    const target = targetPaths(config, configPath, home);
    const prefixes = prefixesIn(manifest);
    // Refused before anything is written when the target lacks a place for something.
    for (const prefix of prefixes) destinationOf(prefix, target);
    const pairs = pathPairs(manifest.configured, target);

    const id = newRestoreId();
    mkdirSync(join(root, 'backups'), { recursive: true, mode: 0o700 });
    staging = join(root, 'backups', `.restore-${id}`);
    await extractVerified(archive, manifest, staging);

    const stagedConfig = join(staging, 'root', 'config.yaml');
    if (existsSync(stagedConfig)) {
      writeFileSync(stagedConfig, rewriteText(readFileSync(stagedConfig, 'utf8'), pairs));
    }
    let rows = 0;
    if (existsSync(join(staging, 'database'))) {
      rows += rewriteDatabase(join(staging, 'database'), CORE_PATH_COLUMNS, pairs);
    }
    const stagedConnectors = join(staging, 'root', 'connectors');
    if (existsSync(stagedConnectors)) {
      for (const name of readdirSync(stagedConnectors)) {
        const store = join(stagedConnectors, name, 'raw.db');
        if (existsSync(store)) rows += rewriteDatabase(store, RAW_PATH_COLUMNS, pairs);
      }
    }
    applyModes(staging, manifest.entries);

    const units: SwitchUnit[] = [];
    for (const prefix of prefixes) {
      if (prefix === 'root') {
        for (const name of readdirSync(join(staging, 'root'))) {
          // start.sh names this machine's Node and paths; mama service install writes it.
          if (name === 'start.sh') continue;
          // The install lock lives in runtime/, so its files are switched one by one.
          if (name === 'runtime') {
            for (const child of readdirSync(join(staging, 'root', 'runtime'))) {
              units.push({
                staged: join(staging, 'root', 'runtime', child),
                destination: join(target.root!, 'runtime', child),
              });
            }
            continue;
          }
          units.push({
            staged: join(staging, 'root', name),
            destination: join(target.root!, name),
          });
        }
      } else {
        const destination = destinationOf(prefix, target);
        units.push({
          staged: join(staging, ...prefix.split('/')),
          destination,
          // A WAL left beside the old database would be applied to the new one.
          ...(prefix === 'database'
            ? { companions: ['-wal', '-shm', '-journal'].map((end) => destination + end) }
            : {}),
        });
      }
    }
    switchUnits(root, units, id);
    finishSwitch(root);

    write(`restored: ${archive}`);
    write(
      `  ${units.length} path(s) put in place; ${rows} stored path(s) rewritten from the old install's locations`
    );
    write(
      `  backup taken ${manifest.createdAt} by mama-os ${manifest.mama}; database schema version ${manifest.schemaVersion ?? 'none'}`
    );
    if (!manifest.includesSecrets && !existsSync(join(target.root!, 'auth.env'))) {
      write('  no auth.env: run mama secret set for each secret before starting');
    } else if (!manifest.includesSecrets) {
      write("  this install's own credentials were kept (the backup held none)");
    }
    write("  start.sh was kept; mama service install writes it for this machine's paths");
    write('  Codex sessions start over; anything erased after this backup was taken is back');
    write('Check it with mama doctor, then start it with mama service start.');
  } catch (error) {
    if (error instanceof CliInputError) throw error;
    throw new CliInputError(
      `Restore failed and this install was put back as it was: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    if (staging) removeTree(staging);
    lock.release();
  }
}
