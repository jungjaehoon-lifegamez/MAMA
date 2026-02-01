/**
 * Lane-based Concurrency Manager
 *
 * Implements a queue system for managing concurrent task execution.
 * Based on OpenClaw's command-queue.js pump pattern.
 *
 * Key features:
 * - Session lanes: Ensure same-session messages are processed in order
 * - Global lane: Limit total concurrent API calls (rate limit protection)
 * - 2-stage queueing: Session lane → Global lane
 *
 * @example
 * ```typescript
 * const manager = new LaneManager();
 *
 * // Simple enqueue
 * const result = await manager.enqueue('session:user1', async () => {
 *   return await callApi();
 * });
 *
 * // 2-stage queueing (session → global)
 * const result = await manager.enqueueWithSession('user1', async () => {
 *   return await callApi();
 * });
 * ```
 */

import {
  type LaneState,
  type QueueEntry,
  type LaneManagerConfig,
  type EnqueueOptions,
  type LaneLogger,
  defaultLogger,
} from './types.js';

export class LaneManager {
  private lanes: Map<string, LaneState> = new Map();
  private config: Required<Omit<LaneManagerConfig, 'logger'>> & { logger: LaneLogger };

  constructor(config?: LaneManagerConfig) {
    this.config = {
      defaultMaxConcurrent: config?.defaultMaxConcurrent ?? 1,
      warnAfterMs: config?.warnAfterMs ?? 2000,
      logger: config?.logger ?? defaultLogger,
    };
  }

  /**
   * Get or create lane state
   */
  private getLaneState(lane: string): LaneState {
    let state = this.lanes.get(lane);
    if (!state) {
      state = {
        lane,
        queue: [],
        active: 0,
        maxConcurrent: this.config.defaultMaxConcurrent,
        draining: false,
      };
      this.lanes.set(lane, state);
    }
    return state;
  }

  /**
   * Drain lane queue using pump pattern
   * Executes tasks up to maxConcurrent limit
   */
  private drainLane(lane: string): void {
    const state = this.getLaneState(lane);
    if (state.draining) return;
    state.draining = true;

    const pump = () => {
      // Execute tasks up to concurrent limit
      while (state.active < state.maxConcurrent && state.queue.length > 0) {
        const entry = state.queue.shift()!;
        const waitedMs = Date.now() - entry.enqueuedAt;

        // Warn if waited too long
        if (waitedMs >= entry.warnAfterMs) {
          entry.onWait?.(waitedMs, state.queue.length);
          this.config.logger.warn(
            `Long wait: lane=${lane} waited=${waitedMs}ms queue=${state.queue.length}`
          );
        }

        state.active += 1;

        // Execute task asynchronously
        (async () => {
          const startTime = Date.now();
          try {
            const result = await entry.task();
            state.active -= 1;
            this.config.logger.debug(
              `Task done: lane=${lane} duration=${Date.now() - startTime}ms active=${state.active} queued=${state.queue.length}`
            );
            pump(); // Continue processing
            entry.resolve(result);
          } catch (err) {
            state.active -= 1;
            this.config.logger.debug(
              `Task error: lane=${lane} duration=${Date.now() - startTime}ms error="${err}"`
            );
            pump(); // Continue processing even on error
            entry.reject(err as Error);
          }
        })();
      }

      state.draining = false;
    };

    pump();
  }

  /**
   * Enqueue a task in a lane
   *
   * @param lane - Lane identifier
   * @param task - Async task to execute
   * @param options - Enqueue options
   * @returns Promise that resolves with task result
   */
  enqueue<T>(lane: string, task: () => Promise<T>, options?: EnqueueOptions): Promise<T> {
    const state = this.getLaneState(lane);

    return new Promise((resolve, reject) => {
      const entry: QueueEntry<T> = {
        task,
        resolve: resolve as (value: unknown) => void,
        reject,
        enqueuedAt: Date.now(),
        warnAfterMs: options?.warnAfterMs ?? this.config.warnAfterMs,
        onWait: options?.onWait,
      };

      state.queue.push(entry as QueueEntry<unknown>);
      this.config.logger.debug(
        `Enqueued: lane=${lane} queueSize=${state.queue.length + state.active}`
      );
      this.drainLane(lane);
    });
  }

  /**
   * Resolve session lane name from session key
   * Ensures consistent naming: "user1" → "session:user1"
   */
  resolveSessionLane(sessionKey: string): string {
    const cleaned = sessionKey.trim() || 'main';
    return cleaned.startsWith('session:') ? cleaned : `session:${cleaned}`;
  }

  /**
   * Resolve global lane name
   * Returns "main" if not specified
   */
  resolveGlobalLane(lane?: string): string {
    const cleaned = lane?.trim();
    return cleaned || 'main';
  }

  /**
   * 2-stage queueing: Session lane → Global lane
   *
   * This ensures:
   * 1. Same-session messages are processed in order (session lane)
   * 2. Total API calls are rate-limited (global lane)
   *
   * @param sessionKey - Session identifier (will be prefixed with "session:")
   * @param task - Async task to execute
   * @param globalLane - Global lane name (default: "main")
   */
  enqueueWithSession<T>(
    sessionKey: string,
    task: () => Promise<T>,
    globalLane?: string
  ): Promise<T> {
    const sessionLaneName = this.resolveSessionLane(sessionKey);
    const globalLaneName = this.resolveGlobalLane(globalLane);

    // Nested queueing: session → global
    return this.enqueue(sessionLaneName, () => this.enqueue(globalLaneName, task));
  }

  /**
   * Set max concurrent tasks for a lane
   */
  setLaneMaxConcurrent(lane: string, maxConcurrent: number): void {
    const state = this.getLaneState(lane);
    state.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
    // Trigger drain in case we increased the limit
    this.drainLane(lane);
  }

  /**
   * Get current queue size for a lane
   * Includes both queued and active tasks
   */
  getQueueSize(lane: string): number {
    const state = this.lanes.get(lane);
    if (!state) return 0;
    return state.queue.length + state.active;
  }

  /**
   * Get total queue size across all lanes
   */
  getTotalQueueSize(): number {
    let total = 0;
    for (const state of this.lanes.values()) {
      total += state.queue.length + state.active;
    }
    return total;
  }

  /**
   * Clear all pending tasks in a lane
   * Active tasks continue to completion
   *
   * @returns Number of tasks removed
   */
  clearLane(lane: string): number {
    const state = this.lanes.get(lane);
    if (!state) return 0;

    const removed = state.queue.length;

    // Reject all pending tasks
    for (const entry of state.queue) {
      entry.reject(new Error('Lane cleared'));
    }

    state.queue.length = 0;
    return removed;
  }

  /**
   * Get all lane names
   */
  getLanes(): string[] {
    return Array.from(this.lanes.keys());
  }

  /**
   * Get lane statistics
   */
  getStats(): Map<string, { queued: number; active: number; maxConcurrent: number }> {
    const stats = new Map();
    for (const [lane, state] of this.lanes) {
      stats.set(lane, {
        queued: state.queue.length,
        active: state.active,
        maxConcurrent: state.maxConcurrent,
      });
    }
    return stats;
  }
}

// Singleton instance for global use
let globalLaneManager: LaneManager | null = null;

/**
 * Get or create global LaneManager instance
 */
export function getGlobalLaneManager(config?: LaneManagerConfig): LaneManager {
  if (!globalLaneManager) {
    globalLaneManager = new LaneManager(config);
  }
  return globalLaneManager;
}

/**
 * Reset global LaneManager (mainly for testing)
 */
export function resetGlobalLaneManager(): void {
  globalLaneManager = null;
}
