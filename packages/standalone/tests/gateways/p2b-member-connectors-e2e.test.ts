import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { mama, upsertConnectorEventIndex } from '@jungjaehoon/mama-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildAgentToolExecutionContext } from '../../src/agent/agent-loop.js';
import { getSessionPool, SessionPool, setSessionPool } from '../../src/agent/session-pool.js';
import { createContextCompileService } from '../../src/agent/context-compile-service.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { AgentContext, AgentLoopOptions } from '../../src/agent/types.js';
import { DEFAULT_ROLES } from '../../src/cli/config/types.js';
import { createRuntimeMessageRouter } from '../../src/cli/commands/start.js';
import { ChannelHistory, setChannelHistory } from '../../src/gateways/channel-history.js';
import type { MamaApiClient } from '../../src/gateways/context-injector.js';
import { MessageRouter } from '../../src/gateways/message-router.js';
import { SessionStore } from '../../src/gateways/session-store.js';
import StandaloneDatabase from '../../src/sqlite.js';
import { makeAuthorityHarness } from '../envelope/fixtures.js';

interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: 'group' };
  from: { id: number; is_bot: false; first_name: string; username: string };
  text: string;
  entities?: Array<{ type: 'mention'; offset: number; length: number }>;
}

interface SlackEvent {
  type: 'message';
  channel: string;
  channel_type: 'channel';
  user: string;
  text: string;
  ts: string;
}

interface DiscordMessage {
  id: string;
  content: string;
  author: { id: string; bot: false; username: string; tag: string };
  guild: { id: string; name: string };
  channel: {
    id: string;
    type: number;
    name: string;
    isDMBased: () => false;
    sendTyping: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    messages: { fetch: ReturnType<typeof vi.fn> };
  };
  mentions: { has: ReturnType<typeof vi.fn> };
  attachments: Map<string, never>;
  react: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
}

const telegramSdk = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: { message: TelegramMessage }) => Promise<void> | void>(),
  api: {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    sendChatAction: vi.fn().mockResolvedValue(undefined),
    sendPhoto: vi.fn().mockResolvedValue(undefined),
    sendDocument: vi.fn().mockResolvedValue(undefined),
    sendSticker: vi.fn().mockResolvedValue(undefined),
    getFile: vi.fn(),
    getStickerSet: vi.fn().mockResolvedValue({ stickers: [] }),
  },
}));

const slackSdk = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (payload: { event: SlackEvent; ack: () => Promise<void> }) => Promise<void>
  >(),
  authTest: vi.fn().mockResolvedValue({ ok: true, team_id: 'team-p2b' }),
  socketStart: vi.fn().mockResolvedValue(undefined),
  socketDisconnect: vi.fn().mockResolvedValue(undefined),
  postMessage: vi.fn().mockResolvedValue({ ok: true, ts: 'response-ts' }),
  chatUpdate: vi.fn().mockResolvedValue({ ok: true }),
  chatDelete: vi.fn().mockResolvedValue({ ok: true }),
}));

const discordSdk = vi.hoisted(() => ({
  handlers: new Map<string, (message: DiscordMessage) => Promise<void>>(),
}));

vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(() => ({
    on: vi.fn(
      (event: string, handler: (ctx: { message: TelegramMessage }) => Promise<void> | void) => {
        telegramSdk.handlers.set(event, handler);
      }
    ),
    catch: vi.fn(),
    init: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    botInfo: { id: 123, username: 'test_bot' },
    api: telegramSdk.api,
  })),
}));

vi.mock('@slack/socket-mode', () => ({
  SocketModeClient: vi.fn().mockImplementation(() => ({
    on: vi.fn(
      (
        event: string,
        handler: (payload: { event: SlackEvent; ack: () => Promise<void> }) => Promise<void>
      ) => {
        slackSdk.handlers.set(event, handler);
      }
    ),
    start: slackSdk.socketStart,
    disconnect: slackSdk.socketDisconnect,
  })),
}));

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    auth: { test: slackSdk.authTest },
    chat: {
      postMessage: slackSdk.postMessage,
      update: slackSdk.chatUpdate,
      delete: slackSdk.chatDelete,
    },
  })),
}));

vi.mock('discord.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    user: { id: 'bot-user', tag: 'MAMA#0001', username: 'MAMA' },
    login: vi.fn().mockResolvedValue('synthetic-token'),
    destroy: vi.fn().mockResolvedValue(undefined),
    once: vi.fn(),
    on: vi.fn((event: string, handler: (message: DiscordMessage) => Promise<void>) => {
      discordSdk.handlers.set(event, handler);
    }),
    channels: { cache: new Map() },
  })),
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    DirectMessages: 4,
    MessageContent: 8,
    GuildMembers: 16,
    GuildMessageReactions: 32,
  },
  Partials: { Channel: 1 },
  Events: {
    ClientReady: 'ready',
    MessageCreate: 'messageCreate',
    ShardDisconnect: 'shardDisconnect',
    Error: 'error',
  },
  ChannelType: { DM: 1, GuildText: 0 },
  AttachmentBuilder: vi.fn(),
}));

vi.mock('../../src/gateways/attachment-utils.js', () => ({
  downloadFile: vi.fn(),
  buildContentBlocks: vi.fn().mockResolvedValue([]),
  detectImageType: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/gateways/telegram-media.js', () => ({
  downloadTelegramMedia: vi.fn(),
  pruneTelegramMediaRoot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/memory/memory-logger.js', () => ({
  getMemoryLogger: vi.fn(() => ({ logMessage: vi.fn() })),
}));

vi.mock('../../src/security/security-monitor.js', () => ({
  logSecurityEventOnly: vi.fn(),
}));

vi.mock('@jungjaehoon/mama-core/debug-logger', () => ({
  DebugLogger: class {
    debug = vi.fn();
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
}));

import { DiscordGateway } from '../../src/gateways/discord.js';
import { SlackGateway } from '../../src/gateways/slack.js';
import { TelegramGateway } from '../../src/gateways/telegram.js';
import type { AgentLoopClient } from '../../src/gateways/message-router.js';
import type { TurnProcessor } from '../../src/gateways/turn-contract.js';
import type { NormalizedMessage } from '../../src/gateways/types.js';
import { NodeSQLiteAdapter } from '../../../mama-core/src/db-adapter/node-sqlite-adapter.js';
import type { DatabaseAdapter } from '../../../mama-core/src/db-manager.js';
import {
  createPrincipalRepository,
  type PrincipalRepository,
} from '../../../mama-core/src/identity/principal-repository.js';
import { applyMigrationsThrough } from '../../../mama-core/src/test-utils.js';

type Connector = 'telegram' | 'slack' | 'discord';

const SHARED_CONNECTOR = 'board';
const SHARED_CHANNEL = 'member-visible';
const SIBLING_CHANNEL = 'owner-hidden';
const PRE_REVOKE_ASSISTANT_MARKER = 'P2B_PRE_REVOKE_ASSISTANT_MARKER';

interface BridgeOperation {
  tool: 'context_compile' | 'mama_recall';
  input: Record<string, unknown>;
}

interface ConnectorScenario {
  connector: Connector;
  namespace: string;
  channelId: string;
  deliver(
    turnProcessor: TurnProcessor,
    resolver: PrincipalResolver,
    input?: { externalId?: string; sequence?: number }
  ): Promise<void>;
}

type PrincipalResolver = (
  connector: string,
  namespace: string,
  externalId: string
) => ReturnType<PrincipalRepository['resolveByExternal']>;

function completed(): ReturnType<TurnProcessor['processTurn']> {
  return Promise.resolve({
    outcome: 'completed',
    response: 'member response',
    sessionId: 'p2b-member-session',
    injectedDecisions: [],
    duration: 1,
    provenance: { status: 'available', modelRunId: 'p2b-member-run' },
    sourceTurnId: 'p2b-member-turn',
    sourceMessageRef: 'p2b:member:turn',
  });
}

const scenarios: readonly ConnectorScenario[] = [
  {
    connector: 'telegram',
    namespace: 'global',
    channelId: '-5001',
    async deliver(turnProcessor, principalResolver, input = {}) {
      const externalId = Number(input.externalId ?? '777');
      const sequence = input.sequence ?? 1;
      const mediaRoot = mkdtempSync(join(tmpdir(), 'mama-p2b-telegram-'));
      const gateway = new TelegramGateway({
        token: 'synthetic-token',
        turnProcessor,
        principalResolver,
        config: { allowedChats: ['-5001'], ownerUserIds: ['100'] },
        mediaRoot,
        messageLedgerPath: join(mediaRoot, 'ledger.json'),
        fetchImpl: vi.fn(),
      });
      await gateway.start();
      try {
        const handler = telegramSdk.handlers.get('message');
        expect(handler).toBeTypeOf('function');
        await handler!({
          message: {
            message_id: sequence,
            date: 1_700_000_000,
            chat: { id: -5001, type: 'group' },
            from: {
              id: externalId,
              is_bot: false,
              first_name: 'Member',
              username: `member-${externalId}`,
            },
            text: '@test_bot read my scope',
            entities: [{ type: 'mention', offset: 0, length: 9 }],
          },
        });
      } finally {
        await gateway.stop();
        rmSync(mediaRoot, { recursive: true, force: true });
      }
    },
  },
  {
    connector: 'slack',
    namespace: 'team-p2b',
    channelId: 'channel-p2b',
    async deliver(turnProcessor, principalResolver, input = {}) {
      const externalId = input.externalId ?? '777';
      const sequence = input.sequence ?? 1;
      const gateway = new SlackGateway({
        botToken: 'xoxb-synthetic',
        appToken: 'xapp-synthetic',
        ownerUserId: 'owner',
        turnProcessor,
        principalResolver,
        config: { channels: { 'channel-p2b': { requireMention: false } } },
      });
      await gateway.start();
      try {
        const handler = slackSdk.handlers.get('message');
        expect(handler).toBeTypeOf('function');
        await handler!({
          event: {
            type: 'message',
            channel: 'channel-p2b',
            channel_type: 'channel',
            user: externalId,
            text: 'read my scope',
            ts: `1700000000.${String(sequence).padStart(4, '0')}`,
          },
          ack: vi.fn().mockResolvedValue(undefined),
        });
      } finally {
        await gateway.stop();
      }
    },
  },
  {
    connector: 'discord',
    namespace: 'guild-p2b',
    channelId: 'channel-p2b',
    async deliver(turnProcessor, principalResolver, input = {}) {
      const externalId = input.externalId ?? '777';
      const sequence = input.sequence ?? 1;
      new DiscordGateway({
        token: 'synthetic-token',
        ownerUserId: 'owner',
        turnProcessor,
        principalResolver,
        sessionDirectory: {
          listSessions: vi.fn().mockReturnValue([]),
          updateChannelName: vi.fn().mockReturnValue(false),
        },
        config: { guilds: { 'guild-p2b': { requireMention: false } } },
      });
      const handler = discordSdk.handlers.get('messageCreate');
      expect(handler).toBeTypeOf('function');
      await handler!({
        id: `message-p2b-${sequence}`,
        content: 'read my scope',
        author: {
          id: externalId,
          bot: false,
          username: `member-${externalId}`,
          tag: `member-${externalId}#0001`,
        },
        guild: { id: 'guild-p2b', name: 'P2b Guild' },
        channel: {
          id: 'channel-p2b',
          type: 0,
          name: 'p2b',
          isDMBased: () => false,
          sendTyping: vi.fn().mockResolvedValue(undefined),
          send: vi.fn().mockResolvedValue({ id: 'placeholder' }),
          messages: { fetch: vi.fn() },
        },
        mentions: { has: vi.fn().mockReturnValue(false) },
        attachments: new Map(),
        react: vi.fn().mockResolvedValue(undefined),
        reply: vi.fn().mockResolvedValue({ id: 'response' }),
      });
    },
  },
];

const lifecycleScenarios = scenarios.flatMap((scenario) => [
  { scenario, lifecycle: 'suspend' as const },
  { scenario, lifecycle: 'offboard' as const },
]);

const realMamaApiClient: MamaApiClient = {
  async search(query, limit) {
    const result = await mama.suggest(query, limit === undefined ? undefined : { limit });
    return (result?.results ?? []) as Awaited<ReturnType<MamaApiClient['search']>>;
  },
};

describe('Phase 2b Task 5b connector member E2E', () => {
  let adapter: DatabaseAdapter;
  let repository: PrincipalRepository;
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-p2b-connectors-'));
    const dbPath = join(tempDir, 'principals.db');
    const migrationDb = new Database(dbPath);
    migrationDb.pragma('foreign_keys = ON');
    applyMigrationsThrough(migrationDb, 65);
    migrationDb.close();
    adapter = new NodeSQLiteAdapter({ dbPath }) as unknown as DatabaseAdapter;
    adapter.connect();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getSessionPool().dispose();
    setSessionPool(new SessionPool());
    setChannelHistory(new ChannelHistory());
    telegramSdk.handlers.clear();
    slackSdk.handlers.clear();
    discordSdk.handlers.clear();
    adapter.prepare('DELETE FROM principal_scope_grants').run();
    adapter.prepare('DELETE FROM external_identities').run();
    adapter.prepare('DELETE FROM principals').run();
    repository = createPrincipalRepository(adapter);
  });

  afterAll(() => {
    getSessionPool().dispose();
    adapter.disconnect();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function ownerContext(principalId: string): AgentContext {
    return {
      source: 'telegram',
      platform: 'telegram',
      roleName: 'owner_console',
      role: DEFAULT_ROLES.definitions.owner_console,
      session: { sessionId: 'p2b-owner', startedAt: new Date(0) },
      capabilities: [],
      limitations: [],
      principalId,
    };
  }

  function buildRouterHarness(input: {
    repository: PrincipalRepository;
    configuredGrant: () => Record<string, readonly string[]>;
  }): {
    router: MessageRouter;
    sessionStore: SessionStore;
    observations: Array<{ options: AgentLoopOptions; result: unknown }>;
    grantReadCount: () => number;
    compileCount: () => number;
    setOperation: (operation: BridgeOperation) => void;
    setBeforeExecute: (hook: ((options: AgentLoopOptions) => Promise<void>) | null) => void;
  } {
    const visibilityService = createContextCompileService({
      memoryAdapter: adapter,
      channelGrant: input.configuredGrant,
    });
    let compileCalls = 0;
    const countedVisibilityService = {
      async compileAndPersistContext(
        request: Parameters<typeof visibilityService.compileAndPersistContext>[0]
      ) {
        compileCalls += 1;
        return visibilityService.compileAndPersistContext(request);
      },
    };
    const executor = new GatewayToolExecutor({
      contextCompileService: countedVisibilityService,
      channelGrantProvider: input.configuredGrant,
      envelopeIssuanceMode: 'enabled',
    });
    const observations: Array<{ options: AgentLoopOptions; result: unknown }> = [];
    let operation: BridgeOperation = {
      tool: 'context_compile',
      input: { task: 'find the phase 2b marker', connectors: [SHARED_CONNECTOR], limit: 20 },
    };
    let beforeExecute: ((options: AgentLoopOptions) => Promise<void>) | null = null;
    const agentLoopClient: AgentLoopClient = {
      childRuntimeToolCapable: false,
      async run(_prompt, options) {
        expect(options).toBeDefined();
        const executionContext = buildAgentToolExecutionContext(options);
        expect(executionContext).not.toBeNull();
        await beforeExecute?.(options!);
        const result = await executor.execute(operation.tool, operation.input, executionContext!);
        observations.push({ options: options!, result });
        const serializedResult = JSON.stringify(result);
        return {
          response: serializedResult.includes('P2B_VISIBLE_')
            ? `${PRE_REVOKE_ASSISTANT_MARKER}\n${serializedResult}`
            : serializedResult,
        };
      },
    };
    const sessionDb = new StandaloneDatabase(':memory:');
    const sessionStore = new SessionStore(sessionDb);
    const { authority } = makeAuthorityHarness(sessionDb);
    let grantReads = 0;
    const router = createRuntimeMessageRouter({
      sessionStore,
      agentLoopClient,
      mamaApiClient: realMamaApiClient,
      config: { backend: 'codex' },
      envelopeConfig: {
        projectRefsFor: () => [],
        rawConnectorsFor: () => [],
        memoryScopesFor: () => [],
        allowedDestinationsFor: (message) => [{ kind: message.source, id: message.channelId }],
        reactiveBudgetSeconds: 30,
      },
      envelopeAuthority: authority,
      memberGrantReader: {
        listActiveGrants(principalId) {
          grantReads += 1;
          return input.repository.listActiveGrants(principalId);
        },
      },
      configuredGrant: input.configuredGrant,
    });
    return {
      router,
      sessionStore,
      observations,
      grantReadCount: () => grantReads,
      compileCount: () => compileCalls,
      setOperation(nextOperation) {
        operation = nextOperation;
      },
      setBeforeExecute(hook) {
        beforeExecute = hook;
      },
    };
  }

  it.each(scenarios)(
    'TG-04 admits an active $connector member through the real SDK callback',
    async (scenario) => {
      const principalId = repository.registerMember({
        connector: scenario.connector,
        namespace: scenario.namespace,
        externalId: '777',
        now: 1,
      });
      const routed: NormalizedMessage[] = [];
      const turnProcessor: TurnProcessor = {
        processTurn: vi.fn((message) => {
          routed.push(message);
          return completed();
        }),
      };

      await scenario.deliver(turnProcessor, repository.resolveByExternal.bind(repository));

      expect(routed).toHaveLength(1);
      expect(routed[0]?.principal).toEqual({
        class: 'member',
        lane: 'public',
        canonicalId: `${scenario.connector}:${scenario.namespace}:777`,
        principalId,
        consoleEligible: false,
      });
    }
  );

  it.each(scenarios)(
    'TG-03/TG-04/TG-05 gives $connector exact shared visibility and revokes it on the next turn',
    async (scenario) => {
      repository.ensureOwner({
        connector: 'telegram',
        namespace: 'global',
        externalId: 'owner',
        now: 10,
      });
      const ownerPrincipalId = repository.resolveByExternal(
        'telegram',
        'global',
        'owner'
      )!.principalId;
      const memberPrincipalId = repository.registerMember({
        connector: scenario.connector,
        namespace: scenario.namespace,
        externalId: '777',
        now: 11,
      });
      const now = Date.now();
      upsertConnectorEventIndex(adapter, {
        source_connector: SHARED_CONNECTOR,
        source_type: 'message',
        source_id: `${scenario.connector}-visible`,
        channel: SHARED_CHANNEL,
        content: `P2B_VISIBLE_${scenario.connector}`,
        source_timestamp_ms: now,
        tenant_id: 'default',
      });
      upsertConnectorEventIndex(adapter, {
        source_connector: SHARED_CONNECTOR,
        source_type: 'message',
        source_id: `${scenario.connector}-hidden`,
        channel: SIBLING_CHANNEL,
        content: `P2B_HIDDEN_${scenario.connector}`,
        source_timestamp_ms: now + 1,
        tenant_id: 'default',
      });
      const ownerExecutor = new GatewayToolExecutor({
        envelopeIssuanceMode: 'off',
        principalRepository: repository,
      });
      ownerExecutor.setAgentContext(ownerContext(ownerPrincipalId));
      const scopeInput = {
        principal_id: memberPrincipalId,
        scope: {
          kind: 'source',
          connector: SHARED_CONNECTOR,
          channel_id: SHARED_CHANNEL,
        },
      };
      await expect(ownerExecutor.execute('member_scope_grant', scopeInput)).resolves.toMatchObject({
        success: true,
        status: 'created',
      });

      let configuredSources: Record<string, readonly string[]> = {
        [SHARED_CONNECTOR]: [SHARED_CHANNEL, SIBLING_CHANNEL],
      };
      const configuredGrant = () => configuredSources;
      const harness = buildRouterHarness({ repository, configuredGrant });
      try {
        await scenario.deliver(harness.router, repository.resolveByExternal.bind(repository));

        expect(harness.observations).toHaveLength(1);
        const granted = harness.observations[0]!;
        expect(granted.options.memberEffectiveScope?.channelGrant).toMatchObject({
          [scenario.connector]: [scenario.channelId],
          [SHARED_CONNECTOR]: [SHARED_CHANNEL],
        });
        expect(granted.options.memberEffectiveScope?.memoryScopes).toContainEqual({
          kind: 'user',
          id: memberPrincipalId,
        });
        expect(JSON.stringify(granted.result)).toContain(`P2B_VISIBLE_${scenario.connector}`);
        expect(JSON.stringify(granted.result)).not.toContain(`P2B_HIDDEN_${scenario.connector}`);
        expect(harness.grantReadCount()).toBe(1);

        await expect(
          ownerExecutor.execute('member_scope_revoke', scopeInput)
        ).resolves.toMatchObject({ success: true, status: 'revoked' });
        await scenario.deliver(harness.router, repository.resolveByExternal.bind(repository));

        expect(harness.observations).toHaveLength(2);
        const revoked = harness.observations[1]!;
        expect(revoked.options.sessionPolicyFingerprint).not.toBe(
          granted.options.sessionPolicyFingerprint
        );
        const replacementPrompt = await revoked.options.freshSessionSystemPrompt?.();
        expect(replacementPrompt).toBeDefined();
        expect(replacementPrompt).not.toContain(PRE_REVOKE_ASSISTANT_MARKER);
        expect(revoked.result).toMatchObject({ success: false, code: 'connector_out_of_scope' });
        expect(JSON.stringify(revoked.result)).not.toContain(`P2B_VISIBLE_${scenario.connector}`);
        expect(harness.grantReadCount()).toBe(2);
        expect(harness.compileCount()).toBe(1);

        await scenario.deliver(harness.router, repository.resolveByExternal.bind(repository), {
          sequence: 3,
        });
        const stableRevoked = harness.observations[2]!;
        expect(stableRevoked.options.sessionPolicyFingerprint).toBe(
          revoked.options.sessionPolicyFingerprint
        );
        expect(stableRevoked.result).toMatchObject({
          success: false,
          code: 'connector_out_of_scope',
        });
        expect(harness.grantReadCount()).toBe(3);
        expect(harness.compileCount()).toBe(1);

        await ownerExecutor.execute('member_scope_grant', scopeInput);
        await scenario.deliver(harness.router, repository.resolveByExternal.bind(repository), {
          sequence: 4,
        });
        const restored = harness.observations[3]!;
        expect(JSON.stringify(restored.result)).toContain(`P2B_VISIBLE_${scenario.connector}`);

        configuredSources = {};
        await scenario.deliver(harness.router, repository.resolveByExternal.bind(repository), {
          sequence: 5,
        });
        const connectorRemoved = harness.observations[4]!;
        expect(connectorRemoved.options.sessionPolicyFingerprint).not.toBe(
          restored.options.sessionPolicyFingerprint
        );
        expect(connectorRemoved.result).toMatchObject({
          success: false,
          code: 'connector_out_of_scope',
        });
        expect(harness.grantReadCount()).toBe(5);
        expect(harness.compileCount()).toBe(2);
      } finally {
        harness.sessionStore.close();
      }
    }
  );

  it.each(scenarios)(
    'TG-04 denies another member private scope through the $connector callback',
    async (scenario) => {
      const memberPrincipalId = repository.registerMember({
        connector: scenario.connector,
        namespace: scenario.namespace,
        externalId: '777',
        now: 20,
      });
      const otherPrincipalId = repository.registerMember({
        connector: scenario.connector,
        namespace: scenario.namespace,
        externalId: '778',
        now: 21,
      });
      const harness = buildRouterHarness({ repository, configuredGrant: () => ({}) });
      harness.setOperation({
        tool: 'mama_recall',
        input: {
          query: 'another member private evidence',
          scopes: [{ kind: 'user', id: otherPrincipalId }],
        },
      });
      try {
        await scenario.deliver(harness.router, repository.resolveByExternal.bind(repository));

        expect(harness.observations).toHaveLength(1);
        expect(harness.observations[0]?.options.memberEffectiveScope?.memoryScopes).toEqual([
          { kind: 'user', id: memberPrincipalId },
        ]);
        expect(harness.observations[0]?.result).toMatchObject({
          success: false,
          code: 'memory_scope_out_of_scope',
        });
        expect(JSON.stringify(harness.observations[0]?.result)).not.toContain(otherPrincipalId);
        expect(harness.grantReadCount()).toBe(1);
      } finally {
        harness.sessionStore.close();
      }
    }
  );

  it('TG-04 preserves connector namespaces when all upstream user IDs match', async () => {
    const principalIds = new Map<Connector, string>();
    for (const scenario of scenarios) {
      principalIds.set(
        scenario.connector,
        repository.registerMember({
          connector: scenario.connector,
          namespace: scenario.namespace,
          externalId: '777',
          now: 30 + principalIds.size,
        })
      );
    }
    const routed: NormalizedMessage[] = [];
    const turnProcessor: TurnProcessor = {
      processTurn: vi.fn((message) => {
        routed.push(message);
        return completed();
      }),
    };

    for (const [index, scenario] of scenarios.entries()) {
      await scenario.deliver(turnProcessor, repository.resolveByExternal.bind(repository), {
        sequence: 30 + index,
      });
    }

    expect(new Set(principalIds.values())).toHaveProperty('size', 3);
    expect(routed).toHaveLength(3);
    for (const message of routed) {
      expect(message.principal?.principalId).toBe(principalIds.get(message.source as Connector));
      expect(message.principal?.canonicalId).toBe(
        `${message.source}:${
          scenarios.find((scenario) => scenario.connector === message.source)!.namespace
        }:777`
      );
    }
  });

  it.each(lifecycleScenarios)(
    'TG-04 returns a $lifecycle $scenario.connector member to the current safe external behavior',
    async ({ scenario, lifecycle }) => {
      const principalId = repository.registerMember({
        connector: scenario.connector,
        namespace: scenario.namespace,
        externalId: '777',
        now: 40,
      });
      repository[lifecycle](principalId, 41);
      const harness = buildRouterHarness({ repository, configuredGrant: () => ({}) });
      try {
        await scenario.deliver(harness.router, repository.resolveByExternal.bind(repository), {
          sequence: lifecycle === 'suspend' ? 40 : 41,
        });

        expect(harness.grantReadCount()).toBe(0);
        if (scenario.connector === 'telegram') {
          expect(harness.observations).toHaveLength(1);
          expect(harness.observations[0]?.options.memberEffectiveScope).toBeUndefined();
          expect(harness.observations[0]?.options.memberScopeRequired).toBeUndefined();
        } else {
          expect(harness.observations).toEqual([]);
        }
      } finally {
        harness.sessionStore.close();
      }
    }
  );

  it('TG-03/TG-04 keeps one in-flight detached snapshot while the next turn sees revoke', async () => {
    const scenario = scenarios[0]!;
    repository.ensureOwner({
      connector: 'telegram',
      namespace: 'global',
      externalId: 'owner',
      now: 50,
    });
    const ownerPrincipalId = repository.resolveByExternal(
      'telegram',
      'global',
      'owner'
    )!.principalId;
    const memberPrincipalId = repository.registerMember({
      connector: scenario.connector,
      namespace: scenario.namespace,
      externalId: '777',
      now: 51,
    });
    upsertConnectorEventIndex(adapter, {
      source_connector: SHARED_CONNECTOR,
      source_type: 'message',
      source_id: 'inflight-visible',
      channel: SHARED_CHANNEL,
      content: 'P2B_INFLIGHT_VISIBLE',
      source_timestamp_ms: Date.now(),
      tenant_id: 'default',
    });
    const ownerExecutor = new GatewayToolExecutor({
      envelopeIssuanceMode: 'off',
      principalRepository: repository,
    });
    ownerExecutor.setAgentContext(ownerContext(ownerPrincipalId));
    const scopeInput = {
      principal_id: memberPrincipalId,
      scope: {
        kind: 'source',
        connector: SHARED_CONNECTOR,
        channel_id: SHARED_CHANNEL,
      },
    };
    await ownerExecutor.execute('member_scope_grant', scopeInput);
    const harness = buildRouterHarness({
      repository,
      configuredGrant: () => ({ [SHARED_CONNECTOR]: [SHARED_CHANNEL] }),
    });
    let releaseExecution!: () => void;
    const executionRelease = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    let markEntered!: (options: AgentLoopOptions) => void;
    const entered = new Promise<AgentLoopOptions>((resolve) => {
      markEntered = resolve;
    });
    harness.setBeforeExecute(async (options) => {
      markEntered(options);
      await executionRelease;
    });
    try {
      const inFlight = scenario.deliver(
        harness.router,
        repository.resolveByExternal.bind(repository),
        { sequence: 50 }
      );
      const inFlightOptions = await entered;
      await ownerExecutor.execute('member_scope_revoke', scopeInput);
      releaseExecution();
      await inFlight;

      expect(JSON.stringify(harness.observations[0]?.result)).toContain('P2B_INFLIGHT_VISIBLE');
      expect(harness.observations[0]?.options.memberEffectiveScope).toBe(
        inFlightOptions.memberEffectiveScope
      );

      harness.setBeforeExecute(null);
      await scenario.deliver(harness.router, repository.resolveByExternal.bind(repository), {
        sequence: 51,
      });
      expect(harness.observations[1]?.options.sessionPolicyFingerprint).not.toBe(
        inFlightOptions.sessionPolicyFingerprint
      );
      expect(harness.observations[1]?.result).toMatchObject({
        success: false,
        code: 'connector_out_of_scope',
      });
      expect(harness.grantReadCount()).toBe(2);
      expect(harness.compileCount()).toBe(1);
    } finally {
      releaseExecution();
      harness.sessionStore.close();
    }
  });
});
