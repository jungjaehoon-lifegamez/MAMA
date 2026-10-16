import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { physicalReadPath } from './backend-security.js';
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** A shared parent must never supply executable code owned/writable by someone else. */
/** Only this uid may change what the installer copies; another account cannot swap a file in. */
export function assertOwnedDirectory(path: string): void {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('tools_root ownership requires a POSIX uid');
  const meta = lstatSync(path);
  // System font directories are root's; root-owned and not shared-writable is as safe.
  if (!meta.isDirectory() || (meta.uid !== uid && meta.uid !== 0) || (meta.mode & 0o022) !== 0)
    throw new Error(
      `Unsafe tools_root directory ${path}: require a real directory of uid ${uid} without group/other write`
    );
}

/** Sticky shared parents prevent another uid from renaming this uid's toolkit tree. */
/**
 * Every existing folder above a root must be this account's or root's, and writable by others
 * only when sticky: otherwise another account could rename the root away from the path the
 * session denies and allows were written for.
 */
export function assertRootAncestors(root: string, label = 'tools_root'): void {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error(`${label} ownership requires a POSIX uid`);
  for (let path = dirname(root); ; path = dirname(path)) {
    if (existsSync(path)) {
      const meta = statSync(path);
      if (
        !meta.isDirectory() ||
        (meta.uid !== uid && meta.uid !== 0) ||
        ((meta.mode & 0o022) !== 0 && (meta.mode & 0o1000) === 0)
      )
        throw new Error(
          `Unsafe ${label} ancestor ${path}: require uid ${uid} or root and no group/other write unless sticky`
        );
    }
    if (dirname(path) === path) break;
  }
}

export function assertToolsOwnership(root: string): void {
  assertRootAncestors(physicalReadPath(root));
  if (!existsSync(root)) return;
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('tools_root ownership requires a POSIX uid');
  if (lstatSync(root).isSymbolicLink())
    throw new Error(`Unsafe tools_root ${root}: root must be a directory, not a symlink`);
  const directory = (path: string) => {
    const meta = statSync(path);
    if (!meta.isDirectory() || meta.uid !== uid || (meta.mode & 0o022) !== 0)
      throw new Error(
        `Unsafe tools_root directory ${path}: require uid ${uid} and no group/other write permission`
      );
  };
  directory(root);
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (entry === 'current') {
      const meta = lstatSync(path);
      if (!meta.isSymbolicLink() || meta.uid !== uid)
        throw new Error(
          `Unsafe tools_root current ${path}: require a managed link owned by uid ${uid}`
        );
      // A dangling current is a broken toolkit, handled by readDocumentToolkit.
      if (existsSync(path)) {
        const target = realpathSync(path);
        if (
          relative(realpathSync(root), target) !== target.split(sep).at(-1) ||
          !target.split(sep).at(-1)?.startsWith('v-')
        )
          throw new Error(
            `Unsafe tools_root current ${path}: target must be a managed version directory`
          );
        directory(path);
      }
    } else if (entry.startsWith('v-')) {
      if (lstatSync(path).isSymbolicLink())
        throw new Error(`Unsafe tools_root version ${path}: symlinks are not allowed`);
      directory(path);
    }
  }
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Like member_root, resolve existing ancestors before checking even a future install path. */
export function validateToolsRoot(root: string, forbiddenPaths: readonly string[]): string {
  if (!isAbsolute(root)) throw new Error('tools_root must be absolute');
  const physical = physicalReadPath(resolve(root));
  assertRootAncestors(physical);
  for (const forbidden of forbiddenPaths.map(physicalReadPath)) {
    if (contains(forbidden, physical) || contains(physical, forbidden))
      throw new Error('tools_root must not overlap HOME, the MAMA home or member_root');
  }
  return physical;
}

/** A configured owner data directory can introduce another deny at runtime. Never bypass it. */
export function assertToolsReadable(root: string, deniedPaths: readonly string[]): void {
  const physical = physicalReadPath(root);
  if (deniedPaths.some((path) => contains(physicalReadPath(path), physical)))
    throw new Error('tools_root is under a session read deny; move it outside denied paths');
}
