import { accessSync, constants, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { CliInputError } from '../prompt.js';

export interface DefaultRoots {
  memberRoot: string;
  toolsRoot: string;
}

/**
 * Where a new install keeps its member folders and its document tools: outside HOME, one place
 * per person on the machine (plan decision 3). On macOS a folder of this user's sits directly in
 * the sticky Shared folder beside the home folders, so no account uses a parent another set up;
 * on Linux it is /var/lib/mama/<user>, which the installer creates once with sudo.
 */
export function defaultRoots(
  options: { platform?: NodeJS.Platform; home?: string; user?: string } = {}
): DefaultRoots | undefined {
  const platform = options.platform ?? process.platform;
  const user = options.user ?? userInfo().username;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(user)) return undefined;
  const base =
    platform === 'darwin'
      ? join(dirname(options.home ?? homedir()), 'Shared', `mama-${user}`)
      : platform === 'linux'
        ? join('/var/lib/mama', user)
        : undefined;
  return base === undefined
    ? undefined
    : { memberRoot: join(base, 'members'), toolsRoot: join(base, 'tools') };
}

/**
 * Make a root that this user alone owns and writes, or refuse one that is not: the agent runs
 * what tools_root holds and reads what member_root holds, and the Shared folder lets any account
 * create a folder first. `ownParent` also checks the per-user folder a default sits in. A root
 * this account cannot create (Linux's /var/lib/mama) names the one sudo step that makes its
 * per-user folder; the subfolders are made here.
 */
export function prepareRoot(
  path: string,
  options: { uid?: number; ownParent?: boolean } = {}
): void {
  const uid = options.uid ?? process.getuid?.();
  if (!existsSync(path)) {
    try {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EACCES' && code !== 'EPERM' && code !== 'EROFS') throw error;
      const folder = options.ownParent ? dirname(path) : path;
      throw new CliInputError(
        `${path} cannot be created. Create ${folder} for this account once: sudo install -d -o "$USER" -m 0700 ${folder}`
      );
    }
  }
  for (const folder of options.ownParent ? [dirname(path), path] : [path]) {
    const stat = lstatSync(folder);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new CliInputError(`${folder} must be a folder, not a link or a file`);
    if (uid !== undefined && stat.uid !== uid)
      throw new CliInputError(`${folder} belongs to another account; choose another folder`);
    if ((stat.mode & 0o022) !== 0)
      throw new CliInputError(`${folder} can be written by other accounts; run chmod 700 on it`);
  }
  accessSync(path, constants.W_OK);
}
