import { beforeEach, describe, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({
  handlers: new Map<string, (message: SyntheticDiscordMessage) => Promise<void>>(),
  downloadFile: vi.fn(),
  buildContentBlocks: vi.fn().mockResolvedValue([]),
  logMessage: vi.fn(),
}));

vi.mock('discord.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    user: { id: 'bot-user', tag: 'MAMA#0001', username: 'MAMA' },
    login: vi.fn().mockResolvedValue('synthetic-token'),
    destroy: vi.fn().mockResolvedValue(undefined),
    once: vi.fn(),
    on: vi.fn((event: string, handler: (message: SyntheticDiscordMessage) => Promise<void>) => {
      seams.handlers.set(event, handler);
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
  downloadFile: seams.downloadFile,
  buildContentBlocks: seams.buildContentBlocks,
}));

vi.mock('../../src/memory/memory-logger.js', () => ({
  getMemoryLogger: vi.fn(() => ({ logMessage: seams.logMessage })),
}));

vi.mock('@jungjaehoon/mama-core/debug-logger', () => ({
  DebugLogger: class {
    debug = vi.fn();
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
}));

import { ChannelHistory, setChannelHistory } from '../../src/gateways/channel-history.js';
import { DiscordGateway } from '../../src/gateways/discord.js';
import type { TurnProcessor } from '../../src/gateways/turn-contract.js';
import type { NormalizedMessage } from '../../src/gateways/types.js';

interface SyntheticDiscordMessage {
  id: string;
  content: string;
  author: {
    id: string;
    bot: boolean;
    username: string;
    tag: string;
  };
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

function completed(): ReturnType<TurnProcessor['processTurn']> {
  return Promise.resolve({
    outcome: 'completed',
    response: 'completed',
    sessionId: 'discord-principal-session',
    injectedDecisions: [],
    duration: 1,
    provenance: { status: 'available', modelRunId: 'discord-principal-run' },
    sourceTurnId: 'discord-principal-turn',
    sourceMessageRef: 'discord:synthetic:turn',
  });
}

function makeMessage(input: {
  userId: string;
  messageId: string;
  guildId?: string | null;
}): SyntheticDiscordMessage {
  return {
    id: input.messageId,
    content: 'synthetic request',
    author: {
      id: input.userId,
      bot: false,
      username: `synthetic-${input.userId}`,
      tag: `synthetic-${input.userId}#0001`,
    },
    guild:
      input.guildId === null
        ? null
        : { id: input.guildId ?? 'guild-principal', name: 'Synthetic Guild' },
    channel: {
      id: 'channel-principal',
      type: 0,
      name: 'principal',
      isDMBased: () => false,
      sendTyping: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue({ id: 'placeholder-message' }),
      messages: { fetch: vi.fn() },
    },
    mentions: { has: vi.fn().mockReturnValue(false) },
    attachments: new Map([
      [
        'attachment-1',
        {
          url: 'https://cdn.invalid/payload.txt',
          name: 'payload.txt',
          contentType: 'text/plain',
          size: 12,
        },
      ],
    ]),
    react: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue({ id: 'response-message' }),
  };
}

function makeGateway(
  turnProcessor: TurnProcessor,
  principalResolver?: ConstructorParameters<typeof DiscordGateway>[0]['principalResolver']
): DiscordGateway {
  return new DiscordGateway({
    token: 'synthetic-token',
    ownerUserId: 'owner-user',
    turnProcessor,
    principalResolver,
    sessionDirectory: {
      listSessions: vi.fn().mockReturnValue([]),
      updateChannelName: vi.fn().mockReturnValue(false),
    },
    config: {
      guilds: {
        'guild-principal': {
          requireMention: false,
        },
      },
    },
  });
}

async function deliver(message: SyntheticDiscordMessage): Promise<void> {
  const handler = seams.handlers.get('messageCreate');
  expect(handler).toBeTypeOf('function');
  await handler!(message);
}

describe('Discord ingress principal admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seams.handlers.clear();
    seams.downloadFile.mockResolvedValue('/tmp/discord-principal-file');
    seams.buildContentBlocks.mockResolvedValue([]);
    setChannelHistory(new ChannelHistory());
  });

  it('diverts an unmentioned external sender with zero persistence or external effects', async () => {
    const turnProcessor: TurnProcessor = { processTurn: vi.fn(() => completed()) };
    const gateway = makeGateway(turnProcessor);
    const history = new ChannelHistory();
    setChannelHistory(history);
    const message = makeMessage({ userId: 'external-user', messageId: 'message-1' });

    await deliver(message);

    expect(turnProcessor.processTurn).not.toHaveBeenCalled();
    expect(seams.downloadFile).not.toHaveBeenCalled();
    expect(seams.buildContentBlocks).not.toHaveBeenCalled();
    expect(message.channel.sendTyping).not.toHaveBeenCalled();
    expect(message.react).not.toHaveBeenCalled();
    expect(message.reply).not.toHaveBeenCalled();
    expect(history.getHistory('channel-principal')).toEqual([]);
    expect(gateway).toBeInstanceOf(DiscordGateway);
  });

  it('admits an unmentioned owner in a requireMention:false channel with a frozen principal', async () => {
    const routed: NormalizedMessage[] = [];
    const turnProcessor: TurnProcessor = {
      processTurn: vi.fn((message) => {
        routed.push(message);
        return completed();
      }),
    };
    const principalResolver = vi.fn().mockReturnValue({
      principalId: 'registry-member-principal',
      kind: 'member',
      status: 'active',
    });
    makeGateway(turnProcessor, principalResolver);
    const message = makeMessage({ userId: 'owner-user', messageId: 'message-2' });

    await deliver(message);

    expect(turnProcessor.processTurn).toHaveBeenCalledTimes(1);
    expect(routed[0]?.principal).toEqual({
      class: 'owner',
      lane: 'owner',
      canonicalId: 'discord:guild-principal:owner-user',
      consoleEligible: false,
    });
    expect(Object.isFrozen(routed[0]?.principal)).toBe(true);
    expect(seams.downloadFile).toHaveBeenCalledTimes(1);
    expect(principalResolver).not.toHaveBeenCalled();
  });

  it('overlays an active member with the guild namespace while preserving divert admission', async () => {
    const turnProcessor: TurnProcessor = { processTurn: vi.fn(() => completed()) };
    const principalResolver = vi.fn().mockReturnValue({
      principalId: 'discord-member-principal',
      kind: 'member',
      status: 'active',
    });
    makeGateway(turnProcessor, principalResolver);
    const message = makeMessage({ userId: 'member-user', messageId: 'message-3' });

    await deliver(message);

    expect(principalResolver).toHaveBeenCalledWith('discord', 'guild-principal', 'member-user');
    expect(turnProcessor.processTurn).not.toHaveBeenCalled();
    expect(seams.downloadFile).not.toHaveBeenCalled();
  });

  it('uses the direct namespace for a diverted member DM', async () => {
    const turnProcessor: TurnProcessor = { processTurn: vi.fn(() => completed()) };
    const principalResolver = vi.fn().mockReturnValue({
      principalId: 'discord-direct-member-principal',
      kind: 'member',
      status: 'active',
    });
    makeGateway(turnProcessor, principalResolver);
    const message = makeMessage({
      userId: 'direct-member-user',
      messageId: 'message-4',
      guildId: null,
    });

    await deliver(message);

    expect(principalResolver).toHaveBeenCalledWith('discord', 'direct', 'direct-member-user');
    expect(turnProcessor.processTurn).not.toHaveBeenCalled();
  });
});
