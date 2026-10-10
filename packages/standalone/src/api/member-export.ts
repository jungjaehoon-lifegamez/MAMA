import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  readSync,
  readdirSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'fflate';
import { memberPaths, memberClaudeTmpDir } from '../runtime/member-paths.js';
import { physicalReadPath } from '../runtime/backend-security.js';
import { O_NOFOLLOW_ANY, OWNER_FILE_MAX_UPLOAD_BYTES } from './file-delivery.js';

const archiveSuffix = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Installed Claude 2.1.293's history storage rewrites history.jsonl; installed Codex's
 * codex_message_history (message-history/src/lib.rs) writes history.jsonl under CODEX_HOME.
 * Config homes are assigned in native-session.ts. No account/config/credential file is admitted. */
const managedHistoryFiles = new Set([
  'claude-config/history.jsonl',
  '.codex/history.jsonl',
  'runtime/client-journal.jsonl',
]);
const managedRoots = new Set(['claude-config', '.codex', 'codex-runtime', 'runtime']);

export function memberTrees(root: string, id: string): string[] {
  const temp = memberClaudeTmpDir(id);
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const archives = (parent: string, identity: string) =>
    existsSync(parent)
      ? readdirSync(parent)
          .filter((name) =>
            new RegExp(`^\\.retired-${escaped(identity)}-${archiveSuffix}$`).test(name)
          )
          .map((name) => join(parent, name))
      : [];
  return [
    memberPaths(root, id).runtimeRoot,
    temp,
    ...archives(root, id),
    ...archives(dirname(temp), basename(temp)),
  ]
    .filter(existsSync)
    .map((path) => join(physicalReadPath(dirname(path)), basename(path)));
}
export interface MemberExportFile {
  path: string;
  name: string;
  size: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  nlink: number;
  eligible: boolean;
  privateManaged: boolean;
}
// Every ZIP entry costs at least its local and central headers (30 + 46 bytes) and its name twice,
// so a tree whose entries alone pass the upload limit cannot be exported. Charging every walked
// entry that cost bounds the walk before it holds an unbounded inventory.
const ZIP_ENTRY_HEADER_BYTES = 30 + 46;
export function memberFileInventory(root: string, id: string) {
  const allFiles: MemberExportFile[] = [];
  const symlinks: string[] = [];
  let walked = 0;
  const walk = (path: string, name: string, runtimeRoot: string | undefined) => {
    walked += ZIP_ENTRY_HEADER_BYTES + 2 * Buffer.byteLength(name);
    if (walked > OWNER_FILE_MAX_UPLOAD_BYTES)
      throw new Error(
        `Member files hold too many entries for one export (over ${OWNER_FILE_MAX_UPLOAD_BYTES} bytes of ZIP headers alone)`
      );
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      // Never followed; named so the member knows the export left it out.
      symlinks.push(name);
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort())
        walk(join(path, entry), `${name}/${entry}`, runtimeRoot);
    } else if (stat.isFile()) {
      const local = runtimeRoot === undefined ? undefined : relative(runtimeRoot, path);
      let eligible = true;
      let privateManaged = false;
      if (local !== undefined) {
        if (managedRoots.has(local.split('/')[0]!)) {
          eligible =
            managedHistoryFiles.has(local) ||
            local.startsWith('claude-config/projects/') ||
            local.startsWith('.codex/sessions/');
          privateManaged = !eligible;
        } else if (local === 'workspace/.tmp' || local.startsWith('workspace/.tmp/'))
          eligible = false;
        else if (new RegExp(`^workspace/files/member-export-${archiveSuffix}\\.zip$`).test(local))
          eligible = false;
      }
      allFiles.push({
        path,
        name,
        size: stat.size,
        dev: stat.dev,
        ino: stat.ino,
        mtimeMs: stat.mtimeMs,
        nlink: stat.nlink,
        eligible,
        privateManaged,
      });
    }
    // Never follow a link or try to open a socket/FIFO found by the walk.
  };
  const live = memberPaths(root, id).runtimeRoot;
  const trees = memberTrees(root, id);
  for (const tree of trees)
    walk(
      tree,
      `files/${basename(tree)}`,
      tree === live ? tree : dirname(tree) === root ? join(tree, 'runtime') : undefined
    );
  const links = new Map<string, number>();
  for (const file of allFiles) {
    const key = `${file.dev}:${file.ino}`;
    links.set(key, (links.get(key) ?? 0) + 1);
  }
  // A workspace alias of an account/credential inode must obey the managed-directory deny.
  const privateInodes = new Set(
    allFiles.filter((file) => file.privateManaged).map((file) => `${file.dev}:${file.ino}`)
  );
  const omittedFiles: string[] = [...symlinks];
  const files = allFiles.filter((file) => {
    if (!file.eligible) return false;
    if (
      (links.get(`${file.dev}:${file.ino}`) ?? 0) < file.nlink ||
      privateInodes.has(`${file.dev}:${file.ino}`)
    ) {
      omittedFiles.push(file.name);
      return false;
    }
    return true;
  });
  return { trees, allFiles, files, omittedFiles, links };
}

/** Include files left out of the ZIP: erasure removes those links and managed files too. */
export function memberInventorySnapshot(
  inventory: ReturnType<typeof memberFileInventory>,
  omittedFiles: readonly string[] = inventory.omittedFiles
): string {
  return JSON.stringify({
    files: inventory.allFiles
      .map(({ path, dev, ino, size, mtimeMs, nlink }) => ({ path, dev, ino, size, mtimeMs, nlink }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    omittedFiles: [...omittedFiles].sort(),
  });
}
const oversized = (size: number) =>
  new Error(
    `Member export is ${size} bytes; Telegram limit is ${OWNER_FILE_MAX_UPLOAD_BYTES} bytes (50 MiB)`
  );

/** Build a bounded archive off the model turn. The caller owns delivery and final removal. */
export async function buildMemberExport(root: string, id: string, core: unknown, product: unknown) {
  const inventory = memberFileInventory(root, id);
  const json = [
    ['core.json', strToU8(JSON.stringify(core))],
    ['product.json', strToU8(JSON.stringify(product))],
  ] as const;
  const predicted =
    inventory.files.reduce((n, file) => n + file.size, 0) +
    json.reduce((n, [, bytes]) => n + bytes.length, 0);
  if (predicted > OWNER_FILE_MAX_UPLOAD_BYTES) throw oversized(predicted);
  const filesRoot = join(memberPaths(root, id).workspaceDir, 'files');
  if (physicalReadPath(filesRoot) !== resolve(filesRoot))
    throw new Error('Member export output directory must not be a symlink');
  mkdirSync(filesRoot, { recursive: true, mode: 0o700 });
  const path = join(filesRoot, `member-export-${randomUUID()}.zip`);
  // Refuse a link in any component at creation, not only in the file name: the directory was
  // checked above, but a swapped ancestor would otherwise place the archive outside the member.
  const output = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (process.platform === 'darwin' ? O_NOFOLLOW_ANY : constants.O_NOFOLLOW),
    0o600
  );
  if (process.platform === 'linux' && readlinkSync(`/proc/self/fd/${output}`) !== path) {
    closeSync(output);
    throw new Error('Member export output directory changed while the archive was created');
  }
  let size = 0,
    finished = false,
    fileCount = 0,
    fileBytes = 0;
  const omittedFiles = [...inventory.omittedFiles];
  const zip = new Zip((error, chunk, final) => {
    if (error) throw error;
    if (size + chunk.length > OWNER_FILE_MAX_UPLOAD_BYTES) throw oversized(size + chunk.length);
    let offset = 0;
    while (offset < chunk.length) {
      const written = writeSync(output, chunk, offset, chunk.length - offset);
      if (written <= 0) throw new Error('Member export write made no progress');
      offset += written;
      size += written;
    }
    finished = final;
  });
  try {
    for (const [name, bytes] of json) {
      const entry = new ZipDeflate(name, { level: 6 });
      zip.add(entry);
      entry.push(bytes, true);
    }
    const buffer = Buffer.alloc(64 * 1024);
    for (const file of inventory.files) {
      // Darwin rejects O_NOFOLLOW + O_NOFOLLOW_ANY together. ANY supplies the stronger deny,
      // like file-delivery.ts; O_NONBLOCK prevents a raced-in FIFO from waiting for a writer.
      const flags =
        constants.O_RDONLY |
        constants.O_NONBLOCK |
        (process.platform === 'darwin' ? O_NOFOLLOW_ANY : constants.O_NOFOLLOW);
      const input = openSync(file.path, flags);
      try {
        if (process.platform === 'linux' && readlinkSync(`/proc/self/fd/${input}`) !== file.path)
          throw new Error(`Member export file path changed: ${file.name}`);
        const stat = fstatSync(input);
        if (!stat.isFile() || stat.dev !== file.dev || stat.ino !== file.ino)
          throw new Error(`Member export file changed: ${file.name}`);
        if (stat.nlink > (inventory.links.get(`${file.dev}:${file.ino}`) ?? 0)) {
          omittedFiles.push(file.name);
          continue;
        }
        const entry = new ZipPassThrough(file.name);
        zip.add(entry);
        let count: number,
          bytes = 0;
        while ((count = readSync(input, buffer, 0, buffer.length, null)) > 0) {
          entry.push(buffer.subarray(0, count));
          bytes += count;
          await new Promise<void>((resume) => setImmediate(resume));
        }
        entry.push(new Uint8Array(), true);
        fileCount++;
        fileBytes += bytes;
      } finally {
        closeSync(input);
      }
    }
    zip.end();
    if (!finished) throw new Error('Member export zip did not finish');
    return {
      path,
      filesRoot,
      size,
      fileCount,
      fileBytes,
      omittedFiles,
      fileSnapshot: memberInventorySnapshot(inventory, omittedFiles),
    };
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  } finally {
    closeSync(output);
  }
}
