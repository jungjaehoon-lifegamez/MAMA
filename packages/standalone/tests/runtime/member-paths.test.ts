import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  ensureMemberPaths,
  memberPaths,
  validateMemberRoot,
} from '../../src/runtime/member-paths.js';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
it('separates backend state and host runtime paths, creates private roots and a git boundary', () => {
  const home = mkdtempSync('/private/tmp/fixture-owner-');
  roots.push(home);
  vi.stubEnv('HOME', home);
  const root = mkdtempSync('/private/tmp/fixture-members-');
  roots.push(root);
  validateMemberRoot(root, home);
  const first = ensureMemberPaths(root, 'fixture-one');
  const second = ensureMemberPaths(root, 'fixture-two');
  for (const key of Object.keys(first) as Array<keyof typeof first>) {
    expect(first[key]).not.toBe(second[key]);
    expect(first[key]).toContain('/fixture-one');
  }
  expect(statSync(root).mode & 0o777).toBe(0o700);
  expect(readFileSync(join(first.workspaceDir, '.git', 'HEAD'), 'utf8')).toBe(
    'ref: refs/heads/main\n'
  );
  for (const id of ['../escape', 'a/b', '.', '', 'a:b'])
    expect(() => memberPaths(root, id)).toThrow(/safe path component/);
  symlinkSync(home, join(root, 'fixture-symlink'));
  expect(() => ensureMemberPaths(root, 'fixture-symlink')).toThrow(/symlink/);
});
