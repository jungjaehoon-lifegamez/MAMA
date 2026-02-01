/**
 * Token Keep-Alive Scheduler
 *
 * Periodically runs Claude CLI to keep OAuth token refreshed.
 * Prevents token expiration during long idle periods.
 *
 * Default: Every 6 hours
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface TokenKeepAliveOptions {
  /** Interval in milliseconds (default: 6 hours) */
  intervalMs?: number;
  /** Callback on successful refresh */
  onRefresh?: () => void;
  /** Callback on refresh error */
  onError?: (error: Error) => void;
}

export class TokenKeepAlive {
  private readonly intervalMs: number;
  private readonly onRefresh?: () => void;
  private readonly onError?: (error: Error) => void;
  private timer: NodeJS.Timeout | null = null;
  private lastRefresh: number | null = null;

  constructor(options: TokenKeepAliveOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.onRefresh = options.onRefresh;
    this.onError = options.onError;
  }

  /**
   * Start the keep-alive scheduler
   */
  start(): void {
    if (this.timer) {
      console.log('[TokenKeepAlive] Already running');
      return;
    }

    // Run immediately on start to ensure token is valid
    this.refresh().catch(() => {
      // Ignore initial error - will retry on interval
    });

    this.timer = setInterval(() => {
      this.refresh().catch(() => {
        // Error already logged in refresh()
      });
    }, this.intervalMs);

    // Don't prevent process exit
    this.timer.unref();

    const hours = Math.round(this.intervalMs / (60 * 60 * 1000));
    console.log(`[TokenKeepAlive] Started (every ${hours} hours)`);
  }

  /**
   * Stop the keep-alive scheduler
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[TokenKeepAlive] Stopped');
    }
  }

  /**
   * Manually refresh the token
   */
  async refresh(): Promise<boolean> {
    try {
      // Run simple claude command to trigger token refresh
      await execAsync('claude --version', { timeout: 30000 });

      this.lastRefresh = Date.now();
      console.log(`[TokenKeepAlive] Token refreshed at ${new Date().toISOString()}`);
      this.onRefresh?.();
      return true;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error(`[TokenKeepAlive] Refresh failed: ${err.message}`);
      this.onError?.(err);
      return false;
    }
  }

  /**
   * Get last refresh timestamp
   */
  getLastRefresh(): number | null {
    return this.lastRefresh;
  }

  /**
   * Check if keep-alive is running
   */
  isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * Get time until next refresh (in milliseconds)
   */
  getTimeUntilNextRefresh(): number | null {
    if (!this.timer || !this.lastRefresh) {
      return null;
    }
    const elapsed = Date.now() - this.lastRefresh;
    return Math.max(0, this.intervalMs - elapsed);
  }
}
