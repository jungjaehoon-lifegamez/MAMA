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
  readdirSync,
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

const VERSION_TEMP =
  /^version\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NODE_TEMP = /^\.node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Whether `<tools_root>/node` holds only what syncMemberNode writes: a hand-picked tools_root may
 * already have a `node` folder of the person's own, which boot must not overwrite, adopt or remove.
 * A folder with a `node` but no `version` was not written here (the version is written first).
 */
export function isManagedMemberNode(dir: string): boolean {
  try {
    if (lstatSync(dir).isSymbolicLink() || !statSync(dir).isDirectory()) return false;
    const entries = readdirSync(dir);
    if (!entries.every((name) => name === 'version' || name === 'bin' || VERSION_TEMP.test(name)))
      return false;
    const bin = join(dir, 'bin');
    const binEntries = entries.includes('bin')
      ? lstatSync(bin).isDirectory()
        ? readdirSync(bin)
        : undefined
      : [];
    if (binEntries === undefined) return false;
    if (!binEntries.every((name) => name === 'node' || NODE_TEMP.test(name))) return false;
    if (!entries.includes('version')) return !binEntries.includes('node');
    const version = join(dir, 'version');
    return lstatSync(version).isFile() && /^v\d+\.\d+\.\d+/.test(readFileSync(version, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
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
  if (existsSync(dir) && !isManagedMemberNode(dir))
    throw new Error(
      `${dir} holds files MAMA did not write; move them out of tools_root so members get MAMA's Node`
    );
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
  // The version first: it marks the folder as this host's before any node is written. A crash
  // before the rename leaves a version with an old or missing node, which the next boot replaces.
  const versionTemp = `${versionFile}.${randomUUID()}`;
  writeFileSync(versionTemp, `${version}\n`, { mode: 0o644 });
  renameSync(versionTemp, versionFile);
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
  return { path: target, version, how: link ? 'linked' : 'copied' };
}
