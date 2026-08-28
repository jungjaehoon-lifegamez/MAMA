import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statusCommand } from '../../src/cli/commands/status.js';

let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'mama-status-home-'));
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

describe('Story ONB-2: machine-readable onboarding status', () => {
  describe('AC #4: JSON output remains parseable and reports observation failures', () => {
    it('writes only JSON to stdout for a fresh HOME', async () => {
      let output = '';
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        output += String(chunk);
        return true;
      });
      vi.spyOn(console, 'log').mockImplementation(() => undefined);

      await statusCommand({ json: true });

      const payload = JSON.parse(output) as {
        onboarding: { complete: boolean; missing: string[] };
        daemon: { running: boolean };
      };
      expect(payload.onboarding.complete).toBe(false);
      expect(payload.onboarding.missing[0]).toBe('config');
      expect(payload.daemon.running).toBe(false);
    });

    it('keeps JSON status available while surfacing a malformed state-file path', async () => {
      const mamaHome = join(home, '.mama');
      mkdirSync(mamaHome, { recursive: true });
      const configPath = join(mamaHome, 'config.yaml');
      writeFileSync(configPath, 'version: [');
      let output = '';
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        output += String(chunk);
        return true;
      });
      vi.spyOn(console, 'log').mockImplementation(() => undefined);

      await statusCommand({ json: true });

      const payload = JSON.parse(output) as {
        onboarding: null;
        onboardingError: string;
        daemon: { running: boolean };
      };
      expect(payload.onboarding).toBeNull();
      expect(payload.onboardingError).toContain(configPath);
      expect(payload.daemon.running).toBe(false);
    });
  });
});
