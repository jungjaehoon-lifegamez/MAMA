import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

/**
 * Members are denied the home directory, so a Node.js under it (the install's `~/.mama/node`)
 * cannot run in their shell. Boot gives sessions the daemon's own Node at `<tools_root>/node/bin`,
 * which members read (owner decision 2026-11-14).
 */
export const MEMBER_NODE_DIR = 'node';

export function memberNodeBin(toolsRoot: string): string {
  return join(toolsRoot, MEMBER_NODE_DIR, 'bin');
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export interface MemberNode {
  path: string;
  version: string;
  /** `copied` for a Node under HOME, `linked` for one members can already read. */
  how: 'copied' | 'linked' | 'unchanged';
}

/**
 * A Node outside HOME (Homebrew, a system package) is linked: it may need the libraries beside it.
 * A Node under HOME is copied, `node` only: the install's Node is the official single-file build,
 * and npm and npx would need the network the shell is refused. A copy that does not run is an
 * error, never kept.
 */
export function syncMemberNode(
  toolsRoot: string,
  execPath = process.execPath,
  version = process.version,
  home = homedir()
): MemberNode {
  const source = realpathSync(execPath);
  const dir = join(toolsRoot, MEMBER_NODE_DIR);
  const bin = memberNodeBin(toolsRoot);
  const target = join(bin, 'node');
  const versionFile = join(dir, 'version');
  const link = !within(realpathSync(home), source);
  const recorded = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : undefined;
  let present: boolean;
  try {
    const meta = lstatSync(target);
    present = link
      ? meta.isSymbolicLink() && readlinkSync(target) === source
      : meta.isFile() && meta.size === statSync(source).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    present = false;
  }
  if (present && recorded === version) return { path: target, version, how: 'unchanged' };
  mkdirSync(bin, { recursive: true, mode: 0o755 });
  chmodSync(dir, 0o755);
  chmodSync(bin, 0o755);
  const temp = join(bin, `.node-${randomUUID()}`);
  try {
    if (link) symlinkSync(source, temp);
    else {
      // A clone on APFS and on reflink file systems, a plain copy elsewhere.
      copyFileSync(source, temp, constants.COPYFILE_FICLONE);
      chmodSync(temp, 0o755);
      const ran = execFileSync(temp, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim();
      if (ran !== version) throw new Error(`the copy of ${source} reports ${ran}, not ${version}`);
    }
    // Running member processes keep the old file; new ones start the new one.
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
  const versionTemp = `${versionFile}.${randomUUID()}`;
  writeFileSync(versionTemp, `${version}\n`, { mode: 0o644 });
  renameSync(versionTemp, versionFile);
  return { path: target, version, how: link ? 'linked' : 'copied' };
}
