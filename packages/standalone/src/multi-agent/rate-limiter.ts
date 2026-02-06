/**
 * Rate Limiter for Multi-Agent Operations
 *
 * Provides sliding window rate limiting to prevent API abuse
 * and ensure stable performance across different platforms.
 */

export interface RateLimitConfig {
  /** Maximum requests per window */
  maxRequests: number;
  /** Window duration in milliseconds */
  windowMs: number;
  /** Grace period for burst requests */
  burstAllowance?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  retryAfter?: number;
}

/**
 * Sliding Window Rate Limiter
 *
 * Uses a sliding window approach for accurate rate limiting.
 * Automatically cleans up old entries to prevent memory leaks.
 */
export class RateLimiter {
  private requests = new Map<string, number[]>();
  private config: Required<RateLimitConfig>;
  private cleanupInterval: NodeJS.Timeout;

  constructor(config: RateLimitConfig) {
    this.config = {
      burstAllowance: 2,
      ...config,
    };

    // Cleanup old entries every minute
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000);
  }

  /**
   * Check if request is allowed for the given key
   */
  checkLimit(key: string): RateLimitResult {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    // Get or create request history for this key
    let requestTimes = this.requests.get(key) || [];

    // Remove requests outside the current window
    requestTimes = requestTimes.filter((time) => time > windowStart);

    // Check if we're within limits (including burst allowance)
    const maxWithBurst = this.config.maxRequests + this.config.burstAllowance;
    const allowed = requestTimes.length < maxWithBurst;

    if (allowed) {
      // Add current request
      requestTimes.push(now);
      this.requests.set(key, requestTimes);
    }

    // Calculate reset time (when oldest request will expire)
    const oldestRequest = requestTimes[0];
    const resetTime = oldestRequest ? oldestRequest + this.config.windowMs : now;

    // Calculate retry-after for denied requests
    const retryAfter =
      !allowed && requestTimes.length > 0 ? Math.ceil((resetTime - now) / 1000) : undefined;

    return {
      allowed,
      remaining: Math.max(0, this.config.maxRequests - requestTimes.length),
      resetTime,
      retryAfter,
    };
  }

  /**
   * Clean up old request records to prevent memory leaks
   */
  private cleanup(): void {
    const cutoff = Date.now() - this.config.windowMs;

    for (const [key, times] of this.requests.entries()) {
      const filtered = times.filter((time) => time > cutoff);

      if (filtered.length === 0) {
        // No recent requests, remove entry
        this.requests.delete(key);
      } else if (filtered.length < times.length) {
        // Some old requests, update entry
        this.requests.set(key, filtered);
      }
    }
  }

  /**
   * Get current stats for debugging
   */
  getStats(): { totalKeys: number; totalRequests: number } {
    let totalRequests = 0;

    for (const times of this.requests.values()) {
      totalRequests += times.length;
    }

    return {
      totalKeys: this.requests.size,
      totalRequests,
    };
  }

  /**
   * Reset all rate limiting data
   */
  reset(): void {
    this.requests.clear();
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.requests.clear();
  }
}

/**
 * Platform-specific rate limit configurations
 */
export const RATE_LIMITS = {
  // Slack API limits: ~1 request per second per workspace
  SLACK_MENTION: {
    maxRequests: 50,
    windowMs: 60000, // 1 minute
    burstAllowance: 5,
  },

  // Discord API limits: more generous
  DISCORD_MENTION: {
    maxRequests: 100,
    windowMs: 60000, // 1 minute
    burstAllowance: 10,
  },

  // General agent operations
  AGENT_OPERATIONS: {
    maxRequests: 30,
    windowMs: 60000, // 1 minute
    burstAllowance: 3,
  },
} as const;
