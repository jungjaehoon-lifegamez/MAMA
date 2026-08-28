import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';
import {
  collectAssessDeps,
  writeCompletionMarker,
  migrateLegacyInstall,
} from '../../src/onboarding/assess-live.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mama-onb-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function writeConfig(home: string, config: unknown): void {
  writeFileSync(join(home, 'config.yaml'), yaml.dump(config));
}

describe('collectAssessDeps', () => {
  it('fresh home reports everything missing', async () => {
    const deps = await collectAssessDeps(home);
    expect(deps.configExists).toBe(false);
    expect(deps.telegramToken).toBe(false);
    expect(deps.allowedChats).toBe(false);
    expect(deps.ownerFacts).toBe(false);
    expect(deps.enabledConnectors).toBe(0);
    expect(deps.firstReportAt).toBeNull();
  });

  it('reads telegram token, allowed_chats and owner facts from config.yaml', async () => {
    writeConfig(home, {
      telegram: { enabled: true, token: 't', allowed_chats: ['1001'] },
      owner: { name: 'Owner', language: 'ko', timezone: 'Asia/Seoul' },
    });
    const deps = await collectAssessDeps(home);
    expect(deps.configExists).toBe(true);
    expect(deps.telegramToken).toBe(true);
    expect(deps.allowedChats).toBe(true);
    expect(deps.ownerFacts).toBe(true);
  });

  it('empty allowed_chats is NOT an anchor', async () => {
    writeConfig(home, { telegram: { enabled: true, token: 't', allowed_chats: [] } });
    const deps = await collectAssessDeps(home);
    expect(deps.allowedChats).toBe(false);
  });

  it('counts only enabled connectors', async () => {
    writeFileSync(
      join(home, 'connectors.json'),
      JSON.stringify({ connectors: { slack: { enabled: true }, gmail: { enabled: false } } })
    );
    const deps = await collectAssessDeps(home);
    expect(deps.enabledConnectors).toBe(1);
  });

  it('first_report reads state/first-report.json', async () => {
    mkdirSync(join(home, 'state'), { recursive: true });
    writeFileSync(
      join(home, 'state', 'first-report.json'),
      JSON.stringify({ at: '2026-08-28T01:00:00Z' })
    );
    const deps = await collectAssessDeps(home);
    expect(deps.firstReportAt).toBe('2026-08-28T01:00:00Z');
  });
});

describe('writeCompletionMarker', () => {
  it('is idempotent and preserves first completed_at', async () => {
    await writeCompletionMarker(home);
    const first = JSON.parse(readFileSync(join(home, 'setup-complete.json'), 'utf-8'));
    await writeCompletionMarker(home);
    const second = JSON.parse(readFileSync(join(home, 'setup-complete.json'), 'utf-8'));
    expect(second.completed_at).toBe(first.completed_at);
  });
});

describe('migrateLegacyInstall', () => {
  it('backfills marker when persona files + telegram config exist', () => {
    writeFileSync(join(home, 'SOUL.md'), '# soul');
    writeFileSync(join(home, 'USER.md'), '# user');
    writeConfig(home, { telegram: { enabled: true, token: 't', allowed_chats: ['1'] } });
    expect(migrateLegacyInstall(home)).toBe(true);
    expect(existsSync(join(home, 'setup-complete.json'))).toBe(true);
  });

  it('does not backfill on fresh home', () => {
    expect(migrateLegacyInstall(home)).toBe(false);
  });

  it('does not backfill on partial legacy (personas only, no telegram config)', () => {
    writeFileSync(join(home, 'SOUL.md'), '# soul');
    writeFileSync(join(home, 'USER.md'), '# user');
    expect(migrateLegacyInstall(home)).toBe(false);
    expect(existsSync(join(home, 'setup-complete.json'))).toBe(false);
  });
});
