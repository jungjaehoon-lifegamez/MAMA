import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConnectorConfig } from '../../src/connectors/config-loader.js';
import { loadConnector, LOADABLE_CONNECTORS } from '../../src/connectors/index.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeConfig(value: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'connector-config-'));
  roots.push(root);
  const path = join(root, 'connectors.json');
  writeFileSync(path, JSON.stringify(value), 'utf8');
  return path;
}

const valid = {
  enabled: true,
  pollIntervalMinutes: 5,
  channels: { 'channel-key': { role: 'hub', name: 'display-name', boardId: 'board-key' } },
  auth: { type: 'token', tokenName: 'MAMA_AUTH_TOKEN' },
};

describe('connector config loader', () => {
  it('rejects ambient auth token names outside the managed MAMA secret list', () => {
    const result = loadConnectorConfig(
      writeConfig({ slack: { ...valid, auth: { type: 'token', tokenName: 'SLACK_BOT_TOKEN' } } })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('managed MAMA secret');
  });
  it('accepts managed iCal feed secret names', () => {
    const result = loadConnectorConfig(
      writeConfig({
        ical: {
          ...valid,
          channels: { stays: { role: 'reference', name: 'Stays', feedName: 'Stays' } },
          auth: { type: 'token', tokenName: 'MAMA_ICAL_URL_STAYS' },
        },
      })
    );
    expect(result.ok).toBe(true);
  });

  it('rejects iCal feed keys that cannot form a secret name and colliding names', () => {
    const invalid = loadConnectorConfig(
      writeConfig({ ical: { ...valid, channels: { '7stay': { role: 'reference' } } } })
    );
    expect(invalid).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('7stay') },
    });
    const collision = loadConnectorConfig(
      writeConfig({
        ical: {
          ...valid,
          channels: {
            'shared-feed': { role: 'reference' },
            shared_feed: { role: 'reference' },
          },
        },
      })
    );
    expect(collision).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('shared_feed') },
    });
  });

  it('registers every restored connector with a loadable factory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'connector-factory-'));
    roots.push(root);
    const paths = {
      kagemushaDbPath: join(root, 'kagemusha.db'),
      connectorStatePath: join(root, 'connector-state.json'),
      imessageDbPath: join(root, 'chat.db'),
      claudeCodeProjectsPath: join(root, 'projects'),
    };
    for (const name of [
      'gmail',
      'drive',
      'sheets',
      'notion',
      'obsidian',
      'discord',
      'telegram',
      'imessage',
      'claude-code',
    ]) {
      expect(LOADABLE_CONNECTORS).toContain(name);
      const connector = await loadConnector(
        name,
        {
          enabled: false,
          pollIntervalMinutes: 5,
          channels: {},
          auth: { type: 'none' },
        },
        paths
      );
      expect(connector.name).toBe(name);
    }
  });

  it.each([false, true])(
    'loads calendar CLI auth without ignoring or enabling it (%s)',
    (enabled) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const calendar = {
        enabled,
        pollIntervalMinutes: 5,
        channels: { calendar: { role: 'reference' } },
        auth: { type: 'cli', cli: 'gws', cliAuthCommand: 'gws auth login' },
      };
      const result = loadConnectorConfig(writeConfig({ calendar }));
      expect(result).toEqual({
        ok: true,
        config: { calendar },
        enabledNames: enabled ? ['calendar'] : [],
      });
      expect(warn).not.toHaveBeenCalled();
    }
  );

  it('normalizes connector names and returns only enabled names', () => {
    const result = loadConnectorConfig(
      writeConfig({ Slack: valid, Trello: { ...valid, enabled: false } })
    );
    expect(result).toMatchObject({ ok: true, enabledNames: ['slack'] });
    expect(result.ok && result.config.slack?.channels['channel-key']?.name).toBe('display-name');
  });

  it('loads every restored source connector and its channel-specific settings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const names = [
      'gmail',
      'drive',
      'sheets',
      'notion',
      'obsidian',
      'discord',
      'telegram',
      'imessage',
      'claude-code',
    ];
    const config = Object.fromEntries(
      names.map((name) => [
        name,
        {
          ...valid,
          auth:
            name === 'gmail' || name === 'drive' || name === 'sheets'
              ? { type: 'cli', cli: 'gws', cliAuthCommand: 'gws auth login' }
              : name === 'obsidian' || name === 'imessage' || name === 'claude-code'
                ? { type: 'none' }
                : {
                    type: 'token',
                    tokenName: `MAMA_${name.toUpperCase().replace('-', '_')}_TOKEN`,
                  },
          channels: {
            source: {
              role: 'reference',
              ...(name === 'drive' ? { folderId: 'folder-fixture', driveId: 'drive-fixture' } : {}),
              ...(name === 'sheets'
                ? {
                    spreadsheetId: 'spreadsheet-fixture',
                    sheetRange: 'Notes!A:Z',
                    dataRange: 'Notes!A2:Z',
                  }
                : {}),
              ...(name === 'obsidian' ? { vaultPath: '/tmp/vault-fixture' } : {}),
            },
          },
        },
      ])
    );

    const result = loadConnectorConfig(writeConfig(config));
    expect(result.ok).toBe(true);
    expect(result.ok && result.enabledNames).toEqual(names);
    expect(result.ok && result.config.drive?.channels.source).toMatchObject({
      folderId: 'folder-fixture',
      driveId: 'drive-fixture',
    });
    expect(result.ok && result.config.sheets?.channels.source).toMatchObject({
      spreadsheetId: 'spreadsheet-fixture',
      sheetRange: 'Notes!A:Z',
      dataRange: 'Notes!A2:Z',
    });
    expect(result.ok && result.config.obsidian?.channels.source?.vaultPath).toBe(
      '/tmp/vault-fixture'
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats a missing file as an empty successful configuration', () => {
    const root = mkdtempSync(join(tmpdir(), 'connector-config-missing-'));
    roots.push(root);
    const result = loadConnectorConfig(join(root, 'missing.json'));
    expect(result).toMatchObject({ ok: true, config: {}, enabledNames: [] });
  });

  it('fails closed without echoing auth values', () => {
    const path = writeConfig({ trello: { ...valid, auth: { type: 'token', tokenName: 7 } } });
    const result = loadConnectorConfig(path);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
  });
});
