import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConnectorConfig } from '../../src/connectors/config-loader.js';

const connectorMocks = vi.hoisted(() => ({
  loadedNames: [] as string[],
  active: new Map<string, object>(),
  channelConfigs: undefined as Record<string, Record<string, unknown>> | undefined,
}));

vi.mock('../../src/connectors/framework/index.js', () => ({
  ConnectorRegistry: class {
    register(name: string, connector: object): void {
      connectorMocks.active.set(name, connector);
    }

    getActive(): Map<string, object> {
      return connectorMocks.active;
    }
  },
  PollingScheduler: class {
    startBatch(_registry: unknown, channelConfigs: Record<string, Record<string, unknown>>): void {
      connectorMocks.channelConfigs = channelConfigs;
    }
    stop(): void {}
  },
  RawStore: class {},
}));

vi.mock('../../src/connectors/index.js', () => ({
  loadConnector: async (name: string) => {
    connectorMocks.loadedNames.push(name);
    return {
      init: async () => {},
    };
  },
}));

vi.mock('../../src/memory/history-extractor.js', () => ({
  buildProjectTruth: () => ({ projects: {} }),
  groupByChannel: () => new Map(),
  buildEntityObservations: () => [],
}));

vi.mock('../../src/memory/raw-backed-memory-ingest.js', () => ({
  ingestRawBackedMemoryCandidates: async () => ({ saved: 0, skippedExisting: 0 }),
}));

vi.mock('@jungjaehoon/mama-core', () => ({
  MODEL_NAME: 'test-model',
  getAdapter: undefined,
  upsertConnectorEventIndex: undefined,
  upsertEntityObservations: undefined,
}));

vi.mock('@jungjaehoon/mama-core/debug-logger', () => ({
  DebugLogger: class {
    debug(): void {}
  },
}));

function validConnector(enabled = true): Record<string, unknown> {
  return {
    enabled,
    pollIntervalMinutes: 5,
    channels: {
      product: {
        role: 'truth',
        name: 'Product',
        keywords: ['roadmap'],
        spreadsheetId: 'sheet-id',
        sheetRange: 'Sheet1!A1:Z1',
        dataRange: 'Sheet1!A2:Z',
        boardId: 'board-id',
        folderId: 'folder-id',
        driveId: 'drive-id',
        vaultPath: '/vault',
        watchPatterns: ['**/*.md'],
        project_entity_id: 'project-entity',
      },
    },
    auth: {
      type: 'token',
      cli: 'trello-cli',
      cliAuthCommand: 'trello-cli auth',
      tokenName: 'TRELLO_TOKEN',
      token: 'api-key:secret-token',
    },
  };
}

describe('Story M1R Task 4: strict connector configuration loader', () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-connector-config-'));
    configPath = join(tempDir, 'connectors.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeConfig(value: unknown): void {
    writeFileSync(configPath, JSON.stringify(value), 'utf8');
  }

  it('loads an enabled Trello connector and all supported optional fields', () => {
    writeConfig({ Trello: validConnector(true) });

    const result = loadConnectorConfig(configPath);

    expect(result.ok).toBe(true);
    expect(result.config).toEqual({ trello: validConnector(true) });
    expect(result.enabledNames).toEqual(['trello']);
  });

  it('loads a disabled Trello connector without enabling it', () => {
    writeConfig({ TRELLO: validConnector(false) });

    const result = loadConnectorConfig(configPath);

    expect(result.ok).toBe(true);
    expect(result.config.trello?.enabled).toBe(false);
    expect(result.enabledNames).toEqual([]);
  });

  it('accepts deployed legacy metadata while returning only the supported shape', () => {
    const connector = validConnector();
    connector.historicalBackfill = true;
    connector.auth = {
      ...(connector.auth as Record<string, unknown>),
      envFile: '/ignored/auth.env',
      apiKeyName: 'IGNORED_API_KEY',
    };
    connector.channels = {
      product: {
        role: 'truth',
        boardId: 'board-id',
        kagemusha_room_id: 'legacy-room',
        trello_last_activity: 'legacy-cursor',
        trello_matched_kanban_lists: ['legacy-list'],
      },
    };
    writeConfig({ trello: connector });

    const result = loadConnectorConfig(configPath);

    expect(result.ok).toBe(true);
    expect(result.config.trello).toEqual({
      enabled: true,
      pollIntervalMinutes: 5,
      channels: { product: { role: 'truth', boardId: 'board-id' } },
      auth: {
        type: 'token',
        cli: 'trello-cli',
        cliAuthCommand: 'trello-cli auth',
        tokenName: 'TRELLO_TOKEN',
        token: 'api-key:secret-token',
      },
    });
  });

  it('treats a missing file as a successful empty configuration', () => {
    const result = loadConnectorConfig(configPath);

    expect(result).toMatchObject({ ok: true, config: {}, enabledNames: [] });
  });

  it('uses ~/.mama/connectors.json by default', () => {
    const previousHome = process.env.HOME;
    process.env.HOME = tempDir;
    mkdirSync(join(tempDir, '.mama'));
    writeFileSync(
      join(tempDir, '.mama', 'connectors.json'),
      JSON.stringify({ Trello: validConnector(true) }),
      'utf8'
    );
    try {
      expect(loadConnectorConfig()).toMatchObject({ ok: true, enabledNames: ['trello'] });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  it('returns a typed parse failure with empty fail-closed outputs', () => {
    writeFileSync(configPath, '{"trello":', 'utf8');

    const result = loadConnectorConfig(configPath);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'parse_error', path: configPath },
      config: {},
      enabledNames: [],
    });
  });

  it('returns a typed read failure for errors other than a missing file', () => {
    mkdirSync(configPath);

    const result = loadConnectorConfig(configPath);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'read_error', path: configPath },
      config: {},
      enabledNames: [],
    });
  });

  it('loads a regular symlink but rejects a dangling symlink as a read error', () => {
    const targetPath = join(tempDir, 'target.json');
    const linkPath = join(tempDir, 'link.json');
    writeFileSync(targetPath, JSON.stringify({ trello: validConnector() }), 'utf8');
    symlinkSync(targetPath, linkPath);

    expect(loadConnectorConfig(linkPath)).toMatchObject({ ok: true, enabledNames: ['trello'] });

    rmSync(targetPath);
    const dangling = loadConnectorConfig(linkPath);
    expect(dangling).toMatchObject({
      ok: false,
      error: { code: 'read_error' },
      config: {},
      enabledNames: [],
    });
  });

  it('returns a typed read failure for an unreadable file', () => {
    writeConfig({ trello: validConnector() });
    chmodSync(configPath, 0o000);
    try {
      const result = loadConnectorConfig(configPath);
      expect(result).toMatchObject({ ok: false, error: { code: 'read_error' } });
    } finally {
      chmodSync(configPath, 0o600);
    }
  });

  it.each([
    ['null root', null, 'connectors'],
    ['array root', [], 'connectors'],
    ['null connector', { trello: null }, 'connectors[0]'],
    ['array connector', { trello: [] }, 'connectors[0]'],
    ['missing enabled', { trello: { ...validConnector(), enabled: undefined } }, 'enabled'],
    ['non-boolean enabled', { trello: { ...validConnector(), enabled: 'yes' } }, 'enabled'],
    [
      'missing interval',
      { trello: { ...validConnector(), pollIntervalMinutes: undefined } },
      'pollIntervalMinutes',
    ],
    [
      'zero interval',
      { trello: { ...validConnector(), pollIntervalMinutes: 0 } },
      'pollIntervalMinutes',
    ],
    [
      'negative interval',
      { trello: { ...validConnector(), pollIntervalMinutes: -1 } },
      'pollIntervalMinutes',
    ],
    [
      'infinite interval',
      { trello: { ...validConnector(), pollIntervalMinutes: Infinity } },
      'pollIntervalMinutes',
    ],
    ['array channels', { trello: { ...validConnector(), channels: [] } }, 'channels'],
    [
      'null channel',
      { trello: { ...validConnector(), channels: { product: null } } },
      'channels[0]',
    ],
    [
      'invalid role',
      { trello: { ...validConnector(), channels: { product: { role: 'owner' } } } },
      'role',
    ],
    [
      'missing role',
      { trello: { ...validConnector(), channels: { product: { name: 'Product' } } } },
      'role',
    ],
    [
      'non-string channel field',
      {
        trello: {
          ...validConnector(),
          channels: { product: { role: 'truth', boardId: 42 } },
        },
      },
      'boardId',
    ],
    [
      'non-array keywords',
      {
        trello: {
          ...validConnector(),
          channels: { product: { role: 'truth', keywords: 'roadmap' } },
        },
      },
      'keywords',
    ],
    [
      'non-string watch pattern',
      {
        trello: {
          ...validConnector(),
          channels: { product: { role: 'truth', watchPatterns: ['*.md', 7] } },
        },
      },
      'watchPatterns',
    ],
    [
      'invalid project entity id',
      {
        trello: {
          ...validConnector(),
          channels: { product: { role: 'truth', project_entity_id: false } },
        },
      },
      'project_entity_id',
    ],
    ['array auth', { trello: { ...validConnector(), auth: [] } }, 'auth'],
    [
      'invalid auth type',
      { trello: { ...validConnector(), auth: { type: 'oauth' } } },
      'auth.type',
    ],
    [
      'non-string auth field',
      { trello: { ...validConnector(), auth: { type: 'token', tokenName: false } } },
      'tokenName',
    ],
  ])('rejects %s', (_label, value, errorField) => {
    writeConfig(value);

    const result = loadConnectorConfig(configPath);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('validation_error');
      expect(result.error.message).toContain(errorField);
      expect(result.config).toEqual({});
      expect(result.enabledNames).toEqual([]);
    }
  });

  it.each([
    'name',
    'spreadsheetId',
    'sheetRange',
    'dataRange',
    'boardId',
    'folderId',
    'driveId',
    'vaultPath',
  ])('rejects a non-string channel %s', (field) => {
    writeConfig({
      trello: {
        ...validConnector(),
        channels: { product: { role: 'truth', [field]: false } },
      },
    });

    const result = loadConnectorConfig(configPath);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain(field);
    }
  });

  it.each(['keywords', 'watchPatterns'])('rejects a malformed channel %s array', (field) => {
    writeConfig({
      trello: {
        ...validConnector(),
        channels: { product: { role: 'truth', [field]: ['valid', false] } },
      },
    });

    const result = loadConnectorConfig(configPath);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain(field);
    }
  });

  it('accepts an explicit null project_entity_id', () => {
    const connector = validConnector();
    connector.channels = { product: { role: 'truth', project_entity_id: null } };
    writeConfig({ trello: connector });

    const result = loadConnectorConfig(configPath);

    expect(result.ok).toBe(true);
    expect(result.config.trello?.channels.product?.project_entity_id).toBeNull();
  });

  it.each(['cli', 'cliAuthCommand', 'tokenName', 'token'])(
    'rejects a non-string auth %s',
    (field) => {
      writeConfig({
        trello: {
          ...validConnector(),
          auth: { type: 'token', [field]: false },
        },
      });

      const result = loadConnectorConfig(configPath);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain(field);
      }
    }
  );

  it('does not expose auth secrets in validation errors', () => {
    const secret = 'api-key:super-secret-token';
    writeConfig({
      trello: {
        ...validConnector(),
        channels: [],
        auth: { type: 'token', token: secret },
      },
    });

    const result = loadConnectorConfig(configPath);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('normalizes connector keys to lowercase and rejects collisions', () => {
    writeConfig({ Trello: validConnector(), Slack: validConnector(false) });
    expect(loadConnectorConfig(configPath)).toMatchObject({
      ok: true,
      enabledNames: ['trello'],
    });

    writeConfig({ Trello: validConnector(), trello: validConnector(false) });
    const collision = loadConnectorConfig(configPath);
    expect(collision.ok).toBe(false);
    if (!collision.ok) {
      expect(collision.error).toMatchObject({ code: 'validation_error' });
      expect(collision.error.message).toMatch(/collision/i);
    }
  });

  it('keeps special record keys as data without changing object prototypes', () => {
    writeFileSync(
      configPath,
      JSON.stringify({ safe: validConnector() }).replace('safe', '__proto__')
    );

    const result = loadConnectorConfig(configPath);

    expect(result.ok).toBe(true);
    expect(Object.getPrototypeOf(result.config)).toBeNull();
    expect(Object.keys(result.config)).toEqual(['__proto__']);
    expect(result.enabledNames).toEqual(['__proto__']);
  });

  it('returns an immutable enabled-name boundary and fresh results', () => {
    writeConfig({ Trello: validConnector() });
    const first = loadConnectorConfig(configPath);
    expect(first.ok).toBe(true);
    expect(Object.isFrozen(first.enabledNames)).toBe(true);
    expect(() => (first.enabledNames as string[]).push('slack')).toThrow();

    if (first.ok) {
      first.config.trello!.enabled = false;
    }
    const second = loadConnectorConfig(configPath);
    expect(second.enabledNames).toEqual(['trello']);
    expect(second.config.trello?.enabled).toBe(true);
  });

  it('returns frozen null-prototype empty configs for missing files and failures', () => {
    const missing = loadConnectorConfig(configPath);
    expect(Object.isFrozen(missing.config)).toBe(true);
    expect(Object.getPrototypeOf(missing.config)).toBeNull();

    writeFileSync(configPath, '{', 'utf8');
    const failed = loadConnectorConfig(configPath);
    expect(failed.ok).toBe(false);
    expect(Object.isFrozen(failed.config)).toBe(true);
    expect(Object.getPrototypeOf(failed.config)).toBeNull();
  });

  it('never includes raw connector or channel keys in validation errors', () => {
    const connectorKey = 'connector\n\u001b[31m-secret';
    const channelKey = 'channel\r\u001b[2J-secret';
    writeConfig({
      [connectorKey]: {
        ...validConnector(),
        channels: { [channelKey]: { role: 'invalid' } },
      },
    });

    const result = loadConnectorConfig(configPath);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toContain(connectorKey);
      expect(result.error.message).not.toContain(channelKey);
      expect(result.error.message).not.toContain('\u001b');
      expect(result.error.message).not.toContain('\n');
      expect(result.error.message.length).toBeLessThan(160);
    }
  });
});

describe('Story M1R Task 4: connector initialization uses the strict loader', () => {
  let tempHome: string;
  let previousHome: string | undefined;
  let previousPollMinutes: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    previousPollMinutes = process.env.MAMA_CONNECTOR_POLL_MINUTES;
    tempHome = mkdtempSync(join(tmpdir(), 'mama-connector-init-'));
    process.env.HOME = tempHome;
    delete process.env.MAMA_CONNECTOR_POLL_MINUTES;
    mkdirSync(join(tempHome, '.mama'));
    connectorMocks.loadedNames.length = 0;
    connectorMocks.active.clear();
    connectorMocks.channelConfigs = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousPollMinutes === undefined) {
      delete process.env.MAMA_CONNECTOR_POLL_MINUTES;
    } else {
      process.env.MAMA_CONNECTOR_POLL_MINUTES = previousPollMinutes;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('auto-enables only claude-code when the connector file is missing', async () => {
    const { initConnectors } = await import('../../src/cli/runtime/connector-init.js');

    const result = await initConnectors(null);

    expect(connectorMocks.loadedNames).toEqual(['claude-code']);
    expect(result.enabledConnectorNames).toEqual(['claude-code']);
    result.connectorSchedulerStop?.();
  });

  it('logs malformed JSON and auto-enables only claude-code', async () => {
    writeFileSync(join(tempHome, '.mama', 'connectors.json'), '{', 'utf8');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { initConnectors } = await import('../../src/cli/runtime/connector-init.js');

    const result = await initConnectors(null);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/failed to load connector configuration.*parse_error/i)
    );
    expect(connectorMocks.loadedNames).toEqual(['claude-code']);
    expect(result.enabledConnectorNames).toEqual(['claude-code']);
    result.connectorSchedulerStop?.();
  });

  it('logs a sanitized explicit error and initializes only auto-enabled claude-code on failure', async () => {
    const secret = 'api-key:must-not-leak';
    writeFileSync(
      join(tempHome, '.mama', 'connectors.json'),
      JSON.stringify({
        trello: {
          ...validConnector(),
          channels: [],
          auth: { type: 'token', token: secret },
        },
      }),
      'utf8'
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { initConnectors } = await import('../../src/cli/runtime/connector-init.js');

    const result = await initConnectors(null);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/failed to load connector configuration.*validation_error/i)
    );
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(secret);
    expect(connectorMocks.loadedNames).toEqual(['claude-code']);
    expect(result.enabledConnectorNames).toEqual(['claude-code']);
    result.connectorSchedulerStop?.();
  });

  it('registers enabled normalized connectors and skips disabled connectors', async () => {
    writeFileSync(
      join(tempHome, '.mama', 'connectors.json'),
      JSON.stringify({ Trello: validConnector(true), Slack: validConnector(false) }),
      'utf8'
    );
    const { initConnectors } = await import('../../src/cli/runtime/connector-init.js');

    const result = await initConnectors(null);

    expect(connectorMocks.loadedNames).toEqual(['trello', 'claude-code']);
    expect(result.enabledConnectorNames).toEqual(['trello', 'claude-code']);
    result.connectorSchedulerStop?.();
  });

  it('uses prototype-safe per-source maps for special kagemusha channel keys', async () => {
    const pollutionKey = '__proto__:probe';
    const config = validConnector(true);
    config.channels = { safe: { role: 'hub' } };
    writeFileSync(
      join(tempHome, '.mama', 'connectors.json'),
      JSON.stringify({ kagemusha: config }).replace('safe', pollutionKey),
      'utf8'
    );
    const { initConnectors } = await import('../../src/cli/runtime/connector-init.js');
    let pollutedDuringInit = false;
    let stop: (() => void) | undefined;

    try {
      const result = await initConnectors(null);
      stop = result.connectorSchedulerStop;
      pollutedDuringInit = Object.prototype.hasOwnProperty.call(Object.prototype, pollutionKey);
      expect(Object.getPrototypeOf(connectorMocks.channelConfigs)).toBeNull();
      const protoSource = connectorMocks.channelConfigs?.['__proto__'];
      expect(Object.getPrototypeOf(protoSource)).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(protoSource, pollutionKey)).toBe(true);
      expect(pollutedDuringInit).toBe(false);
    } finally {
      delete (Object.prototype as Record<string, unknown>)[pollutionKey];
      stop?.();
    }
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, pollutionKey)).toBe(false);
  });
});
