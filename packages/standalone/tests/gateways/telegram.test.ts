/**
 * Unit tests for Telegram Gateway (grammY)
 *
 * Note: These tests mock grammY's Bot class to test gateway logic without
 * requiring an actual Telegram bot connection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockApi = {
  sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
  editMessageText: vi.fn().mockResolvedValue(undefined),
  sendPhoto: vi.fn().mockResolvedValue(undefined),
  sendDocument: vi.fn().mockResolvedValue(undefined),
  sendChatAction: vi.fn().mockResolvedValue(undefined),
  sendSticker: vi.fn().mockResolvedValue(undefined),
  getStickerSet: vi.fn().mockResolvedValue({ stickers: [] }),
};

vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    catch: vi.fn(),
    init: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    botInfo: { id: 123, username: 'test_bot' },
    api: mockApi,
  })),
  InputFile: vi.fn().mockImplementation((path: string) => ({ path })),
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
    const line1 = 'a'.repeat(3000) + '\n';
    const line2 = 'b'.repeat(3000);
    const text = line1 + line2;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chunks = (gateway as any).splitMessage(text, 4096);
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

  it('should store botId from bot.botInfo', async () => {
    await gateway.start();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((gateway as any).botId).toBe(123);
  });

  it('should store botUsername from bot.botInfo', async () => {
    await gateway.start();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((gateway as any).botUsername).toBe('test_bot');
  });

  it('should clear bot info after stop()', async () => {
    await gateway.start();
    await gateway.stop();
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
  });

  it('should return false when no sticker is cached for the emotion', async () => {
    const result = await gateway.sendSticker('12345', 'happy');
    expect(result).toBe(false);
  });

  it('should call api.sendMessage with emoji fallback when no sticker found', async () => {
    await gateway.sendSticker('12345', 'happy');
    expect(mockApi.sendMessage).toHaveBeenCalled();
    const [chatId, emoji] = mockApi.sendMessage.mock.calls[0];
    expect(chatId).toBe(12345);
    expect(typeof emoji).toBe('string');
    expect(emoji.length).toBeGreaterThan(0);
  });

  it('should use "happy" emotion emojis as default for unknown emotions', async () => {
    const result = await gateway.sendSticker('12345', 'unknown_emotion');
    expect(result).toBe(false);
    expect(mockApi.sendMessage).toHaveBeenCalled();
  });
});
