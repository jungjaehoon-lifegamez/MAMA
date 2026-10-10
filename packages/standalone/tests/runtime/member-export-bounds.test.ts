import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { memberPaths } from '../../src/runtime/member-paths.js';

// A small upload limit makes the ZIP-header budget reachable with a handful of entries.
vi.mock('../../src/api/file-delivery.js', async (original) => ({
  ...(await original<typeof import('../../src/api/file-delivery.js')>()),
  OWNER_FILE_MAX_UPLOAD_BYTES: 2_000,
}));
const { memberFileInventory } = await import('../../src/api/member-export.js');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const memberTree = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'member-export-bounds-')));
  roots.push(root);
  const id = `m${Date.now()}`;
  const files = join(memberPaths(root, id).workspaceDir, 'files');
  mkdirSync(files, { recursive: true });
  return { root, id, files };
};

it('refuses a tree whose ZIP headers alone pass the upload limit, empty files included', () => {
  const { root, id, files } = memberTree();
  for (let i = 0; i < 40; i++) writeFileSync(join(files, `empty-${i}.txt`), '');
  expect(() => memberFileInventory(root, id)).toThrow(/too many entries for one export/);
});

it('names a symbolic link the export leaves out, without following it', () => {
  const { root, id, files } = memberTree();
  writeFileSync(join(files, 'kept.txt'), 'kept');
  symlinkSync(tmpdir(), join(files, 'outside'));
  const inventory = memberFileInventory(root, id);
  expect(inventory.files.map((file) => file.name)).toEqual([
    `files/${id}/workspace/files/kept.txt`,
  ]);
  expect(inventory.omittedFiles).toEqual([`files/${id}/workspace/files/outside`]);
});
