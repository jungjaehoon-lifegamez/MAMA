import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeReadPaths } from '../../src/runtime/backend-security.js';
import {
  claudeMemberDisallowedTools,
  claudeOwnerDisallowedTools,
} from '../../src/agent/claude-native-tool-policy.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it('normalizes symlinks and missing descendants through the existing ancestor and deduplicates', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fixture-paths-')));
  roots.push(root);
  mkdirSync(join(root, 'actual'));
  symlinkSync(join(root, 'actual'), join(root, 'alias'));
  writeFileSync(join(root, 'actual', 'data'), 'fixture');
  expect(
    normalizeReadPaths([
      join(root, 'alias', 'data'),
      join(root, 'actual', 'data'),
      join(root, 'alias', 'missing', 'data'),
    ])
  ).toEqual([join(root, 'actual', 'data'), join(root, 'actual', 'missing', 'data')]);
});

it('adds Read and Edit member rules while preserving every owner rule verbatim', () => {
  const paths = ['/fixture/owner'];
  const workspace = '/fixture/member/workspace';
  const owner = claudeOwnerDisallowedTools(paths, workspace);
  expect(owner).toEqual([
    'Read(//fixture/owner)',
    'Read(//fixture/owner/**)',
    'Edit(//fixture/member/workspace/.claude)',
    'Edit(//fixture/member/workspace/.claude/**)',
    'Write(//fixture/member/workspace/.claude)',
    'Write(//fixture/member/workspace/.claude/**)',
    'NotebookEdit(//fixture/member/workspace/.claude)',
    'NotebookEdit(//fixture/member/workspace/.claude/**)',
  ]);
  const member = claudeMemberDisallowedTools(paths, workspace);
  expect(member).toEqual(
    expect.arrayContaining([...owner, 'Edit(//fixture/owner)', 'Edit(//fixture/owner/**)'])
  );
});
