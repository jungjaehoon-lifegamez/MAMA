/**
 * Memory Agent Debounce Queue
 *
 * Implements the Kagemusha delta-digest pattern:
 * - Buffers incoming hook events
 * - Max 50 items, oldest dropped on overflow
 * - Flush triggers: timer (30s) or queue full
 * - Deduplication via content hash
 */

import crypto from 'node:crypto';

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface MemoryScopeRef {
  kind: 'global' | 'user' | 'channel' | 'project';
  id: string;
}

export interface QueueItem {
  messages: ConversationMessage[];
  scopes: MemoryScopeRef[];
  timestamp: number;
  /** Internal: content hash for deduplication */
  _hash?: string;
}

export interface MemoryAgentQueueOptions {
  maxSize: number;
  flushInterval: number;
  onFlush: (items: QueueItem[]) => Promise<void>;
}

function computeHash(messages: ConversationMessage[]): string {
  const content = messages.map((m) => `${m.role}:${m.content}`).join('\n');
  return crypto.createHash('sha256').update(content).digest('hex');
}

export class MemoryAgentQueue {
  private queue: QueueItem[] = [];
  private hashes: Set<string> = new Set();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly maxSize: number;
  private readonly flushInterval: number;
  private readonly onFlush: (items: QueueItem[]) => Promise<void>;
  private flushing = false;

  constructor(options: MemoryAgentQueueOptions) {
    this.maxSize = options.maxSize;
    this.flushInterval = options.flushInterval;
    this.onFlush = options.onFlush;

    this.timer = setInterval(() => {
      if (this.queue.length > 0 && !this.flushing) {
        this.flush().catch((err) => {
          console.error('[MemoryAgentQueue] timer flush error:', err);
        });
      }
    }, this.flushInterval);
  }

  get size(): number {
    return this.queue.length;
  }

  /**
   * Enqueue an item. Drops oldest if at max capacity.
   * Returns false if item was deduplicated (skipped).
   */
  enqueue(item: QueueItem): boolean {
    const hash = computeHash(item.messages);

    // Deduplication: skip if same content hash already queued
    if (this.hashes.has(hash)) {
      return false;
    }

    // Drop oldest if at max capacity
    if (this.queue.length >= this.maxSize) {
      const dropped = this.queue.shift()!;
      if (dropped._hash) {
        this.hashes.delete(dropped._hash);
      }
      console.warn('[MemoryAgentQueue] queue full, dropped oldest item');
    }

    this.queue.push({ ...item, _hash: hash });
    this.hashes.add(hash);
    return true;
  }

  /**
   * Flush all queued items through the onFlush callback.
   */
  async flush(): Promise<void> {
    if (this.queue.length === 0 || this.flushing) {
      return;
    }

    this.flushing = true;
    const items = this.queue.splice(0);
    this.hashes.clear();

    const count = items.length;
    const start = Date.now();

    try {
      await this.onFlush(items);
      const duration = Date.now() - start;
      console.log(`[MemoryAgentQueue] flushed ${count} items in ${duration}ms`);
    } catch (err) {
      console.error(`[MemoryAgentQueue] flush failed for ${count} items:`, err);
      throw err;
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Stop the flush timer and clear the queue.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.queue = [];
    this.hashes.clear();
  }
}
