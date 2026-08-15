import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MAMAConfig } from '../../../src/cli/config/types.js';

const networkClients = vi.hoisted(() => ({
  discordLogin: vi.fn().mockResolvedValue('synthetic-token'),
  discordDestroy: vi.fn().mockResolvedValue(undefined),
  slackAuthTest: vi.fn().mockResolvedValue({ team_id: 'workspace-synthetic' }),
  slackStart: vi.fn().mockResolvedValue(undefined),
  slackDisconnect: vi.fn().mockResolvedValue(undefined),
  telegramInit: vi.fn().mockResolvedValue(undefined),
  telegramStart: vi.fn(),
  telegramStop: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('discord.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    user: { id: 'bot-user', tag: 'MAMA#0001', username: 'MAMA' },
    login: networkClients.discordLogin,
    destroy: networkClients.discordDestroy,
    once: vi.fn(),
    on: vi.fn(),
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

vi.mock('@slack/socket-mode', () => ({
  SocketModeClient: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    start: networkClients.slackStart,
    disconnect: networkClients.slackDisconnect,
  })),
}));

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    auth: { test: networkClients.slackAuthTest },
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true }),
      update: vi.fn().mockResolvedValue({ ok: true }),
      delete: vi.fn().mockResolvedValue({ ok: true }),
    },
  })),
}));

vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    catch: vi.fn(),
    init: networkClients.telegramInit,
    start: networkClients.telegramStart,
    stop: networkClients.telegramStop,
    botInfo: { id: 123, username: 'test_bot' },
    api: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      sendPhoto: vi.fn().mockResolvedValue(undefined),
      sendDocument: vi.fn().mockResolvedValue(undefined),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendSticker: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      getStickerSet: vi.fn().mockResolvedValue({ stickers: [] }),
    },
  })),
  InputFile: vi.fn().mockImplementation((path: string) => ({ path })),
}));

import { NodeSQLiteAdapter } from '../../../../mama-core/src/db-adapter/node-sqlite-adapter.js';
import type { DatabaseAdapter as CoreDatabaseAdapter } from '../../../../mama-core/src/db-manager.js';
import { createPrincipalRepository } from '../../../../mama-core/src/identity/principal-repository.js';
import { applyMigrationsThrough } from '../../../../mama-core/src/test-utils.js';
import { initGateways, type GatewayInitResult } from '../../../src/cli/runtime/gateway-init.js';
import { resetRoleManager } from '../../../src/agent/role-manager.js';
import { DiscordGateway, SlackGateway, TelegramGateway } from '../../../src/gateways/index.js';

describe('Principal registry startup wiring', () => {
  const config = {
    discord: { enabled: true, token: 'discord-token-synthetic' },
    slack: {
      enabled: true,
      bot_token: 'slack-bot-token-synthetic',
      app_token: 'slack-app-token-synthetic',
    },
    telegram: { enabled: true, token: 'telegram-token-synthetic' },
  } as unknown as MAMAConfig;
  const toolExecutor = {
    setSlackGateway: vi.fn(),
    setTelegramGateway: vi.fn(),
  };
  const agentLoop = {
    setDiscordGateway: vi.fn(),
    setTelegramGateway: vi.fn(),
  };
  let adapter: CoreDatabaseAdapter;
  let tempDir: string;
  let originalWorkspace: string | undefined;
  let originalLedgerPath: string | undefined;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-principal-registry-init-'));
    const dbPath = join(tempDir, 'core.db');
    const migrationDb = new Database(dbPath);
    migrationDb.pragma('foreign_keys = ON');
    applyMigrationsThrough(migrationDb, 64);
    migrationDb.close();

    adapter = new NodeSQLiteAdapter({ dbPath }) as unknown as CoreDatabaseAdapter;
    adapter.connect();
    originalWorkspace = process.env.MAMA_WORKSPACE;
    originalLedgerPath = process.env.MAMA_TELEGRAM_MESSAGE_LEDGER_PATH;
    process.env.MAMA_WORKSPACE = tempDir;
    process.env.MAMA_TELEGRAM_MESSAGE_LEDGER_PATH = join(tempDir, 'telegram-ledger.json');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetRoleManager();
    adapter.prepare('DELETE FROM external_identities').run();
    adapter.prepare('DELETE FROM principals').run();
  });

  afterAll(() => {
    resetRoleManager();
    adapter.disconnect();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalWorkspace === undefined) {
      delete process.env.MAMA_WORKSPACE;
    } else {
      process.env.MAMA_WORKSPACE = originalWorkspace;
    }
    if (originalLedgerPath === undefined) {
      delete process.env.MAMA_TELEGRAM_MESSAGE_LEDGER_PATH;
    } else {
      process.env.MAMA_TELEGRAM_MESSAGE_LEDGER_PATH = originalLedgerPath;
    }
  });

  async function stopGateways(result: GatewayInitResult): Promise<void> {
    await Promise.all(result.gateways.map((gateway) => gateway.stop()));
  }

  it('constructs real gateways and injects one resolver backed by the core adapter', async () => {
    const repository = createPrincipalRepository(adapter);
    const principalId = repository.registerMember({
      connector: 'telegram',
      namespace: 'global',
      externalId: 'member-synthetic',
      now: 100,
    });
    const principalResolver = repository.resolveByExternal.bind(repository);

    expect(principalResolver('telegram', 'global', 'member-synthetic')).toEqual({
      principalId,
      kind: 'member',
      status: 'active',
    });

    const result = await initGateways(
      config,
      {} as never,
      toolExecutor as never,
      agentLoop as never,
      'codex',
      {} as never,
      principalResolver
    );

    try {
      expect(result.discordGateway).toBeInstanceOf(DiscordGateway);
      expect(result.slackGateway).toBeInstanceOf(SlackGateway);
      expect(result.telegramGateway).toBeInstanceOf(TelegramGateway);
      expect(result.discordGateway?.principalResolver).toBe(principalResolver);
      expect(result.slackGateway?.principalResolver).toBe(principalResolver);
      expect(result.telegramGateway?.principalResolver).toBe(principalResolver);
      expect(networkClients.discordLogin).toHaveBeenCalledOnce();
      expect(networkClients.slackAuthTest).toHaveBeenCalledOnce();
      expect(networkClients.slackStart).toHaveBeenCalledOnce();
      expect(networkClients.telegramInit).toHaveBeenCalledOnce();
      expect(networkClients.telegramStart).toHaveBeenCalledOnce();
    } finally {
      await stopGateways(result);
    }
  });

  it('keeps Phase 1 real-gateway initialization unchanged without a resolver', async () => {
    const result = await initGateways(
      config,
      {} as never,
      toolExecutor as never,
      agentLoop as never,
      'codex',
      {} as never
    );

    try {
      expect(result.discordGateway).toBeInstanceOf(DiscordGateway);
      expect(result.slackGateway).toBeInstanceOf(SlackGateway);
      expect(result.telegramGateway).toBeInstanceOf(TelegramGateway);
      expect(result.discordGateway?.principalResolver).toBeUndefined();
      expect(result.slackGateway?.principalResolver).toBeUndefined();
      expect(result.telegramGateway?.principalResolver).toBeUndefined();
    } finally {
      await stopGateways(result);
    }
  });
});
