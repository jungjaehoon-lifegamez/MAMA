import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, isAbsolute, relative, sep } from 'node:path';
import { findExecutable } from '../cli/launch-files.js';
import { credentialReadPaths } from '../runtime/backend-security.js';
import { assertToolsOwnership, validateToolsRoot } from '../runtime/tools-paths.js';
import { liveToolkitLease, tryToolkitLock } from './toolkit-process.js';
import { runCommand, type CommandRunner } from './command-runner.js';
import { renderEnvironment, renderOffice, sandboxedCommand } from './office-render.js';
import {
  TOOLKIT_ASSETS,
  TOOLKIT_INSTALL_COMMAND,
  withToolkitState,
  type DocumentToolkit,
} from './toolkit-state.js';

export { readDocumentToolkit } from './toolkit-state.js';

export interface InstallToolkitOptions {
  toolsRoot: string;
  home?: string;
  memberRoot?: string;
  platform?: NodeJS.Platform;
  run?: CommandRunner;
  locate?: (name: string) => string | undefined;
  write?: (line: string) => void;
}

/** Recursive pruning requires both our generated name and our complete publication receipt. */
function isManagedVersion(path: string, name: string): boolean {
  if (!/^v-\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(name))
    return false;
  try {
    const manifestPath = join(path, 'manifest.json');
    if (!lstatSync(manifestPath).isFile()) return false;
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return false;
    const data = manifest as Record<string, unknown>;
    return (
      data.version === 1 &&
      typeof data.installedAt === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data.installedAt) &&
      Number.isFinite(Date.parse(data.installedAt)) &&
      typeof data.pythonVersion === 'string' &&
      /^\d+\.\d+\.\d+$/.test(data.pythonVersion) &&
      typeof data.officeVersion === 'string' &&
      data.officeVersion.trim().length > 0 &&
      typeof data.platform === 'string' &&
      [
        'aix',
        'android',
        'darwin',
        'freebsd',
        'haiku',
        'linux',
        'openbsd',
        'sunos',
        'win32',
        'cygwin',
        'netbsd',
      ].includes(data.platform) &&
      Array.isArray(data.requirements) &&
      data.requirements.length > 0 &&
      data.requirements.every((line) => typeof line === 'string') &&
      typeof data.requirementsSha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(data.requirementsSha256) &&
      typeof data.soffice === 'string' &&
      isAbsolute(data.soffice) &&
      Array.isArray(data.fonts) &&
      data.fonts.length === 2 &&
      data.fonts[0] === 'Noto Sans CJK' &&
      data.fonts[1] === 'Noto Serif CJK'
    );
  } catch {
    // Missing, malformed or unreadable receipts never authorize deleting someone else's files.
    return false;
  }
}

/** Do not follow venv interpreter symlinks into the host Python while changing permissions. */
function permissions(path: string, readOnly: boolean): void {
  const meta = lstatSync(path);
  if (meta.isSymbolicLink()) return;
  chmodSync(
    path,
    meta.isDirectory()
      ? readOnly
        ? 0o555
        : 0o755
      : readOnly
        ? meta.mode & 0o111
          ? 0o555
          : 0o444
        : 0o644
  );
  if (meta.isDirectory())
    for (const name of readdirSync(path)) permissions(join(path, name), readOnly);
}

function removeVersion(path: string): void {
  permissions(path, false);
  rmSync(path, { recursive: true });
}

function fontFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? fontFiles(path) : [path];
  });
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function installOffice(
  root: string,
  version: string,
  platform: NodeJS.Platform,
  run: CommandRunner,
  locate: InstallToolkitOptions['locate']
): Promise<string> {
  if (platform !== 'darwin') {
    const soffice = locate?.('soffice');
    if (!soffice)
      throw new Error(
        'soffice is missing from PATH; install LibreOffice and Noto Sans/Serif CJK fonts on the host'
      );
    const fonts = [join(root, 'fonts'), '/usr/share/fonts', '/usr/local/share/fonts'].flatMap(
      fontFiles
    );
    mkdirSync(join(version, 'fonts'));
    for (const family of ['Sans', 'Serif']) {
      const files = fonts.filter((path) =>
        new RegExp(`Noto${family}CJK.*\\.(otf|ttf|ttc)$`, 'i').test(basename(path))
      );
      if (!files.length) throw new Error(`Noto ${family} CJK fonts are missing from the host`);
      for (const path of files) cpSync(path, join(version, 'fonts', basename(path)));
    }
    return soffice;
  }
  // Homebrew may report success for a cask installed in a different appdir/fontdir.
  const installed = await run('brew', ['list', '--cask', '--versions'], { timeoutMs: 60_000 });
  await run('brew', ['install', 'fontconfig'], { timeoutMs: 900_000 });
  for (const cask of ['libreoffice', 'font-noto-sans-cjk', 'font-noto-serif-cjk']) {
    const location =
      cask === 'libreoffice'
        ? `--appdir=${join(root, 'apps')}`
        : `--fontdir=${join(root, 'fonts')}`;
    await run(
      'brew',
      [
        installed.stdout.split('\n').some((line) => line.startsWith(`${cask} `))
          ? 'upgrade'
          : 'install',
        '--cask',
        location,
        cask,
      ],
      {
        timeoutMs: 900_000,
      }
    );
  }
  const app = join(root, 'apps', 'LibreOffice.app');
  if (!existsSync(join(app, 'Contents', 'MacOS', 'soffice')))
    throw new Error(
      `libreoffice cask is missing under ${join(root, 'apps')}; move/reinstall the cask there before ${TOOLKIT_INSTALL_COMMAND}`
    );
  const fonts = fontFiles(join(root, 'fonts'));
  for (const family of ['Sans', 'Serif']) {
    if (
      !fonts.some((path) =>
        new RegExp(`Noto${family}CJK.*\\.(otf|ttf|ttc)$`, 'i').test(basename(path))
      )
    )
      throw new Error(
        `font-noto-${family.toLowerCase()}-cjk cask is missing under ${join(root, 'fonts')}; move/reinstall the cask there before ${TOOLKIT_INSTALL_COMMAND}`
      );
  }
  // Brew upgrades mutable apps/fonts. A published version uses its own immutable snapshot,
  // so an installation cannot remove resources from a render already running in the daemon.
  // `cp -c` clones on APFS, so a snapshot costs no disk until brew changes the originals;
  // Node's cpSync ignores COPYFILE_FICLONE for directories (measured: 815 MB vs 8 MB).
  const snapshot = join(version, 'LibreOffice.app');
  await run('/bin/cp', ['-cRP', app, snapshot], { timeoutMs: 600_000 });
  // The clone keeps brew's quarantine flag, and a headless first launch would wait on the
  // Gatekeeper prompt. Assess the signature and notarization here, then clear the flag.
  await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', snapshot], { timeoutMs: 120_000 });
  await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', snapshot], { timeoutMs: 120_000 });
  await run('/bin/cp', ['-cRL', join(root, 'fonts'), join(version, 'fonts')], {
    timeoutMs: 600_000,
  });
  return join(version, 'LibreOffice.app', 'Contents', 'MacOS', 'soffice');
}

/** Host-only, offline-testable provisioning. No daemon state, config rewrite or restart. */
export async function installDocumentToolkit(
  options: InstallToolkitOptions
): Promise<DocumentToolkit> {
  const home = options.home ?? homedir();
  const root = validateToolsRoot(options.toolsRoot, [
    home,
    join(home, '.mama'),
    ...(options.memberRoot ? [options.memberRoot] : []),
  ]);
  const run = options.run ?? runCommand;
  const platform = options.platform ?? process.platform;
  const locate = options.locate ?? findExecutable;
  mkdirSync(root, { recursive: true, mode: 0o755 });
  assertToolsOwnership(root);
  const lock = join(root, '.install-lock');
  const releaseLock = tryToolkitLock(lock);
  if (!releaseLock)
    throw new Error(
      `Document toolkit installation is already running at ${lock}; retry mama tools install after it finishes`
    );
  const versionDir = join(root, `v-${Date.now()}-${randomUUID()}`);
  let temp: string | undefined;
  const link = join(root, `.current-${randomUUID()}`);
  let switched = false;
  try {
    temp = realpathSync(mkdtempSync(join(tmpdir(), 'mama-tools-install-')));
    const current = join(root, 'current');
    const previous = existsSync(current) ? realpathSync(current) : undefined;
    if (previous && (!previous.startsWith(`${root}/v-`) || !lstatSync(current).isSymbolicLink()))
      throw new Error('Document toolkit current must be a managed version link');
    const python = locate('python3') ?? 'python3';
    const checkVersion = await run(python, [
      '-I',
      '-c',
      'import sys; print(".".join(map(str, sys.version_info[:3]))); assert sys.version_info >= (3, 10), "python3 >= 3.10 required"',
    ]);
    const [major, minor] = checkVersion.stdout.trim().split('.').map(Number);
    if (!(major > 3 || (major === 3 && minor >= 10)))
      throw new Error('python3 >= 3.10 is required');
    const base = await run(python, [
      '-I',
      '-c',
      'import os, sys; print(os.path.realpath(sys.base_prefix))',
    ]);
    const basePath = base.stdout.trim();
    if (!isAbsolute(basePath)) throw new Error('Python sys.base_prefix must be absolute');
    const offset = relative(realpathSync(home), basePath);
    if (offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)))
      throw new Error('Python sys.base_prefix is under HOME; use a host Python outside HOME');
    // The version directory IS the venv; bin/python3 must stay beside its pyvenv.cfg.
    mkdirSync(versionDir, { mode: 0o755 });
    await run(python, ['-m', 'venv', versionDir], { timeoutMs: 120_000 });
    assertToolsOwnership(root);
    const versionPython = join(versionDir, 'bin', 'python3');
    const requirements = join(TOOLKIT_ASSETS, 'requirements.lock');
    await run(
      versionPython,
      [
        '-m',
        'pip',
        'install',
        '--only-binary=:all:',
        '--no-deps',
        '--require-hashes',
        '-r',
        requirements,
      ],
      { timeoutMs: 900_000 }
    );
    await run(versionPython, ['-m', 'pip', 'check']);
    for (const name of readdirSync(join(versionDir, 'bin'))) {
      if (/^pip/i.test(name) || /^activate(?:\.|$)/i.test(name))
        rmSync(join(versionDir, 'bin', name));
    }
    const soffice = await installOffice(root, versionDir, platform, run, locate);
    const fontconfig = join(versionDir, 'fonts.conf');
    const fontDirs = [
      join(versionDir, 'fonts'),
      ...(platform === 'darwin'
        ? ['/System/Library/Fonts', '/Library/Fonts']
        : [join(root, 'fonts'), '/usr/share/fonts', '/usr/local/share/fonts']),
    ];
    writeFileSync(
      fontconfig,
      `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n<fontconfig>${fontDirs.map((path) => `<dir>${xml(path)}</dir>`).join('')}<cachedir>${xml(join(versionDir, 'font-cache'))}</cachedir></fontconfig>\n`
    );
    const env = renderEnvironment(versionDir, fontconfig, temp);
    mkdirSync(join(versionDir, 'font-cache'));
    const fcCache = locate('fc-cache');
    if (!fcCache) throw new Error('fc-cache is missing from the host fontconfig installation');
    await run(fcCache, ['-f'], { env });
    const officeVersion = await run(soffice, ['--version'], { env });
    await run(
      'python3',
      [
        '-I',
        '-c',
        'import cffi, charset_normalizer, cryptography, et_xmlfile, lxml, openpyxl, pdfminer, pdfplumber, PIL, pycparser, pymupdf, pypdfium2, docx, pptx, reportlab, typing_extensions, xlsxwriter',
      ],
      { env }
    );
    // Libraries remain installable elsewhere; rendering requires the macOS host sandbox.
    if (platform === 'darwin') {
      const stagedSmoke = join(temp, 'smoke.py');
      cpSync(join(TOOLKIT_ASSETS, 'smoke.py'), stagedSmoke);
      const deniedReadPaths = [
        home,
        ...credentialReadPaths(join(home, '.mama')),
        ...(options.memberRoot ? [options.memberRoot] : []),
      ];
      const pptx = join(temp, 'smoke.pptx');
      const smokeCommand = (args: string[]) =>
        sandboxedCommand({
          command: versionPython,
          args: ['-I', stagedSmoke, ...args],
          temp: temp!,
          output: temp!,
          env,
          deniedReadPaths,
          platform,
          timeoutMs: 30_000,
          run,
        });
      await smokeCommand(['create', pptx]);
      await renderOffice({
        soffice,
        input: pptx,
        output: temp,
        temp,
        env,
        deniedReadPaths,
        platform,
        timeoutMs: 30_000,
        run,
      });
      await smokeCommand(['check', join(temp, 'smoke.pdf')]);
    }
    writeFileSync(
      join(versionDir, 'manifest.json'),
      JSON.stringify(
        {
          version: 1,
          installedAt: new Date().toISOString(),
          pythonVersion: checkVersion.stdout.trim(),
          officeVersion: officeVersion.stdout.trim(),
          platform,
          requirements: readFileSync(requirements, 'utf8').trim().split('\n'),
          requirementsSha256: createHash('sha256').update(readFileSync(requirements)).digest('hex'),
          soffice,
          fonts: ['Noto Sans CJK', 'Noto Serif CJK'],
        },
        null,
        2
      ) + '\n'
    );
    permissions(versionDir, true);
    await withToolkitState(root, () => {
      // A renderer's lease pins an old version until its subprocesses finish.
      const leases = existsSync(join(root, '.leases'))
        ? readdirSync(join(root, '.leases')).filter((name) => {
            const path = join(root, '.leases', name);
            if (liveToolkitLease(path)) return true;
            rmSync(path, { force: true });
            return false;
          })
        : [];
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (
          entry.isDirectory() &&
          entry.name.startsWith('v-') &&
          path !== versionDir &&
          path !== previous &&
          !leases.some((lease) => lease.startsWith(`${entry.name}.`))
        ) {
          if (isManagedVersion(path, entry.name)) removeVersion(path);
          else
            (options.write ?? console.log)(
              `Document toolkit: left ${path} untouched; it is not a managed toolkit version.`
            );
        }
      }
      // Publication is the last install operation: even pruning must succeed before switching.
      symlinkSync(basename(versionDir), link);
      renameSync(link, current);
      switched = true;
    });
    return { versionDir, python: versionPython, soffice, fontconfig };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'installation failed';
    throw new Error(
      `Document toolkit: ${detail}. Run ${TOOLKIT_INSTALL_COMMAND} on the host to retry.`
    );
  } finally {
    try {
      rmSync(link, { force: true });
      if (!switched && existsSync(versionDir)) removeVersion(versionDir);
      if (temp) rmSync(temp, { recursive: true, force: true });
    } finally {
      releaseLock();
    }
  }
}
