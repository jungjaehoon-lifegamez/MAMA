import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { memberPaths, memberRoomTmpRoot } from '../../src/runtime/member-paths.js';
import { memberFileInventory } from '../../src/api/member-export.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

it('exports a room workspace but never its account, credential, history or temp files', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'member-export-rooms-')));
  roots.push(root);
  const id = `m${Date.now()}`;
  const runtime = memberPaths(root, id).runtimeRoot;
  const room = join(runtime, 'rooms', createHash('sha256').update('-100').digest('hex'));
  write(join(runtime, 'workspace', 'files', 'note.txt'), 'personal');
  write(join(runtime, '.codex', 'auth.json'), 'fixture-credential');
  for (const [path, text] of [
    ['workspace/files/room-note.txt', 'room work'],
    ['workspace/.tmp/scratch.txt', 'scratch'],
    ['.codex/auth.json', 'fixture-credential'],
    ['.codex/sessions/rollout.jsonl', 'room transcript'],
    ['claude-config/.claude.json', 'fixture-account'],
    ['claude-config/history.jsonl', 'room history'],
    ['claude-config/projects/session.jsonl', 'room transcript'],
  ])
    write(join(room, path), text);
  const roomTemp = memberRoomTmpRoot(id);
  write(join(roomTemp, 'output.txt'), 'room temp');
  roots.push(roomTemp);
  const inventory = memberFileInventory(root, id);
  expect(inventory.files.map((file) => file.name).sort()).toEqual(
    [
      `files/${id}/workspace/files/note.txt`,
      `files/${id}/rooms/${basename(room)}/workspace/files/room-note.txt`,
      `files/${basename(roomTemp)}/output.txt`,
    ].sort()
  );
});
