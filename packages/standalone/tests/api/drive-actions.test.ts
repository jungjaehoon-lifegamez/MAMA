import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCatalog, createDispatcher, type ActionContext } from '@jungjaehoon/mama-core';

import { driveActionRegistrations, driveId, type GwsCall } from '../../src/api/drive-actions.js';

const FOLDER = 'application/vnd.google-apps.folder';
const files: Record<string, Record<string, unknown>> = {
  bin1: {
    id: 'bin1',
    name: 'feedback.pdf',
    mimeType: 'application/pdf',
    size: '4',
    modifiedTime: '2026-10-02T01:00:00.000Z',
    lastModifyingUser: { displayName: 'Member A' },
    parents: ['fold1'],
    driveId: 'drive1',
    webViewLink: 'https://drive.google.com/file/d/bin1/view',
  },
  sheet1: { id: 'sheet1', name: 'Tracker', mimeType: 'application/vnd.google-apps.spreadsheet' },
  fold1: { id: 'fold1', name: 'Parts', mimeType: FOLDER },
  form1: { id: 'form1', name: 'Survey', mimeType: 'application/vnd.google-apps.form' },
};

let home: string;
let calls: Array<{ args: string[]; params: Record<string, unknown>; timeoutMs?: number }>;
let listed: Array<Record<string, unknown>>;

const fakeGws: GwsCall = async (args, options) => {
  const params = JSON.parse(args[args.indexOf('--params') + 1]) as Record<string, unknown>;
  calls.push({ args, params, ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
  const command = args.slice(0, 3).join(' ');
  if (command === 'drive drives list') return { drives: [{ id: 'drive1', name: 'Shared' }] };
  if (command === 'drive files list') {
    const q = String(params.q);
    if (q.includes("name = 'Missing'")) return { files: [] };
    if (q.includes(`mimeType = '${FOLDER}'`)) return { files: [files.fold1] };
    return { files: listed };
  }
  if (command === 'drive files get' && params.alt === undefined) {
    const file = files[String(params.fileId)];
    if (!file) throw new Error('gws CLI returned an error: {"code":404,"reason":"notFound"}');
    return file;
  }
  if (command === 'drive files get' || command === 'drive files export') {
    writeFileSync(args[args.indexOf('--output') + 1], 'data');
    return { status: 'success' };
  }
  throw new Error(`unexpected ${command}`);
};

const owner: ActionContext['access'] = {
  principalId: 'owner',
  agentId: 'agent',
  actions: ['drive.read', 'drive.download'],
  connectors: ['drive'],
  scopes: [],
};

function dispatcher() {
  return createDispatcher(
    createCatalog(
      driveActionRegistrations({ ownerPrincipalId: 'owner', downloadsDir: home, gws: fakeGws })
    )
  );
}

describe('drive.read and drive.download', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'drive-read-'));
    calls = [];
    listed = [files.fold1, files.bin1];
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('reads ids out of the link forms cards and messages carry', () => {
    expect(driveId('bin1', 'file')).toBe('bin1');
    expect(driveId('https://drive.google.com/file/d/a-1_B/view?usp=sharing', 'file')).toBe('a-1_B');
    expect(driveId('https://drive.google.com/open?id=a-2&usp=drive_fs', 'file')).toBe('a-2');
    expect(driveId('https://drive.google.com/drive/u/0/folders/f-3', 'folder')).toBe('f-3');
    expect(driveId('https://docs.google.com/spreadsheets/d/s-4/edit#gid=0', 'file')).toBe('s-4');
    expect(() => driveId('https://example.com/page', 'file')).toThrow('names no Drive file');
    expect(() => driveId('two words', 'file')).toThrow('Drive id or link');
  });

  it('lists the shared drives', async () => {
    const result = await dispatcher()(
      { action: 'drive.read', input: { view: 'drives' } },
      { access: owner }
    );
    expect(result).toMatchObject({
      status: 'completed',
      data: { drives: [{ id: 'drive1', name: 'Shared' }] },
    });
  });

  it('browses a folder down a path, with a name filter, across all drives', async () => {
    const result = await dispatcher()(
      {
        action: 'drive.read',
        input: { view: 'browse', folder: 'drive1', path: 'Parts', name: "it's" },
      },
      { access: owner }
    );
    expect(result).toMatchObject({
      status: 'completed',
      data: {
        folder: 'fold1',
        entries: [
          { id: 'fold1', folder: true },
          {
            id: 'bin1',
            name: 'feedback.pdf',
            type: 'application/pdf',
            folder: false,
            size: 4,
            modified: '2026-10-02T01:00:00.000Z',
            modifiedBy: 'Member A',
            drive: 'drive1',
            link: 'https://drive.google.com/file/d/bin1/view',
          },
        ],
      },
    });
    expect(calls[0].params).toMatchObject({
      q: `'drive1' in parents and name = 'Parts' and mimeType = '${FOLDER}' and trashed = false`,
      corpora: 'allDrives',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    expect(calls[1].params).toMatchObject({
      q: "'fold1' in parents and trashed = false and name contains 'it\\'s'",
      pageSize: 101,
      orderBy: 'folder,name',
    });
  });

  it('names a path segment that does not exist and refuses a folder over 100 entries', async () => {
    const dispatch = dispatcher();
    expect(
      await dispatch(
        { action: 'drive.read', input: { view: 'browse', folder: 'root', path: 'Missing' } },
        { access: owner }
      )
    ).toMatchObject({
      status: 'failed',
      error: { code: 'invalid_input', message: expect.stringContaining('"Missing"') },
    });
    listed = Array.from({ length: 101 }, (_, i) => ({ ...files.bin1, id: `f${i}` }));
    expect(
      await dispatch(
        { action: 'drive.read', input: { view: 'browse', folder: 'root' } },
        { access: owner }
      )
    ).toMatchObject({
      status: 'failed',
      error: { code: 'invalid_input', message: expect.stringContaining('narrow') },
    });
  });

  it('reads one file behind a link', async () => {
    const result = await dispatcher()(
      {
        action: 'drive.read',
        input: { view: 'file', file: 'https://drive.google.com/file/d/bin1/view' },
      },
      { access: owner }
    );
    expect(result).toMatchObject({
      status: 'completed',
      data: { file: { id: 'bin1', parents: ['fold1'] } },
    });
    expect(calls[0].params).toMatchObject({ fileId: 'bin1', supportsAllDrives: true });
  });

  it('searches names and content with the text escaped, newest first', async () => {
    await dispatcher()(
      { action: 'drive.read', input: { view: 'search', text: "a\\b'c" } },
      { access: owner }
    );
    expect(calls[0].params).toMatchObject({
      q: "(name contains 'a\\\\b\\'c' or fullText contains 'a\\\\b\\'c') and trashed = false",
      pageSize: 20,
      orderBy: 'modifiedTime desc',
    });
  });

  it("refuses principals other than the owner and reports gws's error", async () => {
    const dispatch = dispatcher();
    expect(
      await dispatch(
        { action: 'drive.read', input: { view: 'drives' } },
        { access: { ...owner, principalId: 'member' } }
      )
    ).toMatchObject({ status: 'failed', error: { code: 'drive_out_of_scope' } });
    expect(
      await dispatch(
        { action: 'drive.read', input: { view: 'file', file: 'gone' } },
        { access: owner }
      )
    ).toMatchObject({ status: 'failed', error: { message: expect.stringContaining('notFound') } });
    expect(calls).toHaveLength(1);
  });

  it('fetches a binary file with alt=media into the downloads directory', async () => {
    const result = await dispatcher()(
      { action: 'drive.download', input: { file: 'https://drive.google.com/open?id=bin1' } },
      { access: owner }
    );
    const path = join(home, 'drive', 'bin1_feedback.pdf');
    expect(result).toMatchObject({
      status: 'completed',
      data: { file: 'bin1', type: 'application/pdf', exportedAs: null, path, size: 4 },
    });
    expect(readFileSync(path, 'utf8')).toBe('data');
    expect(calls[1]).toMatchObject({
      args: ['drive', 'files', 'get', '--params', expect.any(String), '--output', path],
      params: { fileId: 'bin1', alt: 'media', supportsAllDrives: true },
      timeoutMs: 120_000,
    });
  });

  it('exports a Google spreadsheet as xlsx and refuses folders and other native types', async () => {
    const dispatch = dispatcher();
    const sheet = await dispatch(
      { action: 'drive.download', input: { file: 'sheet1' } },
      { access: owner }
    );
    expect(sheet).toMatchObject({
      status: 'completed',
      data: {
        exportedAs: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        path: join(home, 'drive', 'sheet1_Tracker.xlsx'),
      },
    });
    expect(calls[1]).toMatchObject({
      args: [
        'drive',
        'files',
        'export',
        '--params',
        expect.any(String),
        '--output',
        expect.any(String),
      ],
      params: {
        fileId: 'sheet1',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    });
    for (const file of ['fold1', 'form1']) {
      expect(
        await dispatch({ action: 'drive.download', input: { file } }, { access: owner })
      ).toMatchObject({ status: 'failed', error: { code: 'invalid_input' } });
    }
  });
});
