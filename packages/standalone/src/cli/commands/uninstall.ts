/**
 * `mama uninstall [--dry-run] [--data [--toolkit]]`: stop MAMA and remove its service. With
 * --data, once the MAMA home's path has been typed back, also remove what MAMA created: the MAMA
 * home, the folder of each person it registered under `member_root` (and the folders it retired),
 * and the common skills under `tools_root` (with --toolkit, the toolkit's versions too). A folder
 * MAMA did not create is never removed whole: `member_root` and `tools_root` go only once empty, so
 * a misconfigured root (a volume, a shared folder) loses nothing but MAMA's own entries.
 * `--dry-run` lists what would go and what stays, and changes nothing.
 *
 * The program: an `npm install -g` is npm's to remove. The install command keeps it in the MAMA
 * home instead (Node, the npm prefix and the `mama` command, docs/development/work/install.md):
 * --data removes it with the home, last, so a removal that fails part-way leaves a `mama` to run
 * again; without --data it stays and is named. Either way the startup block the install command
 * wrote is named for the owner to remove: it is the owner's file.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import Database from 'better-sqlite3';
import { defaultConfigPath, loadConfig, type W1Config } from '../../runtime/config.js';
import { physicalReadPath } from '../../runtime/backend-security.js';
import { memberClaudeTmpDir, memberRoomTmpRoot } from '../../runtime/member-paths.js';
import { removeVersion } from '../../tools/document-toolkit.js';
import { CliInputError, createTerminalPrompt, requireTTY, type PromptAdapter } from '../prompt.js';
import { MANAGED_PROGRAM } from '../runtime/backup.js';
import { acquireInstallLock, daemonControlPaths, lockHolder } from '../runtime/daemon-control.js';
import { runStop } from './control.js';
import { serviceFile, uninstallService, type ServiceOptions } from './service.js';

const USAGE = 'Usage: mama uninstall [--dry-run] [--data [--toolkit]]';
const PRINCIPAL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface UninstallOptions extends ServiceOptions {
  prompt?: PromptAdapter;
}

interface Entry {
  path: string;
  what: string;
  /** How it is removed when a plain recursive removal cannot be (a read-only toolkit version). */
  remove?: (path: string) => void;
  /** Part of the managed program: kept when anything before it could not be removed. */
  program?: boolean;
}

interface DataPlan {
  root: string;
  /** Removed, in this order; the MAMA home is last, since the install lock lives there. */
  remove: Entry[];
  /** Removed only when nothing else is left in them. */
  emptied: string[];
  /** MAMA's settings point here, outside the MAMA home; not removed. */
  stays: Entry[];
}

/** The program the install command keeps in the MAMA home, as far as it is there. */
function managedProgram(root: string): string[] {
  return existsSync(join(root, 'npm', 'lib', 'node_modules', '@jungjaehoon', 'mama-os'))
    ? [...MANAGED_PROGRAM].map((name) => join(root, name)).filter((path) => existsSync(path))
    : [];
}

/** The startup files whose marked block the install command wrote (install.sh, "Startup block"). */
function startupBlocks(home: string): string[] {
  return [
    join(process.env.ZDOTDIR ?? home, '.zshrc'),
    join(home, '.bashrc'),
    join(home, '.bash_profile'),
    join(home, '.profile'),
  ].filter(
    (path) =>
      existsSync(path) &&
      readFileSync(path, 'utf8')
        .split('\n')
        .some((line) => line.replace(/\r$/, '') === '# >>> mama >>>')
  );
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

/** Bytes under a path, links counted as themselves; null when part of it cannot be read. */
function sizeOf(path: string): number | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory()) return stat.size;
    let sum = 0;
    for (const name of readdirSync(path)) {
      const size = sizeOf(join(path, name));
      if (size === null) return null;
      sum += size;
    }
    return sum;
  } catch {
    return null;
  }
}

function sized(path: string): string {
  const bytes = sizeOf(path);
  return bytes === null
    ? 'size unknown: part of it cannot be read'
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Inside `parent`, or `parent` itself, by physical path (real case, links resolved). */
function within(parent: string, child: string): boolean {
  const path = relative(physicalReadPath(parent), physicalReadPath(child));
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`));
}

/** The ids of the people MAMA registered, from its own database. */
function registeredPeople(config: W1Config): string[] {
  if (!existsSync(config.database.path)) return [];
  const db = new Database(config.database.path, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare('SELECT principal_id FROM principals').all() as { principal_id: string }[])
      .map((row) => row.principal_id)
      .filter((id) => PRINCIPAL_ID.test(id));
  } finally {
    db.close();
  }
}

/**
 * What --data removes. The MAMA home goes whole, and is refused when it is a link or when it is the
 * filesystem root, HOME or a folder holding HOME (compared by physical path, so a different letter
 * case on a case-insensitive disk is the same folder). Under member_root and tools_root only the
 * entries MAMA creates go.
 */
function dataPlan(home: string, configPath: string, toolkit: boolean): DataPlan {
  const root = dirname(configPath);
  const plan: DataPlan = { root, remove: [], emptied: [], stays: [] };
  if (!existsSync(root)) return plan;
  if (lstatSync(root).isSymbolicLink()) {
    throw new CliInputError(`${root} is a link; remove its target, or the link, yourself`);
  }
  if (within(physicalReadPath(root), home) || physicalReadPath(root) === sep) {
    throw new CliInputError(
      `refusing to remove ${root}: it is the filesystem root, your home or a folder that holds it`
    );
  }
  if (existsSync(configPath)) {
    const config = loadConfig({ home, path: configPath });
    if (config.member_root !== undefined && existsSync(config.member_root)) {
      for (const id of registeredPeople(config)) {
        const folder = join(config.member_root, id);
        if (existsSync(folder))
          plan.remove.push({ path: folder, what: `${id}'s workspace and state` });
        for (const temp of [memberClaudeTmpDir(id), memberRoomTmpRoot(id)]) {
          if (existsSync(temp)) plan.remove.push({ path: temp, what: `${id}'s temporary files` });
        }
      }
      for (const entry of readdirSync(config.member_root)) {
        if (entry.startsWith('.retired-')) {
          plan.remove.push({ path: join(config.member_root, entry), what: 'a retired folder' });
        }
      }
      plan.emptied.push(config.member_root);
    }
    if (config.tools_root !== undefined && existsSync(config.tools_root)) {
      for (const entry of readdirSync(config.tools_root)) {
        const path = join(config.tools_root, entry);
        if (entry === 'skills') {
          plan.remove.push({ path, what: 'the common skills' });
        } else if (!toolkit) {
          continue;
        } else if (entry.startsWith('v-')) {
          plan.remove.push({ path, what: 'a document toolkit version', remove: removeVersion });
        } else if (
          entry === 'current' ||
          entry.startsWith('.current-') ||
          entry === '.leases' ||
          entry === '.mama-document-toolkit'
        ) {
          plan.remove.push({ path, what: 'the document toolkit' });
        } else if (entry === 'apps' || entry === 'fonts') {
          // Homebrew installed these casks into tools_root and keeps their records.
          const casks = entry === 'apps' ? 'libreoffice' : 'font-noto-sans-cjk font-noto-serif-cjk';
          plan.stays.push({ path, what: `installed by Homebrew: brew uninstall --cask ${casks}` });
        }
      }
      if (toolkit) plan.emptied.push(config.tools_root);
    }
    // Settings can point outside the MAMA home; such a path is not proven to be MAMA's alone.
    const elsewhere: Entry[] = [
      { path: config.database.path, what: 'the database' },
      { path: config.logging.file, what: 'the daemon log' },
      { path: config.agent.codex_home ?? join(root, '.codex'), what: 'the Codex home' },
      { path: config.jev.keyFile, what: 'the Jev key' },
      { path: config.jev.vocabFile, what: "Jev's vocabulary" },
      ...(config.agent.codex_cwd
        ? [{ path: config.agent.codex_cwd, what: 'the Codex workspace' }]
        : []),
      ...(config.agent.tools?.mcp_config
        ? [{ path: config.agent.tools.mcp_config, what: 'the MCP configuration' }]
        : []),
    ];
    for (const entry of elsewhere) {
      if (existsSync(entry.path) && !within(root, entry.path)) {
        plan.stays.push({
          path: entry.path,
          what: `${entry.what}, set outside the MAMA home; remove it yourself if it is MAMA's alone`,
        });
      }
    }
  }
  const program = managedProgram(root);
  plan.remove.push({
    path: root,
    what: 'the MAMA home: config, credentials, workspace, logs, backups and, by default, the database',
    // The program goes after the rest of the home, and the home with it (below).
    ...(program.length === 0
      ? {}
      : {
          remove: (path: string) => {
            for (const name of readdirSync(path)) {
              if (!MANAGED_PROGRAM.has(name))
                rmSync(join(path, name), { recursive: true, force: true });
            }
          },
        }),
  });
  program.forEach((path, index) =>
    plan.remove.push({
      path,
      what: 'the managed program the install command put here (Node.js, MAMA OS and the mama command)',
      program: true,
      // The last one takes the emptied home with it.
      ...(index === program.length - 1
        ? {
            remove: (folder: string) => {
              rmSync(folder, { recursive: true, force: true });
              rmdirSync(root);
            },
          }
        : {}),
    })
  );
  return plan;
}

export async function runUninstall(
  args: readonly string[],
  options: UninstallOptions = {}
): Promise<number> {
  const { dryRun, data, toolkit } = parseArgs(args);
  const home = options.home ?? homedir();
  const configPath = options.configPath ?? defaultConfigPath(home);
  const write = options.write ?? ((line: string) => console.log(line));
  const plan = data ? dataPlan(home, configPath, toolkit) : null;
  const program = managedProgram(dirname(configPath));
  /** What stays of the program, and the startup block, after the rest. */
  const programNotes = (): void => {
    if (program.length === 0) {
      if (plan) write('npm uninstall -g @jungjaehoon/mama-os removes the program itself');
    } else if (!plan) {
      write(
        `the managed program stays: ${program.join(', ')} (mama uninstall --data removes it with the data)`
      );
    }
    for (const file of startupBlocks(home)) {
      write(
        `remove the lines from '# >>> mama >>>' to '# <<< mama <<<' in ${file}: the install command wrote them to put ${join(dirname(configPath), 'bin')} on PATH`
      );
    }
  };
  const notes = (prefix: string, say: (line: string) => void): void => {
    if (!plan) return;
    for (const entry of plan.remove)
      say(`${prefix} ${entry.path} (${sized(entry.path)}): ${entry.what}`);
    for (const folder of plan.emptied)
      say(`${prefix} ${folder} too, if nothing else is left in it`);
    for (const entry of plan.stays) {
      say(`stays: ${entry.path} (${entry.what})`);
    }
  };

  if (dryRun) {
    write(`would stop MAMA and remove its service: ${serviceFile(options)}`);
    notes('would remove', write);
    if (!data) write('the data stays; --data also removes it');
    programNotes();
    return 0;
  }

  if (plan && plan.remove.length > 0) {
    const prompt = options.prompt ?? createTerminalPrompt();
    requireTTY(prompt);
    notes('removes', (line) => prompt.write(line));
    const typed = (
      await prompt.text(`This cannot be undone. Type ${plan.root} to remove it`)
    ).trim();
    if (typed !== plan.root) throw new CliInputError('Not confirmed; nothing was removed.');
  }

  // Whatever holds the install (the service's daemon, one started by hand) stops first; a command
  // that cannot be stopped this way leaves everything as it was.
  const control = daemonControlPaths(dirname(configPath));
  if (lockHolder(control) !== null) {
    const stopped = await runStop([], options);
    if (stopped !== 0) return stopped;
  }
  const removed = await uninstallService(options);
  if (removed !== 0 || !plan || !existsSync(plan.root)) {
    programNotes();
    return removed;
  }

  // One entry that cannot be removed does not stop the rest half-way; each failure is reported.
  const failed: string[] = [];
  const lock = acquireInstallLock(control, 'uninstall');
  try {
    for (const entry of plan.remove) {
      if (entry.program && failed.length > 0) {
        write(`kept ${entry.path}: run mama uninstall --data again once the above is removed`);
        continue;
      }
      try {
        if (entry.remove) entry.remove(entry.path);
        else rmSync(entry.path, { recursive: true, force: true });
        write(`removed ${entry.path}`);
      } catch (error) {
        failed.push(`${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const folder of plan.emptied) {
      if (existsSync(folder) && readdirSync(folder).length === 0) {
        rmdirSync(folder);
        write(`removed ${folder}`);
      } else if (existsSync(folder)) {
        write(`kept ${folder}: it still holds what stays, or entries MAMA did not create`);
      }
    }
  } finally {
    // The lock's file went with the MAMA home; closing it is all that is left.
    lock.release();
  }
  for (const failure of failed) write(`could not remove ${failure}`);
  programNotes();
  return failed.length > 0 ? 1 : 0;
}
