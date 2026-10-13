import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cpSync,
  chmodSync,
  lstatSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { installDocumentToolkit, readDocumentToolkit } from '../../src/tools/document-toolkit.js';
import type { CommandRunner } from '../../src/tools/command-runner.js';
import { validateToolsRoot } from '../../src/runtime/tools-paths.js';
import { leaseDocumentToolkit, withToolkitState } from '../../src/tools/toolkit-state.js';

let root: string;
let home: string;
let tools: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'document-tools-')));
  home = join(root, 'home');
  tools = join(root, 'tools');
  mkdirSync(home);
});
afterEach(() => {
  // Published versions are read-only; the host installer owns their permissions.
  const unlock = (path: string) => {
    if (!existsSync(path)) return;
    const meta = lstatSync(path);
    if (meta.isSymbolicLink()) return;
    chmodSync(path, meta.isDirectory() ? 0o755 : 0o644);
    if (meta.isDirectory()) for (const name of readdirSync(path)) unlock(join(path, name));
  };
  unlock(root);
  rmSync(root, { recursive: true, force: true });
});

function fakeHost(fail?: string, fonts = true) {
  const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const run: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, env: options?.env });
    const label = args.join(' ');
    if (fail && label.includes(fail)) throw new Error('fixture command failure');
    if (label.includes('sys.base_prefix')) return { stdout: '/fixture/python\n', stderr: '' };
    if (label.includes('sys.version_info')) return { stdout: '3.14.0\n', stderr: '' };
    if (args[0] === '-m' && args[1] === 'venv') {
      const version = args[2]!;
      mkdirSync(join(version, 'bin'), { recursive: true });
      writeFileSync(join(version, 'pyvenv.cfg'), 'home = /fixture/python\n');
      for (const name of [
        'python3',
        'pip',
        'pip3',
        'pip3.14',
        'activate',
        'activate.csh',
        'Activate.ps1',
      ])
        writeFileSync(join(version, 'bin', name), 'fixture');
    }
    if (command === 'brew' && args[0] !== 'list' && args.at(-1) !== 'fontconfig') {
      if (args.at(-1) === 'libreoffice') {
        const appdir = args.find((arg) => arg.startsWith('--appdir='))!.slice(9);
        const executable = join(appdir, 'LibreOffice.app', 'Contents', 'MacOS', 'soffice');
        mkdirSync(dirname(executable), { recursive: true });
        writeFileSync(executable, 'fixture office');
      } else if (fonts) {
        const fontdir = args.find((arg) => arg.startsWith('--fontdir='))!.slice(10);
        mkdirSync(fontdir, { recursive: true });
        writeFileSync(
          join(fontdir, args.at(-1)!.includes('serif') ? 'NotoSerifCJK.ttc' : 'NotoSansCJK.ttc'),
          'fixture font'
        );
      }
    }
    if (label.includes('--convert-to')) {
      const out = args[args.indexOf('--outdir') + 1]!;
      writeFileSync(join(out, 'smoke.pdf'), 'fixture pdf');
    }
    if (command === '/bin/cp') {
      // The installer clones the snapshot with `cp -c`; the fixture copies the same tree.
      cpSync(args[1]!, args[2]!, {
        recursive: true,
        verbatimSymlinks: args[0]!.includes('P'),
        dereference: args[0]!.includes('L'),
      });
    }
    return { stdout: '', stderr: '' };
  };
  return { run, calls };
}

describe('tools_root boundary', () => {
  it('accepts a shared sibling and rejects relative, overlapping and symlinked roots', () => {
    const members = join(root, 'members');
    expect(validateToolsRoot(tools, [home, members])).toBe(tools);
    for (const path of [
      'relative',
      '~/.tools',
      home,
      join(home, 'tools'),
      root,
      members,
      join(members, 'tools'),
    ])
      expect(() => validateToolsRoot(path, [home, members])).toThrow(/tools_root/);
    expect(() => validateToolsRoot(tools, [home, join(tools, 'members')])).toThrow(/tools_root/);
    symlinkSync(home, join(root, 'alias'));
    expect(() => validateToolsRoot(join(root, 'alias', 'tools'), [home])).toThrow(/tools_root/);
  });
});

describe('host document toolkit installer', () => {
  const install = (run: CommandRunner) =>
    installDocumentToolkit({
      toolsRoot: tools,
      home,
      platform: 'darwin',
      run,
      locate: (name) => `/fixture/${name}`,
    });

  it('installs the shipped lock in place, verifies before publishing and strips package installers', async () => {
    const host = fakeHost();
    const result = await install(host.run);
    const version = realpathSync(join(tools, 'current'));
    expect(result.versionDir).toBe(version);
    expect(existsSync(join(version, 'pyvenv.cfg'))).toBe(true);
    expect(readdirSync(join(version, 'bin'))).toEqual(['python3']);
    expect(host.calls.find((call) => call.args.includes('venv'))?.args.at(-1)).toBe(version);
    const pip = host.calls.find((call) => call.args.includes('--only-binary=:all:'))!;
    expect(pip.command).toBe(join(version, 'bin', 'python3'));
    expect(pip.args).toContain('--no-deps');
    expect(pip.args).toContain('--require-hashes');
    expect(readFileSync(pip.args.at(-1)!, 'utf8')).toContain('python-pptx==1.0.2');
    const smoke = host.calls.find((call) => call.args.some((arg) => arg.includes('import cffi')))!;
    expect(smoke.command).toBe('python3');
    expect(smoke.args[0]).toBe('-I');
    expect(smoke.env?.PATH?.split(':')[0]).toBe(join(version, 'bin'));
    expect(host.calls.some((call) => call.args.includes('check'))).toBe(true);
    expect(host.calls.some((call) => call.args.includes('--convert-to'))).toBe(true);
    expect(host.calls.filter((call) => call.command === '/fixture/fc-cache')).toHaveLength(1);
    const smokeRender = host.calls.find((call) => call.args.includes('--convert-to'))!;
    expect(smokeRender.args[1]).toContain(home);
    expect(smokeRender.env?.HOME).not.toBe(home);
    expect(host.calls.at(-1)?.args).toContain('check');
    const manifest = readDocumentToolkit(tools)!;
    expect(manifest.versionDir).toBe(version);
    expect(manifest.soffice).toContain(version);
    expect(readFileSync(manifest.fontconfig, 'utf8')).toContain(
      `<cachedir>${join(version, 'font-cache')}</cachedir>`
    );
    expect(readFileSync(manifest.fontconfig, 'utf8')).toContain('/System/Library/Fonts');
    expect(statSync(join(version, 'bin', 'python3')).mode & 0o222).toBe(0);
  });

  it.each(['install --only-binary', 'check', 'import cffi', '--convert-to', 'smoke.py check'])(
    'leaves current untouched on %s failure',
    async (failure) => {
      await install(fakeHost().run);
      const before = realpathSync(join(tools, 'current'));
      await expect(install(fakeHost(failure).run)).rejects.toThrow(/mama tools install/);
      expect(realpathSync(join(tools, 'current'))).toBe(before);
      expect(readdirSync(tools).filter((name) => name.startsWith('v-'))).toHaveLength(1);
      expect(existsSync(join(tools, '.install-lock'))).toBe(false);
    }
  );

  it('keeps the previous version and prunes older versions after an atomic switch', async () => {
    const first = await install(fakeHost().run);
    const second = await install(fakeHost().run);
    expect(existsSync(first.versionDir)).toBe(true);
    const third = await install(fakeHost().run);
    expect(realpathSync(join(tools, 'current'))).toBe(third.versionDir);
    expect(existsSync(second.versionDir)).toBe(true);
    expect(existsSync(first.versionDir)).toBe(false);
    expect(readdirSync(tools).some((name) => name.startsWith('.current-'))).toBe(false);
  });

  it('keeps relative app-bundle symlinks in the immutable renderer snapshot', async () => {
    const host = fakeHost();
    const run: CommandRunner = async (command, args, options) => {
      const result = await host.run(command, args, options);
      if (command === 'brew' && args.at(-1) === 'libreoffice') {
        const app = join(tools, 'apps', 'LibreOffice.app', 'Contents');
        mkdirSync(join(app, 'Resources'));
        writeFileSync(join(app, 'Resources', 'fixture-resource'), 'fixture');
        symlinkSync('../Resources/fixture-resource', join(app, 'MacOS', 'resource-link'));
      }
      return result;
    };
    const installed = await install(run);
    const link = join(
      installed.versionDir,
      'LibreOffice.app',
      'Contents',
      'MacOS',
      'resource-link'
    );
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe('../Resources/fixture-resource');
    expect(readFileSync(link, 'utf8')).toBe('fixture');
  });

  it('keeps an active render snapshot through repeated updates and prunes it after release', async () => {
    const first = await install(fakeHost().run);
    const lease = await leaseDocumentToolkit(tools);
    await install(fakeHost().run);
    await install(fakeHost().run);
    expect(existsSync(first.versionDir)).toBe(true);
    lease.release();
    await install(fakeHost().run);
    expect(existsSync(first.versionDir)).toBe(false);
  });

  it('refuses a cask that was installed elsewhere and supplies no toolkit fonts', async () => {
    await expect(install(fakeHost(undefined, false).run)).rejects.toThrow(
      /font-noto.*mama tools install/
    );
    expect(existsSync(join(tools, 'current'))).toBe(false);
  });

  it('assesses the cloned renderer before clearing its quarantine flag', async () => {
    const host = fakeHost();
    await install(host.run);
    const order = host.calls
      .map((call) => call.command)
      .filter((command) => ['/bin/cp', '/usr/sbin/spctl', '/usr/bin/xattr'].includes(command));
    expect(order.slice(0, 3)).toEqual(['/bin/cp', '/usr/sbin/spctl', '/usr/bin/xattr']);
    const failing = fakeHost('--assess');
    await expect(install(failing.run)).rejects.toThrow(/fixture command failure/);
    expect(failing.calls.some((call) => call.command === '/usr/bin/xattr')).toBe(false);
  });

  it('refuses LibreOffice installed to a different appdir even if brew reports success', async () => {
    const host = fakeHost();
    const run: CommandRunner = async (command, args, options) =>
      command === 'brew' && args.at(-1) === 'libreoffice'
        ? { stdout: 'already installed', stderr: '' }
        : host.run(command, args, options);
    await expect(install(run)).rejects.toThrow(/libreoffice cask is missing.*mama tools install/);
    expect(existsSync(join(tools, 'current'))).toBe(false);
  });

  it('upgrades installed casks and rejects concurrent installers', async () => {
    const host = fakeHost();
    const run: CommandRunner = async (command, args, options) =>
      args[0] === 'list'
        ? { stdout: 'libreoffice 1.0\nfont-noto-sans-cjk 1.0\nfont-noto-serif-cjk 1.0', stderr: '' }
        : host.run(command, args, options);
    await install(run);
    expect(
      host.calls
        .filter((call) => call.command === 'brew' && call.args.includes('--cask'))
        .every((call) => call.args[0] === 'upgrade')
    ).toBe(true);
    writeFileSync(join(tools, '.install-lock'), String(process.pid));
    await expect(install(host.run)).rejects.toThrow(/installation.*running.*\.install-lock/);
  });

  it('recovers dead install/state locks and ignores dead render leases after restart', async () => {
    const first = await install(fakeHost().run);
    await install(fakeHost().run);
    writeFileSync(join(tools, '.install-lock'), '2147483647');
    writeFileSync(join(tools, '.state-lock'), '2147483647');
    mkdirSync(join(tools, '.leases'), { recursive: true });
    writeFileSync(
      join(tools, '.leases', `${first.versionDir.split('/').at(-1)}.dead`),
      '2147483647'
    );
    await install(fakeHost().run);
    expect(existsSync(first.versionDir)).toBe(false);
    expect(existsSync(join(tools, '.install-lock'))).toBe(false);
    expect(existsSync(join(tools, '.state-lock'))).toBe(false);
    expect(readdirSync(join(tools, '.leases'))).toEqual([]);
    await withToolkitState(tools, () => {
      expect(
        readFileSync(
          join(tools, '.state-lock', readdirSync(join(tools, '.state-lock'))[0]!),
          'utf8'
        )
      ).toBe(String(process.pid));
    });
  });

  it('recovers legacy empty-directory locks and names a busy state lock', async () => {
    mkdirSync(tools);
    mkdirSync(join(tools, '.install-lock'));
    mkdirSync(join(tools, '.state-lock'));
    await install(fakeHost().run);
    writeFileSync(join(tools, '.state-lock'), String(process.pid));
    const now = Date.now();
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(now)
      .mockReturnValue(now + 31_000);
    try {
      await expect(withToolkitState(tools, () => {})).rejects.toThrow(/busy.*\.state-lock/);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('treats a dangling venv interpreter as absent and reports why', async () => {
    const installed = await install(fakeHost().run);
    chmodSync(join(installed.versionDir, 'bin'), 0o755);
    rmSync(installed.python);
    symlinkSync('/fixture/removed-python', installed.python);
    const broken = vi.fn();
    expect(readDocumentToolkit(tools, broken)).toBeNull();
    expect(broken).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('mama tools install') })
    );
    await expect(leaseDocumentToolkit(tools)).rejects.toThrow(/mama tools install/);
  });

  it.each(['root', 'current', 'version', 'uid'])(
    'refuses unsafe toolkit ownership at install and read (%s)',
    async (kind) => {
      const installed = await install(fakeHost().run);
      if (kind === 'uid') vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1);
      else
        chmodSync(
          kind === 'root'
            ? tools
            : kind === 'current'
              ? join(tools, 'current')
              : installed.versionDir,
          0o777
        );
      try {
        expect(() => readDocumentToolkit(tools)).toThrow(/Unsafe tools_root/);
        await expect(install(fakeHost().run)).rejects.toThrow(/Unsafe tools_root/);
      } finally {
        vi.restoreAllMocks();
      }
    }
  );

  it('rejects a HOME-based interpreter before creating a venv or installing packages', async () => {
    const host = fakeHost();
    const run: CommandRunner = async (command, args, options) =>
      args.join(' ').includes('sys.base_prefix')
        ? { stdout: join(home, '.pyenv', 'python') + '\n', stderr: '' }
        : host.run(command, args, options);
    await expect(install(run)).rejects.toThrow(/sys.base_prefix.*HOME/);
    expect(host.calls.some((call) => call.args.includes('venv'))).toBe(false);
    expect(existsSync(join(tools, '.install-lock'))).toBe(false);
  });

  it('requires soffice on non-macOS hosts', async () => {
    await expect(
      installDocumentToolkit({
        toolsRoot: tools,
        home,
        platform: 'linux',
        run: fakeHost().run,
        locate: () => undefined,
      })
    ).rejects.toThrow(/soffice.*PATH/);
  });

  it('treats an absent toolkit as unavailable', () => {
    expect(readDocumentToolkit()).toBeNull();
    expect(readDocumentToolkit(tools)).toBeNull();
  });
});
