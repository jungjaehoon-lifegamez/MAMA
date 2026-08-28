import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupCommand } from '../../src/cli/commands/setup.js';

let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'mama-setup-contract-'));
  process.env.HOME = home;
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

describe('Story ONB-3 / TG-03 / TG-04: setup delegates to the onboarding contract', () => {
  describe('AC #2: setup prints current status without starting a browser server', () => {
    it('returns after rendering the real status contract for a fresh HOME', async () => {
      let output = '';
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        output += String(chunk);
        return true;
      });
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        output += `${args.map(String).join(' ')}\n`;
      });

      await expect(setupCommand()).resolves.toBeUndefined();

      expect(output).toContain('Onboarding: incomplete');
      expect(output).toContain('mama init');
      expect(output).not.toContain('Setup Wizard');
      expect(output).not.toContain('localhost:3848');
    });
  });
});
