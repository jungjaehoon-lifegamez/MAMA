import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertToolsOwnership, validateToolsRoot } from '../../src/runtime/tools-paths.js';

let root: string;
let parent: string;
let tools: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'tools-ancestors-')));
  parent = join(root, 'shared');
  tools = join(parent, 'nested', 'tools');
  fs.mkdirSync(tools, { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

it.each([0o770, 0o777])(
  'refuses a writable non-sticky ancestor (%s), including absent roots',
  (mode) => {
    fs.chmodSync(parent, mode);
    for (const path of [tools, join(parent, 'future', 'tools')]) {
      expect(() => assertToolsOwnership(path)).toThrow(/Unsafe tools_root ancestor/);
      expect(() => validateToolsRoot(path, [])).toThrow(/Unsafe tools_root ancestor/);
    }
  }
);

it('accepts sticky shared ancestors owned by this uid or root', () => {
  fs.chmodSync(parent, 0o1777);
  expect(() => assertToolsOwnership(tools)).not.toThrow();
  expect(validateToolsRoot(join(parent, 'future', 'tools'), [])).toBe(
    join(parent, 'future', 'tools')
  );
});

it('refuses another uid even when its ancestor is sticky', () => {
  fs.chmodSync(parent, 0o1777);
  vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1);
  expect(() => assertToolsOwnership(tools)).toThrow(/Unsafe tools_root ancestor/);
});
