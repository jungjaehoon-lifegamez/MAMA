import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as utilities from '../../src/cli/runtime/utilities.js';

interface RuntimeUtilities {
  isRuntimeReady?: () => boolean;
}

const isRuntimeReady = (utilities as RuntimeUtilities).isRuntimeReady;
let home: string;
let mamaHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'mama-runtime-readiness-'));
  mamaHome = join(home, '.mama');
  process.env.HOME = home;
  mkdirSync(mamaHome, { recursive: true });
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('Story ONB-7: runtime readiness is not onboarding completion', () => {
  describe('AC #2: config and all shipped persona files are required', () => {
    it('ignores setup-complete.json and becomes ready only from runtime inputs', () => {
      writeFileSync(join(mamaHome, 'setup-complete.json'), '{"completed_at":"now"}');
      expect(isRuntimeReady?.()).toBe(false);

      writeFileSync(join(mamaHome, 'config.yaml'), 'version: 1\n');
      for (const name of ['SOUL.md', 'IDENTITY.md', 'USER.md']) {
        writeFileSync(join(mamaHome, name), `# ${name}\n`);
      }

      expect(isRuntimeReady?.()).toBe(true);
    });
  });
});
