import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext } from '@jungjaehoon/mama-core';
import { driveDeliveryActionRegistrations } from '../../src/api/drive-delivery.js';

const FOLDER = 'folder_test_0123456789';
const owner: ActionContext = {
  access: { principalId: 'owner', agentId: 'agent', scopes: [], actions: ['deliver.drive.file'] },
  operationId: 'op_test#1',
} as ActionContext;

describe('deliver.drive.file', () => {
  let root: string;
  let staging: string;
  const content = 'large result bytes';
  const md5 = createHash('md5').update(content).digest('hex');
  const sha256 = createHash('sha256').update(content).digest('hex');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'drive-delivery-'));
    mkdirSync(join(root, 'workspace', 'files'), { recursive: true });
    writeFileSync(join(root, 'workspace', 'files', 'result.pptx'), content);
    staging = join(root, 'runtime', 'outgoing');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const action = (gws: ReturnType<typeof vi.fn>) =>
    driveDeliveryActionRegistrations({
      ownerPrincipalId: 'owner',
      workspaceDir: join(root, 'workspace'),
      stagingDir: staging,
      delivery: {
        folder: FOLDER,
        readers: [{ domain: 'example.test' }, { user: 'a@example.test' }],
      },
      gws,
    })[0]!;
  const path = () => join(root, 'workspace', 'files', 'result.pptx');

  it('uploads the staged bytes into the folder, shares them with the readers and returns a receipt', async () => {
    const gws = vi.fn(async (args: string[]) => {
      if (args[2] === 'list') return { files: [] };
      if (args[2] === 'create' && args[1] === 'files') {
        return {
          id: 'file_1',
          name: 'result.pptx',
          md5Checksum: md5,
          webViewLink: 'https://drive/f1',
        };
      }
      return { id: 'perm' };
    });
    const receipt = await action(gws).exec({ path: path() }, owner);

    expect(receipt).toEqual({
      fileId: 'file_1',
      name: 'result.pptx',
      link: 'https://drive/f1',
      size: content.length,
      md5,
      sha256,
      readers: [{ domain: 'example.test' }, { user: 'a@example.test' }],
      operationId: 'op_test#1',
      idempotent: false,
    });
    const create = gws.mock.calls.find(([args]) => args[1] === 'files' && args[2] === 'create')!;
    const body = JSON.parse(create[0][create[0].indexOf('--json') + 1]);
    expect(body).toEqual({
      name: 'result.pptx',
      parents: [FOLDER],
      appProperties: { mamaOperationId: 'op_test#1', mamaSha256: sha256 },
    });
    const uploaded = create[0][create[0].indexOf('--upload') + 1];
    expect(uploaded.startsWith(staging)).toBe(true);
    const shares = gws.mock.calls
      .filter(([args]) => args[1] === 'permissions')
      .map(([args]) => JSON.parse(args[args.indexOf('--json') + 1]));
    expect(shares).toEqual([
      { type: 'domain', role: 'reader', domain: 'example.test' },
      { type: 'user', role: 'reader', emailAddress: 'a@example.test' },
    ]);
    expect(readdirSync(staging)).toEqual([]);
  });

  it('returns the file an earlier attempt sent instead of sending it again', async () => {
    const gws = vi.fn(async (args: string[]) => {
      if (args[2] === 'list') {
        return {
          files: [{ id: 'file_1', name: 'result.pptx', md5Checksum: md5, webViewLink: 'l' }],
        };
      }
      return { id: 'perm' };
    });
    const receipt = await action(gws).exec({ path: path() }, owner);

    expect(receipt).toMatchObject({ fileId: 'file_1', idempotent: true });
    expect(gws.mock.calls.some(([args]) => args[1] === 'files' && args[2] === 'create')).toBe(
      false
    );
    // A stop between upload and sharing must not leave a file nobody can read.
    expect(gws.mock.calls.filter(([args]) => args[1] === 'permissions')).toHaveLength(2);
  });

  it('lets a retry that arrives during the upload wait for it instead of uploading again', async () => {
    let release!: () => void;
    const uploaded = new Promise<void>((resolve) => (release = resolve));
    const gws = vi.fn(async (args: string[]) => {
      if (args[2] === 'list') return { files: [] };
      if (args[1] === 'files' && args[2] === 'create') {
        await uploaded;
        return { id: 'file_1', name: 'result.pptx', md5Checksum: md5, webViewLink: 'l' };
      }
      return { id: 'perm' };
    });
    const deliver = action(gws);
    const first = deliver.exec({ path: path() }, owner);
    const retry = deliver.exec({ path: path() }, owner);
    release();
    const [a, b] = await Promise.all([first, retry]);

    expect(b).toEqual(a);
    expect(
      gws.mock.calls.filter(([args]) => args[1] === 'files' && args[2] === 'create')
    ).toHaveLength(1);
  });

  it('fails loudly when Drive stored other bytes, and when the operation sent other content', async () => {
    const wrong = vi.fn(async (args: string[]) =>
      args[2] === 'list' ? { files: [] } : { id: 'file_2', name: 'x', md5Checksum: 'f'.repeat(32) }
    );
    await expect(action(wrong).exec({ path: path() }, owner)).rejects.toThrow(
      /Drive stored file_2 with md5 .*moved to the trash/
    );
    expect(wrong.mock.calls.some(([args]) => args[1] === 'permissions')).toBe(false);
    // The bad copy carries the operation id; it goes to the trash so a retry can upload again.
    const trashed = wrong.mock.calls.find(([args]) => args[2] === 'update')!;
    expect(JSON.parse(trashed[0][trashed[0].indexOf('--params') + 1]).fileId).toBe('file_2');
    expect(JSON.parse(trashed[0][trashed[0].indexOf('--json') + 1])).toEqual({ trashed: true });

    const other = vi.fn(async () => ({
      files: [{ id: 'file_3', name: 'x', md5Checksum: 'e'.repeat(32) }],
    }));
    await expect(action(other).exec({ path: path() }, owner)).rejects.toThrow(
      /already sent Drive file file_3 with other content/
    );
    expect(readdirSync(staging)).toEqual([]);
  });

  it("is the owner's, and sends only files under the workspace files directory", async () => {
    const gws = vi.fn();
    await expect(
      action(gws).exec({ path: path() }, {
        ...owner,
        access: { ...owner.access, principalId: 'member' },
      } as ActionContext)
    ).rejects.toThrow(/owner's/);
    writeFileSync(join(root, 'outside.txt'), 'x');
    await expect(action(gws).exec({ path: join(root, 'outside.txt') }, owner)).rejects.toThrow(
      /workspace files directory/
    );
    expect(gws).not.toHaveBeenCalled();
  });
});
