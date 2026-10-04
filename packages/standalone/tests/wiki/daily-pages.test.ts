import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findDailyPages } from '../../src/wiki/wiki-read.js';

describe('findDailyPages', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'daily-pages-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const page = (path: string): void => {
    const file = join(root, ...path.split('/'));
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '---\ntitle: "x"\n---\n');
  };

  it('finds the day in its month folder and in the flat folder, and nothing else', () => {
    page('daily/2026-10/2026-10-04.md');
    page('daily/2026-10-04.md');
    page('daily/2026-10/2026-10-05.md');
    page('projects/2026-10-04.md');
    page('daily/.obsidian/2026-10-04.md');

    expect(findDailyPages(root, '2026-10-04')).toEqual([
      'daily/2026-10-04.md',
      'daily/2026-10/2026-10-04.md',
    ]);
    expect(findDailyPages(root, '2026-10-06')).toEqual([]);
  });

  it('does not follow a symlinked folder out of the wiki', () => {
    const outside = mkdtempSync(join(tmpdir(), 'daily-outside-'));
    try {
      writeFileSync(join(outside, '2026-10-04.md'), 'x');
      mkdirSync(join(root, 'daily'));
      symlinkSync(outside, join(root, 'daily', '2026-10'));
      expect(findDailyPages(root, '2026-10-04')).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reads an absent daily folder as no page', () => {
    expect(findDailyPages(root, '2026-10-04')).toEqual([]);
  });
});
