import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join, relative, sep } from 'node:path';
import { assertToolsOwnership } from '../runtime/tools-paths.js';
import { onToolkitSignal, tryToolkitLock } from './toolkit-process.js';

export const TOOLKIT_INSTALL_COMMAND = 'mama tools install';
export const TOOLKIT_ASSETS = join(__dirname, '../../toolkit');
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
export const TOOLKIT_VERSION_NAME = new RegExp(`^v-\\d+-${uuid}$`);
export const TOOLKIT_LEASE_NAME = new RegExp(`^v-\\d+-${uuid}\\.${uuid}$`);

/** Never follow a shared lease directory link, at either installation or rendering. */
export function toolkitLeaseDirectory(root: string, create = false): string | null {
  const path = join(root, '.leases');
  let meta;
  try {
    meta = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (!create) return null;
    mkdirSync(path, { mode: 0o700 });
    meta = lstatSync(path);
  }
  const uid = process.getuid?.();
  if (!meta.isDirectory() || uid === undefined || meta.uid !== uid)
    throw new Error(
      `Document toolkit: left ${path} untouched; require a real directory owned by uid ${uid}`
    );
  return path;
}

export interface DocumentToolkit {
  versionDir: string;
  python: string;
  soffice: string;
  fontconfig: string;
}

/** Broken/absent installations disable the toolkit; unsafe ownership remains a hard error. */
export function readDocumentToolkit(
  root?: string,
  onBroken?: (error: Error) => void
): DocumentToolkit | null {
  if (root) assertToolsOwnership(root);
  try {
    if (!root || !existsSync(join(root, 'current'))) return null;
    const versionDir = realpathSync(join(root, 'current'));
    const offset = relative(realpathSync(root), versionDir);
    if (offset !== basename(versionDir) || offset.includes(sep) || !offset.startsWith('v-'))
      throw new Error(`Invalid document toolkit current link; run ${TOOLKIT_INSTALL_COMMAND}`);
    const manifest = JSON.parse(readFileSync(join(versionDir, 'manifest.json'), 'utf8')) as {
      version?: number;
      soffice?: string;
    };
    const python = join(versionDir, 'bin', 'python3');
    const fontconfig = join(versionDir, 'fonts.conf');
    if (
      manifest.version !== 1 ||
      typeof manifest.soffice !== 'string' ||
      ![python, fontconfig, join(versionDir, 'pyvenv.cfg'), manifest.soffice].every(
        (path) => existsSync(path) && statSync(path).isFile()
      )
    )
      throw new Error(`Incomplete document toolkit; run ${TOOLKIT_INSTALL_COMMAND}`);
    return { versionDir, python, soffice: manifest.soffice, fontconfig };
  } catch (error) {
    onBroken?.(
      new Error(
        `Document toolkit unavailable: ${error instanceof Error ? error.message : String(error)}; run ${TOOLKIT_INSTALL_COMMAND}`
      )
    );
    return null;
  }
}

export function requireDocumentToolkit(root?: string): DocumentToolkit {
  const toolkit = readDocumentToolkit(root);
  if (!toolkit)
    throw new Error(
      `Document toolkit is missing; ask the owner to run ${TOOLKIT_INSTALL_COMMAND} on the host`
    );
  return toolkit;
}

/** Switch/prune and render leasing are mutually exclusive, across installer/daemon processes. */
export async function withToolkitState<T>(root: string, work: () => T): Promise<T> {
  const lock = join(root, '.state-lock');
  const deadline = Date.now() + 30_000;
  let release: (() => void) | null;
  for (;;) {
    release = tryToolkitLock(lock);
    if (release) break;
    if (Date.now() >= deadline)
      throw new Error(
        `Document toolkit state is busy at ${lock}; retry after the host install finishes`
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try {
    return work();
  } finally {
    release();
  }
}

export async function leaseDocumentToolkit(
  root?: string
): Promise<{ toolkit: DocumentToolkit; release: () => void }> {
  // An absent tools_root never attempts filesystem writes.
  if (!root || !existsSync(root)) {
    requireDocumentToolkit(root);
  }
  assertToolsOwnership(root!);
  return withToolkitState(root!, () => {
    const toolkit = requireDocumentToolkit(root);
    const directory = toolkitLeaseDirectory(root!, true)!;
    const lease = join(directory, `${basename(toolkit.versionDir)}.${randomUUID()}`);
    writeFileSync(lease, String(process.pid), { flag: 'wx', mode: 0o600 });
    const release = () => rmSync(lease, { force: true });
    const unregister = onToolkitSignal(release);
    return {
      toolkit,
      release: () => {
        try {
          release();
        } finally {
          unregister();
        }
      },
    };
  });
}
