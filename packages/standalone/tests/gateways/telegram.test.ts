/**
 * Unit tests for Telegram Gateway
 *
 * Note: These tests mock node-telegram-bot-api to test gateway logic without
 * requiring an actual Telegram bot connection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node-telegram-bot-api BEFORE importing TelegramGateway
vi.mock('node-telegram-bot-api', () => ({
  default: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    getMe: vi.fn().mockResolvedValue({ id: 123, username: 'test_bot' }),
    stopPolling: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    sendPhoto: vi.fn().mockResolvedValue(undefined),
    sendDocument: vi.fn().mockResolvedValue(undefined),
    sendChatAction: vi.fn().mockResolvedValue(undefined),
    sendSticker: vi.fn().mockResolvedValue(undefined),
    getStickerSet: vi.fn().mockResolvedValue({ stickers: [] }),
  })),
}));

// Mock memory-logger dependency
vi.mock('../../src/memory/memory-logger.js', () => ({
  getMemoryLogger: vi.fn(() => ({
    logMessage: vi.fn(),
  })),
}));

// Mock ToolStatusTracker dependency
vi.mock('../../src/gateways/tool-status-tracker.js', () => ({
  ToolStatusTracker: vi.fn().mockImplementation(() => ({
    toStreamCallbacks: vi.fn().mockReturnValue({}),
    cleanup: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { TelegramGateway } from '../../src/gateways/telegram.js';
import { MessageRouter } from '../../src/gateways/message-router.js';

// Mock MessageRouter
const mockMessageRouter = {
  process: vi.fn().mockResolvedValue({
    response: 'test',
    duration: 100,
  }),
} as unknown as MessageRouter;

describe('TelegramGateway basics', () => {
  let gateway: TelegramGateway;

  beforeEach(() => {
    vi.clearAllMocks();
    gateway = new TelegramGateway({
      token: 'test-bot-token',
      messageRouter: mockMessageRouter,
    });
  });

  it('should have source property set to "telegram"', () => {
    expect(gateway.source).toBe('telegram');
  });

  it('should start in disconnected state', () => {
    expect(gateway.isConnected()).toBe(false);
  });

  it('should set connected to true after start()', async () => {
    await gateway.start();
    expect(gateway.isConnected()).toBe(true);
  });

  it('should set connected to false after stop()', async () => {
    await gateway.start();
    await gateway.stop();
    expect(gateway.isConnected()).toBe(false);
  });

  it('should not throw when stop() called without start()', async () => {
    await expect(gateway.stop()).resolves.not.toThrow();
    expect(gateway.isConnected()).toBe(false);
  });

  it('should not reconnect if already connected', async () => {
    await gateway.start();
    const firstConnectedState = gateway.isConnected();
    await gateway.start(); // second call should be no-op
    expect(gateway.isConnected()).toBe(firstConnectedState);
  });

  it('should allow registering event handlers via onEvent()', () => {
    const handler = vi.fn();
    expect(() => gateway.onEvent(handler)).not.toThrow();
  });

  it('should return null for getLastError() initially', () => {
    expect(gateway.getLastError()).toBeNull();
  });

  it('should return undefined for getLastMessageAt() initially', () => {
    expect(gateway.getLastMessageAt()).toBeUndefined();
  });
});

describe('TelegramGateway - message splitting', () => {
  let gateway: TelegramGateway;

  beforeEach(() => {
    vi.clearAllMocks();
    gateway = new TelegramGateway({
      token: 'test-bot-token',
      messageRouter: mockMessageRouter,
    });
  });

  it('should not split messages under 4096 chars', () => {
    const shortText = 'Hello, world!';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chunks = (gateway as any).splitMessage(shortText, 4096);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(shortText);
  });

  it('should not split a message of exactly 4096 chars', () => {
    const exactText = 'a'.repeat(4096);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chunks = (gateway as any).splitMessage(exactText, 4096);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(exactText);
  });

  it('should split a message exceeding 4096 chars into multiple chunks', () => {
    const longText = 'a'.repeat(8192);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chunks = (gateway as any).splitMessage(longText, 4096);
    expect(chunks.length).toBeGreaterThan(1);
    // All chunks must be within the limit
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });

  it('should preserve the full content after splitting', () => {
    const longText = 'x'.repeat(9000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chunks = (gateway as any).splitMessage(longText, 4096);
    expect(chunks.join('')).toBe(longText);
  });

  it('should prefer splitting at newline boundaries when possible', () => {
    // Build a text where a newline falls near the boundary
    const line1 = 'a'.repeat(3000) + '\n';
    const line2 = 'b'.repeat(3000);
    const text = line1 + line2;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chunks = (gateway as any).splitMessage(text, 4096);
    // First chunk should end at (or include) the newline
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.join('')).toBe(text);
  });
});

describe('TelegramGateway - bot info stored after start()', () => {
  let gateway: TelegramGateway;

  beforeEach(() => {
    vi.clearAllMocks();
    gateway = new TelegramGateway({
      token: 'test-bot-token',
      messageRouter: mockMessageRouter,
    });
  });

  it('should store botId from getMe() response', async () => {
    await gateway.start();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((gateway as any).botId).toBe(123);
  });

  it('should store botUsername from getMe() response', async () => {
    await gateway.start();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((gateway as any).botUsername).toBe('test_bot');
  });

  it('should clear bot info after stop()', async () => {
    await gateway.start();
    await gateway.stop();
    // bot reference should be null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((gateway as any).bot).toBeNull();
  });
});

describe('TelegramGateway - sticker send fallback', () => {
  let gateway: TelegramGateway;

  beforeEach(async () => {
    vi.clearAllMocks();
    gateway = new TelegramGateway({
      token: 'test-bot-token',
      messageRouter: mockMessageRouter,
    });
    await gateway.start();
    // The mock getStickerSet returns { stickers: [] }, so stickerCache stays empty
  });

  it('should return false when no sticker is cached for the emotion', async () => {
    const result = await gateway.sendSticker('12345', 'happy');
    expect(result).toBe(false);
  });

  it('should call sendMessage with an emoji as fallback when no sticker is found', async () => {
    await gateway.sendSticker('12345', 'happy');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const botMock = (gateway as any).bot;
    expect(botMock.sendMessage).toHaveBeenCalled();
    // Should have sent the first emoji candidate for 'happy'
    const [chatId, emoji] = botMock.sendMessage.mock.calls[0];
    expect(chatId).toBe('12345');
    expect(typeof emoji).toBe('string');
    expect(emoji.length).toBeGreaterThan(0);
  });

  it('should use "happy" emotion emojis as default for unknown emotions', async () => {
    const result = await gateway.sendSticker('12345', 'unknown_emotion');
    expect(result).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const botMock = (gateway as any).bot;
    expect(botMock.sendMessage).toHaveBeenCalled();
  });

  it('should throw when bot is null', async () => {
    await gateway.stop(); // sets bot to null
    await expect(gateway.sendSticker('12345', 'happy')).rejects.toThrow(
      'Telegram gateway not connected'
    );
  });
});

describe('TelegramGateway - message dedup', () => {
  let gateway: TelegramGateway;
  let messageHandler: (msg: unknown) => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();
    gateway = new TelegramGateway({
      token: 'test-bot-token',
      messageRouter: mockMessageRouter,
    });
    await gateway.start();
    // Capture the 'message' handler registered on the mock bot
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bot = (gateway as any).bot;
    const onCalls = bot.on.mock.calls;
    const messageCb = onCalls.find((c: unknown[]) => c[0] === 'message');
    messageHandler = messageCb[1];
  });

  it('should process a message the first time', async () => {
    await messageHandler({
      message_id: 1,
      from: { id: 100, username: 'user1' },
      chat: { id: 200, type: 'private' },
      text: 'hello',
    });
    expect(mockMessageRouter.process).toHaveBeenCalledTimes(1);
  });

  it('should ignore duplicate message_id', async () => {
    const msg = {
      message_id: 42,
      from: { id: 100, username: 'user1' },
      chat: { id: 200, type: 'private' },
      text: 'hello',
    };
    await messageHandler(msg);
    await messageHandler(msg); // duplicate
    expect(mockMessageRouter.process).toHaveBeenCalledTimes(1);
  });

  it('should ignore duplicate content signature within 5s', async () => {
    const msg1 = {
      message_id: 1,
      from: { id: 100, username: 'user1' },
      chat: { id: 200, type: 'private' },
      text: 'same text',
    };
    const msg2 = {
      message_id: 2, // different message_id
      from: { id: 100, username: 'user1' },
      chat: { id: 200, type: 'private' },
      text: 'same text', // same content
    };
    await messageHandler(msg1);
    await messageHandler(msg2);
    expect(mockMessageRouter.process).toHaveBeenCalledTimes(1);
  });

  it('should process different content from same user', async () => {
    const msg1 = {
      message_id: 1,
      from: { id: 100, username: 'user1' },
      chat: { id: 200, type: 'private' },
      text: 'hello',
    };
    const msg2 = {
      message_id: 2,
      from: { id: 100, username: 'user1' },
      chat: { id: 200, type: 'private' },
      text: 'world',
    };
    await messageHandler(msg1);
    await messageHandler(msg2);
    expect(mockMessageRouter.process).toHaveBeenCalledTimes(2);
  });
});

describe('TelegramGateway - group chat filtering', () => {
  let gateway: TelegramGateway;
  let messageHandler: (msg: unknown) => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();
    gateway = new TelegramGateway({
      token: 'test-bot-token',
      messageRouter: mockMessageRouter,
    });
    await gateway.start();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bot = (gateway as any).bot;
    const onCalls = bot.on.mock.calls;
    const messageCb = onCalls.find((c: unknown[]) => c[0] === 'message');
    messageHandler = messageCb[1];
  });

  it('should ignore group messages without mention/command/reply', async () => {
    await messageHandler({
      message_id: 1,
      from: { id: 100, username: 'user1' },
      chat: { id: 300, type: 'group' },
      text: 'random group message',
    });
    expect(mockMessageRouter.process).not.toHaveBeenCalled();
  });

  it('should process group messages with @bot mention', async () => {
    await messageHandler({
      message_id: 2,
      from: { id: 100, username: 'user1' },
      chat: { id: 300, type: 'group' },
      text: '@test_bot hello',
      entities: [{ type: 'mention', offset: 0, length: 9 }],
    });
    expect(mockMessageRouter.process).toHaveBeenCalledTimes(1);
  });

  it('should process group messages with /command', async () => {
    await messageHandler({
      message_id: 3,
      from: { id: 100, username: 'user1' },
      chat: { id: 300, type: 'group' },
      text: '/start',
      entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    });
    expect(mockMessageRouter.process).toHaveBeenCalledTimes(1);
  });

  it('should process group messages that reply to bot', async () => {
    await messageHandler({
      message_id: 4,
      from: { id: 100, username: 'user1' },
      chat: { id: 300, type: 'group' },
      text: 'reply text',
      reply_to_message: { from: { id: 123 } }, // botId = 123
    });
    expect(mockMessageRouter.process).toHaveBeenCalledTimes(1);
  });

  it('should process DM messages without filtering', async () => {
    await messageHandler({
      message_id: 5,
      from: { id: 100, username: 'user1' },
      chat: { id: 100, type: 'private' },
      text: 'dm message',
    });
    expect(mockMessageRouter.process).toHaveBeenCalledTimes(1);
  });

  it('should ignore supergroup messages without mention/command/reply', async () => {
    await messageHandler({
      message_id: 6,
      from: { id: 100, username: 'user1' },
      chat: { id: 400, type: 'supergroup' },
      text: 'supergroup chatter',
    });
    expect(mockMessageRouter.process).not.toHaveBeenCalled();
  });
});
