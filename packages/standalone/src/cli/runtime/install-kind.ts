import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CliInputError } from '../prompt.js';
import { readStartScript, shellWords } from '../launch-files.js';
import { shellQuote } from '../secrets.js';

export const PACKAGE_NAME = '@jungjaehoon/mama-os';
const CORE_NAME = '@jungjaehoon/mama-core';

/**
 * How the package the service runs was installed (docs/development/work/update.md, "Install
 * kinds"). npm: a global install, `<prefix>/lib/node_modules/@jungjaehoon/mama-os`; checkout: a
 * workspace build, whose package.json names core `workspace:*` (a published package carries a
 * version); other: anything else, with the reason.
 */
export type PackageKind =
  | { readonly kind: 'npm'; readonly packageRoot: string; readonly prefix: string }
  | { readonly kind: 'checkout'; readonly packageRoot: string; readonly workspaceRoot: string }
  | { readonly kind: 'other'; readonly packageRoot: string | null; readonly reason: string };

/** The service's package, with the Node and the MAMA command start.sh's exec line names. */
export type InstallKind =
  | (Exclude<PackageKind, { kind: 'other' }> & {
      readonly nodePath: string;
      readonly cliPath: string;
    })
  | (Extract<PackageKind, { kind: 'other' }> & {
      readonly nodePath: string | null;
      readonly cliPath: string | null;
    });

/** The nearest folder at or above `from` whose package.json is MAMA OS's, after realpath. */
export function packageRootOf(from: string): string | null {
  let directory = realpathSync(from);
  for (;;) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      const name = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name;
      if (name === PACKAGE_NAME) return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** The package that holds the running code (this CLI or this daemon). */
export function runningPackageRoot(): string {
  const root = packageRootOf(__dirname);
  if (root === null) throw new Error(`${__dirname} is not inside a ${PACKAGE_NAME} package`);
  return root;
}

/** What kind of install a MAMA OS package folder is. */
export function packageKind(packageRoot: string): PackageKind {
  const npm = /^(.*)\/lib\/node_modules\/@jungjaehoon\/mama-os$/.exec(packageRoot);
  if (npm) return { kind: 'npm', packageRoot, prefix: npm[1] };
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, unknown>;
  };
  if (manifest.dependencies?.[CORE_NAME] === 'workspace:*') {
    // `pnpm install` and `pnpm build` run from the workspace root, which builds core first.
    for (let directory = dirname(packageRoot); ; directory = dirname(directory)) {
      if (existsSync(join(directory, 'pnpm-workspace.yaml'))) {
        return { kind: 'checkout', packageRoot, workspaceRoot: directory };
      }
      if (dirname(directory) === directory) break;
    }
    return {
      kind: 'other',
      packageRoot,
      reason: `${packageRoot} names core workspace:* but no pnpm workspace holds it`,
    };
  }
  return {
    kind: 'other',
    packageRoot,
    reason: `${packageRoot} is neither an npm global install nor a checkout`,
  };
}

/**
 * The kind of the package the service runs: start.sh's exec line names it, so this reads that,
 * not the CLI that asks. Without a readable start.sh the kind is `other`, with the reason.
 */
export function installKind(mamaRoot: string, home: string): InstallKind {
  const startPath = join(mamaRoot, 'start.sh');
  if (!existsSync(startPath)) {
    return {
      kind: 'other',
      packageRoot: null,
      nodePath: null,
      cliPath: null,
      reason: `no ${startPath}; mama service install writes it`,
    };
  }
  let words: string[] = [];
  try {
    const exec = readStartScript(readFileSync(startPath, 'utf8'), home).exec;
    if (exec !== null) words = shellWords(exec);
  } catch (error) {
    // Doctor's start.sh check names this too; status and doctor still print the rest.
    return {
      kind: 'other',
      packageRoot: null,
      nodePath: null,
      cliPath: null,
      reason: `${startPath} does not parse: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const [, nodePath, cliPath] = words;
  if (nodePath === undefined || cliPath === undefined) {
    return {
      kind: 'other',
      packageRoot: null,
      nodePath: null,
      cliPath: null,
      reason: `${startPath} has no exec line naming Node and the MAMA command`,
    };
  }
  if (!existsSync(cliPath)) {
    return {
      kind: 'other',
      packageRoot: null,
      nodePath,
      cliPath,
      reason: `${cliPath}, which start.sh runs, is gone`,
    };
  }
  const packageRoot = packageRootOf(cliPath);
  if (packageRoot === null) {
    return {
      kind: 'other',
      packageRoot: null,
      nodePath,
      cliPath,
      reason: `${cliPath}, which start.sh runs, is not inside a ${PACKAGE_NAME} package`,
    };
  }
  return { ...packageKind(packageRoot), nodePath, cliPath };
}

/**
 * Refuse unless the running CLI is the package the service runs. On a machine where `mama` on
 * PATH is an older global install while the service runs a checkout, the PATH one would update
 * the wrong package.
 */
export function requireServicePackage(
  install: InstallKind,
  running: string = runningPackageRoot()
): asserts install is Exclude<InstallKind, { kind: 'other' }> {
  // `other` has no update path whether or not its folder is known (the kinds table).
  if (install.kind === 'other') {
    throw new CliInputError(
      install.packageRoot === null
        ? `Cannot tell which package the service runs: ${install.reason}`
        : `The service runs a package mama cannot update: ${install.reason}`
    );
  }
  if (realpathSync(running) !== install.packageRoot) {
    throw new CliInputError(
      `This mama is ${realpathSync(running)}, but the service runs ${install.packageRoot}${install.nodePath === null || install.cliPath === null ? '' : `; use ${shellQuote(install.nodePath)} ${shellQuote(install.cliPath)}`}`
    );
  }
}

/** How this kind updates: `mama update` for npm, the git steps for a checkout. */
export function updateSteps(install: InstallKind): string[] {
  if (install.kind === 'npm') return ['mama update'];
  if (install.kind === 'other') return [`no update path: ${install.reason}`];
  // `service install` writes the running CLI as exec, so the steps name this checkout's by path.
  // The stop comes first: sessions start the action MCP server from dist, which the build rewrites.
  const cli = `${shellQuote(install.nodePath)} ${shellQuote(install.cliPath)}`;
  const cd = `cd ${shellQuote(install.workspaceRoot)}`;
  return [
    `${cli} stop`,
    `${cd} && git pull --ff-only`,
    `${cd} && pnpm install`,
    `${cd} && pnpm build`,
    `${cli} service install`,
    `${cli} service start`,
  ];
}
