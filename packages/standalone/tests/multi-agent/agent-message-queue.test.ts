/**
 * Unit tests for AgentMessageQueue (Sprint 3 F7)
 *
 * Tests:
 * - Basic enqueue/drain flow
 * - Queue size limit (5 messages, oldest dropped)
 * - TTL expiration (20 minutes)
 * - Multiple agents with independent queues
 * - Drain callback execution
 * - Busy process handling (no re-queue)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AgentMessageQueue,
  type QueuedMessage,
} from '../../src/multi-agent/agent-message-queue.js';
import type { PersistentClaudeProcess } from '../../src/agent/persistent-cli-process.js';

describe('AgentMessageQueue', () => {
  let queue: AgentMessageQueue;

  beforeEach(() => {
    queue = new AgentMessageQueue();
  });

  describe('Basic enqueue/drain', () => {
    it('should enqueue and drain a message', async () => {
      const message: QueuedMessage = {
        prompt: 'Test prompt',
        channelId: 'ch-1',
        threadTs: 'ts-1',
        source: 'slack',
        enqueuedAt: Date.now(),
      };

      queue.enqueue('agent-1', message);
      expect(queue.getQueueSize('agent-1')).toBe(1);

      // Mock process
      const mockProcess = {
        sendMessage: vi.fn().mockResolvedValue({ response: 'Response' }),
      } as unknown as PersistentClaudeProcess;

      // Mock callback
      const mockCallback = vi.fn().mockResolvedValue(undefined);

      await queue.drain('agent-1', mockProcess, mockCallback);

      expect(mockProcess.sendMessage).toHaveBeenCalledWith('Test prompt');
      expect(mockCallback).toHaveBeenCalledWith('agent-1', message, 'Response');
      expect(queue.getQueueSize('agent-1')).toBe(0);
    });

    it('should do nothing if queue is empty', async () => {
      const mockProcess = {
        sendMessage: vi.fn(),
      } as unknown as PersistentClaudeProcess;

      const mockCallback = vi.fn();

      await queue.drain('agent-1', mockProcess, mockCallback);

      expect(mockProcess.sendMessage).not.toHaveBeenCalled();
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it('should return 0 for non-existent queue', () => {
      expect(queue.getQueueSize('nonexistent')).toBe(0);
    });
  });

  describe('Queue size limit', () => {
    it('should drop oldest message when queue exceeds 5', () => {
      for (let i = 1; i <= 6; i++) {
        queue.enqueue('agent-1', {
          prompt: `Message ${i}`,
          channelId: 'ch-1',
          source: 'slack',
          enqueuedAt: Date.now() + i * 1000,
        });
      }

      expect(queue.getQueueSize('agent-1')).toBe(5);
    });

    it('should keep most recent 5 messages', async () => {
      for (let i = 1; i <= 7; i++) {
        queue.enqueue('agent-1', {
          prompt: `Message ${i}`,
          channelId: 'ch-1',
          source: 'slack',
          enqueuedAt: Date.now() + i * 1000,
        });
      }

      const mockProcess = {
        sendMessage: vi.fn().mockResolvedValue({ response: 'OK' }),
      } as unknown as PersistentClaudeProcess;

      const receivedPrompts: string[] = [];
      const mockCallback = vi.fn(async (_aid, msg, _res) => {
        receivedPrompts.push(msg.prompt);
      });

      // Drain all
      for (let i = 0; i < 5; i++) {
        await queue.drain('agent-1', mockProcess, mockCallback);
      }

      // Should have messages 3-7 (dropped 1-2)
      expect(receivedPrompts).toEqual([
        'Message 3',
        'Message 4',
        'Message 5',
        'Message 6',
        'Message 7',
      ]);
    });
  });

  describe('TTL expiration', () => {
    it('should skip expired messages (older than 20 minutes)', async () => {
      const now = Date.now();
      const twentyMinutesAgo = now - 20 * 60 * 1000 - 1000; // 20min + 1s ago

      queue.enqueue('agent-1', {
        prompt: 'Expired message',
        channelId: 'ch-1',
        source: 'slack',
        enqueuedAt: twentyMinutesAgo,
      });

      queue.enqueue('agent-1', {
        prompt: 'Fresh message',
        channelId: 'ch-1',
        source: 'slack',
        enqueuedAt: now,
      });

      const mockProcess = {
        sendMessage: vi.fn().mockResolvedValue({ response: 'OK' }),
      } as unknown as PersistentClaudeProcess;

      const receivedPrompts: string[] = [];
      const mockCallback = vi.fn(async (_aid, msg, _res) => {
        receivedPrompts.push(msg.prompt);
      });

      await queue.drain('agent-1', mockProcess, mockCallback);

      // Should skip expired, deliver fresh
      expect(receivedPrompts).toEqual(['Fresh message']);
      expect(queue.getQueueSize('agent-1')).toBe(0);
    });

    it('should clear expired messages with clearExpired()', () => {
      const now = Date.now();
      const twentyMinutesAgo = now - 20 * 60 * 1000 - 1000;

      queue.enqueue('agent-1', {
        prompt: 'Expired',
        channelId: 'ch-1',
        source: 'slack',
        enqueuedAt: twentyMinutesAgo,
      });

      queue.enqueue('agent-2', {
        prompt: 'Fresh',
        channelId: 'ch-2',
        source: 'slack',
        enqueuedAt: now,
      });

      queue.clearExpired();

      expect(queue.getQueueSize('agent-1')).toBe(0);
      expect(queue.getQueueSize('agent-2')).toBe(1);
    });
  });

  describe('Multiple agents', () => {
    it('should maintain independent queues per agent', () => {
      queue.enqueue('agent-1', {
        prompt: 'Agent 1 msg 1',
        channelId: 'ch-1',
        source: 'slack',
        enqueuedAt: Date.now(),
      });

      queue.enqueue('agent-1', {
        prompt: 'Agent 1 msg 2',
        channelId: 'ch-1',
        source: 'slack',
        enqueuedAt: Date.now(),
      });

      queue.enqueue('agent-2', {
        prompt: 'Agent 2 msg 1',
        channelId: 'ch-1',
        source: 'slack',
        enqueuedAt: Date.now(),
      });

      expect(queue.getQueueSize('agent-1')).toBe(2);
      expect(queue.getQueueSize('agent-2')).toBe(1);
    });

    it('should return all agent IDs with queued messages', () => {
      queue.enqueue('agent-1', {
        prompt: 'Msg 1',
        channelId: 'ch-1',
        source: 'slack',
        enqueuedAt: Date.now(),
      });

      queue.enqueue('agent-2', {
        prompt: 'Msg 2',
        channelId: 'ch-1',
        source: 'slack',
        enqueuedAt: Date.now(),
      });

      const agentIds = queue.getAgentIds();
      expect(agentIds).toHaveLength(2);
      expect(agentIds).toContain('agent-1');
      expect(agentIds).toContain('agent-2');
    });
  });

  describe('Busy process handling', () => {
    it('should re-queue message when process is busy (up to 3 retries)', async () => {
      queue.enqueue('agent-1', {
        prompt: 'Message 1',
        channelId: 'ch-1',
        source: 'slack',
        enqueuedAt: Date.now(),
      });

      const mockProcess = {
        sendMessage: vi.fn().mockRejectedValue(new Error('Process is busy')),
      } as unknown as PersistentClaudeProcess;

      const mockCallback = vi.fn();

      // First attempt: re-queued (retry 1)
      await queue.drain('agent-1', mockProcess, mockCallback);
      expect(queue.getQueueSize('agent-1')).toBe(1);

      // Second attempt: re-queued (retry 2)
      await queue.drain('agent-1', mockProcess, mockCallback);
      expect(queue.getQueueSize('agent-1')).toBe(1);

      // Third attempt: re-queued (retry 3)
      await queue.drain('agent-1', mockProcess, mockCallback);
      expect(queue.getQueueSize('agent-1')).toBe(1);

      // Fourth attempt: dropped after 3 retries
      await queue.drain('agent-1', mockProcess, mockCallback);
      expect(queue.getQueueSize('agent-1')).toBe(0);
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it('should not drain further messages when busy (waits for next idle)', async () => {
      queue.enqueue('agent-1', {
        prompt: 'Message 1',
        channelId: 'ch-1',
        source: 'slack',
        enqueuedAt: Date.now(),
      });

      queue.enqueue('agent-1', {
        prompt: 'Message 2',
        channelId: 'ch-1',
        source: 'slack',
        enqueuedAt: Date.now(),
      });

      const mockProcess = {
        sendMessage: vi.fn().mockRejectedValue(new Error('Process is busy')),
      } as unknown as PersistentClaudeProcess;

      const mockCallback = vi.fn();

      await queue.drain('agent-1', mockProcess, mockCallback);

      // Message 1 re-queued at front, Message 2 still behind it — no further drain
      expect(queue.getQueueSize('agent-1')).toBe(2);
      expect(mockCallback).not.toHaveBeenCalled();
    });
  });

  describe('Error handling', () => {
    it('should log and continue on non-busy errors', async () => {
      queue.enqueue('agent-1', {
        prompt: 'Message 1',
        channelId: 'ch-1',
        source: 'slack',
        enqueuedAt: Date.now(),
      });

      const mockProcess = {
        sendMessage: vi.fn().mockRejectedValue(new Error('Network error')),
      } as unknown as PersistentClaudeProcess;

      const mockCallback = vi.fn();

      // Should not throw
      await expect(queue.drain('agent-1', mockProcess, mockCallback)).resolves.toBeUndefined();

      expect(queue.getQueueSize('agent-1')).toBe(0);
    });
  });

  describe('clearAll', () => {
    it('should clear all queues', () => {
      queue.enqueue('agent-1', {
        prompt: 'Msg 1',
        channelId: 'ch-1',
        source: 'slack',
        enqueuedAt: Date.now(),
      });

      queue.enqueue('agent-2', {
        prompt: 'Msg 2',
        channelId: 'ch-1',
        source: 'slack',
        enqueuedAt: Date.now(),
      });

      queue.clearAll();

      expect(queue.getQueueSize('agent-1')).toBe(0);
      expect(queue.getQueueSize('agent-2')).toBe(0);
      expect(queue.getAgentIds()).toHaveLength(0);
    });
  });
});
