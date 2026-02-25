/**
 * MetricsCleanup — periodic cleanup of old metrics (STORY-022)
 *
 * Runs on a configurable interval, deleting metrics older than retention period.
 */

import { MetricsStore } from './metrics-store.js';

export interface MetricsCleanupOptions {
  /** Retention period in milliseconds (default: 7 days) */
  retentionMs?: number;
  /** Cleanup interval in milliseconds (default: 1 hour) */
  intervalMs?: number;
}

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export class MetricsCleanup {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly retentionMs: number;
  private readonly intervalMs: number;

  constructor(
    private store: MetricsStore,
    options?: MetricsCleanupOptions
  ) {
    this.retentionMs = options?.retentionMs ?? DEFAULT_RETENTION_MS;
    this.intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    // Run once immediately, then on interval
    this.runCleanup();
    this.timer = setInterval(() => this.runCleanup(), this.intervalMs);
    // Unref so it doesn't prevent process exit
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  runCleanup(): number {
    try {
      return this.store.cleanup(this.retentionMs);
    } catch {
      return 0;
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}
