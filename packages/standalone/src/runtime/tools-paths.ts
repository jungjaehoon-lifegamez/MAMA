import { isAbsolute, relative, resolve, sep } from 'node:path';
import { physicalReadPath } from './backend-security.js';
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** A shared parent must never supply executable code owned/writable by someone else. */
export function assertToolsOwnership(root: string): void {
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
