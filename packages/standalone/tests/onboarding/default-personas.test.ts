import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initCommand } from '../../src/cli/commands/init.js';

let home: string;
let mamaHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'mama-default-personas-'));
  mamaHome = join(home, '.mama');
  process.env.HOME = home;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('Story ONB-7 / TG-03 / TG-04: init ships no persona files', () => {
  describe('AC #1: initialization needs no personality ritual', () => {
    it('writes no persona files and no bootstrap script', async () => {
      await initCommand({ force: true, skipAuthCheck: true, backend: 'codex' });

      for (const name of ['SOUL.md', 'IDENTITY.md', 'USER.md', 'BOOTSTRAP.md']) {
        expect(existsSync(join(mamaHome, name))).toBe(false);
      }
      // The one prompt input the runtime does read still gets created.
      expect(existsSync(join(mamaHome, 'CLAUDE.md'))).toBe(true);
    });

    it('never deletes or rewrites a persona file left by an older install', async () => {
      mkdirSync(mamaHome, { recursive: true });
      const soulPath = join(mamaHome, 'SOUL.md');
      writeFileSync(soulPath, '# Owner edited soul\n');

      await initCommand({ force: true, skipAuthCheck: true, backend: 'codex' });

      expect(existsSync(soulPath)).toBe(true);
      expect(readFileSync(soulPath, 'utf8')).toBe('# Owner edited soul\n');
    });
  });
});
