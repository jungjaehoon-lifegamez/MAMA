import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import Database, { type SQLiteDatabase } from '../../../src/sqlite.js';
import { DEFAULT_ROLES, type MAMAConfig } from '../../../src/cli/config/types.js';
import type { AgentLoopOptions } from '../../../src/agent/types.js';
import { buildAgentToolExecutionContext } from '../../../src/agent/agent-loop.js';
import { GatewayToolExecutor } from '../../../src/agent/gateway-tool-executor.js';
import { createMockMamaApi } from '../../../src/gateways/context-injector.js';
import { MessageRouter, type AgentLoopClient } from '../../../src/gateways/message-router.js';
import { SessionStore } from '../../../src/gateways/session-store.js';
import { EnvelopeStore } from '../../../src/envelope/store.js';
import type { EnvelopeAuthority } from '../../../src/envelope/authority.js';
import { buildRuntimeEnvelopeBootstrap } from '../../../src/cli/runtime/envelope-bootstrap.js';
import {
  loadConnectorConfig,
  type ConnectorConfigLoadResult,
} from '../../../src/connectors/config-loader.js';

const DISABLED_CONNECTOR_CONFIG_LOAD_RESULT: ConnectorConfigLoadResult = Object.freeze({
  ok: true,
  config: Object.freeze({}),
  enabledNames: Object.freeze([]),
});

type ParameterIsRequired<
  Params extends readonly unknown[],
  Index extends number,
> = undefined extends Params[Index] ? false : true;

function makeConfig(overrides: Partial<MAMAConfig> = {}): MAMAConfig {
  return {
    version: 1,
    agent: {
      model: 'claude-sonnet-4-6',
      timeout: 300_000,
      max_turns: 5,
      tools: { gateway: true, mcp: false },
    },
    database: { path: ':memory:' },
    logging: { level: 'info', file: '~/.mama/mama.log' },
    timeouts: {
      request_ms: 120_000,
      codex_request_ms: 120_000,
      initialize_ms: 60_000,
      session_ms: 1_800_000,
      session_cleanup_ms: 300_000,
      agent_ms: 300_000,
      ultrawork_ms: 300_000,
      workflow_step_ms: 600_000,
      workflow_max_ms: 1_800_000,
      busy_retry_ms: 5_000,
    },
    workspace: {
      path: '/workspace/project-a',
      scripts: '/workspace/project-a/scripts',
      data: '/workspace/project-a/data',
    },
    ...overrides,
  } as unknown as MAMAConfig;
}

function makeKeyEnv(mode: 'enabled' | 'required' = 'enabled'): Record<string, string> {
  return {
    MAMA_ENVELOPE_ISSUANCE: mode,
    MAMA_ENVELOPE_HMAC_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
    MAMA_ENVELOPE_HMAC_KEY_ID: 'test-key',
    MAMA_ENVELOPE_HMAC_KEY_VERSION: '3',
  };
}

function makeOwnerConfig(): MAMAConfig {
  return makeConfig({
    telegram: { enabled: true, token: 'redacted', allowed_chats: ['7777'] },
    roles: DEFAULT_ROLES,
  } as unknown as Partial<MAMAConfig>);
}

function writeConnectorConfig(
  home: string,
  input: { enabled?: boolean; malformed?: boolean; includeDrive?: boolean } = {}
): void {
  const configDir = join(home, '.mama');
  mkdirSync(configDir, { recursive: true });
  const contents = input.malformed
    ? '{"trello":{"enabled":true,"token":"must-not-leak"'
    : JSON.stringify({
        trello: {
          enabled: input.enabled ?? true,
          pollIntervalMinutes: 15,
          channels: {},
          auth: { type: 'token', tokenName: 'TRELLO_TOKEN' },
        },
        ...(input.includeDrive
          ? {
              drive: {
                enabled: true,
                pollIntervalMinutes: 15,
                channels: {
                  deliverable: {
                    role: 'deliverable',
                    folderId: 'folder-deliverable',
                    driveId: 'drive-shared',
                  },
                  reference: {
                    role: 'reference',
                    folderId: 'folder-reference',
                    driveId: 'drive-shared',
                  },
                },
                auth: { type: 'cli', cli: 'gws' },
              },
            }
          : {}),
      });
  writeFileSync(join(configDir, 'connectors.json'), contents, 'utf8');
}

function loadWrittenConnectorConfig(home: string): ConnectorConfigLoadResult {
  return loadConnectorConfig(join(home, '.mama', 'connectors.json'));
}

describe('STORY-M1R-BOOTSTRAP-1: issuance/config validation', () => {
  describe('AC: buildRuntimeEnvelopeBootstrap validates issuance mode and key material', () => {
    it('TG-01/TG-06 requires the boot-owned connector snapshot at compile time and runtime', () => {
      expectTypeOf<
        ParameterIsRequired<Parameters<typeof buildRuntimeEnvelopeBootstrap>, 3>
      >().toEqualTypeOf<true>();

      const callWithoutSnapshot = buildRuntimeEnvelopeBootstrap as unknown as (
        db: SQLiteDatabase,
        config: MAMAConfig,
        env: Record<string, string>
      ) => unknown;

      expect(() =>
        callWithoutSnapshot(new Database(':memory:'), makeConfig(), {
          MAMA_ENVELOPE_ISSUANCE: 'off',
        })
      ).toThrow(/connectorConfigLoadResult is required/);
    });

    it('defaults new local installs to enabled issuance with a generated persistent key', () => {
      const tempHome = mkdtempSync(join(tmpdir(), 'mama-envelope-autokey-home-'));
      try {
        const db: SQLiteDatabase = new Database(':memory:');
        const env = { HOME: tempHome };

        const bootstrap = buildRuntimeEnvelopeBootstrap(
          db,
          makeConfig(),
          env,
          DISABLED_CONNECTOR_CONFIG_LOAD_RESULT
        );

        expect(bootstrap.envelopeAuthority).toBeDefined();
        expect(bootstrap.envelopeConfig).toBeDefined();
        expect(bootstrap.metadata).toEqual({
          issuance: 'enabled',
          key_id: 'local-generated',
          key_version: 1,
        });
        expect(existsSync(join(tempHome, '.mama', 'envelope-key.json'))).toBe(true);
      } finally {
        rmSync(tempHome, { recursive: true, force: true });
      }
    });

    it.each(['', 'off', 'false'] as Array<string | undefined>)(
      'treats issuance mode %s as disabled without loading key material',
      (mode) => {
        const db: SQLiteDatabase = new Database(':memory:');
        const env = { MAMA_ENVELOPE_ISSUANCE: mode };

        const bootstrap = buildRuntimeEnvelopeBootstrap(
          db,
          makeConfig(),
          env,
          DISABLED_CONNECTOR_CONFIG_LOAD_RESULT
        );

        expect(bootstrap.metadata).toEqual({ issuance: 'off' });
        expect(bootstrap.envelopeAuthority).toBeUndefined();
        expect(bootstrap.envelopeConfig).toBeUndefined();
      }
    );

    it('loads enabled signing config and returns only non-secret metadata', () => {
      const db: SQLiteDatabase = new Database(':memory:');
      const env = makeKeyEnv('enabled');

      const bootstrap = buildRuntimeEnvelopeBootstrap(
        db,
        makeConfig(),
        env,
        DISABLED_CONNECTOR_CONFIG_LOAD_RESULT
      );

      expect(bootstrap.envelopeAuthority).toBeDefined();
      expect(bootstrap.envelopeConfig).toBeDefined();
      expect(bootstrap.metadata).toEqual({
        issuance: 'enabled',
        key_id: 'test-key',
        key_version: 3,
      });
      expect(JSON.stringify(bootstrap.metadata)).not.toContain(env.MAMA_ENVELOPE_HMAC_KEY_BASE64);
    });

    it('requires a valid signing key in required mode', () => {
      const db: SQLiteDatabase = new Database(':memory:');

      expect(() =>
        buildRuntimeEnvelopeBootstrap(
          db,
          makeConfig(),
          { MAMA_ENVELOPE_ISSUANCE: 'required' },
          DISABLED_CONNECTOR_CONFIG_LOAD_RESULT
        )
      ).toThrow(/MAMA_ENVELOPE_HMAC_KEY/);

      expect(() =>
        buildRuntimeEnvelopeBootstrap(
          db,
          makeConfig(),
          {
            MAMA_ENVELOPE_ISSUANCE: 'required',
            MAMA_ENVELOPE_HMAC_KEY_BASE64: 'not base64',
          },
          DISABLED_CONNECTOR_CONFIG_LOAD_RESULT
        )
      ).toThrow(/base64/i);
    });

    it('rejects invalid issuance modes', () => {
      const db: SQLiteDatabase = new Database(':memory:');

      expect(() =>
        buildRuntimeEnvelopeBootstrap(
          db,
          makeConfig(),
          { MAMA_ENVELOPE_ISSUANCE: 'sometimes' },
          DISABLED_CONNECTOR_CONFIG_LOAD_RESULT
        )
      ).toThrow(/MAMA_ENVELOPE_ISSUANCE/i);
    });
  });
});

describe('STORY-M1R-BOOTSTRAP-2: persistence/migrations', () => {
  describe('AC: EnvelopeStore can persist envelopes after bootstrap migrations', () => {
    it('applies envelope migrations before returning an authority', () => {
      const db: SQLiteDatabase = new Database(':memory:');
      const bootstrap = buildRuntimeEnvelopeBootstrap(
        db,
        makeConfig(),
        makeKeyEnv('enabled'),
        DISABLED_CONNECTOR_CONFIG_LOAD_RESULT
      );
      const envelope = bootstrap.envelopeAuthority!.buildAndPersist({
        agent_id: 'worker',
        instance_id: 'inst_bootstrap_test',
        source: 'telegram',
        channel_id: 'tg:1',
        trigger_context: { user_text: 'hello' },
        scope: {
          project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
          raw_connectors: ['telegram'],
          memory_scopes: [{ kind: 'channel', id: 'telegram:tg:1' }],
          allowed_destinations: [{ kind: 'telegram', id: 'tg:1' }],
        },
        tier: 1,
        budget: { wall_seconds: 30 },
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });

      expect(new EnvelopeStore(db).getByHash(envelope.envelope_hash)?.instance_id).toBe(
        'inst_bootstrap_test'
      );
    });
  });
});

describe('STORY-M1R-BOOTSTRAP-3: off-mode behavior', () => {
  describe('AC: MessageRouter and GatewayToolExecutor keep off-mode tool calls open', () => {
    it('keeps off-mode reactive tool calls open without legacy bypass', async () => {
      const previousBypass = process.env.MAMA_ENVELOPE_ALLOW_LEGACY_BYPASS;
      const previousHome = process.env.HOME;
      const tempHome = mkdtempSync(join(tmpdir(), 'mama-envelope-bootstrap-home-'));
      delete process.env.MAMA_ENVELOPE_ALLOW_LEGACY_BYPASS;
      process.env.HOME = tempHome;
      try {
        const db: SQLiteDatabase = new Database(':memory:');
        const sessionStore = new SessionStore(db);
        let capturedOptions: AgentLoopOptions | undefined;
        const agentLoop: AgentLoopClient = {
          async run(_prompt, options) {
            capturedOptions = options;
            return { response: 'ok' };
          },
        };
        const bootstrap = buildRuntimeEnvelopeBootstrap(
          db,
          makeConfig(),
          { MAMA_ENVELOPE_ISSUANCE: 'off' },
          DISABLED_CONNECTOR_CONFIG_LOAD_RESULT
        );
        const router = new MessageRouter(
          sessionStore,
          agentLoop,
          createMockMamaApi([]),
          {},
          bootstrap.envelopeConfig,
          bootstrap.envelopeAuthority
        );
        await router.process({
          source: 'telegram',
          channelId: 'tg:1',
          userId: 'u:1',
          text: 'read memory',
        });
        const executor = new GatewayToolExecutor({
          mamaApi: createMockMamaApi([]),
          envelopeIssuanceMode: bootstrap.metadata.issuance,
        });
        const readablePath = join(
          homedir(),
          '.mama',
          'workspace',
          'test-fixtures',
          'off-mode-read.txt'
        );
        mkdirSync(join(homedir(), '.mama', 'workspace', 'test-fixtures'), { recursive: true });
        writeFileSync(readablePath, 'off mode read fixture', 'utf-8');

        expect(capturedOptions).toBeDefined();
        const result = await executor.execute(
          'Read',
          { path: readablePath },
          buildAgentToolExecutionContext(capturedOptions) ?? undefined
        );

        expect(result).toMatchObject({ success: true });
      } finally {
        if (previousBypass === undefined) {
          delete process.env.MAMA_ENVELOPE_ALLOW_LEGACY_BYPASS;
        } else {
          process.env.MAMA_ENVELOPE_ALLOW_LEGACY_BYPASS = previousBypass;
        }
        if (previousHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = previousHome;
        }
        rmSync(tempHome, { recursive: true, force: true });
      }
    });
  });
});

describe('STORY-TG-DRIVE-PARITY: Drive destination safety', () => {
  it('TG-01/TG-05/TG-06: uses the boot-owned connector snapshot instead of reading a home config', () => {
    const connectorConfigLoadResult: ConnectorConfigLoadResult = {
      ok: true,
      config: {
        drive: {
          enabled: true,
          pollIntervalMinutes: 15,
          channels: {
            deliverable: {
              role: 'deliverable',
              folderId: 'snapshot-deliverable',
              driveId: 'snapshot-drive',
            },
          },
          auth: { type: 'cli', cli: 'gws' },
        },
      },
      enabledNames: ['drive'],
    };
    const bootstrap = buildRuntimeEnvelopeBootstrap(
      new Database(':memory:'),
      makeOwnerConfig(),
      makeKeyEnv('enabled'),
      connectorConfigLoadResult
    );

    expect(
      bootstrap.envelopeConfig!.allowedDestinationsFor({
        source: 'telegram',
        channelId: '7777',
        userId: '7777',
        text: 'upload translated images',
        metadata: { chatType: 'private' },
      })
    ).toContainEqual({ kind: 'drive', id: 'snapshot-deliverable' });
  });

  it('authorizes only configured deliverable folders, never reference folders or a drive root', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'mama-envelope-drive-home-'));
    try {
      writeConnectorConfig(tempHome, { includeDrive: true });
      const db: SQLiteDatabase = new Database(':memory:');
      const bootstrap = buildRuntimeEnvelopeBootstrap(
        db,
        makeOwnerConfig(),
        {
          ...makeKeyEnv('enabled'),
          HOME: tempHome,
        },
        loadWrittenConnectorConfig(tempHome)
      );
      const destinations = bootstrap.envelopeConfig!.allowedDestinationsFor({
        source: 'telegram',
        channelId: '7777',
        userId: '7777',
        text: 'upload translated images',
        metadata: { chatType: 'private' },
      });

      expect(destinations).toContainEqual({ kind: 'drive', id: 'folder-deliverable' });
      expect(destinations).not.toContainEqual({ kind: 'drive', id: 'folder-reference' });
      expect(destinations).not.toContainEqual({ kind: 'drive', id: 'drive-shared' });
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('STORY-M1R-BOOTSTRAP-4: concurrency/lock release', () => {
  describe('AC: SessionStore releases MessageRouter locks after envelopeAuthority failures', () => {
    it('releases the session lock when envelope creation fails after acquisition', async () => {
      const db: SQLiteDatabase = new Database(':memory:');
      const sessionStore = new SessionStore(db);
      const bootstrap = buildRuntimeEnvelopeBootstrap(
        db,
        makeConfig(),
        makeKeyEnv('enabled'),
        DISABLED_CONNECTOR_CONFIG_LOAD_RESULT
      );
      let failNextBuild = true;
      const fakeAuthority = {
        buildAndPersist(input: Parameters<EnvelopeAuthority['buildAndPersist']>[0]) {
          if (failNextBuild) {
            failNextBuild = false;
            throw new Error('synthetic envelope failure');
          }
          return bootstrap.envelopeAuthority!.buildAndPersist(input);
        },
      } as unknown as EnvelopeAuthority;
      const router = new MessageRouter(
        sessionStore,
        {
          async run() {
            return { response: 'ok' };
          },
        },
        createMockMamaApi([]),
        {},
        bootstrap.envelopeConfig,
        fakeAuthority
      );

      await expect(
        router.process({
          source: 'telegram',
          channelId: 'tg:lock-release',
          userId: 'u:1',
          text: 'hello',
        })
      ).rejects.toThrow('synthetic envelope failure');

      await expect(
        router.process({
          source: 'telegram',
          channelId: 'tg:lock-release',
          userId: 'u:1',
          text: 'hello again',
        })
      ).resolves.toMatchObject({ response: 'ok' });
    });
  });
});

describe('STORY-M1R-BOOTSTRAP-5: verified-owner connector snapshot', () => {
  it('loads active connector config synchronously and grants Trello only when enabled', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'mama-envelope-connectors-'));
    try {
      writeConnectorConfig(tempHome);
      const db: SQLiteDatabase = new Database(':memory:');
      const bootstrap = buildRuntimeEnvelopeBootstrap(
        db,
        makeOwnerConfig(),
        {
          ...makeKeyEnv('enabled'),
          HOME: tempHome,
        },
        loadWrittenConnectorConfig(tempHome)
      );

      expect(
        bootstrap.envelopeConfig?.rawConnectorsFor({
          source: 'telegram',
          channelId: '7777',
          userId: 'telegram:user',
          text: 'current Trello work?',
          metadata: { chatType: 'private' },
        })
      ).toEqual(['telegram', 'trello']);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it.each([
    ['disabled', true],
    ['missing', false],
  ])('does not grant Trello when config is %s', (_label, writeConfig) => {
    const tempHome = mkdtempSync(join(tmpdir(), 'mama-envelope-connectors-'));
    try {
      if (writeConfig) {
        writeConnectorConfig(tempHome, { enabled: false });
      }
      const bootstrap = buildRuntimeEnvelopeBootstrap(
        new Database(':memory:'),
        makeOwnerConfig(),
        {
          ...makeKeyEnv('enabled'),
          HOME: tempHome,
        },
        loadWrittenConnectorConfig(tempHome)
      );

      expect(
        bootstrap.envelopeConfig?.rawConnectorsFor({
          source: 'telegram',
          channelId: '7777',
          userId: 'telegram:user',
          text: 'current Trello work?',
          metadata: { chatType: 'private' },
        })
      ).toEqual(['telegram']);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('keeps Trello out when the supplied snapshot reports malformed config', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'mama-envelope-connectors-'));
    try {
      writeConnectorConfig(tempHome, { malformed: true });
      const bootstrap = buildRuntimeEnvelopeBootstrap(
        new Database(':memory:'),
        makeOwnerConfig(),
        {
          ...makeKeyEnv('enabled'),
          HOME: tempHome,
        },
        loadWrittenConnectorConfig(tempHome)
      );

      expect(
        bootstrap.envelopeConfig?.rawConnectorsFor({
          source: 'telegram',
          channelId: '7777',
          userId: 'telegram:user',
          text: 'current Trello work?',
          metadata: { chatType: 'private' },
        })
      ).toEqual(['telegram']);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('does not read connector config or create auth state when issuance is off', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'mama-envelope-connectors-off-'));
    try {
      writeConnectorConfig(tempHome, { malformed: true });

      const bootstrap = buildRuntimeEnvelopeBootstrap(
        new Database(':memory:'),
        makeOwnerConfig(),
        {
          MAMA_ENVELOPE_ISSUANCE: 'off',
          HOME: tempHome,
        },
        loadWrittenConnectorConfig(tempHome)
      );

      expect(bootstrap).toEqual({ metadata: { issuance: 'off' } });
      expect(existsSync(join(tempHome, '.mama', 'envelope-key.json'))).toBe(false);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
