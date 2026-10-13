import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  openSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import {
  openWorkspaceFile,
  O_NOFOLLOW_ANY,
  OWNER_FILE_MAX_UPLOAD_BYTES,
} from '../api/file-delivery.js';
import { runCommand, type CommandRunner } from './command-runner.js';
import {
  requireOfficeSandbox,
  renderEnvironment,
  renderOffice,
  sandboxedCommand,
} from './office-render.js';
import { leaseDocumentToolkit, TOOLKIT_ASSETS } from './toolkit-state.js';

export { officeSandboxProfile } from './office-render.js';

export interface DocumentRenderOptions {
  toolsRoot?: string;
  deniedReadPaths?: readonly string[];
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  maxBytes?: number;
  pageLimit?: number;
  run?: CommandRunner;
  /** Explicit host integration test override, never supplied by an action caller. */
  soffice?: string;
}

export interface DocumentRenderResult {
  pdf: string;
  pages: string[];
  pageCount: number;
  /** Embedded font names, one array per rendered page. */
  fonts: string[][];
}

// All callers and both backends share the daemon's host renderer; failures release the queue.
let queue: Promise<unknown> = Promise.resolve();

/** Publish bounded regular files without following links planted by an untrusted renderer/caller. */
function publishFile(temp: string, output: string, name: string): void {
  const source = openWorkspaceFile(temp, join(temp, name), OWNER_FILE_MAX_UPLOAD_BYTES, true);
  let target: number | undefined;
  try {
    if (realpathSync(output) !== output)
      throw new Error('Render output directory must not be a symlink');
    const path = join(output, name);
    target = openSync(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (process.platform === 'darwin' ? O_NOFOLLOW_ANY : constants.O_NOFOLLOW),
      0o600
    );
    if (process.platform === 'linux' && readlinkSync(`/proc/self/fd/${target}`) !== path)
      throw new Error('Render output path changed');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < source.size) {
      const count = readSync(
        source.fd,
        buffer,
        0,
        Math.min(buffer.length, source.size - position),
        position
      );
      if (!count) throw new Error('Render output changed during publication');
      let written = 0;
      while (written < count) written += writeSync(target, buffer, written, count - written);
      position += count;
    }
  } finally {
    closeSync(source.fd);
    if (target !== undefined) closeSync(target);
  }
}

export function createDocumentRenderer(options: DocumentRenderOptions) {
  const perform = async (workspace: string, input: string): Promise<DocumentRenderResult> => {
    requireOfficeSandbox(options.platform);
    const lease = await leaseDocumentToolkit(options.toolsRoot);
    const toolkit = lease.toolkit;
    let fd: number | undefined;
    let temp: string | undefined;
    let output: string | undefined;
    let completed = false;
    try {
      const resolved = resolve(workspace, input);
      if (realpathSync(resolved) !== resolved)
        throw new Error('Document path must not pass through a symlink');
      const file = openWorkspaceFile(
        workspace,
        resolved,
        options.maxBytes ?? OWNER_FILE_MAX_UPLOAD_BYTES,
        true
      );
      fd = file.fd;
      const extension = extname(file.path).toLowerCase();
      temp = realpathSync(mkdtempSync(join(tmpdir(), 'mama-office-render-')));
      if (
        ![
          '.pptx',
          '.docx',
          '.xlsx',
          '.ppt',
          '.doc',
          '.xls',
          '.odt',
          '.odp',
          '.ods',
          '.pdf',
        ].includes(extension)
      )
        throw new Error('Render requires an office document or PDF extension');
      // Keep the name inside the 255-byte component limit whatever the input's basename.
      const stem = Buffer.from(basename(file.path, extname(file.path)), 'utf8')
        .subarray(0, 120)
        .toString('utf8')
        .replace(/\uFFFD+$/, '');
      output = mkdtempSync(join(dirname(file.path), `${stem}.render-`));
      if (realpathSync(dirname(file.path)) !== dirname(file.path))
        throw new Error('Document output directory changed');
      const staged = join(temp, `document${extension}`);
      // Hold and copy the validated descriptor, never reopen an agent-mutable input pathname.
      const stagedFd = openSync(staged, 'wx', 0o600);
      try {
        let position = 0;
        const buffer = Buffer.allocUnsafe(64 * 1024);
        while (position < file.size) {
          const count = readSync(
            file.fd,
            buffer,
            0,
            Math.min(buffer.length, file.size - position),
            position
          );
          if (!count) throw new Error('Document changed while staging');
          let written = 0;
          while (written < count) written += writeSync(stagedFd, buffer, written, count - written);
          position += count;
        }
        if (fstatSync(file.fd).size !== file.size)
          throw new Error('Document changed while staging');
      } finally {
        closeSync(stagedFd);
      }
      const env = renderEnvironment(toolkit.versionDir, toolkit.fontconfig, temp);
      const deadline = Date.now() + (options.timeoutMs ?? 120_000);
      const remaining = () => {
        const ms = deadline - Date.now();
        if (ms <= 0) throw new Error('Document render timed out');
        return ms;
      };
      const run = options.run ?? runCommand;
      const shared = {
        temp,
        output: temp,
        env,
        run,
        platform: options.platform,
        deniedReadPaths: options.deniedReadPaths ?? [],
      };
      const pdf = extension === '.pdf' ? staged : join(temp, 'document.pdf');
      if (extension !== '.pdf') {
        await renderOffice({
          ...shared,
          soffice: options.soffice ?? toolkit.soffice,
          input: staged,
          timeoutMs: remaining(),
        });
        if (!existsSync(pdf)) throw new Error('LibreOffice produced no PDF');
      }
      // Product code may be installed under the owner's HOME, denied to member renders.
      // Stage this shipped host helper in the readable temp directory before sandboxing Python.
      copyFileSync(join(TOOLKIT_ASSETS, 'rasterize.py'), join(temp, 'rasterize.py'));
      const raster = await sandboxedCommand({
        ...shared,
        command: toolkit.python,
        args: ['-I', join(temp, 'rasterize.py'), pdf, temp, String(options.pageLimit ?? 50)],
        timeoutMs: remaining(),
      });
      const data = JSON.parse(raster.stdout) as DocumentRenderResult;
      const limit = options.pageLimit ?? 50;
      if (
        !Number.isInteger(data.pageCount) ||
        data.pageCount < 1 ||
        data.pageCount > limit ||
        !Array.isArray(data.pages) ||
        data.pages.length !== data.pageCount ||
        !Array.isArray(data.fonts) ||
        data.fonts.length !== data.pageCount ||
        data.fonts.some(
          (fonts) => !Array.isArray(fonts) || fonts.some((font) => typeof font !== 'string')
        )
      )
        throw new Error('Invalid rasterizer receipt or document page limit exceeded');
      for (const page of data.pages) {
        if (!/^page-\d{3}\.png$/.test(page)) throw new Error('Invalid rasterizer output path');
        publishFile(temp, output, page);
      }
      if (extension !== '.pdf') publishFile(temp, output, 'document.pdf');
      completed = true;
      return {
        pdf:
          extension === '.pdf'
            ? relative(workspace, file.path)
            : relative(workspace, join(output, 'document.pdf')),
        pages: data.pages.map((page) => relative(workspace, join(output!, page))),
        pageCount: data.pageCount,
        fonts: data.fonts,
      };
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (temp) rmSync(temp, { recursive: true, force: true });
      lease.release();
      if (!completed && output) rmSync(output, { recursive: true, force: true });
    }
  };
  return {
    render(workspace: string, input: string): Promise<DocumentRenderResult> {
      const result = queue.then(() => perform(workspace, input));
      queue = result.catch(() => {});
      return result;
    },
  };
}
