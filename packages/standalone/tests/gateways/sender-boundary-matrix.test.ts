import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface SyntheticTelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: 'private' | 'group' | 'supergroup'; title?: string };
  from: { id: number; is_bot: false; first_name: string; username: string };
  text?: string;
  entities?: Array<{ type: 'mention' | 'bot_command'; offset: number; length: number }>;
  document?: {
    file_id: string;
    file_unique_id: string;
    file_name: string;
    mime_type: string;
    file_size: number;
  };
}

interface SyntheticSlackEvent {
  type: string;
  subtype?: string;
  channel: string;
  channel_type: 'im' | 'mpim' | 'channel';
  user: string;
  text: string;
  ts: string;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    url_private_download: string;
    size: number;
  }>;
}

interface SyntheticDiscordMessage {
  id: string;
  content: string;
  author: { id: string; bot: boolean; username: string; tag: string };
  guild: { id: string; name: string } | null;
  channel: {
    id: string;
    type: number;
    name: string;
    isDMBased: () => boolean;
    sendTyping: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    messages: { fetch: ReturnType<typeof vi.fn> };
  };
  mentions: { has: ReturnType<typeof vi.fn> };
  attachments: Map<string, { url: string; name: string; contentType: string; size: number }>;
  react: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
}

const telegramSeams = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: { message: SyntheticTelegramMessage }) => Promise<void> | void>(),
  api: {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    sendChatAction: vi.fn().mockResolvedValue(undefined),
    sendPhoto: vi.fn().mockResolvedValue(undefined),
    sendDocument: vi.fn().mockResolvedValue(undefined),
    sendSticker: vi.fn().mockResolvedValue(undefined),
    getFile: vi.fn().mockResolvedValue({ file_path: 'matrix.txt', file_size: 12 }),
    getStickerSet: vi.fn().mockResolvedValue({ stickers: [] }),
  },
  downloadTelegramMedia: vi.fn(),
}));

const slackSeams = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (payload: { event: SyntheticSlackEvent; ack: () => Promise<void> }) => Promise<void>
  >(),
  authTest: vi.fn(),
  socketStart: vi.fn().mockResolvedValue(undefined),
  socketDisconnect: vi.fn().mockResolvedValue(undefined),
  postMessage: vi.fn().mockResolvedValue({ ok: true, ts: 'matrix-response' }),
  chatUpdate: vi.fn().mockResolvedValue({ ok: true }),
  chatDelete: vi.fn().mockResolvedValue({ ok: true }),
}));

const discordSeams = vi.hoisted(() => ({
  handlers: new Map<string, (message: SyntheticDiscordMessage) => Promise<void>>(),
}));

const attachmentSeams = vi.hoisted(() => ({
  downloadFile: vi.fn(),
  buildContentBlocks: vi.fn().mockResolvedValue([]),
  detectImageType: vi.fn().mockReturnValue(null),
}));

const sharedSeams = vi.hoisted(() => ({
  logMessage: vi.fn(),
  logSecurityEventOnly: vi.fn(),
}));

vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(() => ({
    on: vi.fn(
      (
        event: string,
        handler: (ctx: { message: SyntheticTelegramMessage }) => Promise<void> | void
      ) => {
        telegramSeams.handlers.set(event, handler);
      }
    ),
    catch: vi.fn(),
    init: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    botInfo: { id: 123, username: 'test_bot' },
    api: telegramSeams.api,
  })),
}));

vi.mock('@slack/socket-mode', () => ({
  SocketModeClient: vi.fn().mockImplementation(() => ({
    on: vi.fn(
      (
        event: string,
        handler: (payload: {
          event: SyntheticSlackEvent;
          ack: () => Promise<void>;
        }) => Promise<void>
      ) => {
        slackSeams.handlers.set(event, handler);
      }
    ),
    start: slackSeams.socketStart,
    disconnect: slackSeams.socketDisconnect,
  })),
}));

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    auth: { test: slackSeams.authTest },
    chat: {
      postMessage: slackSeams.postMessage,
      update: slackSeams.chatUpdate,
      delete: slackSeams.chatDelete,
    },
  })),
}));

vi.mock('discord.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    user: { id: 'bot-user', tag: 'MAMA#0001', username: 'MAMA' },
    login: vi.fn().mockResolvedValue('synthetic-token'),
    destroy: vi.fn().mockResolvedValue(undefined),
    once: vi.fn(),
    on: vi.fn((event: string, handler: (message: SyntheticDiscordMessage) => Promise<void>) => {
      discordSeams.handlers.set(event, handler);
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
  downloadFile: attachmentSeams.downloadFile,
  buildContentBlocks: attachmentSeams.buildContentBlocks,
  detectImageType: attachmentSeams.detectImageType,
}));

vi.mock('../../src/gateways/telegram-media.js', () => ({
  downloadTelegramMedia: telegramSeams.downloadTelegramMedia,
  pruneTelegramMediaRoot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/memory/memory-logger.js', () => ({
  getMemoryLogger: vi.fn(() => ({ logMessage: sharedSeams.logMessage })),
}));

vi.mock('../../src/security/security-monitor.js', () => ({
  logSecurityEventOnly: sharedSeams.logSecurityEventOnly,
}));

vi.mock('@jungjaehoon/mama-core/debug-logger', () => ({
  DebugLogger: class {
    debug = vi.fn();
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
}));

import Database from '../../src/sqlite.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { AgentLoopOptions } from '../../src/agent/types.js';
import { getRoleManager, resetRoleManager } from '../../src/agent/role-manager.js';
import { DEFAULT_ROLES } from '../../src/cli/config/types.js';
import { ChannelHistory, setChannelHistory } from '../../src/gateways/channel-history.js';
import { createMockMamaApi, type MamaApiClient } from '../../src/gateways/context-injector.js';
import { DiscordGateway } from '../../src/gateways/discord.js';
import { MessageRouter, PUBLIC_LANE_SYSTEM_PROMPT } from '../../src/gateways/message-router.js';
import { SessionStore } from '../../src/gateways/session-store.js';
import { SlackGateway } from '../../src/gateways/slack.js';
import { TelegramGateway } from '../../src/gateways/telegram.js';
import type { NormalizedMessage } from '../../src/gateways/types.js';

type Connector = 'telegram' | 'slack' | 'discord';
type Surface = 'dm' | 'group' | 'public-channel';
type Sender = 'owner' | 'external';

interface MatrixCell {
  connector: Connector;
  surface: Surface;
  sender: Sender;
}

interface CapturedModelCall {
  prompt: string;
  options: AgentLoopOptions;
}

interface RouterHarness {
  router: MessageRouter;
  sessionStore: SessionStore;
  modelCalls: CapturedModelCall[];
  mamaApi: ReturnType<typeof trackedMamaApi>;
  enhance: ReturnType<typeof vi.fn>;
  close: () => void;
}

interface DeliveryObservation {
  channelId: string;
  downloadCount: number;
  outboundCount: number;
  outboundTargets: string[];
  typingCount: number;
  deletionCount: number;
  reactionCount: number;
}

const connectors: Connector[] = ['telegram', 'slack', 'discord'];
const surfaces: Surface[] = ['dm', 'group', 'public-channel'];
const senders: Sender[] = ['owner', 'external'];
const matrixCells: MatrixCell[] = connectors.flatMap((connector) =>
  surfaces.flatMap((surface) => senders.map((sender) => ({ connector, surface, sender })))
);

const originalHome = process.env.HOME;
const matrixHome = mkdtempSync(join(tmpdir(), 'mama-sender-matrix-'));
const matrixMamaHome = join(matrixHome, '.mama');
const matrixAttachmentPath = join(matrixHome, 'matrix.txt');

beforeAll(() => {
  mkdirSync(join(matrixMamaHome, 'briefs'), { recursive: true });
  writeFileSync(join(matrixMamaHome, 'SOUL.md'), '# Synthetic owner persona\n', { mode: 0o600 });
  writeFileSync(matrixAttachmentPath, 'matrix file');
  process.env.HOME = matrixHome;
});

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  rmSync(matrixHome, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  telegramSeams.handlers.clear();
  slackSeams.handlers.clear();
  discordSeams.handlers.clear();
  telegramSeams.api.sendMessage.mockResolvedValue({ message_id: 1 });
  telegramSeams.downloadTelegramMedia.mockResolvedValue({
    localPath: matrixAttachmentPath,
    sourceRef: 'telegram:file:matrix',
    filename: 'matrix.txt',
    mimeType: 'text/plain',
    size: 11,
    kind: 'document',
  });
  slackSeams.authTest.mockResolvedValue({ ok: true, team_id: 'team-matrix' });
  attachmentSeams.downloadFile.mockResolvedValue(matrixAttachmentPath);
  attachmentSeams.buildContentBlocks.mockResolvedValue([]);
  setChannelHistory(new ChannelHistory());
  resetRoleManager();
  getRoleManager({ rolesConfig: DEFAULT_ROLES });
});

afterEach(() => {
  resetRoleManager();
});

function trackedMamaApi(): MamaApiClient & {
  search: ReturnType<typeof vi.fn>;
  recallMemory: ReturnType<typeof vi.fn>;
  loadCheckpoint: ReturnType<typeof vi.fn>;
  listDecisions: ReturnType<typeof vi.fn>;
} {
  const base = createMockMamaApi([]);
  return {
    ...base,
    search: vi.fn().mockResolvedValue([]),
    recallMemory: vi.fn().mockResolvedValue({
      profile: { static: [], dynamic: [], evidence: [] },
      memories: [],
      graph_context: { primary: [], expanded: [], edges: [] },
      search_meta: { query: 'matrix', scope_order: [], retrieval_sources: [] },
    }),
    loadCheckpoint: vi.fn().mockResolvedValue(null),
    listDecisions: vi.fn().mockResolvedValue([]),
  };
}

function createRouterHarness(
  run?: (
    prompt: string,
    options: AgentLoopOptions
  ) => Promise<{ response: string; modelRunId: string }>
): RouterHarness {
  const sessionStore = new SessionStore(new Database(':memory:'));
  const modelCalls: CapturedModelCall[] = [];
  const agentLoop = {
    childRuntimeToolCapable: false,
    run: vi.fn(async (prompt: string, options?: AgentLoopOptions) => {
      if (!options) throw new Error('Missing matrix agent options');
      modelCalls.push({ prompt, options });
      if (run) return run(prompt, options);
      return { response: 'matrix response', modelRunId: `matrix-run-${modelCalls.length}` };
    }),
  };
  const mamaApi = trackedMamaApi();
  const router = new MessageRouter(sessionStore, agentLoop, mamaApi, {
    backend: 'codex',
    implicitMemoryRecall: true,
    implicitLegacyContextSearch: true,
  });
  const enhance = vi.fn().mockResolvedValue({
    agentsContent: 'MATRIX OWNER AGENT CONTEXT',
    rulesContent: 'MATRIX OWNER RULE CONTEXT',
    keywordInstructions: '',
    skillContent: '',
  });
  (router as unknown as { promptEnhancer: { enhance: typeof enhance } }).promptEnhancer = {
    enhance,
  };
  return {
    router,
    sessionStore,
    modelCalls,
    mamaApi,
    enhance,
    close: () => sessionStore.close(),
  };
}

function makeTelegramMessage(
  cell: MatrixCell,
  chatId: number,
  userId: number
): SyntheticTelegramMessage {
  const isGroup = cell.surface !== 'dm';
  const mentioned = cell.sender === 'owner' || cell.surface === 'group';
  const text = mentioned && isGroup ? '@test_bot matrix request' : 'matrix request';
  return {
    message_id: Math.abs(chatId) + (cell.sender === 'owner' ? 1 : 2),
    date: 1_700_000_000,
    chat: {
      id: chatId,
      type: cell.surface === 'dm' ? 'private' : cell.surface === 'group' ? 'group' : 'supergroup',
      title: isGroup ? 'Matrix surface' : undefined,
    },
    from: {
      id: userId,
      is_bot: false,
      first_name: 'Synthetic',
      username: `synthetic-${userId}`,
    },
    text,
    entities: mentioned && isGroup ? [{ type: 'mention', offset: 0, length: 9 }] : undefined,
    document:
      cell.connector === 'telegram' && !(cell.sender === 'external' && cell.surface === 'group')
        ? {
            file_id: 'matrix-file',
            file_unique_id: 'matrix-file-unique',
            file_name: 'matrix.txt',
            mime_type: 'text/plain',
            file_size: 11,
          }
        : undefined,
  };
}

async function runTelegramCell(
  cell: MatrixCell,
  harness: RouterHarness
): Promise<DeliveryObservation> {
  const ownerUserId = 41_001;
  const chatId =
    cell.surface === 'dm'
      ? cell.sender === 'owner'
        ? ownerUserId
        : 41_002
      : cell.surface === 'group'
        ? -42_001
        : -43_001;
  const userId = cell.sender === 'owner' ? ownerUserId : 49_001;
  const mediaRoot = mkdtempSync(join(tmpdir(), 'mama-matrix-telegram-'));
  const gateway = new TelegramGateway({
    token: 'synthetic-token',
    turnProcessor: harness.router,
    config: {
      allowedChats: [String(chatId)],
      ownerUserIds:
        cell.surface === 'dm' && cell.sender === 'external' ? [] : [String(ownerUserId)],
    },
    mediaRoot,
    messageLedgerPath: join(mediaRoot, 'ledger.json'),
    fetchImpl: vi.fn(),
  });
  await gateway.start();

  try {
    const handler = telegramSeams.handlers.get('message');
    expect(handler).toBeTypeOf('function');
    await handler!({ message: makeTelegramMessage(cell, chatId, userId) });
    return {
      channelId: String(chatId),
      downloadCount: telegramSeams.downloadTelegramMedia.mock.calls.length,
      outboundCount:
        telegramSeams.api.sendMessage.mock.calls.length +
        telegramSeams.api.editMessageText.mock.calls.length +
        telegramSeams.api.sendPhoto.mock.calls.length +
        telegramSeams.api.sendDocument.mock.calls.length +
        telegramSeams.api.sendSticker.mock.calls.length,
      outboundTargets: [
        ...telegramSeams.api.sendMessage.mock.calls.map((call) => String(call[0])),
        ...telegramSeams.api.editMessageText.mock.calls.map((call) => String(call[0])),
        ...telegramSeams.api.sendPhoto.mock.calls.map((call) => String(call[0])),
        ...telegramSeams.api.sendDocument.mock.calls.map((call) => String(call[0])),
        ...telegramSeams.api.sendSticker.mock.calls.map((call) => String(call[0])),
      ],
      typingCount: telegramSeams.api.sendChatAction.mock.calls.length,
      deletionCount: telegramSeams.api.deleteMessage.mock.calls.length,
      reactionCount: 0,
    };
  } finally {
    await gateway.stop();
    rmSync(mediaRoot, { recursive: true, force: true });
  }
}

function makeSlackEvent(cell: MatrixCell): SyntheticSlackEvent {
  const channelId = `slack-${cell.surface}`;
  const isPublic = cell.surface === 'public-channel';
  return {
    type: 'message',
    subtype: cell.sender === 'external' ? 'file_share' : undefined,
    channel: channelId,
    channel_type: cell.surface === 'dm' ? 'im' : cell.surface === 'group' ? 'mpim' : 'channel',
    user: cell.sender === 'owner' ? 'slack-owner' : 'slack-external',
    text: isPublic ? '<@U123> matrix request' : 'matrix request',
    ts: `${cell.surface === 'dm' ? 5101 : cell.surface === 'group' ? 5102 : 5103}.${
      cell.sender === 'owner' ? '0001' : '0002'
    }`,
    files: [
      {
        id: 'matrix-file',
        name: 'matrix.txt',
        mimetype: 'text/plain',
        url_private_download: 'https://files.invalid/matrix.txt',
        size: 11,
      },
    ],
  };
}

async function runSlackCell(
  cell: MatrixCell,
  harness: RouterHarness
): Promise<DeliveryObservation> {
  const event = makeSlackEvent(cell);
  const gateway = new SlackGateway({
    botToken: 'xoxb-synthetic',
    appToken: 'xapp-synthetic',
    ownerUserId: 'slack-owner',
    turnProcessor: harness.router,
    config: { channels: { [event.channel]: { requireMention: false } } },
  });
  await gateway.start();

  try {
    const route =
      event.subtype === 'file_share'
        ? 'message'
        : cell.surface === 'public-channel'
          ? 'app_mention'
          : 'message';
    const handler = slackSeams.handlers.get(route);
    expect(handler).toBeTypeOf('function');
    await handler!({ event, ack: vi.fn().mockResolvedValue(undefined) });
    return {
      channelId: event.channel,
      downloadCount: attachmentSeams.downloadFile.mock.calls.length,
      outboundCount: slackSeams.postMessage.mock.calls.length,
      outboundTargets: slackSeams.postMessage.mock.calls.map((call) =>
        String((call[0] as { channel?: string }).channel)
      ),
      typingCount: 0,
      deletionCount: 0,
      reactionCount: 0,
    };
  } finally {
    await gateway.stop();
  }
}

function makeDiscordMessage(cell: MatrixCell): SyntheticDiscordMessage {
  const isDM = cell.surface === 'dm';
  const channelId = `discord-${cell.surface}`;
  return {
    id: `discord-${cell.surface}-${cell.sender}`,
    content: 'matrix request',
    author: {
      id: cell.sender === 'owner' ? 'discord-owner' : 'discord-external',
      bot: false,
      username: `synthetic-${cell.sender}`,
      tag: `synthetic-${cell.sender}#0001`,
    },
    guild: isDM ? null : { id: 'guild-matrix', name: 'Matrix Guild' },
    channel: {
      id: channelId,
      type: isDM ? 1 : 0,
      name: cell.surface,
      isDMBased: () => isDM,
      sendTyping: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue({ id: 'placeholder-message' }),
      messages: { fetch: vi.fn() },
    },
    mentions: { has: vi.fn().mockReturnValue(cell.surface === 'public-channel') },
    attachments: new Map([
      [
        'matrix-file',
        {
          url: 'https://cdn.invalid/matrix.txt',
          name: 'matrix.txt',
          contentType: 'text/plain',
          size: 11,
        },
      ],
    ]),
    react: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue({ id: 'response-message' }),
  };
}

async function runDiscordCell(
  cell: MatrixCell,
  harness: RouterHarness
): Promise<DeliveryObservation> {
  const message = makeDiscordMessage(cell);
  new DiscordGateway({
    token: 'synthetic-token',
    ownerUserId: 'discord-owner',
    turnProcessor: harness.router,
    sessionDirectory: {
      listSessions: vi.fn().mockReturnValue([]),
      updateChannelName: vi.fn().mockReturnValue(false),
    },
    config: {
      guilds: {
        'guild-matrix': {
          requireMention: cell.surface === 'public-channel',
        },
      },
    },
  });
  const handler = discordSeams.handlers.get('messageCreate');
  expect(handler).toBeTypeOf('function');
  await handler!(message);
  return {
    channelId: message.channel.id,
    downloadCount: attachmentSeams.downloadFile.mock.calls.length,
    outboundCount: message.reply.mock.calls.length + message.channel.send.mock.calls.length,
    outboundTargets: [
      ...message.reply.mock.calls.map(() => message.channel.id),
      ...message.channel.send.mock.calls.map(() => message.channel.id),
    ],
    typingCount: message.channel.sendTyping.mock.calls.length,
    deletionCount: 0,
    reactionCount: message.react.mock.calls.length,
  };
}

async function runCell(cell: MatrixCell, harness: RouterHarness): Promise<DeliveryObservation> {
  if (cell.connector === 'telegram') return runTelegramCell(cell, harness);
  if (cell.connector === 'slack') return runSlackCell(cell, harness);
  return runDiscordCell(cell, harness);
}

function publicTelegramMessage(channelId: string, text: string): NormalizedMessage {
  return {
    source: 'telegram',
    channelId,
    userId: 'public-user',
    text,
    principal: {
      class: 'external',
      lane: 'public',
      canonicalId: 'telegram:global:public-user',
      consoleEligible: false,
    },
    metadata: {
      chatType: 'group',
      historyContext: 'EXTERNAL HISTORY MUST NOT ENTER THE PROMPT',
      messageId: `public-${text}`,
    },
  };
}

function ownerTelegramMessage(channelId: string, text: string): NormalizedMessage {
  return {
    source: 'telegram',
    channelId,
    userId: 'owner-user',
    text,
    principal: {
      class: 'owner',
      lane: 'owner',
      canonicalId: 'telegram:global:owner-user',
      consoleEligible: true,
    },
    metadata: { chatType: 'private', messageId: `owner-${text}` },
  };
}

describe('Task 10: sender boundary completion matrix', () => {
  it('defines all 18 connector, surface, and sender cells', () => {
    expect(matrixCells).toHaveLength(18);
    expect(
      new Set(matrixCells.map((cell) => `${cell.connector}/${cell.surface}/${cell.sender}`))
    ).toHaveLength(18);
  });

  it.each(matrixCells)(
    'covers $connector/$surface/$sender without crossing the sender boundary',
    async (cell) => {
      const harness = createRouterHarness();
      const processTurn = vi.spyOn(harness.router, 'processTurn');
      const sessionCreation = vi.spyOn(harness.sessionStore, 'getOrCreate');
      const toolExecution = vi.spyOn(GatewayToolExecutor.prototype, 'execute');
      const historyWrite = vi.spyOn(ChannelHistory.prototype, 'record');

      try {
        const observation = await runCell(cell, harness);
        const publicGroupException =
          cell.connector === 'telegram' && cell.surface === 'group' && cell.sender === 'external';

        if (cell.sender === 'external' && !publicGroupException) {
          expect(processTurn).not.toHaveBeenCalled();
          expect(sessionCreation).not.toHaveBeenCalled();
          expect(harness.sessionStore.listSessions()).toEqual([]);
          expect(harness.modelCalls).toEqual([]);
          expect(harness.enhance).not.toHaveBeenCalled();
          expect(harness.mamaApi.search).not.toHaveBeenCalled();
          expect(harness.mamaApi.recallMemory).not.toHaveBeenCalled();
          expect(harness.mamaApi.loadCheckpoint).not.toHaveBeenCalled();
          expect(toolExecution).not.toHaveBeenCalled();
          expect(historyWrite).not.toHaveBeenCalled();
          expect(observation.downloadCount).toBe(0);
          expect(observation.outboundCount).toBe(0);
          expect(observation.typingCount).toBe(0);
          expect(observation.deletionCount).toBe(0);
          expect(observation.reactionCount).toBe(0);
          return;
        }

        expect(processTurn).toHaveBeenCalledTimes(1);
        expect(sessionCreation).toHaveBeenCalledTimes(1);
        expect(harness.sessionStore.listSessions()).toHaveLength(1);
        expect(harness.modelCalls).toHaveLength(1);
        expect(toolExecution).not.toHaveBeenCalled();
        expect(observation.outboundCount).toBeGreaterThan(0);
        expect(new Set(observation.outboundTargets)).toEqual(new Set([observation.channelId]));

        if (publicGroupException) {
          expect(harness.sessionStore.listSessions('telegram')[0]?.channelId).toBe(
            `${observation.channelId}#public`
          );
          expect(harness.modelCalls[0]?.options).toMatchObject({
            systemPrompt: PUBLIC_LANE_SYSTEM_PROMPT,
            agentContext: {
              roleName: 'public_lane',
              role: { allowedTools: [], blockedTools: expect.arrayContaining(['*']) },
            },
          });
          expect(harness.modelCalls[0]?.prompt).toBe('matrix request');
          expect(harness.enhance).not.toHaveBeenCalled();
          expect(harness.mamaApi.search).not.toHaveBeenCalled();
          expect(harness.mamaApi.recallMemory).not.toHaveBeenCalled();
          expect(harness.mamaApi.loadCheckpoint).not.toHaveBeenCalled();
          expect(observation.downloadCount).toBe(0);
          expect(new Set(historyWrite.mock.calls.map(([channelId]) => channelId))).toEqual(
            new Set([`${observation.channelId}#public`])
          );
        } else {
          expect(observation.downloadCount).toBe(1);
          expect(harness.enhance).toHaveBeenCalledTimes(1);
          expect(harness.mamaApi.recallMemory).toHaveBeenCalledTimes(1);
          expect(harness.modelCalls[0]?.options.agentContext?.role).toBeDefined();
          expect(harness.modelCalls[0]?.options.agentContext?.roleName).not.toBe('public_lane');
        }
      } finally {
        toolExecution.mockRestore();
        historyWrite.mockRestore();
        sessionCreation.mockRestore();
        processTurn.mockRestore();
        harness.close();
      }
    }
  );

  it('excludes a diverted Discord sender from the next owner prompt history', async () => {
    const harness = createRouterHarness();
    const externalCell: MatrixCell = {
      connector: 'discord',
      surface: 'public-channel',
      sender: 'external',
    };
    const ownerCell: MatrixCell = { ...externalCell, sender: 'owner' };

    try {
      const external = makeDiscordMessage(externalCell);
      external.content = 'EXTERNAL HISTORY MARKER';
      new DiscordGateway({
        token: 'synthetic-token',
        ownerUserId: 'discord-owner',
        turnProcessor: harness.router,
        config: { guilds: { 'guild-matrix': { requireMention: true } } },
      });
      await discordSeams.handlers.get('messageCreate')!(external);
      expect(harness.modelCalls).toEqual([]);

      await runDiscordCell(ownerCell, harness);
      const ownerPrompt = harness.modelCalls
        .map((call) => `${call.options.systemPrompt ?? ''}\n${call.prompt}`)
        .join('\n');
      expect(ownerPrompt).not.toContain('EXTERNAL HISTORY MARKER');
    } finally {
      harness.close();
    }
  });
});

describe('Task 10: parity regressions', () => {
  it('TG-01 preserves per-lane order and isolates owner and public Telegram session keys', async () => {
    let releaseFirstPublic!: () => void;
    const firstPublicRelease = new Promise<void>((resolve) => {
      releaseFirstPublic = resolve;
    });
    let markFirstPublicEntered!: () => void;
    const firstPublicEntered = new Promise<void>((resolve) => {
      markFirstPublicEntered = resolve;
    });
    let markOwnerEntered!: () => void;
    const ownerEntered = new Promise<void>((resolve) => {
      markOwnerEntered = resolve;
    });
    const runOrder: string[] = [];
    const harness = createRouterHarness(async (prompt, options) => {
      runOrder.push(prompt);
      if (options.agentContext?.roleName === 'public_lane' && prompt === 'public-one') {
        markFirstPublicEntered();
        await firstPublicRelease;
      }
      if (options.agentContext?.roleName === 'owner_console') markOwnerEntered();
      return { response: `response-${prompt}`, modelRunId: `run-${runOrder.length}` };
    });
    const channelId = `tg-01-${Date.now()}`;

    try {
      const first = harness.router.process(publicTelegramMessage(channelId, 'public-one'));
      await firstPublicEntered;
      const second = harness.router.process(publicTelegramMessage(channelId, 'public-two'));
      await Promise.resolve();
      expect(runOrder).toEqual(['public-one']);

      const owner = harness.router.process(ownerTelegramMessage(channelId, 'owner-one'));
      await ownerEntered;
      expect(runOrder).toEqual(['public-one', 'owner-one']);

      releaseFirstPublic();
      await Promise.all([first, second, owner]);
      expect(runOrder).toEqual(['public-one', 'owner-one', 'public-two']);
      expect(
        harness.sessionStore.listSessions('telegram').map((session) => session.channelId)
      ).toEqual(expect.arrayContaining([channelId, `${channelId}#public`]));
      expect(harness.sessionStore.listSessions('telegram')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ channelId, userId: 'owner-user' }),
          expect.objectContaining({ channelId: `${channelId}#public`, userId: 'public-user' }),
        ])
      );
    } finally {
      releaseFirstPublic();
      harness.close();
    }
  });

  it('TG-05 replaces a public session with only bounded public history', async () => {
    const harness = createRouterHarness();
    const channelId = `tg-05-${Date.now()}`;

    try {
      const ownerSession = harness.sessionStore.getOrCreate('telegram', channelId, 'owner-user');
      harness.sessionStore.updateSession(
        ownerSession.id,
        'PRIVATE OWNER TURN MUST NOT APPEAR',
        'PRIVATE OWNER RESPONSE MUST NOT APPEAR'
      );

      await harness.router.process(publicTelegramMessage(channelId, 'public history turn'));
      await harness.router.process(publicTelegramMessage(channelId, 'request replacement'));

      expect(harness.modelCalls[1]?.options.resumeSession).toBe(true);
      const rebuilt = await harness.modelCalls[1]?.options.freshSessionSystemPrompt?.();
      expect(rebuilt).toContain(PUBLIC_LANE_SYSTEM_PROMPT);
      expect(rebuilt).toContain('public history turn');
      expect(rebuilt).toContain('matrix response');
      expect(rebuilt).not.toMatch(/PRIVATE OWNER|EXTERNAL HISTORY MUST NOT ENTER THE PROMPT/i);
      expect(harness.mamaApi.search).not.toHaveBeenCalled();
      expect(harness.mamaApi.recallMemory).not.toHaveBeenCalled();
      expect(harness.mamaApi.loadCheckpoint).not.toHaveBeenCalled();
    } finally {
      harness.close();
    }
  });

  it('fails closed after a Slack restart without team_id on both event routes', async () => {
    const admitted = createRouterHarness();
    const restarted = createRouterHarness();
    slackSeams.authTest
      .mockResolvedValueOnce({ ok: true, team_id: 'team-before-restart' })
      .mockResolvedValue({ ok: true });

    try {
      const firstGateway = new SlackGateway({
        botToken: 'xoxb-synthetic',
        appToken: 'xapp-synthetic',
        ownerUserId: 'slack-owner',
        turnProcessor: admitted.router,
        config: { channels: { 'slack-restart': { requireMention: false } } },
      });
      await firstGateway.start();
      await slackSeams.handlers.get('message')!({
        event: {
          ...makeSlackEvent({ connector: 'slack', surface: 'dm', sender: 'owner' }),
          channel: 'slack-restart',
          ts: '6100.0001',
        },
        ack: vi.fn().mockResolvedValue(undefined),
      });
      expect(admitted.modelCalls).toHaveLength(1);
      await firstGateway.stop();

      vi.clearAllMocks();
      attachmentSeams.downloadFile.mockResolvedValue(matrixAttachmentPath);
      const secondGateway = new SlackGateway({
        botToken: 'xoxb-synthetic',
        appToken: 'xapp-synthetic',
        ownerUserId: 'slack-owner',
        turnProcessor: restarted.router,
        config: { channels: { 'slack-restart': { requireMention: false } } },
      });
      await secondGateway.start();

      for (const [index, route] of (['message', 'app_mention'] as const).entries()) {
        await slackSeams.handlers.get(route)!({
          event: {
            ...makeSlackEvent({ connector: 'slack', surface: 'public-channel', sender: 'owner' }),
            channel: 'slack-restart',
            ts: `6100.000${index + 2}`,
          },
          ack: vi.fn().mockResolvedValue(undefined),
        });
      }

      expect(restarted.modelCalls).toEqual([]);
      expect(restarted.sessionStore.listSessions()).toEqual([]);
      expect(attachmentSeams.downloadFile).not.toHaveBeenCalled();
      expect(slackSeams.postMessage).not.toHaveBeenCalled();
      await secondGateway.stop();
    } finally {
      admitted.close();
      restarted.close();
    }
  });
});
