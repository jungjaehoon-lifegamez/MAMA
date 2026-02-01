/**
 * Unit tests for Discord message editing with throttle
 *
 * Tests the 150ms throttle mechanism for streaming message updates
 * to respect Discord rate limits.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiscordGateway } from '../../src/gateways/discord.js';
import { MessageRouter } from '../../src/gateways/message-router.js';
import type { Message } from 'discord.js';

// Mock discord.js
vi.mock('discord.js', () => {
  const mockClient = {
    user: { id: '123456789', tag: 'TestBot#1234' },
    login: vi.fn().mockResolvedValue('token'),
    destroy: vi.fn().mockResolvedValue(undefined),
    once: vi.fn(),
    on: vi.fn(),
  };

  return {
    Client: vi.fn(() => mockClient),
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      DirectMessages: 4,
      MessageContent: 8,
    },
    Partials: {
      Channel: 1,
    },
    Events: {
      ClientReady: 'ready',
      MessageCreate: 'messageCreate',
      ShardDisconnect: 'shardDisconnect',
      Error: 'error',
    },
    ChannelType: {
      DM: 1,
      GuildText: 0,
    },
  };
});

// Mock MessageRouter
const mockMessageRouter = {
  process: vi.fn().mockResolvedValue({
    response: 'Test response',
    duration: 100,
    sessionId: 'session-123',
  }),
} as unknown as MessageRouter;

describe('DiscordGateway - Message Editing with Throttle', () => {
  let gateway: DiscordGateway;
  let mockMessage: Message;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    gateway = new DiscordGateway({
      token: 'test-token',
      messageRouter: mockMessageRouter,
    });

    mockMessage = {
      edit: vi.fn().mockResolvedValue(undefined),
    } as unknown as Message;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('editMessageThrottled', () => {
    it('should edit immediately if 150ms has passed since last edit', async () => {
      // First edit happens immediately
      await gateway.editMessageThrottled(mockMessage, 'First edit');
      expect(mockMessage.edit).toHaveBeenCalledWith('First edit');
      expect(mockMessage.edit).toHaveBeenCalledTimes(1);

      // Advance time by 150ms
      vi.advanceTimersByTime(150);

      // Second edit should happen immediately
      await gateway.editMessageThrottled(mockMessage, 'Second edit');
      expect(mockMessage.edit).toHaveBeenCalledWith('Second edit');
      expect(mockMessage.edit).toHaveBeenCalledTimes(2);
    });

    it('should respect 150ms minimum between edits', async () => {
      // First edit
      await gateway.editMessageThrottled(mockMessage, 'Edit 1');
      expect(mockMessage.edit).toHaveBeenCalledTimes(1);

      // Try to edit after 50ms (too soon)
      vi.advanceTimersByTime(50);
      await gateway.editMessageThrottled(mockMessage, 'Edit 2');
      expect(mockMessage.edit).toHaveBeenCalledTimes(1); // Still 1, not called yet

      // Advance another 100ms (total 150ms)
      vi.advanceTimersByTime(100);
      expect(mockMessage.edit).toHaveBeenCalledWith('Edit 2');
      expect(mockMessage.edit).toHaveBeenCalledTimes(2);
    });

    it('should batch rapid edits (10ms apart) into single edit after 150ms', async () => {
      // First edit
      await gateway.editMessageThrottled(mockMessage, 'Edit 1');
      expect(mockMessage.edit).toHaveBeenCalledTimes(1);

      // Rapid edits at 10ms intervals
      vi.advanceTimersByTime(10);
      await gateway.editMessageThrottled(mockMessage, 'Edit 2');

      vi.advanceTimersByTime(10);
      await gateway.editMessageThrottled(mockMessage, 'Edit 3');

      vi.advanceTimersByTime(10);
      await gateway.editMessageThrottled(mockMessage, 'Edit 4');

      // Still only 1 edit (the first one)
      expect(mockMessage.edit).toHaveBeenCalledTimes(1);

      // Advance to 150ms total
      vi.advanceTimersByTime(120);

      // Now the final pending edit should be flushed
      expect(mockMessage.edit).toHaveBeenCalledWith('Edit 4');
      expect(mockMessage.edit).toHaveBeenCalledTimes(2);
    });

    it('should always flush final pending edit', async () => {
      // First edit
      await gateway.editMessageThrottled(mockMessage, 'Edit 1');
      expect(mockMessage.edit).toHaveBeenCalledTimes(1);

      // Queue a second edit
      vi.advanceTimersByTime(50);
      await gateway.editMessageThrottled(mockMessage, 'Edit 2');
      expect(mockMessage.edit).toHaveBeenCalledTimes(1); // Still pending

      // Advance time to trigger flush
      vi.advanceTimersByTime(100);
      expect(mockMessage.edit).toHaveBeenCalledWith('Edit 2');
      expect(mockMessage.edit).toHaveBeenCalledTimes(2);
    });

    it('should handle multiple throttle cycles correctly', async () => {
      // Cycle 1: Edit immediately
      await gateway.editMessageThrottled(mockMessage, 'Cycle 1 - Edit 1');
      expect(mockMessage.edit).toHaveBeenCalledTimes(1);

      // Queue edit within throttle window
      vi.advanceTimersByTime(50);
      await gateway.editMessageThrottled(mockMessage, 'Cycle 1 - Edit 2');

      // Flush cycle 1
      vi.advanceTimersByTime(100);
      expect(mockMessage.edit).toHaveBeenCalledWith('Cycle 1 - Edit 2');
      expect(mockMessage.edit).toHaveBeenCalledTimes(2);

      // Cycle 2: Edit immediately (150ms passed)
      await gateway.editMessageThrottled(mockMessage, 'Cycle 2 - Edit 1');
      expect(mockMessage.edit).toHaveBeenCalledWith('Cycle 2 - Edit 1');
      expect(mockMessage.edit).toHaveBeenCalledTimes(3);

      // Queue edit within throttle window
      vi.advanceTimersByTime(50);
      await gateway.editMessageThrottled(mockMessage, 'Cycle 2 - Edit 2');

      // Flush cycle 2
      vi.advanceTimersByTime(100);
      expect(mockMessage.edit).toHaveBeenCalledWith('Cycle 2 - Edit 2');
      expect(mockMessage.edit).toHaveBeenCalledTimes(4);
    });

    it('should not lose pending edit if timer is pending', async () => {
      // First edit
      await gateway.editMessageThrottled(mockMessage, 'Edit 1');

      // Queue second edit
      vi.advanceTimersByTime(50);
      await gateway.editMessageThrottled(mockMessage, 'Edit 2');

      // Queue third edit (replaces pending)
      vi.advanceTimersByTime(10);
      await gateway.editMessageThrottled(mockMessage, 'Edit 3');

      // Flush - should have Edit 3 (the final pending)
      vi.advanceTimersByTime(90);
      expect(mockMessage.edit).toHaveBeenCalledWith('Edit 3');
      expect(mockMessage.edit).toHaveBeenCalledTimes(2);
    });

    it('should handle no pending edit gracefully', async () => {
      // This tests the guard clause in flushEdit
      // Create a scenario where flushEdit is called with no pending edit
      // (This is an edge case but important for robustness)

      // First edit
      await gateway.editMessageThrottled(mockMessage, 'Edit 1');
      expect(mockMessage.edit).toHaveBeenCalledTimes(1);

      // Advance past throttle window
      vi.advanceTimersByTime(150);

      // No second edit queued, so no additional calls
      expect(mockMessage.edit).toHaveBeenCalledTimes(1);
    });
  });
});
