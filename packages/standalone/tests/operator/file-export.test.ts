import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  exportFile,
  renderCsv,
  resolveExportRoot,
  slugExportName,
} from '../../src/operator/file-export.js';
import { resolvePrivateWorkspaceFile } from '../../src/operator/owner-event-effects.js';

let workspace: string;
let root: string;
let previousWorkspace: string | undefined;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'mama-export-'));
  previousWorkspace = process.env.MAMA_WORKSPACE;
  process.env.MAMA_WORKSPACE = workspace;
  root = resolveExportRoot();
});

afterEach(() => {
  if (previousWorkspace === undefined) delete process.env.MAMA_WORKSPACE;
  else process.env.MAMA_WORKSPACE = previousWorkspace;
  rmSync(workspace, { recursive: true, force: true });
});

const NOW = Date.parse('2026-09-04T05:06:07.000Z');

describe('Story ONE-MAMA-P3 Task 1: file_export (csv + md)', () => {
  it('AC #1 csv with two rows round-trips through the file', async () => {
    const result = await exportFile(
      {
        format: 'csv',
        name: 'tasks',
        rows: [
          { id: 1, title: 'a' },
          { id: 2, title: 'b' },
        ],
      },
      root,
      NOW
    );
    const text = readFileSync(result.path, 'utf-8');
    expect(text).toBe('id,title\r\n1,a\r\n2,b\r\n');
    expect(result.bytes).toBe(Buffer.byteLength(text));
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(result.path).size).toBe(result.bytes);
  });

  it('AC #2 csv escapes commas, quotes, newlines and neutralises formula-leading cells', () => {
    const csv = renderCsv([
      { v: 'a,b' },
      { v: 'say "hi"' },
      { v: 'line1\nline2' },
      { v: '=SUM(A1)' },
      { v: '+1' },
      { v: '-x' },
      { v: '@cmd' },
    ]);
    const lines = csv.split('\r\n');
    expect(lines[1]).toBe('"a,b"');
    expect(lines[2]).toBe('"say ""hi"""');
    expect(lines[3]).toBe('"line1\nline2"');
    expect(lines[4]).toBe("'=SUM(A1)");
    expect(lines[5]).toBe("'+1");
    expect(lines[6]).toBe("'-x");
    expect(lines[7]).toBe("'@cmd");
  });

  it('AC #3 inconsistent row keys use columns when given, else the stable union', () => {
    expect(renderCsv([{ a: 1 }, { b: 2 }, { a: 3, c: null }])).toBe(
      'a,b,c\r\n1,,\r\n,2,\r\n3,,\r\n'
    );
    expect(renderCsv([{ a: 1, b: 2 }], ['b'])).toBe('b\r\n2\r\n');
  });

  it('AC #4 md writes content verbatim with a trailing newline', async () => {
    const result = await exportFile(
      { format: 'md', name: 'notes', content: '# Hello\n- one' },
      root,
      NOW
    );
    expect(readFileSync(result.path, 'utf-8')).toBe('# Hello\n- one\n');
    expect(result.path.endsWith('.md')).toBe(true);
  });

  it('AC #5 names are slugged to a safe basename; path parts and non-ascii collapse', async () => {
    // non-ascii written as escapes: the pre-commit hook rejects raw non-ascii in source
    expect(slugExportName('Aufgaben \u00dcbersicht \u2713')).toBe('aufgaben-ubersicht');
    expect(slugExportName('\u65e5\u672c\u8a9e')).toBe('export');
    expect(slugExportName('a/../../b')).toBe('a-b');
    expect(slugExportName('Weekly Tasks (Sep)')).toBe('weekly-tasks-sep');
    const result = await exportFile(
      { format: 'md', name: '../../escape', content: 'x' },
      root,
      NOW
    );
    expect(resolve(result.path).startsWith(resolve(root))).toBe(true);
    expect(result.path).toContain('escape-20260904T050607Z.md');
  });

  it('AC #6 the same name in the same second never overwrites: a counter suffix is used', async () => {
    const a = await exportFile({ format: 'md', name: 'same', content: 'first' }, root, NOW);
    const b = await exportFile({ format: 'md', name: 'same', content: 'second' }, root, NOW);
    expect(a.path).not.toBe(b.path);
    expect(readFileSync(a.path, 'utf-8')).toBe('first\n');
    expect(b.path).toContain('-1.md');
  });

  it('AC #7 resolveExportRoot follows MAMA_WORKSPACE, and the produced path passes the outbound guard', async () => {
    expect(root).toBe(join(resolve(workspace), 'exports'));
    const other = mkdtempSync(join(tmpdir(), 'mama-export-other-'));
    try {
      expect(resolveExportRoot({ MAMA_WORKSPACE: other } as NodeJS.ProcessEnv)).toBe(
        join(resolve(other), 'exports')
      );
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    const result = await exportFile({ format: 'csv', name: 't', rows: [{ a: 1 }] }, root, NOW);
    // macOS mounts tmp under /private; the guard returns the real path.
    expect(resolvePrivateWorkspaceFile(result.path)).toBe(realpathSync(result.path));
  });

  it('AC #8 empty rows produce a header-only file, not a zero-byte file', async () => {
    const result = await exportFile(
      { format: 'csv', name: 'empty', columns: ['id', 'title'], rows: [] },
      root,
      NOW
    );
    expect(readFileSync(result.path, 'utf-8')).toBe('id,title\r\n');
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('AC #9 csv requires rows and md requires content', async () => {
    await expect(exportFile({ format: 'csv', name: 'x' }, root, NOW)).rejects.toThrow(
      /csv requires rows/
    );
    await expect(exportFile({ format: 'md', name: 'x', content: '  ' }, root, NOW)).rejects.toThrow(
      /md requires content/
    );
  });
});
