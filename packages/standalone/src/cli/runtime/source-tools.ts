import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AuthConfig, SourceTool } from '../../connectors/framework/types.js';
import { gwsTool } from '../../connectors/framework/gws-utils.js';
import { readStartScript, shellWords, startPathEntries, startScriptPath } from '../launch-files.js';
import { shellQuote } from '../secrets.js';
import { managedNodePath, nodeMovePlaces } from './node-move-journal.js';

/**
 * The tools sources run (docs/development/work/install.md, PR 3, I4): a source names its tool
 * with a `type: 'cli'` requirement, and this says, for the sources being enabled, which of those
 * tools the service cannot find, how to install each and how to log in. It reports; it never
 * refuses a setup.
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
    const reading = readStartScript(readFileSync(startPath, 'utf8'), home);
    return {
      path: startScriptPath(reading, home, platform),
      nodePath: (reading.exec === null ? undefined : shellWords(reading.exec)[1]) ?? null,
    };
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

export function sourceTools(
  sources: ReadonlyArray<{ readonly name: string; readonly needs: readonly AuthConfig[] }>,
  service: ServiceSight,
  install: { readonly root: string; readonly home: string },
  find: {
    /** Where a service whose PATH is `dirs` finds `name`. */
    inDirs(name: string, dirs: readonly string[]): string | undefined;
    /** Where this shell finds `name`. */
    shell(name: string): string | undefined;
  }
): SourceToolReport[] {
  const used = new Map<SourceTool, string[]>();
  for (const { name, needs } of sources) {
    for (const need of needs) {
      if (need.type !== 'cli' || need.cli === undefined) continue;
      const tool = SOURCE_TOOLS.find(({ command }) => command === need.cli);
      if (tool === undefined)
        throw new Error(`${name} runs ${need.cli}, and nothing says how to install it`);
      const names = used.get(tool) ?? [];
      if (!names.includes(name)) used.set(tool, [...names, name]);
    }
  }
  const { root, home } = install;
  // An install the install command made (PR 2): start.sh runs ~/.mama/node, and its PATH names
  // ~/.mama/npm/bin. A tool that is a Node script installs there with that Node.
  const managed = service.nodePath === managedNodePath(root);
  const nodeBin = dirname(managedNodePath(root));
  const prefix = nodeMovePlaces(root).prefix;
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
      login: `${run} ${tool.loginArgs}`,
    };
  });
}

/** What `mama init` and `init --section connectors` print for each report. */
export function sourceToolLines(reports: readonly SourceToolReport[]): string[] {
  return reports.flatMap((report) => {
    const { tool, sources } = report;
    const who = sources.join(', ');
    const s = sources.length > 1 ? '' : 's';
    const scopes = `${tool.command} with the scopes ${who} need${s}:`;
    if (report.servicePath !== null) return [`Log in to ${scopes} ${report.login}`];
    if (report.shellPath !== null)
      return [
        `${who} run${s} ${tool.command}; this shell finds ${report.shellPath}, but the service's PATH does not name ${dirname(report.shellPath)}. mama service install adds it; mama service restart then applies it.`,
        `Log in to ${scopes} ${report.login}`,
      ];
    return [
      `${who} run${s} ${tool.command}, which the service's PATH does not have. Install it${report.install.length > 1 ? ' with one of' : ''}:`,
      ...report.install.map((command) => `  ${command}`),
      `Then log in to ${scopes}`,
      `  ${report.login}`,
    ];
  });
}
