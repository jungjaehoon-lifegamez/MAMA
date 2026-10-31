import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AuthRequirement, SourceTool } from '../../connectors/framework/types.js';
import { gwsTool } from '../../connectors/framework/gws-utils.js';
import { readStartScript, shellWords, startPathEntries, startScriptPath } from '../launch-files.js';
import { CliInputError } from '../prompt.js';
import { shellQuote } from '../secrets.js';
import { managedNodePath, nodeMovePlaces } from './node-move-journal.js';

/**
 * The tools sources run (docs/development/work/install.md, PR 3, I4): a source names its tool
 * with a `type: 'cli'` requirement, and this says, for the sources being enabled, which of those
 * tools the service cannot find, how to install each and how to log in. It reports; the caller
 * decides: `init --section connectors` refuses a source whose tool the service cannot find
 * (W2.4.5e), since that source's start would stop boot.
 */

/** Every tool a source runs, by its command. */
const SOURCE_TOOLS: readonly SourceTool[] = [gwsTool];

/** What the service runs a source's tool with. */
export interface ServiceSight {
  /** The folders its PATH names, in order. */
  readonly path: string[];
  /** The Node start.sh runs; `null` when its exec line names none. */
  readonly nodePath: string | null;
}

/**
 * start.sh's PATH and Node when it exists; before it does (a setup whose service step has not
 * run), what `mama service install` will write from this shell.
 */
export function serviceSight(
  root: string,
  home: string,
  platform: NodeJS.Platform,
  planned: () => { nodePath: string; executablePaths: string[] },
  toolDirectoryExists?: (path: string) => boolean
): ServiceSight {
  const startPath = join(root, 'start.sh');
  if (existsSync(startPath)) {
    // A read error (EACCES) is its own; only the parse is named as one.
    const text = readFileSync(startPath, 'utf8');
    try {
      const reading = readStartScript(text, home);
      return {
        path: startScriptPath(reading, home, platform),
        nodePath: (reading.exec === null ? undefined : shellWords(reading.exec)[1]) ?? null,
      };
    } catch (error) {
      throw new CliInputError(
        `${startPath} does not parse (${error instanceof Error ? error.message : String(error)}); mama service install --replace rewrites it`,
        { cause: error }
      );
    }
  }
  const launch = planned();
  return {
    path: startPathEntries({
      ...launch,
      ...(toolDirectoryExists ? { exists: toolDirectoryExists } : {}),
    }),
    nodePath: launch.nodePath,
  };
}

export interface SourceToolReport {
  readonly tool: SourceTool;
  /** The sources being enabled that run it. */
  readonly sources: string[];
  /** Where the service finds it; `null` when its PATH does not. */
  readonly servicePath: string | null;
  /** Where this shell finds it when the service does not: `mama service install` adds its folder. */
  readonly shellPath: string | null;
  /** Commands that install it, each one way to do it; empty when the service or this shell has it. */
  readonly install: string[];
  /** The command, from this shell, that runs the tool the service will run, with its login. */
  readonly login: string;
}

/** `path` under `home` with nothing a shell reads specially in the rest of it. */
function underHome(path: string, home: string): string | null {
  const rest = path.startsWith(`${home}/`) ? path.slice(home.length + 1) : null;
  return rest !== null && /^[\w./-]+$/.test(rest) ? rest : null;
}

/** `path` for a shell: `~/...` under `home`, anything else quoted. */
function shellPath(path: string, home: string): string {
  const rest = underHome(path, home);
  return rest === null ? shellQuote(path) : `~/${rest}`;
}

/** A `PATH=` prefix that puts `folder` first: `$HOME/...` under `home`, anything else quoted. */
function pathFirst(folder: string, home: string): string {
  const rest = underHome(folder, home);
  return rest === null ? `PATH=${shellQuote(folder)}:"$PATH"` : `PATH="$HOME/${rest}:$PATH"`;
}

type Source = { readonly name: string; readonly needs: readonly AuthRequirement[] };

/** The tool a `type: 'cli'` requirement names; `undefined` for any other requirement. */
function toolFor(source: string, need: AuthRequirement): SourceTool | undefined {
  if (need.type !== 'cli' || need.cli === undefined) return undefined;
  const tool = SOURCE_TOOLS.find(({ command }) => command === need.cli);
  if (tool === undefined)
    throw new Error(`${source} runs ${need.cli}, and nothing says how to install it`);
  return tool;
}

/**
 * `enabled` is every source that will run, `sources` among them: one login serves every source
 * that runs the tool, so it names the scopes all of them need, and logging in for a new source
 * does not narrow what an earlier one was granted.
 */
export function sourceTools(
  sources: readonly Source[],
  service: ServiceSight,
  install: { readonly root: string; readonly home: string },
  find: {
    /** Where a service whose PATH is `dirs` finds `name`. */
    inDirs(name: string, dirs: readonly string[]): string | undefined;
    /** Where this shell finds `name`. */
    shell(name: string): string | undefined;
  },
  enabled: readonly Source[] = sources
): SourceToolReport[] {
  const used = new Map<SourceTool, string[]>();
  for (const { name, needs } of sources) {
    for (const need of needs) {
      const tool = toolFor(name, need);
      if (tool === undefined) continue;
      const names = used.get(tool) ?? [];
      if (!names.includes(name)) used.set(tool, [...names, name]);
    }
  }
  const scopes = new Map<SourceTool, Set<string>>();
  for (const { name, needs } of enabled) {
    for (const need of needs) {
      const tool = toolFor(name, need);
      if (tool === undefined || need.scope === undefined) continue;
      scopes.set(tool, (scopes.get(tool) ?? new Set()).add(need.scope));
    }
  }
  const { root, home } = install;
  // An install the install command made (PR 2): start.sh runs ~/.mama/node, and its PATH names
  // ~/.mama/npm/bin. A tool that is a Node script installs there with that Node.
  const nodeBin = dirname(managedNodePath(root));
  const prefix = nodeMovePlaces(root).prefix;
  const managed =
    service.nodePath === managedNodePath(root) && service.path.includes(join(prefix, 'bin'));
  return [...used].map(([tool, names]) => {
    const onService = find.inDirs(tool.command, service.path) ?? null;
    const onShell = find.shell(tool.command) ?? null;
    const shellOnly = onService === null ? onShell : null;
    const target = onService ?? shellOnly;
    let run: string;
    if (managed) {
      run = `${pathFirst(nodeBin, home)} ${shellPath(target ?? join(prefix, 'bin', tool.command), home)}`;
    } else {
      run = target === null || target === onShell ? tool.command : shellPath(target, home);
    }
    return {
      tool,
      sources: names,
      servicePath: onService,
      shellPath: shellOnly,
      install:
        target !== null
          ? []
          : managed
            ? [
                `${pathFirst(nodeBin, home)} ${shellPath(join(nodeBin, 'npm'), home)} install -g --prefix ${shellPath(prefix, home)} ${tool.npmPackage}`,
              ]
            : [`npm install -g ${tool.npmPackage}`, `brew install ${tool.brewFormula}`],
      login: `${run} ${tool.loginArgs}${scopes.has(tool) ? ` ${tool.scopeFlag} ${[...scopes.get(tool)!].sort().join(',')}` : ''}`,
    };
  });
}

/**
 * What `mama init` and `init --section connectors` print for each report: the tool's login, after
 * what it needs first. A tool the service cannot find also gets how to install it, and `next`
 * last: the service does not start while a source's tool is missing from its PATH (the source's
 * start fails boot).
 */
export function sourceToolLines(reports: readonly SourceToolReport[], next: string): string[] {
  return reports.flatMap((report) => {
    const { tool, sources } = report;
    const who = sources.join(', ');
    const s = sources.length > 1 ? '' : 's';
    const stops = `MAMA's service does not start with ${who} until ${tool.command} is on its PATH.`;
    if (report.servicePath !== null)
      return [tool.beforeLogin, `Then log in to ${tool.command} for ${who}: ${report.login}`];
    if (report.shellPath !== null)
      return [
        `${who} run${s} ${tool.command}; this shell finds ${report.shellPath}, but the service's PATH does not name ${dirname(report.shellPath)}. mama service install adds it.`,
        tool.beforeLogin,
        `Then log in to ${tool.command} for ${who}: ${report.login}`,
        `${stops} ${next}`,
      ];
    return [
      `${who} run${s} ${tool.command}, which the service's PATH does not have. Install it${report.install.length > 1 ? ' with one of' : ''}:`,
      ...report.install.map((command) => `  ${command}`),
      tool.beforeLogin,
      `Then log in to ${tool.command} for ${who}:`,
      `  ${report.login}`,
      `${stops} ${next}`,
    ];
  });
}
