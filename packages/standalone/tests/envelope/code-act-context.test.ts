import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostBridge } from '../../src/agent/code-act/host-bridge.js';
import { CodeActSandbox } from '../../src/agent/code-act/sandbox.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type {
  AgentLoopOptions,
  GatewayToolExecutionContext,
  MAMAApiInterface,
} from '../../src/agent/types.js';
import {
  createContextCompileService,
  type ContextCompileServiceAdapter,
} from '../../src/agent/context-compile-service.js';
import { getContextPacket, upsertConnectorEventIndex } from '../../../mama-core/src/index.js';
import { getAdapter } from '../../../mama-core/src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../../mama-core/src/test-utils.js';
import { DEFAULT_CONFIG, DEFAULT_ROLES, type MAMAConfig } from '../../src/cli/config/types.js';
import { buildRuntimeEnvelopeBootstrap } from '../../src/cli/runtime/envelope-bootstrap.js';
import { getReactiveRoutePolicy } from '../../src/envelope/reactive-config.js';
import type { NormalizedMessage } from '../../src/gateways/types.js';
import { createMockMamaApi } from '../../src/gateways/context-injector.js';
import { MessageRouter, type AgentLoopClient } from '../../src/gateways/message-router.js';
import { SessionStore } from '../../src/gateways/session-store.js';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import type { Envelope } from '../../src/envelope/types.js';
import { makeSignedEnvelope } from './fixtures.js';
import { scopeDaemonRawConnectors } from '../../src/cli/commands/start.js';

let testDbPath = '';
let previousMamaDbPath: string | undefined;

function makeExecutor(overrides?: Partial<GatewayToolExecutor>): GatewayToolExecutor {
  return {
    execute: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  } as unknown as GatewayToolExecutor;
}

describe('Story M1R: Code-Act envelope context propagation', () => {
  beforeAll(async () => {
    await CodeActSandbox.warmup();
  });

  describe('AC: forwards the active envelope context to host bridge gateway calls', () => {
    it('forwards the active envelope context to host bridge gateway calls', async () => {
      const executeFn = vi.fn().mockResolvedValue({
        success: true,
        results: [],
        count: 0,
      });
      const executionContext: GatewayToolExecutionContext = {
        agentId: 'chat_bot',
        source: 'telegram',
        channelId: 'tg:1',
        envelope: makeSignedEnvelope({
          source: 'telegram',
          channel_id: 'tg:1',
        }),
        executionSurface: 'code_act',
      };
      const bridge = new HostBridge(
        makeExecutor({ execute: executeFn }),
        undefined,
        executionContext
      );
      const sandbox = new CodeActSandbox();
      bridge.injectInto(sandbox, 1);

      const result = await sandbox.execute('mama_search({ query: "contracts" })');

      expect(result.success).toBe(true);
      expect(executeFn).toHaveBeenCalledWith(
        'mama_search',
        { query: 'contracts' },
        executionContext
      );
    });

    it('preserves a host-issued workorder attempt id in nested Code-Act gateway calls', async () => {
      const mamaApi = {
        suggest: vi.fn().mockResolvedValue({ success: true, results: [], count: 0 }),
      } as unknown as MAMAApiInterface;
      const executor = new GatewayToolExecutor({ mamaApi });
      const executeSpy = vi.spyOn(executor, 'execute');
      const executionContext: GatewayToolExecutionContext = {
        agentId: 'workorder-board',
        source: 'operator',
        channelId: 'worker:board',
        agentContext: {
          source: 'operator',
          platform: 'telegram',
          roleName: 'owner_console',
          role: DEFAULT_ROLES.definitions.owner_console,
          session: {
            sessionId: 'workorder:board:148',
            channelId: 'worker:board',
            userId: 'workorder-board',
            startedAt: new Date(),
          },
          capabilities: ['*'],
          limitations: [],
          tier: 1,
          backend: 'codex',
        },
        executionSurface: 'model_tool',
        workorderAttemptId: 148,
      };

      const result = await executor.execute(
        'code_act',
        { code: `mama_search({ query: 'contracts' })` },
        executionContext
      );

      expect(result.success).toBe(true);
      const innerCall = executeSpy.mock.calls.find(([toolName]) => toolName === 'mama_search');
      expect(innerCall?.[2]?.executionSurface).toBe('code_act');
      expect(innerCall?.[2]?.parentToolName).toBe('code_act');
      expect(innerCall?.[2]?.workorderAttemptId).toBe(148);
    });
  });
});

interface ObservedAdapter {
  adapter: ContextCompileServiceAdapter;
  rawQueryCount(): number;
}

function observeRawQueries(options: { throwOnRawQuery?: boolean } = {}): ObservedAdapter {
  const base = getAdapter();
  let rawQueries = 0;
  return {
    adapter: {
      prepare(sql) {
        if (/FROM\s+connector_event_index\s+WHERE/i.test(sql)) {
          rawQueries += 1;
          if (options.throwOnRawQuery) {
            throw new Error('synthetic Trello raw query failure');
          }
        }
        return base.prepare(sql);
      },
      transaction<T>(fn: () => T): T {
        return base.transaction(fn);
      },
    },
    rawQueryCount: () => rawQueries,
  };
}

function makeCodeActContext(
  rawConnectors: string[],
  tier: 1 | 2 | 3 = 2
): GatewayToolExecutionContext {
  return {
    agentId: 'owner_console',
    source: 'telegram',
    channelId: '7777',
    envelope: makeSignedEnvelope({
      agent_id: 'owner_console',
      source: 'telegram',
      channel_id: '7777',
      tier,
      scope: {
        project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
        raw_connectors: rawConnectors,
        memory_scopes: [{ kind: 'project', id: '/workspace/project-a' }],
        allowed_destinations: [{ kind: 'telegram', id: '7777' }],
      },
    }),
    executionSurface: 'code_act',
  };
}

function routeRawConnectors(input: {
  source?: NormalizedMessage['source'];
  channelId?: string;
  chatType?: string;
  enabledConnectorNames?: readonly string[];
  includeOwnerRole?: boolean;
}): string[] {
  const source = input.source ?? 'telegram';
  const roles =
    input.includeOwnerRole === false
      ? {
          definitions: { chat_bot: DEFAULT_ROLES.definitions.chat_bot },
          sourceMapping: DEFAULT_ROLES.sourceMapping,
        }
      : DEFAULT_ROLES;
  const config = {
    version: 1,
    workspace: { path: '/workspace/project-a' },
    telegram: { enabled: true, token: 'redacted', allowed_chats: ['7777'] },
    roles,
  } as unknown as MAMAConfig;
  return getReactiveRoutePolicy(
    {
      source,
      channelId: input.channelId ?? '7777',
      userId: `${source}:user`,
      text: 'current Trello work?',
      metadata: input.chatType ? { chatType: input.chatType } : {},
    },
    config,
    { HOME: '/tmp/home' },
    input.enabledConnectorNames ?? ['trello']
  ).rawConnectors;
}

function realCodeActHarness(input: {
  rawConnectors?: string[];
  tier?: 1 | 2 | 3;
  throwOnRawQuery?: boolean;
  executionContext?: GatewayToolExecutionContext;
}) {
  const observed = observeRawQueries({ throwOnRawQuery: input.throwOnRawQuery });
  const service = createContextCompileService({ memoryAdapter: observed.adapter });
  const compileSpy = vi.spyOn(service, 'compileAndPersistContext');
  const executor = new GatewayToolExecutor({
    contextCompileService: service,
    envelopeIssuanceMode: 'enabled',
  });
  const bridge = new HostBridge(
    executor,
    undefined,
    input.executionContext ?? makeCodeActContext(input.rawConnectors ?? [], input.tier)
  );
  const gatewayResults: unknown[] = [];
  bridge.onToolUse = (_name, _toolInput, result) => {
    if (result !== undefined) {
      gatewayResults.push(result);
    }
  };
  const sandbox = new CodeActSandbox();
  bridge.injectInto(sandbox, 2);
  return { sandbox, observed, compileSpy, gatewayResults };
}

describe('Story M1R Task 5: real Code-Act Trello context boundary', () => {
  const source = `context_compile({ task: 'current Trello work', connectors: ['trello'] })`;

  beforeAll(async () => {
    previousMamaDbPath = process.env.MAMA_DB_PATH;
    testDbPath = await initTestDB('code-act-context');
    await CodeActSandbox.warmup();
  });

  beforeEach(() => {
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM context_packets').run();
    adapter.prepare('DELETE FROM model_runs').run();
    adapter.prepare('DELETE FROM connector_event_index').run();
  });

  afterAll(async () => {
    try {
      await cleanupTestDB(testDbPath);
    } finally {
      if (previousMamaDbPath === undefined) {
        delete process.env.MAMA_DB_PATH;
      } else {
        process.env.MAMA_DB_PATH = previousMamaDbPath;
      }
    }
  });

  it('lets an allowed owner reach the real compiler/raw query and returns an empty packet', async () => {
    const harness = realCodeActHarness({
      rawConnectors: routeRawConnectors({ chatType: 'private' }),
    });

    const result = await harness.sandbox.execute(source);

    expect(result.success).toBe(true);
    expect(result.metrics.hostCallCount).toBe(1);
    expect(harness.compileSpy).toHaveBeenCalledOnce();
    expect(harness.observed.rawQueryCount()).toBeGreaterThan(0);
    expect(result.value).toMatchObject({
      packet: {
        task: 'current Trello work',
        source_refs: [],
        selected_evidence: [],
      },
    });
  });

  it('feeds the exact bootstrapped MessageRouter envelope into the real Code-Act compiler', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'mama-code-act-router-envelope-'));
    const connectorDir = join(tempHome, '.mama');
    mkdirSync(connectorDir, { recursive: true });
    writeFileSync(
      join(connectorDir, 'connectors.json'),
      JSON.stringify({
        trello: {
          enabled: true,
          pollIntervalMinutes: 15,
          channels: {},
          auth: { type: 'token', tokenName: 'TRELLO_TOKEN' },
        },
      }),
      'utf8'
    );
    const config: MAMAConfig = {
      ...DEFAULT_CONFIG,
      agent: { ...DEFAULT_CONFIG.agent },
      database: { path: ':memory:' },
      logging: { ...DEFAULT_CONFIG.logging },
      workspace: {
        path: '/workspace/project-a',
        scripts: '/workspace/project-a/scripts',
        data: '/workspace/project-a/data',
      },
      telegram: { enabled: true, token: 'redacted', allowed_chats: ['7777'] },
      roles: DEFAULT_ROLES,
    };
    const sessionsDb: SQLiteDatabase = new Database(':memory:');
    const sessionStore = new SessionStore(sessionsDb);
    let emittedEnvelope: Envelope | undefined;
    const agentLoop: AgentLoopClient = {
      async run(_prompt, options: AgentLoopOptions) {
        emittedEnvelope = options.envelope;
        return { response: 'ok' };
      },
    };

    try {
      const bootstrap = buildRuntimeEnvelopeBootstrap(sessionsDb, config, {
        HOME: tempHome,
        MAMA_ENVELOPE_ISSUANCE: 'enabled',
        MAMA_ENVELOPE_HMAC_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
        MAMA_ENVELOPE_HMAC_KEY_ID: 'router-test-key',
        MAMA_ENVELOPE_HMAC_KEY_VERSION: '1',
      });
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
        channelId: '7777',
        userId: 'telegram:owner',
        text: 'current Trello work?',
        metadata: { chatType: 'private' },
      });

      expect(emittedEnvelope?.scope.raw_connectors).toEqual(['telegram', 'kagemusha', 'trello']);
      const executionContext: GatewayToolExecutionContext = {
        agentId: emittedEnvelope!.agent_id,
        source: 'telegram',
        channelId: '7777',
        envelope: emittedEnvelope,
        executionSurface: 'code_act',
      };
      const harness = realCodeActHarness({ executionContext });

      const result = await harness.sandbox.execute(source);

      expect(executionContext.envelope).toBe(emittedEnvelope);
      expect(result.success).toBe(true);
      expect(harness.compileSpy).toHaveBeenCalledOnce();
      expect(harness.observed.rawQueryCount()).toBeGreaterThan(0);
    } finally {
      sessionStore.close();
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it.each([
    ['owner group', routeRawConnectors({ chatType: 'group' })],
    ['unverified private chat', routeRawConnectors({ channelId: '9999', chatType: 'private' })],
    ['non-Telegram private route', routeRawConnectors({ source: 'slack', chatType: 'private' })],
    ['missing owner role', routeRawConnectors({ chatType: 'private', includeOwnerRole: false })],
    [
      'disabled or missing Trello connector',
      routeRawConnectors({ chatType: 'private', enabledConnectorNames: [] }),
    ],
    [
      'internal wiki workorder',
      scopeDaemonRawConnectors(['trello', 'kagemusha'], 'workorder-wiki'),
    ],
  ])(
    'returns connector_out_of_scope before the service and raw query for %s',
    async (_label, rawConnectors) => {
      const harness = realCodeActHarness({ rawConnectors });

      const result = await harness.sandbox.execute(source);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/connector_out_of_scope.*envelope policy denied/i);
      expect(harness.gatewayResults).toContainEqual(
        expect.objectContaining({ success: false, code: 'connector_out_of_scope' })
      );
      expect(harness.compileSpy).not.toHaveBeenCalled();
      expect(harness.observed.rawQueryCount()).toBe(0);
    }
  );

  it('persists raw source-ref provenance without copying content into provenance fields', async () => {
    const adapter = getAdapter();
    const raw = upsertConnectorEventIndex(adapter, {
      source_connector: 'trello',
      source_type: 'card',
      source_id: 'card-42',
      channel: 'board-7',
      title: 'Current Trello card',
      content: 'private card content must not become provenance',
      source_timestamp_ms: Date.parse('2026-07-21T06:00:00.000Z'),
      tenant_id: 'default',
      project_id: '/workspace/project-a',
      memory_scope_kind: 'project',
      memory_scope_id: '/workspace/project-a',
    });
    const harness = realCodeActHarness({
      rawConnectors: routeRawConnectors({ chatType: 'private' }),
    });

    const result = await harness.sandbox.execute(source);

    expect(result.success).toBe(true);
    const value = result.value as {
      packet_id: string;
      packet: { source_refs: unknown[] };
    };
    const expectedRef = {
      kind: 'raw',
      connector: 'trello',
      raw_id: raw.event_index_id,
      source_id: 'card-42',
      channel_id: 'board-7',
    };
    expect(value.packet.source_refs).toContainEqual(expectedRef);
    const stored = getContextPacket(adapter, value.packet_id);
    expect(stored).toMatchObject({
      envelope_hash: expect.any(String),
      input_snapshot_ref: `context_compile:${value.packet_id}`,
      source_refs: expect.arrayContaining([expectedRef]),
    });
    expect(stored?.source_refs_json).not.toContain('private card content');
  });

  it('surfaces raw adapter failures as explicit tool failures without an empty fallback', async () => {
    const harness = realCodeActHarness({
      rawConnectors: routeRawConnectors({ chatType: 'private' }),
      throwOnRawQuery: true,
    });

    const result = await harness.sandbox.execute(source);

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('synthetic Trello raw query failure');
    expect(harness.compileSpy).toHaveBeenCalledOnce();
    expect(harness.observed.rawQueryCount()).toBe(1);
    expect(harness.gatewayResults).toContainEqual(
      expect.objectContaining({ success: false, code: 'context_compile_failed' })
    );
  });

  it('keeps context_compile available at Tier 2 and unavailable at Tier 3', () => {
    const harness = realCodeActHarness({ rawConnectors: ['trello'] });
    const bridge = new HostBridge(
      new GatewayToolExecutor({
        contextCompileService: createContextCompileService({ memoryAdapter: getAdapter() }),
      })
    );

    expect(bridge.getAvailableFunctions(2).map((tool) => tool.name)).toContain('context_compile');
    expect(bridge.getAvailableFunctions(3).map((tool) => tool.name)).not.toContain(
      'context_compile'
    );
    harness.compileSpy.mockRestore();
  });
});
