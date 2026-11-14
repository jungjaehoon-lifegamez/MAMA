import { afterEach, beforeEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memberNodeBin, syncMemberNode } from '../../src/runtime/member-node.js';
import { assertToolsOwnership } from '../../src/runtime/tools-paths.js';

let root: string;
let home: string;
let tools: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'member-node-')));
  home = join(root, 'home');
  tools = join(root, 'tools');
  fs.mkdirSync(join(home, '.mama', 'node', 'bin'), { recursive: true });
  fs.mkdirSync(tools, { mode: 0o700 });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A single-file stand-in for the install's Node under HOME. */
function homeNode(prints: string): string {
  const path = join(home, '.mama', 'node', 'bin', 'node');
  fs.writeFileSync(path, `#!/bin/sh\necho ${prints}\n`, { mode: 0o755 });
  return path;
}

it('copies a Node under HOME to tools_root, where members can run it', () => {
  const source = homeNode('v22.0.1');
  const first = syncMemberNode(tools, source, 'v22.0.1', home);
  expect(first).toEqual({
    path: join(tools, 'node', 'bin', 'node'),
    version: 'v22.0.1',
    how: 'copied',
  });
  expect(fs.lstatSync(first.path).isFile()).toBe(true);
  expect(fs.statSync(first.path).mode & 0o777).toBe(0o755);
  expect(execFileSync(first.path, [], { encoding: 'utf8' }).trim()).toBe('v22.0.1');
  expect(fs.readdirSync(memberNodeBin(tools))).toEqual(['node']);
  expect(() => assertToolsOwnership(tools)).not.toThrow();
  expect(syncMemberNode(tools, source, 'v22.0.1', home).how).toBe('unchanged');
  // A moved Node (another pin) replaces the copy at the next boot.
  fs.writeFileSync(source, '#!/bin/sh\necho v22.0.12\n');
  expect(syncMemberNode(tools, source, 'v22.0.12', home).how).toBe('copied');
  expect(execFileSync(first.path, [], { encoding: 'utf8' }).trim()).toBe('v22.0.12');
  expect(fs.readFileSync(join(tools, 'node', 'version'), 'utf8')).toBe('v22.0.12\n');
});

it('refuses a copy that does not run as the same Node and keeps nothing', () => {
  const source = homeNode('v1.0.0');
  expect(() => syncMemberNode(tools, source, 'v22.0.1', home)).toThrow(/reports v1\.0\.0/);
  expect(fs.readdirSync(memberNodeBin(tools))).toEqual([]);
});

it('links a Node outside HOME, which may need the libraries beside it', () => {
  const linked = syncMemberNode(tools, process.execPath, process.version, home);
  expect(linked.how).toBe('linked');
  expect(fs.readlinkSync(linked.path)).toBe(fs.realpathSync(process.execPath));
  expect(execFileSync(linked.path, ['--version'], { encoding: 'utf8' }).trim()).toBe(
    process.version
  );
  expect(() => assertToolsOwnership(tools)).not.toThrow();
  expect(syncMemberNode(tools, process.execPath, process.version, home).how).toBe('unchanged');
});

it('refuses a node folder another account could change', () => {
  syncMemberNode(tools, homeNode('v22.0.1'), 'v22.0.1', home);
  fs.chmodSync(join(tools, 'node', 'bin'), 0o777);
  expect(() => assertToolsOwnership(tools)).toThrow(/Unsafe tools_root directory/);
  fs.chmodSync(join(tools, 'node', 'bin'), 0o755);
  fs.chmodSync(join(tools, 'node', 'bin', 'node'), 0o777);
  expect(() => assertToolsOwnership(tools)).toThrow(/Unsafe tools_root node/);
  fs.rmSync(join(tools, 'node', 'bin', 'node'));
  fs.symlinkSync('../relative', join(tools, 'node', 'bin', 'node'));
  expect(() => assertToolsOwnership(tools)).toThrow(/Unsafe tools_root node/);
  fs.rmSync(join(tools, 'node', 'bin', 'node'));
  fs.rmSync(join(tools, 'node', 'bin'), { recursive: true });
  fs.symlinkSync(home, join(tools, 'node', 'bin'));
  expect(() => assertToolsOwnership(tools)).toThrow(/symlinks are not allowed/);
});
