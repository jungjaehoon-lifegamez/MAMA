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
import { randomUUID } from 'node:crypto';
import { installDocumentToolkit, readDocumentToolkit } from '../../src/tools/document-toolkit.js';
import type { CommandRunner } from '../../src/tools/command-runner.js';
import { validateToolsRoot } from '../../src/runtime/tools-paths.js';
import {
  leaseDocumentToolkit,
  toolkitLeaseDirectory,
  withToolkitState,
} from '../../src/tools/toolkit-state.js';
import { onToolkitSignal } from '../../src/tools/toolkit-process.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createSkillStore } from '../../src/runtime/skills.js';

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
    if (args.includes('--version')) return { stdout: 'LibreOffice 26.2\n', stderr: '' };
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

  it.each(['install-first', 'publish-first'])(
    'keeps published skills through toolkit installation (%s)',
    async (order) => {
      const source = join(home, 'workspace', 'skills', 'fixture-skill');
      mkdirSync(source, { recursive: true });
      mkdirSync(tools);
      writeFileSync(
        join(source, 'SKILL.md'),
        '---\nname: fixture-skill\ndescription: Fixture\n---\nFixture steps'
      );
      const db = await openCoreDatabase({ path: join(root, 'state.db') });
      try {
        const skills = createSkillStore({
          adapter: db.adapter,
          commonPrincipalId: 'common',
          commonScopes: () => [],
          paths: { toolsRoot: tools, workspace: () => join(home, 'workspace') },
        });
        if (order === 'publish-first') {
          expect(() => skills.publish('fixture-skill')).toThrow(/mama tools install/);
          expect(existsSync(join(tools, 'skills'))).toBe(false);
        }
        await install(fakeHost().run);
        skills.publish('fixture-skill');
        // The adoption path must also recognise a skill publication in an older unmarked root.
        rmSync(join(tools, '.mama-document-toolkit'));
        await install(fakeHost().run);
        expect((await skills.read('common', 'file:common:fixture-skill')).text).toContain(
          'Fixture steps'
        );
      } finally {
        db.close();
      }
    }
  );

  it('refuses an unrelated non-empty root before running host commands', async () => {
    mkdirSync(tools);
    writeFileSync(join(tools, 'keep.txt'), 'unrelated data');
    const host = fakeHost();
    await expect(install(host.run)).rejects.toThrow(/unmarked.*tools_root/);
    expect(readFileSync(join(tools, 'keep.txt'), 'utf8')).toBe('unrelated data');
    expect(readdirSync(tools)).toEqual(['keep.txt']);
    expect(host.calls).toEqual([]);
  });

  it.each(['empty', 'unrelated', 'unmanaged-link', 'wrong-name'])(
    'refuses an unmarked root with an unmanaged skills directory (%s)',
    async (layout) => {
      const skills = join(tools, 'skills');
      mkdirSync(skills, { recursive: true });
      if (layout === 'unrelated') writeFileSync(join(skills, 'keep.txt'), 'unrelated data');
      if (layout === 'unmanaged-link') {
        mkdirSync(join(skills, '.versions'));
        mkdirSync(join(skills, 'unrelated'));
        symlinkSync('unrelated', join(skills, 'fixture-skill'));
      }
      if (layout === 'wrong-name') {
        const version = `fixture-skill-extra-${randomUUID()}`;
        mkdirSync(join(skills, '.versions', version), { recursive: true });
        symlinkSync(`.versions/${version}`, join(skills, 'fixture-skill'));
      }
      const before = readdirSync(skills);
      const host = fakeHost();
      await expect(install(host.run)).rejects.toThrow(/unmarked.*tools_root/);
      expect(readdirSync(tools)).toEqual(['skills']);
      expect(readdirSync(skills)).toEqual(before);
      expect(host.calls).toEqual([]);
    }
  );

  it('marks an empty root and adopts an unmarked root made by the previous installer', async () => {
    mkdirSync(tools);
    const first = await install(fakeHost().run);
    const marker = join(tools, '.mama-document-toolkit');
    expect(lstatSync(marker).isFile()).toBe(true);
    const receipt = readFileSync(marker, 'utf8');
    rmSync(marker);
    mkdirSync(join(tools, '.leases'));
    mkdirSync(join(tools, '.install-lock'));
    writeFileSync(join(tools, '.state-lock'), '2147483647');
    const candidate = join(tools, '.install-lock.Abc123');
    mkdirSync(candidate);
    writeFileSync(join(candidate, `2147483647-${randomUUID()}`), '2147483647');
    symlinkSync(first.versionDir.split('/').at(-1)!, join(tools, `.current-${randomUUID()}`));
    const second = await install(fakeHost().run);
    expect(readFileSync(marker, 'utf8')).toBe(receipt);
    expect(readDocumentToolkit(tools)?.versionDir).toBe(second.versionDir);
    expect(existsSync(first.versionDir)).toBe(true);
  });

  it.each(['unrelated-lock', 'manifest-less-version'])(
    'refuses an unmarked root with %s',
    async (kind) => {
      const first = await install(fakeHost().run);
      rmSync(join(tools, '.mama-document-toolkit'));
      if (kind === 'unrelated-lock') {
        mkdirSync(join(tools, '.install-lock'));
        writeFileSync(join(tools, '.install-lock', 'keep.txt'), 'unrelated data');
      } else {
        const partial = join(tools, `v-1234567890123-${randomUUID()}`);
        mkdirSync(partial);
        writeFileSync(join(partial, 'keep.txt'), 'unrelated data');
      }
      const host = fakeHost();
      await expect(install(host.run)).rejects.toThrow(/unmarked.*tools_root/);
      expect(host.calls).toEqual([]);
      expect(readDocumentToolkit(tools)?.versionDir).toBe(first.versionDir);
      expect(existsSync(join(tools, '.mama-document-toolkit'))).toBe(false);
    }
  );

  it('refuses a lease directory owned by a different uid', () => {
    mkdirSync(join(tools, '.leases'), { recursive: true });
    vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1);
    try {
      expect(() => toolkitLeaseDirectory(tools)).toThrow(/\.leases.*owned by uid/);
      expect(existsSync(join(tools, '.leases'))).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('leaves unrelated and non-regular lease entries untouched and reports them', async () => {
    const first = await install(fakeHost().run);
    const leases = join(tools, '.leases');
    mkdirSync(leases);
    const unrelated = join(leases, 'keep.txt');
    writeFileSync(unrelated, 'unrelated data');
    const target = join(root, 'private.txt');
    writeFileSync(target, 'private data');
    const link = join(leases, `${first.versionDir.split('/').at(-1)}.${randomUUID()}`);
    symlinkSync(target, link);
    const directory = join(leases, `${first.versionDir.split('/').at(-1)}.${randomUUID()}`);
    mkdirSync(directory);
    const output: string[] = [];
    await installDocumentToolkit({
      toolsRoot: tools,
      home,
      platform: 'darwin',
      run: fakeHost().run,
      locate: (name) => `/fixture/${name}`,
      write: (line) => output.push(line),
    });
    expect(readFileSync(unrelated, 'utf8')).toBe('unrelated data');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(lstatSync(directory).isDirectory()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('private data');
    for (const path of [unrelated, link, directory])
      expect(output.some((line) => line.includes(path) && /untouched/.test(line))).toBe(true);
  });

  it('refuses a symlinked lease directory without reading or modifying its target', async () => {
    await install(fakeHost().run);
    const target = join(root, 'other-leases');
    mkdirSync(target);
    writeFileSync(join(target, 'keep.txt'), 'unrelated data');
    const link = join(tools, '.leases');
    symlinkSync(target, link);
    await expect(install(fakeHost().run)).rejects.toThrow(/\.leases.*real directory/);
    await expect(leaseDocumentToolkit(tools)).rejects.toThrow(/\.leases.*real directory/);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readdirSync(target)).toEqual(['keep.txt']);
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('unrelated data');
  });

  it.each(['file', 'directory'])(
    'refuses an expected font symlink to a private %s',
    async (kind) => {
      const target = join(root, 'private');
      if (kind === 'directory') {
        mkdirSync(target);
        writeFileSync(join(target, 'secret.txt'), 'private data');
      } else writeFileSync(target, 'private data');
      const host = fakeHost();
      const run: CommandRunner = async (command, args, options) => {
        const result = await host.run(command, args, options);
        if (command === 'brew' && args.at(-1) === 'font-noto-serif-cjk') {
          const font = join(tools, 'fonts', 'NotoSansCJK.ttc');
          rmSync(font);
          symlinkSync(target, font);
        }
        return result;
      };
      await expect(install(run)).rejects.toThrow(/NotoSansCJK\.ttc.*symlink/);
      expect(host.calls.some((call) => call.command === '/bin/cp')).toBe(false);
      expect(existsSync(join(tools, 'current'))).toBe(false);
      expect(readdirSync(tools).filter((name) => name.startsWith('v-'))).toEqual([]);
      expect(readFileSync(kind === 'directory' ? join(target, 'secret.txt') : target, 'utf8')).toBe(
        'private data'
      );
    }
  );

  it('refuses a fonts directory other accounts can write, before copying from it', async () => {
    const host = fakeHost();
    mkdirSync(join(tools, 'fonts'), { recursive: true });
    chmodSync(join(tools, 'fonts'), 0o777);
    await expect(install(host.run)).rejects.toThrow(/without group\/other write/);
    expect(host.calls.some((call) => call.command === '/bin/cp')).toBe(false);
  });

  it('refuses a pre-existing expected font symlink before running host commands', async () => {
    const target = join(root, 'private.txt');
    writeFileSync(target, 'private data');
    mkdirSync(join(tools, 'fonts'), { recursive: true });
    symlinkSync(target, join(tools, 'fonts', 'NotoSansCJK.ttc'));
    const host = fakeHost();
    await expect(install(host.run)).rejects.toThrow(/NotoSansCJK\.ttc.*symlink/);
    expect(host.calls).toEqual([]);
    expect(readFileSync(target, 'utf8')).toBe('private data');
  });

  it('copies only verified CJK font files and does not follow unrelated font links', async () => {
    const target = join(root, 'private');
    mkdirSync(target);
    writeFileSync(join(target, 'secret.txt'), 'private data');
    const host = fakeHost();
    const run: CommandRunner = async (command, args, options) => {
      const result = await host.run(command, args, options);
      if (command === 'brew' && args.at(-1) === 'font-noto-serif-cjk') {
        writeFileSync(join(tools, 'fonts', 'unrelated.txt'), 'unrelated data');
        symlinkSync(target, join(tools, 'fonts', 'private-link'));
      }
      return result;
    };
    const installed = await install(run);
    expect(readdirSync(join(installed.versionDir, 'fonts'))).toEqual([
      'NotoSansCJK.ttc',
      'NotoSerifCJK.ttc',
    ]);
    const copies = host.calls.filter((call) => call.command === '/bin/cp');
    expect(copies.map((call) => call.args[0])).toEqual(['-cRP', '-c', '-c']);
  });

  it.each(['SIGINT', 'SIGHUP', 'SIGTERM'] as const)(
    'cleans an interrupted install before CLI exit on %s',
    async (signal) => {
      const codes = { SIGINT: 130, SIGHUP: 129, SIGTERM: 143 };
      const unregister = onToolkitSignal(() => {}, { exit: true });
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('fixture interrupted');
      });
      const host = fakeHost();
      let inspected = false;
      const run: CommandRunner = async (command, args, options) => {
        const result = await host.run(command, args, options);
        if (args.some((arg) => arg.endsWith('smoke.py')) && args.includes('check')) {
          const temporary = options!.env!.HOME!;
          const version = readdirSync(tools).find((name) => name.startsWith('v-'))!;
          expect(existsSync(join(tools, version))).toBe(true);
          expect(existsSync(temporary)).toBe(true);
          expect(() => process.emit(signal)).toThrow('fixture interrupted');
          // Inspect here, before rejecting the runner lets the installer's finally execute.
          expect(
            readdirSync(tools).filter((name) =>
              /^(v-|\.current-|\.install-lock|\.state-lock)/.test(name)
            )
          ).toEqual([]);
          expect(existsSync(temporary)).toBe(false);
          inspected = true;
          throw new Error('fixture interrupted');
        }
        return result;
      };
      try {
        await expect(install(run)).rejects.toThrow('fixture interrupted');
        expect(inspected).toBe(true);
        expect(exit).toHaveBeenCalledWith(codes[signal]);
        expect(existsSync(join(tools, 'current'))).toBe(false);
      } finally {
        exit.mockRestore();
        unregister();
      }
      await install(fakeHost().run);
    }
  );

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

  it('leaves unrelated v-other data untouched and reports the preserved directory', async () => {
    await install(fakeHost().run);
    const unrelated = join(tools, 'v-other');
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(join(unrelated, 'keep.txt'), 'unrelated data');
    const output: string[] = [];
    await installDocumentToolkit({
      toolsRoot: tools,
      home,
      platform: 'darwin',
      run: fakeHost().run,
      locate: (name) => `/fixture/${name}`,
      write: (line) => output.push(line),
    });
    expect(readFileSync(join(unrelated, 'keep.txt'), 'utf8')).toBe('unrelated data');
    expect(
      output.some((line) => line.includes(unrelated) && /left|preserv|untouched/i.test(line))
    ).toBe(true);
  });

  it.each(['missing', 'malformed', 'partial', 'symlink', 'wrong-name'])(
    'preserves a directory without a managed version name and valid manifest (%s)',
    async (kind) => {
      const installed = await install(fakeHost().run);
      const unrelated = join(
        tools,
        kind === 'wrong-name' ? 'v-other' : 'v-1234567890123-00000000-0000-4000-8000-000000000000'
      );
      mkdirSync(unrelated);
      writeFileSync(join(unrelated, 'keep.txt'), 'unrelated data');
      const manifest = join(unrelated, 'manifest.json');
      if (kind === 'malformed') writeFileSync(manifest, '{');
      if (kind === 'partial')
        writeFileSync(manifest, JSON.stringify({ version: 1, soffice: '/fixture/soffice' }));
      if (kind === 'symlink') symlinkSync(join(installed.versionDir, 'manifest.json'), manifest);
      if (kind === 'wrong-name') cpSync(join(installed.versionDir, 'manifest.json'), manifest);
      await installDocumentToolkit({
        toolsRoot: tools,
        home,
        platform: 'darwin',
        run: fakeHost().run,
        locate: (name) => `/fixture/${name}`,
        write: () => {},
      });
      expect(readFileSync(join(unrelated, 'keep.txt'), 'utf8')).toBe('unrelated data');
    }
  );

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
      join(tools, '.leases', `${first.versionDir.split('/').at(-1)}.${randomUUID()}`),
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

  it.each(['root', 'current', 'version', 'uid', 'ancestor'])(
    'refuses unsafe toolkit ownership at install and read (%s)',
    async (kind) => {
      const installed = await install(fakeHost().run);
      if (kind === 'uid') vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1);
      else
        chmodSync(
          kind === 'root'
            ? tools
            : kind === 'ancestor'
              ? root
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

  it('refuses a future toolkit beneath an unsafe ancestor before install writes or commands', async () => {
    chmodSync(root, 0o777);
    const host = fakeHost();
    await expect(install(host.run)).rejects.toThrow(/Unsafe tools_root ancestor/);
    expect(host.calls).toEqual([]);
    expect(existsSync(tools)).toBe(false);
    expect(() => readDocumentToolkit(tools)).toThrow(/Unsafe tools_root ancestor/);
  });

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

  it('installs the libraries on Linux without running an unsandboxed renderer', async () => {
    mkdirSync(join(tools, 'fonts'), { recursive: true });
    for (const family of ['Sans', 'Serif'])
      writeFileSync(join(tools, 'fonts', `Noto${family}CJK.ttc`), 'fixture font');
    const host = fakeHost();
    const result = await installDocumentToolkit({
      toolsRoot: tools,
      home,
      platform: 'linux',
      run: host.run,
      locate: (name) => {
        if (name === 'soffice') {
          writeFileSync(join(tools, 'soffice'), 'fixture office');
          return join(tools, 'soffice');
        }
        return `/fixture/${name}`;
      },
    });
    expect(readDocumentToolkit(tools)?.versionDir).toBe(result.versionDir);
    expect(host.calls.some((call) => call.args.includes('--require-hashes'))).toBe(true);
    expect(host.calls.some((call) => call.args.includes('--convert-to'))).toBe(false);
    expect(host.calls.some((call) => call.args.some((arg) => arg.endsWith('rasterize.py')))).toBe(
      false
    );
  });

  it('treats an absent toolkit as unavailable', () => {
    expect(readDocumentToolkit()).toBeNull();
    expect(readDocumentToolkit(tools)).toBeNull();
  });
});
