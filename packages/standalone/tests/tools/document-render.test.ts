import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createDocumentRenderer, officeSandboxProfile } from '../../src/tools/document-render.js';
import { runCommand, type CommandRunner } from '../../src/tools/command-runner.js';
import { documentActionRegistrations } from '../../src/api/document-actions.js';
import { defaultToolsRoot } from '../../src/cli/commands/tools.js';
import { MEMBER_ACTIONS, OWNER_ACTIONS } from '../../src/runtime/action-surface.js';
import type { ActionContext } from '@jungjaehoon/mama-core';

let root: string;
let workspace: string;
let tools: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'document-render-')));
  workspace = join(root, 'workspace');
  tools = join(root, 'tools');
  mkdirSync(workspace);
  const version = join(tools, 'v-fixture');
  mkdirSync(join(version, 'bin'), { recursive: true });
  for (const path of ['pyvenv.cfg', 'bin/python3', 'fonts.conf', 'soffice'])
    writeFileSync(join(version, path), 'fixture');
  writeFileSync(
    join(version, 'manifest.json'),
    JSON.stringify({
      version: 1,
      soffice: join(version, 'soffice'),
      pythonVersion: '3.14.0',
      requirementsSha256: 'fixture',
      fonts: ['Noto Sans CJK', 'Noto Serif CJK'],
    })
  );
  symlinkSync('v-fixture', join(tools, 'current'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function fakeRenderer() {
  const calls: Array<{
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }> = [];
  const run: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, ...options });
    if (args.includes('--convert-to')) {
      const profile = args
        .find((arg) => arg.startsWith('-env:UserInstallation='))!
        .slice('-env:UserInstallation='.length);
      const macros = readFileSync(
        join(new URL(profile).pathname, 'user', 'registrymodifications.xcu'),
        'utf8'
      );
      expect(macros).toContain('MacroSecurityLevel');
      expect(macros).toContain('<value>3</value>');
      expect(macros).toContain('BlockUntrustedRefererLinks');
      expect(macros).toContain('/org.openoffice.Office.Writer/Content/Update');
      expect(macros).toContain('/org.openoffice.Office.Calc/Content/Update');
      // Never in both schemas: Writer's Link uses 2, Calc's uses 1.
      expect(macros).toContain(
        '/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value>'
      );
      expect(macros).toContain(
        '/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>1</value>'
      );
      expect(macros).toContain(
        'oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value>'
      );
      const out = args[args.indexOf('--outdir') + 1]!;
      writeFileSync(join(out, 'document.pdf'), 'fixture pdf');
    }
    const scriptIndex = args.findIndex((arg) => arg.endsWith('rasterize.py'));
    if (scriptIndex !== -1) {
      const output = args[scriptIndex + 2]!;
      writeFileSync(join(output, 'page-001.png'), 'fixture png');
      return {
        stdout: JSON.stringify({
          pageCount: 1,
          pages: ['page-001.png'],
          fonts: [['NotoSansCJKkr-Regular']],
        }),
        stderr: '',
      };
    }
    return { stdout: '', stderr: '' };
  };
  return { run, calls };
}

// Central-directory sizes describe expansion without allocating or extracting huge payloads.
function metadataZip(entries: Array<{ size: number; compressed: number }>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  entries.forEach(({ size, compressed }, index) => {
    const name = Buffer.from(`entry-${index}`);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(compressed, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local);
    const record = Buffer.alloc(46 + name.length);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(compressed, 20);
    record.writeUInt32LE(size, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    name.copy(record, 46);
    central.push(record);
    offset += local.length;
  });
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe('host document renderer', () => {
  it('stages documents and the macro profile inside the private host render root', async () => {
    const host = fakeRenderer();
    writeFileSync(join(workspace, 'draft.doc'), 'legacy document');
    let staged: string | undefined;
    const run: CommandRunner = async (command, args, options) => {
      staged = options?.cwd;
      const parent = join(realpathSync('/tmp'), `mama-office-host-${process.getuid!()}`);
      expect(staged).toMatch(new RegExp(`^${parent}/mama-office-render-`));
      expect(statSync(parent).mode & 0o777).toBe(0o700);
      expect(args[1]).toContain(`(allow file-read* (subpath ${JSON.stringify(staged)}))`);
      expect(readFileSync(join(staged!, 'document.doc'), 'utf8')).toBe('legacy document');
      return host.run(command, args, options);
    };
    await createDocumentRenderer({
      toolsRoot: tools,
      run,
      platform: 'darwin',
      deniedReadPaths: [`/tmp/mama-office-host-${process.getuid!()}`],
    }).render(workspace, 'draft.doc');
    expect(existsSync(staged!)).toBe(false);
  });

  it.each([
    [
      '512 MiB total',
      Array.from({ length: 3 }, () => ({ size: 180 * 1024 ** 2, compressed: 10 * 1024 ** 2 })),
    ],
    ['256 MiB entry', [{ size: 256 * 1024 ** 2 + 1, compressed: 10 * 1024 ** 2 }]],
    ['10,000 entries', Array.from({ length: 10_001 }, () => ({ size: 0, compressed: 0 }))],
    ['100:1 expansion', [{ size: 101, compressed: 1 }]],
    ['100:1 expansion', [{ size: 1, compressed: 0 }]],
  ])('refuses ZIP input exceeding %s before LibreOffice', async (limit, entries) => {
    const host = fakeRenderer();
    writeFileSync(join(workspace, 'draft.docx'), metadataZip(entries));
    const run: CommandRunner = (command, args, options) => {
      const index = args.findIndex((arg) => arg.endsWith('inspect-office-zip.py'));
      return index >= 0
        ? runCommand('/usr/bin/python3', ['-I', ...args.slice(index)], options)
        : host.run(command, args, options);
    };
    await expect(
      createDocumentRenderer({ toolsRoot: tools, run, platform: 'darwin' }).render(
        workspace,
        'draft.docx'
      )
    ).rejects.toThrow(limit);
    expect(host.calls.some((call) => call.args.includes('--convert-to'))).toBe(false);
    expect(readdirSync(workspace)).toEqual(['draft.docx']);
    expect(readdirSync(join(tools, '.leases'))).toEqual([]);
  });

  it.each(['docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods'])(
    'checks the ZIP directory before converting %s',
    async (extension) => {
      const host = fakeRenderer();
      writeFileSync(
        join(workspace, `draft.${extension}`),
        metadataZip([{ size: 100, compressed: 1 }])
      );
      let inspected = false;
      const run: CommandRunner = async (command, args, options) => {
        const index = args.findIndex((arg) => arg.endsWith('inspect-office-zip.py'));
        if (index >= 0) {
          expect(args[index - 1]).toBe('-I');
          expect(args[index - 2]).toBe(join(tools, 'v-fixture', 'bin', 'python3'));
          expect(command).toBe('/usr/bin/sandbox-exec');
          const result = await runCommand(
            '/usr/bin/python3',
            ['-I', ...args.slice(index)],
            options
          );
          inspected = true;
          return result;
        }
        if (args.includes('--convert-to')) expect(inspected).toBe(true);
        return host.run(command, args, options);
      };
      expect(
        (
          await createDocumentRenderer({ toolsRoot: tools, run, platform: 'darwin' }).render(
            workspace,
            `draft.${extension}`
          )
        ).pageCount
      ).toBe(1);
    }
  );

  it('keeps the output directory name within the component limit for a long input name', async () => {
    const host = fakeRenderer();
    const name = `${'é'.repeat(121)}.pptx`; // 242 bytes before the extension, 2 bytes a character
    writeFileSync(join(workspace, name), 'fixture input');
    const renderer = createDocumentRenderer({
      toolsRoot: tools,
      run: host.run,
      platform: 'darwin',
      deniedReadPaths: [],
      timeoutMs: 120,
    });
    const result = await renderer.render(workspace, name);
    const directory = result.pdf.split('/')[0]!;
    expect(Buffer.byteLength(directory, 'utf8')).toBeLessThanOrEqual(255);
    expect(existsSync(join(workspace, result.pdf))).toBe(true);
  });

  it('returns only relative output paths and cleans a fresh macro-disabled profile', async () => {
    const host = fakeRenderer();
    const input = join(workspace, 'draft.pptx');
    writeFileSync(input, 'fixture input');
    const renderer = createDocumentRenderer({
      toolsRoot: tools,
      run: host.run,
      platform: 'darwin',
      deniedReadPaths: [join(root, 'credentials')],
      timeoutMs: 120,
    });
    const result = await renderer.render(workspace, 'draft.pptx');
    expect(result.pageCount).toBe(1);
    expect(result.fonts).toEqual([['NotoSansCJKkr-Regular']]);
    expect(result.pdf).toMatch(/^draft\.render-[^/]+\/document\.pdf$/);
    expect(result.pages[0]).toMatch(/^draft\.render-[^/]+\/page-001\.png$/);
    expect(existsSync(join(workspace, result.pdf))).toBe(true);
    expect(existsSync(join(workspace, result.pages[0]!))).toBe(true);
    expect(host.calls[0]!.command).toBe('/usr/bin/sandbox-exec');
    expect(host.calls.every((call) => call.command === '/usr/bin/sandbox-exec')).toBe(true);
    const profileText = host.calls[0]!.args[1]!;
    expect(profileText).toContain('(deny network*)');
    expect(profileText).toContain('(allow network-bind network-inbound (local unix-socket))');
    expect(profileText).toContain(join(root, 'credentials'));
    expect(host.calls[0]!.env?.FONTCONFIG_FILE).toBe(join(tools, 'v-fixture', 'fonts.conf'));
    expect(host.calls[0]!.timeoutMs).toBeLessThanOrEqual(120);
    expect(existsSync(host.calls[0]!.env!.HOME!)).toBe(false);
    expect(readFileSync(input, 'utf8')).toBe('fixture input');
  });

  it('rasterizes PDF input directly and does not invoke LibreOffice', async () => {
    const host = fakeRenderer();
    writeFileSync(join(workspace, 'original.pdf'), 'original pdf bytes');
    const result = await createDocumentRenderer({
      toolsRoot: tools,
      run: host.run,
      platform: 'darwin',
    }).render(workspace, 'original.pdf');
    expect(result.pdf).toBe('original.pdf');
    expect(host.calls).toHaveLength(1);
    expect(host.calls[0]!.args.some((arg) => arg.endsWith('rasterize.py'))).toBe(true);
    expect(readFileSync(join(workspace, result.pdf), 'utf8')).toBe('original pdf bytes');
  });

  it.each([
    ['linux', 'draft.docx'],
    ['linux', 'original.pdf'],
    ['win32', 'draft.docx'],
    ['win32', 'original.pdf'],
  ] as const)(
    'refuses rendering on %s for %s before running any subprocess',
    async (platform, input) => {
      const host = fakeRenderer();
      writeFileSync(join(workspace, input), 'fixture document');
      await expect(
        createDocumentRenderer({
          toolsRoot: tools,
          run: host.run,
          platform,
        }).render(workspace, input)
      ).rejects.toThrow(/sandbox-exec.*read.*network/i);
      expect(host.calls).toHaveLength(0);
      expect(readdirSync(workspace)).toEqual([input]);
      expect(existsSync(join(tools, '.leases'))).toBe(false);
      expect(existsSync(join(tools, '.state-lock'))).toBe(false);
    }
  );

  it('refuses escapes, symlinks, nonregular files, unsupported extensions and oversized files', async () => {
    const host = fakeRenderer();
    const render = createDocumentRenderer({
      toolsRoot: tools,
      run: host.run,
      maxBytes: 20,
      platform: 'darwin',
    });
    writeFileSync(join(root, 'outside.docx'), 'fixture');
    symlinkSync(join(root, 'outside.docx'), join(workspace, 'link.docx'));
    mkdirSync(join(workspace, 'nested'));
    writeFileSync(join(workspace, 'nested', 'input.docx'), 'fixture');
    symlinkSync(join(workspace, 'nested'), join(workspace, 'alias'));
    writeFileSync(join(workspace, 'large.xlsx'), 'x'.repeat(21));
    writeFileSync(join(workspace, 'bad.txt'), 'fixture');
    for (const path of [
      '../outside.docx',
      'link.docx',
      'alias/input.docx',
      'nested',
      'large.xlsx',
      'bad.txt',
    ])
      await expect(render.render(workspace, path)).rejects.toThrow();
    expect(host.calls).toHaveLength(0);
    expect(readdirSync(join(tools, '.leases'))).toEqual([]);
  });

  it('refuses an absent toolkit with the host install command', async () => {
    await expect(
      createDocumentRenderer({ platform: 'darwin' }).render(workspace, 'draft.pptx')
    ).rejects.toThrow(/mama tools install/);
  });

  it('serializes calls and continues after a timeout', async () => {
    writeFileSync(join(workspace, 'draft.docx'), 'fixture');
    const host = fakeRenderer();
    let release!: () => void;
    let first = true;
    const started: string[] = [];
    const run: CommandRunner = async (command, args, options) => {
      if (args.includes('--convert-to')) {
        started.push('office');
        if (first) {
          first = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          throw new Error('document render timed out');
        }
      }
      return host.run(command, args, options);
    };
    const renderer = createDocumentRenderer({ toolsRoot: tools, run, platform: 'darwin' });
    const a = renderer.render(workspace, 'draft.docx');
    const rejected = expect(a).rejects.toThrow(/timed out/);
    const b = createDocumentRenderer({ toolsRoot: tools, run, platform: 'darwin' }).render(
      workspace,
      'draft.docx'
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toHaveLength(1);
    release();
    await rejected;
    expect((await b).pageCount).toBe(1);
    expect(started).toHaveLength(2);
  });

  it('bounds actual child execution and kills it on timeout', async () => {
    await expect(
      runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 50 })
    ).rejects.toThrow(/timed out/);
  });

  it.each(['page limit', 'path escape', 'output symlink'])(
    'rejects unsafe raster output (%s) and removes partial results',
    async (failure) => {
      writeFileSync(join(workspace, 'draft.docx'), 'fixture');
      writeFileSync(join(root, 'outside.png'), 'outside bytes');
      const host = fakeRenderer();
      const run: CommandRunner = async (command, args, options) => {
        const result = await host.run(command, args, options);
        const index = args.findIndex((arg) => arg.endsWith('rasterize.py'));
        if (index < 0) return result;
        if (failure === 'page limit')
          return { stdout: JSON.stringify({ pageCount: 51, pages: [], fonts: [] }), stderr: '' };
        if (failure === 'path escape')
          return {
            stdout: JSON.stringify({ pageCount: 1, pages: ['../outside.png'], fonts: [[]] }),
            stderr: '',
          };
        const png = join(args[index + 2]!, 'page-001.png');
        rmSync(png);
        symlinkSync(join(root, 'outside.png'), png);
        return result;
      };
      await expect(
        createDocumentRenderer({ toolsRoot: tools, run, platform: 'darwin' }).render(
          workspace,
          'draft.docx'
        )
      ).rejects.toThrow();
      expect(readdirSync(workspace)).toEqual(['draft.docx']);
      expect(readdirSync(join(tools, '.leases'))).toEqual([]);
      expect(readFileSync(join(root, 'outside.png'), 'utf8')).toBe('outside bytes');
    }
  );

  it('escapes sandbox strings and denies every credential path', () => {
    const profile = officeSandboxProfile('/tmp/render', '/tmp/output', [
      '/fixture/auth.env',
      '/fixture/config.yaml',
      '/fixture/runtime',
      '/fixture/.codex',
      '/fixture/jev-key',
      '/fixture/"quoted',
    ]);
    expect(profile).toContain('(deny file-write*)');
    expect(profile).not.toContain('(subpath "/private/tmp")');
    expect(profile).toContain(
      '(literal "/private/tmp") (regex #"^/private/tmp/OSL_PIPE_[0-9]+_SingleOfficeIPC_[0-9a-f]+$")'
    );
    expect(profile).toContain('(deny appleevent-send)');
    expect(profile).toContain('(subpath "/tmp/render")');
    expect(profile).toContain('(subpath "/tmp/output")');
    expect(profile).not.toContain('(allow network-outbound');
    expect(profile).not.toContain('(allow network-bind)');
    expect(profile).not.toContain('(subpath "/private/var/folders")');
    expect(profile).toContain('(deny file-read*');
    expect(profile).toContain('\\"quoted');
  });

  it('denies HOME for a common owner render, including linked images', async () => {
    const host = fakeRenderer();
    writeFileSync(join(workspace, 'draft.docx'), 'fixture');
    const [action] = documentActionRegistrations({
      toolsRoot: tools,
      workspaceDir: workspace,
      ownerPrincipalId: 'common',
      run: host.run,
      platform: 'darwin',
    });
    await action!.exec({ path: 'draft.docx' }, {
      access: { principalId: 'common' },
    } as ActionContext);
    expect(host.calls[0]!.args[1]).toContain(homedir());
    expect(host.calls[0]!.env?.HOME).not.toBe(homedir());
  });

  it('resolves the caller workspace from host authority, including owners in personal DMs', async () => {
    expect(MEMBER_ACTIONS).toContain('document.render');
    expect(OWNER_ACTIONS).toContain('document.render');
    const host = fakeRenderer();
    const personal = join(root, 'personal');
    mkdirSync(personal);
    writeFileSync(join(personal, 'mine.docx'), 'fixture');
    const [action] = documentActionRegistrations({
      toolsRoot: tools,
      workspaceDir: workspace,
      ownerPrincipalId: 'common',
      principalPaths: (id) => {
        expect(id).toBe('person');
        return { workspaceDir: personal };
      },
      run: host.run,
      platform: 'darwin',
    });
    const result = (await action!.exec({ path: 'mine.docx' }, {
      access: { principalId: 'person' },
    } as ActionContext)) as { pdf: string };
    expect(existsSync(join(personal, result.pdf))).toBe(true);
    await expect(
      action!.exec({ path: join(workspace, 'mine.docx') }, {
        access: { principalId: 'person' },
      } as ActionContext)
    ).rejects.toThrow();
  });
});

// The owner supplies a host soffice and an installed toolkit; never install or discover either.
const liveSoffice = process.env.MAMA_DOCUMENT_TEST_SOFFICE;
const liveTools = process.env.MAMA_DOCUMENT_TEST_TOOLS_ROOT;
it.runIf(Boolean(liveSoffice))(
  'real Korean/Japanese PPTX render embeds CJK fonts',
  async () => {
    const { readDocumentToolkit } = await import('../../src/tools/document-toolkit.js');
    const toolsRoot = liveTools ?? defaultToolsRoot();
    const toolkit = readDocumentToolkit(toolsRoot)!;
    const smoke = join(__dirname, '../../toolkit/smoke.py');
    const env = { ...process.env, PATH: `${join(toolkit.versionDir, 'bin')}:${process.env.PATH}` };
    await runCommand('python3', ['-I', smoke, 'create', join(workspace, 'smoke.pptx')], { env });
    const result = await createDocumentRenderer({ toolsRoot, soffice: liveSoffice }).render(
      workspace,
      'smoke.pptx'
    );
    expect(result.fonts.flat().some((font) => /Noto.*CJK/i.test(font))).toBe(true);
    await runCommand('python3', ['-I', smoke, 'check', join(workspace, result.pdf)], { env });
    // Pages just under the per-page limit still stop at the document's pixel budget.
    await runCommand(
      'python3',
      [
        '-I',
        '-c',
        'import pymupdf,sys\nd=pymupdf.open()\nfor _ in range(30): d.new_page(width=1500,height=1600)\nd.save(sys.argv[1])',
        join(workspace, 'large.pdf'),
      ],
      { env }
    );
    await expect(
      createDocumentRenderer({ toolsRoot, soffice: liveSoffice }).render(workspace, 'large.pdf')
    ).rejects.toThrow(/200 megapixel/);
  },
  60_000
);
