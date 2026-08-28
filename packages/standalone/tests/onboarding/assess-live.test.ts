import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectAssessDeps,
  migrateLegacyInstall,
  writeCompletionMarker,
} from '../../src/onboarding/assess-live.js';
import { saveConfig } from '../../src/cli/config/config-manager.js';
import { DEFAULT_CONFIG, type MAMAConfig } from '../../src/cli/config/types.js';

let home: string;
let mamaHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'mama-onb-home-'));
  mamaHome = join(home, '.mama');
  process.env.HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  rmSync(home, { recursive: true, force: true });
});

async function writeConfig(overrides: Partial<MAMAConfig> = {}): Promise<void> {
  const config = structuredClone(DEFAULT_CONFIG);
  await saveConfig({ ...config, ...overrides });
}

function connectorConfig(enabled: boolean): Record<string, unknown> {
  return {
    enabled,
    pollIntervalMinutes: 5,
    channels: {},
    auth: { type: 'none' },
  };
}

describe('Story ONB-2: live onboarding assessment', () => {
  describe('AC #1: configuration and gateway readiness come from loadable live state', () => {
    it('reports a fresh HOME as missing without accepting an alternate path authority', async () => {
      const deps = await collectAssessDeps();

      expect(deps.configLoadable).toBe(false);
      expect(deps.telegramConfigured).toBe(false);
      expect(deps.allowedChats).toBe(false);
      expect(deps.enabledConnectors).toBe(0);
      expect(deps.firstReportAt).toBeNull();
    });

    it('requires Telegram to be enabled and have a token', async () => {
      await writeConfig({ telegram: { enabled: false, token: 't', allowed_chats: ['1001'] } });

      expect((await collectAssessDeps()).telegramConfigured).toBe(false);

      await writeConfig({ telegram: { enabled: true, token: 't', allowed_chats: ['1001'] } });
      const deps = await collectAssessDeps();

      expect(deps.configLoadable).toBe(true);
      expect(deps.telegramConfigured).toBe(true);
      expect(deps.allowedChats).toBe(true);
    });

    it('does not treat an empty allowed_chats list as a trust anchor', async () => {
      await writeConfig({ telegram: { enabled: true, token: 't', allowed_chats: [] } });

      expect((await collectAssessDeps()).allowedChats).toBe(false);
    });

    it('throws an explicit config path when config.yaml is malformed', async () => {
      mkdirSync(mamaHome, { recursive: true });
      const configPath = join(mamaHome, 'config.yaml');
      writeFileSync(configPath, 'version: [');

      await expect(collectAssessDeps()).rejects.toThrow(configPath);
    });
  });

  describe('AC #2: connector and first-report state fail loudly when malformed', () => {
    it('counts only enabled connectors', async () => {
      mkdirSync(mamaHome, { recursive: true });
      writeFileSync(
        join(mamaHome, 'connectors.json'),
        JSON.stringify({ slack: connectorConfig(true), gmail: connectorConfig(false) })
      );

      expect((await collectAssessDeps()).enabledConnectors).toBe(1);
    });

    it('throws an explicit connectors path when connectors.json is malformed', async () => {
      mkdirSync(mamaHome, { recursive: true });
      const connectorsPath = join(mamaHome, 'connectors.json');
      writeFileSync(connectorsPath, '{');

      await expect(collectAssessDeps()).rejects.toThrow(connectorsPath);
    });

    it('throws an explicit connectors path when connectors.json has an invalid shape', async () => {
      mkdirSync(mamaHome, { recursive: true });
      const connectorsPath = join(mamaHome, 'connectors.json');
      writeFileSync(connectorsPath, 'null');

      await expect(collectAssessDeps()).rejects.toThrow(connectorsPath);
    });

    it('reads the first confirmed report timestamp', async () => {
      mkdirSync(join(mamaHome, 'state'), { recursive: true });
      writeFileSync(
        join(mamaHome, 'state', 'first-report.json'),
        JSON.stringify({ at: '2026-08-28T01:00:00Z' })
      );

      expect((await collectAssessDeps()).firstReportAt).toBe('2026-08-28T01:00:00Z');
    });

    it('throws an explicit first-report path when first-report.json is malformed', async () => {
      mkdirSync(join(mamaHome, 'state'), { recursive: true });
      const reportPath = join(mamaHome, 'state', 'first-report.json');
      writeFileSync(reportPath, '{');

      await expect(collectAssessDeps()).rejects.toThrow(reportPath);
    });

    it('throws an explicit first-report path when first-report.json has an invalid shape', async () => {
      mkdirSync(join(mamaHome, 'state'), { recursive: true });
      const reportPath = join(mamaHome, 'state', 'first-report.json');
      writeFileSync(reportPath, 'null');

      await expect(collectAssessDeps()).rejects.toThrow(reportPath);
    });
  });

  describe('AC #3: completion and legacy migration markers are consistent and idempotent', () => {
    it('preserves the first completion timestamp', async () => {
      await writeCompletionMarker(mamaHome);
      const first = JSON.parse(readFileSync(join(mamaHome, 'setup-complete.json'), 'utf-8'));
      await writeCompletionMarker(mamaHome);
      const second = JSON.parse(readFileSync(join(mamaHome, 'setup-complete.json'), 'utf-8'));

      expect(second.completed_at).toBe(first.completed_at);
    });

    it('backfills both completion and first-report evidence for a working legacy install', async () => {
      mkdirSync(mamaHome, { recursive: true });
      writeFileSync(join(mamaHome, 'SOUL.md'), '# soul');
      writeFileSync(join(mamaHome, 'USER.md'), '# user');
      await writeConfig({ telegram: { enabled: true, token: 't', allowed_chats: ['1'] } });

      expect(await migrateLegacyInstall(mamaHome)).toBe(true);
      expect(existsSync(join(mamaHome, 'setup-complete.json'))).toBe(true);
      expect(existsSync(join(mamaHome, 'state', 'first-report.json'))).toBe(true);
      expect((await collectAssessDeps()).firstReportAt).not.toBeNull();
    });

    it('does not re-read legacy eligibility after both migration markers exist', async () => {
      mkdirSync(mamaHome, { recursive: true });
      writeFileSync(join(mamaHome, 'SOUL.md'), '# soul');
      writeFileSync(join(mamaHome, 'USER.md'), '# user');
      await writeConfig({ telegram: { enabled: true, token: 't', allowed_chats: ['1'] } });
      expect(await migrateLegacyInstall(mamaHome)).toBe(true);

      writeFileSync(join(mamaHome, 'config.yaml'), 'version: [');

      expect(await migrateLegacyInstall(mamaHome)).toBe(false);
    });

    it('does not backfill a fresh or partial legacy install', async () => {
      expect(await migrateLegacyInstall(mamaHome)).toBe(false);

      mkdirSync(mamaHome, { recursive: true });
      writeFileSync(join(mamaHome, 'SOUL.md'), '# soul');
      writeFileSync(join(mamaHome, 'USER.md'), '# user');

      expect(await migrateLegacyInstall(mamaHome)).toBe(false);
      expect(existsSync(join(mamaHome, 'setup-complete.json'))).toBe(false);
      expect(existsSync(join(mamaHome, 'state', 'first-report.json'))).toBe(false);
    });

    it('throws an explicit completion path when an existing legacy marker is invalid', async () => {
      mkdirSync(mamaHome, { recursive: true });
      writeFileSync(join(mamaHome, 'SOUL.md'), '# soul');
      writeFileSync(join(mamaHome, 'USER.md'), '# user');
      await writeConfig({ telegram: { enabled: true, token: 't', allowed_chats: ['1'] } });
      const completionPath = join(mamaHome, 'setup-complete.json');
      writeFileSync(completionPath, 'null');

      await expect(migrateLegacyInstall(mamaHome)).rejects.toThrow(completionPath);
    });
  });
});
