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
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';

const { DebugLogger } = debugLogger as unknown as {
  DebugLogger: new (context?: string) => {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};

const logger = new DebugLogger('MemoryAgentQueue');

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

function computeHash(messages: ConversationMessage[], scopes: MemoryScopeRef[] = []): string {
  const scopeKey = scopes
    .map((s) => `${s.kind}:${s.id}`)
    .sort()
    .join('|');
  const content = messages.map((m) => `${m.role}:${m.content}`).join('\n');
  return crypto.createHash('sha256').update(`${scopeKey}\n${content}`).digest('hex');
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
          logger.error('timer flush error:', err);
        });
      }
    }, this.flushInterval);
  }

  get size(): number {
    return this.queue.length;
  }

  /**
   * Enqueue an item. Triggers flush on overflow, drops oldest if still full.
   * Returns false if item was deduplicated (skipped).
   */
  enqueue(item: QueueItem): boolean {
    const hash = computeHash(item.messages, item.scopes);

    // Deduplication: skip if same content hash already queued
    if (this.hashes.has(hash)) {
      return false;
    }

    // Trigger flush when at max capacity (don't drop items)
    if (this.queue.length >= this.maxSize && !this.flushing) {
      this.flush().catch((err) => {
        logger.error('overflow flush error:', err);
      });
    }

    // If still full after flush attempt (flushing in progress), drop oldest
    if (this.queue.length >= this.maxSize) {
      const dropped = this.queue.shift()!;
      if (dropped._hash) {
        this.hashes.delete(dropped._hash);
      }
      logger.warn('queue full during flush, dropped oldest item');
    }

    this.queue.push({ ...item, _hash: hash });
    this.hashes.add(hash);
    return true;
  }

  /**
   * Flush all queued items through the onFlush callback.
   * Restores items and hashes on failure.
   */
  async flush(): Promise<void> {
    if (this.queue.length === 0 || this.flushing) {
      return;
    }

    this.flushing = true;
    const items = this.queue.splice(0);
    const savedHashes = new Set(this.hashes);
    this.hashes.clear();

    const count = items.length;
    const start = Date.now();

    try {
      await this.onFlush(items);
      const duration = Date.now() - start;
      logger.info(`flushed ${count} items in ${duration}ms`);
    } catch (err) {
      // Restore items and hashes on failure
      this.queue.unshift(...items);
      for (const h of savedHashes) {
        this.hashes.add(h);
      }
      logger.error(`flush failed for ${count} items:`, err);
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
