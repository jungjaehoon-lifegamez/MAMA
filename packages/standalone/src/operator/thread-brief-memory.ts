/**
 * Per-thread memory of the console brief already sent on a durable thread.
 *
 * "Fixed things once, turns carry only deltas": the owner operating brief is standing
 * policy, not per-turn evidence. Re-embedding it in every owner-event and scheduled turn
 * spent more host prompt text on repetition than every agent reply of the day combined.
 *
 * The rule is exactly one hash comparison: send the brief when this thread has not
 * already been given this exact text, otherwise omit it. A restart clears the map, so a
 * resumed thread counts as fresh and gets the brief once - the same in-process,
 * bounded-LRU shape as ThreadHintMemory (experience-hints.ts).
 *
 * Deliberately NOT part of the session policy fingerprint: an owner brief correction must
 * refresh what the thread reads, never rotate the thread itself.
 */

import { createHash } from 'node:crypto';

const DEFAULT_LIMIT = 100;

export function briefContentHash(brief: string): string {
  return createHash('sha256').update(brief).digest('hex').slice(0, 16);
}

export class ThreadBriefMemory {
  private readonly seen = new Map<string, string>();

  constructor(private readonly limit: number = DEFAULT_LIMIT) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('[thread-brief-memory] limit must be a positive integer');
    }
  }

  /**
   * Record this brief against the thread and report whether the turn should carry it.
   * Empty text is never "sent" and never displaces a remembered hash.
   */
  admit(threadId: string, brief: string | null | undefined): boolean {
    const text = brief?.trim() ?? '';
    if (!text) return false;
    const hash = briefContentHash(text);
    const prior = this.seen.get(threadId);
    // Re-insert so recency ordering is the eviction order.
    this.seen.delete(threadId);
    this.seen.set(threadId, hash);
    while (this.seen.size > this.limit) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
    return prior !== hash;
  }

  /** Test/diagnostic seam: forget a thread (e.g. when its thread id rotates). */
  forget(threadId: string): void {
    this.seen.delete(threadId);
  }
}
