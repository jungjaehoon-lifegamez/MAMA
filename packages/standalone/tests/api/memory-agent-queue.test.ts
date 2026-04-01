/**
 * Unit tests for MemoryAgentQueue
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryAgentQueue, type QueueItem } from '../../src/api/memory-agent-queue.js';

describe('MemoryAgentQueue', () => {
  let queue: MemoryAgentQueue;
  let flushedItems: QueueItem[][];
  let onFlush: (items: QueueItem[]) => Promise<void>;

  beforeEach(() => {
    flushedItems = [];
    onFlush = vi.fn(async (items: QueueItem[]) => {
      flushedItems.push(items);
    });
  });

  afterEach(() => {
    queue?.stop();
    vi.useRealTimers();
  });

  function makeItem(content: string, scopes: QueueItem['scopes'] = []): QueueItem {
    return {
      messages: [{ role: 'user', content }],
      scopes,
      timestamp: Date.now(),
    };
  }

  describe('enqueue', () => {
    it('should add items to the queue', () => {
      queue = new MemoryAgentQueue({ maxSize: 50, flushInterval: 30_000, onFlush });
      const result = queue.enqueue(makeItem('hello'));
      expect(result).toBe(true);
      expect(queue.size).toBe(1);
    });

    it('should flush then accept new item when at max capacity', () => {
      // flush() synchronously splices the queue before awaiting onFlush,
      // so after the fire-and-forget flush, queue is empty and the new item is added.
      queue = new MemoryAgentQueue({ maxSize: 3, flushInterval: 30_000, onFlush });
      queue.enqueue(makeItem('one'));
      queue.enqueue(makeItem('two'));
      queue.enqueue(makeItem('three'));
      expect(queue.size).toBe(3);

      queue.enqueue(makeItem('four'));
      // flush() synchronously emptied the queue, then 'four' was added
      expect(queue.size).toBe(1);
    });

    it('should deduplicate items with identical content', () => {
      queue = new MemoryAgentQueue({ maxSize: 50, flushInterval: 30_000, onFlush });
      const result1 = queue.enqueue(makeItem('same content'));
      const result2 = queue.enqueue(makeItem('same content'));
      expect(result1).toBe(true);
      expect(result2).toBe(false);
      expect(queue.size).toBe(1);
    });

    it('should allow items with different content', () => {
      queue = new MemoryAgentQueue({ maxSize: 50, flushInterval: 30_000, onFlush });
      queue.enqueue(makeItem('content A'));
      queue.enqueue(makeItem('content B'));
      expect(queue.size).toBe(2);
    });

    it('should not deduplicate items with same content but different scopes', () => {
      queue = new MemoryAgentQueue({ maxSize: 50, flushInterval: 30_000, onFlush });
      const result1 = queue.enqueue(makeItem('same content', [{ kind: 'project', id: 'proj-a' }]));
      const result2 = queue.enqueue(makeItem('same content', [{ kind: 'project', id: 'proj-b' }]));
      expect(result1).toBe(true);
      expect(result2).toBe(true);
      expect(queue.size).toBe(2);
    });
  });

  describe('flush', () => {
    it('should flush all items and call onFlush', async () => {
      queue = new MemoryAgentQueue({ maxSize: 50, flushInterval: 30_000, onFlush });
      queue.enqueue(makeItem('alpha'));
      queue.enqueue(makeItem('beta'));

      await queue.flush();

      expect(onFlush).toHaveBeenCalledOnce();
      expect(flushedItems).toHaveLength(1);
      expect(flushedItems[0]).toHaveLength(2);
      expect(queue.size).toBe(0);
    });

    it('should be a no-op when queue is empty', async () => {
      queue = new MemoryAgentQueue({ maxSize: 50, flushInterval: 30_000, onFlush });
      await queue.flush();
      expect(onFlush).not.toHaveBeenCalled();
    });

    it('should clear dedup hashes after flush', async () => {
      queue = new MemoryAgentQueue({ maxSize: 50, flushInterval: 30_000, onFlush });
      queue.enqueue(makeItem('repeat'));
      await queue.flush();

      // Same content should be accepted again after flush
      const result = queue.enqueue(makeItem('repeat'));
      expect(result).toBe(true);
      expect(queue.size).toBe(1);
    });

    it('should propagate flush errors', async () => {
      const failFlush = vi.fn(async () => {
        throw new Error('flush failed');
      });
      queue = new MemoryAgentQueue({ maxSize: 50, flushInterval: 30_000, onFlush: failFlush });
      queue.enqueue(makeItem('item'));

      await expect(queue.flush()).rejects.toThrow('flush failed');
    });

    it('should restore items on flush failure', async () => {
      const failFlush = vi.fn(async () => {
        throw new Error('transient error');
      });
      queue = new MemoryAgentQueue({ maxSize: 50, flushInterval: 30_000, onFlush: failFlush });
      queue.enqueue(makeItem('important data'));

      await expect(queue.flush()).rejects.toThrow('transient error');

      // Items should be restored
      expect(queue.size).toBe(1);

      // Dedup should still work (hashes restored)
      const result = queue.enqueue(makeItem('important data'));
      expect(result).toBe(false);
    });
  });

  describe('timer flush', () => {
    it('should auto-flush on timer interval', async () => {
      vi.useFakeTimers();
      queue = new MemoryAgentQueue({ maxSize: 50, flushInterval: 1000, onFlush });
      queue.enqueue(makeItem('timed'));

      // Advance past flush interval
      await vi.advanceTimersByTimeAsync(1100);

      expect(onFlush).toHaveBeenCalledOnce();
      expect(queue.size).toBe(0);
    });
  });

  describe('stop', () => {
    it('should clear queue and stop timer', () => {
      queue = new MemoryAgentQueue({ maxSize: 50, flushInterval: 30_000, onFlush });
      queue.enqueue(makeItem('will be cleared'));
      queue.stop();
      expect(queue.size).toBe(0);
    });
  });
});
