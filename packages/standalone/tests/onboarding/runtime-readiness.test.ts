import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRuntimeReady } from '../../src/cli/runtime/utilities.js';
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
  describe('AC #2: config.yaml is the only required runtime input', () => {
    it('ignores setup-complete.json and becomes ready only from runtime inputs', () => {
      writeFileSync(join(mamaHome, 'setup-complete.json'), '{"completed_at":"now"}');
      expect(isRuntimeReady()).toBe(false);

      writeFileSync(join(mamaHome, 'config.yaml'), 'version: 1\n');

      expect(isRuntimeReady()).toBe(true);
    });

    it('is ready with config.yaml alone — retired persona files are not required', () => {
      writeFileSync(join(mamaHome, 'config.yaml'), 'version: 1\n');

      // Personas were retired: the owner runtime loads no SOUL/IDENTITY/USER
      // file, so their absence must not hold the runtime back.
      expect(isRuntimeReady()).toBe(true);
    });
  });
});
