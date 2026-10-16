/**
 * `mama uninstall [--dry-run] [--data [--toolkit]]`: stop MAMA and remove its service. With
 * --data, once the MAMA home's path has been typed back, also remove what MAMA keeps: the MAMA
 * home, every person's folder under `member_root`, and the common skills under `tools_root` (all
 * of `tools_root` with --toolkit). `--dry-run` lists what would go and changes nothing. The
 * program itself is an npm package, which npm removes; the owner's vault and other tools' homes
 * (such as ~/.claude) are not MAMA's to remove.
 */
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { defaultConfigPath, loadConfig } from '../../runtime/config.js';
import { CliInputError, createTerminalPrompt, requireTTY, type PromptAdapter } from '../prompt.js';
import { acquireInstallLock, daemonControlPaths } from '../runtime/daemon-control.js';
import { serviceFile, uninstallService, type ServiceOptions } from './service.js';

const USAGE = 'Usage: mama uninstall [--dry-run] [--data [--toolkit]]';

export interface UninstallOptions extends ServiceOptions {
  prompt?: PromptAdapter;
}

interface Target {
  path: string;
  what: string;
}

function parseArgs(args: readonly string[]): { dryRun: boolean; data: boolean; toolkit: boolean } {
  const flags = new Set(args);
  for (const arg of flags) {
    if (!['--dry-run', '--data', '--toolkit'].includes(arg)) throw new CliInputError(USAGE);
  }
  if (flags.has('--toolkit') && !flags.has('--data')) throw new CliInputError(USAGE);
  return {
    dryRun: flags.has('--dry-run'),
    data: flags.has('--data'),
    toolkit: flags.has('--toolkit'),
  };
}

/** Bytes under a path, links counted as themselves. */
function sizeOf(path: string): number {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((sum, name) => sum + sizeOf(join(path, name)), 0);
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * What --data removes, from the config that says where it is. The config's own checks keep
 * member_root and tools_root apart from HOME and the MAMA home; a removal this broad also refuses,
 * on its own, any target that is the filesystem root, HOME or a folder holding HOME, since a
 * hand-edited config could otherwise point it at the user's files.
 */
function dataTargets(home: string, configPath: string, toolkit: boolean): Target[] {
  const root = dirname(configPath);
  const targets: Target[] = [];
  if (existsSync(configPath)) {
    const config = loadConfig({ home, path: configPath });
    if (config.member_root !== undefined) {
      targets.push({ path: config.member_root, what: "every person's workspace and state" });
    }
    if (config.tools_root !== undefined) {
      targets.push(
        toolkit
          ? { path: config.tools_root, what: 'the document toolkit and the common skills' }
          : { path: join(config.tools_root, 'skills'), what: 'the common skills' }
      );
    }
  }
  // Last: the install lock lives here, and it is held while the rest goes.
  targets.push({ path: root, what: 'the MAMA home: database, config, credentials, logs, backups' });
  const realHome = realpathSync(home);
  for (const target of targets) {
    const physical = existsSync(target.path) ? realpathSync(target.path) : resolve(target.path);
    const fromTarget = relative(physical, realHome);
    if (physical === sep || fromTarget === '' || !fromTarget.startsWith('..')) {
      throw new CliInputError(
        `refusing to remove ${target.path}: it is the filesystem root, your home or a folder that holds it`
      );
    }
  }
  return targets.filter((target) => existsSync(target.path));
}

export async function runUninstall(
  args: readonly string[],
  options: UninstallOptions = {}
): Promise<number> {
  const { dryRun, data, toolkit } = parseArgs(args);
  const home = options.home ?? homedir();
  const configPath = options.configPath ?? defaultConfigPath(home);
  const write = options.write ?? ((line: string) => console.log(line));
  const targets = data ? dataTargets(home, configPath, toolkit) : [];

  if (dryRun) {
    write(`would stop MAMA and remove its service: ${serviceFile(options)}`);
    for (const target of targets) {
      write(`would remove ${target.path} (${megabytes(sizeOf(target.path))}): ${target.what}`);
    }
    if (!data) write('the data stays; --data also removes it');
    return 0;
  }

  if (data && targets.length > 0) {
    const prompt = options.prompt ?? createTerminalPrompt();
    requireTTY(prompt);
    for (const target of targets) prompt.write(`removes ${target.path}: ${target.what}`);
    const root = dirname(configPath);
    const typed = (
      await prompt.text(`This cannot be undone. Type ${root} to remove all of it`)
    ).trim();
    if (typed !== root) throw new CliInputError('Not confirmed; nothing was removed.');
  }

  const stopped = await uninstallService(options);
  if (stopped !== 0 || !data) return stopped;

  // A daemon started by hand, or another command, still holding the install is refused here.
  const root = dirname(configPath);
  if (existsSync(root)) {
    const lock = acquireInstallLock(daemonControlPaths(root), 'uninstall');
    try {
      for (const target of targets.filter((target) => target.path !== root)) {
        rmSync(target.path, { recursive: true, force: true });
        write(`removed ${target.path}`);
      }
    } finally {
      lock.release();
    }
    rmSync(root, { recursive: true, force: true });
    write(`removed ${root}`);
  }
  write('npm uninstall -g @jungjaehoon/mama-os removes the program itself');
  return 0;
}
