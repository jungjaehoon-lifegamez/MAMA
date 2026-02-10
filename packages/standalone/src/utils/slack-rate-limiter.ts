/**
 * Slack API Rate Limiter
 *
 * Implements rate limiting and request queuing for Slack Web API calls
 * to prevent hitting API limits and ensure reliable operation.
 *
 * Slack API Limits:
 * - Tier 1: 1+ request per second per workspace
 * - Tier 2: 20+ requests per minute per workspace
 * - Tier 3: 50+ requests per minute per workspace
 * - Tier 4: 100+ requests per minute per workspace
 *
 * Reference: https://api.slack.com/docs/rate-limits
 */

import { createSafeLogger } from './log-sanitizer.js';

export interface RateLimitConfig {
  /** Maximum requests per minute (default: 50) */
  maxRequestsPerMinute?: number;
  /** Minimum interval between requests in ms (default: 1000ms) */
  minIntervalMs?: number;
  /** Maximum queue size (default: 100) */
  maxQueueSize?: number;
  /** Request timeout in ms (default: 30000ms) */
  requestTimeoutMs?: number;
  /** Enable retry on rate limit errors (default: true) */
  enableRetry?: boolean;
  /** Maximum retry attempts (default: 3) */
  maxRetries?: number;
  /** Base retry delay in ms (default: 2000ms) */
  retryDelayMs?: number;
}

export interface QueuedRequest<T> {
  /** Unique request ID for tracking */
  id: string;
  /** The API call to execute */
  apiCall: () => Promise<T>;
  /** Promise resolve function */
  resolve: (value: T) => void;
  /** Promise reject function */
  reject: (error: Error) => void;
  /** Timestamp when request was queued */
  queuedAt: number;
  /** Number of retry attempts */
  attempts: number;
  /** Request timeout handle */
  timeoutHandle?: NodeJS.Timeout;
  /** Retry delay timeout handle (for pending retry) */
  retryTimeoutHandle?: NodeJS.Timeout;
}

export interface RateLimitStats {
  /** Total requests processed */
  totalRequests: number;
  /** Requests currently queued */
  queuedRequests: number;
  /** Rate limit hits */
  rateLimitHits: number;
  /** Failed requests */
  failedRequests: number;
  /** Average response time in ms */
  averageResponseTime: number;
  /** Last request timestamp */
  lastRequestTime: number;
}

const DEFAULT_CONFIG: Required<RateLimitConfig> = {
  maxRequestsPerMinute: 50,
  minIntervalMs: 1000,
  maxQueueSize: 100,
  requestTimeoutMs: 30000,
  enableRetry: true,
  maxRetries: 3,
  retryDelayMs: 2000,
};

/**
 * Slack API Rate Limiter with request queuing and retry logic
 */
export class SlackRateLimiter {
  private config: Required<RateLimitConfig>;
  private logger = createSafeLogger('SlackRateLimiter');

  /** Queue of pending requests */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private requestQueue: QueuedRequest<any>[] = [];

  /** Whether the limiter is currently processing requests */
  private processing = false;

  /** Timestamps of recent requests for rate tracking */
  private requestHistory: number[] = [];

  /** Last API call timestamp */
  private lastRequestTime = 0;

  /** Statistics tracking */
  private stats: RateLimitStats = {
    totalRequests: 0,
    queuedRequests: 0,
    rateLimitHits: 0,
    failedRequests: 0,
    averageResponseTime: 0,
    lastRequestTime: 0,
  };

  /** Response time tracking for averages */
  private responseTimes: number[] = [];

  constructor(config: RateLimitConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Queue an API request for rate-limited execution
   */
  async queueRequest<T>(apiCall: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const requestId = this.generateRequestId();

      // Check queue size limit
      if (this.requestQueue.length >= this.config.maxQueueSize) {
        const error = new Error(
          `Request queue full (${this.config.maxQueueSize} requests). Try again later.`
        );
        this.logger.warn('Request queue full, rejecting new request');
        reject(error);
        return;
      }

      // Create queued request
      const queuedRequest: QueuedRequest<T> = {
        id: requestId,
        apiCall,
        resolve,
        reject,
        queuedAt: Date.now(),
        attempts: 0,
      };

      // Add timeout
      queuedRequest.timeoutHandle = setTimeout(() => {
        this.removeFromQueue(requestId);
        const error = new Error(
          `Request ${requestId} timed out after ${this.config.requestTimeoutMs}ms`
        );
        reject(error);
      }, this.config.requestTimeoutMs);

      // Add to queue
      this.requestQueue.push(queuedRequest);
      this.stats.queuedRequests = this.requestQueue.length;

      this.logger.log(`Queued request ${requestId} (queue size: ${this.requestQueue.length})`);

      // Start processing if not already running
      if (!this.processing) {
        this.startProcessing();
      }
    });
  }

  /**
   * Start processing the request queue
   */
  private async startProcessing(): Promise<void> {
    if (this.processing) return;

    this.processing = true;
    this.logger.log('Started request queue processing');

    while (this.requestQueue.length > 0) {
      const request = this.requestQueue.shift();
      if (!request) break;

      try {
        await this.processRequest(request);
      } catch (error) {
        this.logger.error(`Failed to process request ${request.id}:`, error);
      }

      this.stats.queuedRequests = this.requestQueue.length;
    }

    this.processing = false;
    this.logger.log('Finished request queue processing');
  }

  /**
   * Process a single request with rate limiting
   */
  private async processRequest<T>(request: QueuedRequest<T>): Promise<void> {
    // Clean up timeout
    if (request.timeoutHandle) {
      clearTimeout(request.timeoutHandle);
      delete request.timeoutHandle;
    }

    // Check if we need to wait before making the request
    await this.waitForRateLimit();

    request.attempts++;
    const startTime = Date.now();

    try {
      this.logger.log(`Processing request ${request.id} (attempt ${request.attempts})`);

      // Execute the API call
      const result = await request.apiCall();

      // Update statistics
      const responseTime = Date.now() - startTime;
      this.updateStats(responseTime, true);

      this.logger.log(`Request ${request.id} completed in ${responseTime}ms`);
      request.resolve(result);
    } catch (error) {
      const responseTime = Date.now() - startTime;

      // Check if it's a rate limit error
      if (this.isRateLimitError(error)) {
        this.stats.rateLimitHits++;
        this.logger.warn(`Rate limit hit for request ${request.id}`);

        // Retry if enabled and under limit — defer stats until final attempt
        if (this.config.enableRetry && request.attempts < this.config.maxRetries) {
          const retryDelay = this.calculateRetryDelay(request.attempts);
          this.logger.log(`Retrying request ${request.id} in ${retryDelay}ms`);

          // Store retry timeout handle for cancellation in reset()
          request.retryTimeoutHandle = setTimeout(() => {
            // Clear retry timeout handle before re-queueing
            delete request.retryTimeoutHandle;

            // Re-attach timeout for retry (same timeout as original request)
            request.timeoutHandle = setTimeout(() => {
              this.removeFromQueue(request.id);
              const error = new Error(
                `Request timeout after ${this.config.requestTimeoutMs}ms (retry attempt)`
              );
              request.reject(error);
            }, this.config.requestTimeoutMs);

            this.requestQueue.unshift(request); // Put back at front of queue
            this.startProcessing();
          }, retryDelay);
          return;
        }
      }

      // Only record failure stats for final failures (not retryable intermediate errors)
      this.updateStats(responseTime, false);
      this.logger.error(`Request ${request.id} failed after ${request.attempts} attempts:`, error);
      request.reject(error as Error);
    }
  }

  /**
   * Wait if necessary to respect rate limits
   */
  private async waitForRateLimit(): Promise<void> {
    let now = Date.now();

    // Clean old request history (older than 1 minute)
    this.requestHistory = this.requestHistory.filter((time) => now - time < 60000);

    // Check requests per minute limit
    if (this.requestHistory.length >= this.config.maxRequestsPerMinute) {
      const oldestRequest = Math.min(...this.requestHistory);
      const waitTime = 60000 - (now - oldestRequest);
      if (waitTime > 0) {
        this.logger.log(`Rate limit reached, waiting ${waitTime}ms`);
        await this.sleep(waitTime);
        now = Date.now(); // Refresh timestamp after sleep
      }
    }

    // Check minimum interval between requests
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.config.minIntervalMs) {
      const waitTime = this.config.minIntervalMs - timeSinceLastRequest;
      this.logger.log(`Minimum interval not met, waiting ${waitTime}ms`);
      await this.sleep(waitTime);
      now = Date.now(); // Refresh timestamp after sleep
    }

    // Record this request (now reflects actual time after any waits)
    this.lastRequestTime = now;
    this.requestHistory.push(now);
    this.stats.lastRequestTime = now;
  }

  /**
   * Check if an error is a rate limit error with strict type validation
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private isRateLimitError(error: any): boolean {
    // Ensure error is an object before checking properties
    if (!error || typeof error !== 'object') {
      return false;
    }

    // Slack API returns 429 status for rate limits
    if (typeof error.status === 'number' && error.status === 429) {
      return true;
    }

    // Check for Slack-specific rate limit error codes
    if (typeof error.code === 'string' && error.code === 'rate_limited') {
      return true;
    }

    // Check error message with type safety
    if (typeof error.message === 'string' && error.message.toLowerCase().includes('rate limit')) {
      return true;
    }

    return false;
  }

  /**
   * Calculate retry delay with exponential backoff
   */
  private calculateRetryDelay(attempt: number): number {
    const baseDelay = this.config.retryDelayMs;
    const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
    const jitter = Math.random() * 1000; // Add 0-1000ms jitter
    return Math.min(exponentialDelay + jitter, 30000); // Max 30s delay
  }

  /**
   * Update statistics tracking
   */
  private updateStats(responseTime: number, success: boolean): void {
    this.stats.totalRequests++;
    if (!success) {
      this.stats.failedRequests++;
    }

    // Track response times for average
    this.responseTimes.push(responseTime);
    if (this.responseTimes.length > 100) {
      this.responseTimes.shift(); // Keep only last 100
    }

    this.stats.averageResponseTime =
      this.responseTimes.reduce((sum, time) => sum + time, 0) / this.responseTimes.length;
  }

  /**
   * Remove a request from the queue by ID
   */
  private removeFromQueue(requestId: string): void {
    const index = this.requestQueue.findIndex((req) => req.id === requestId);
    if (index !== -1) {
      const request = this.requestQueue.splice(index, 1)[0];
      if (request.timeoutHandle) {
        clearTimeout(request.timeoutHandle);
      }
      this.stats.queuedRequests = this.requestQueue.length;
    }
  }

  /**
   * Generate a unique request ID
   */
  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  /**
   * Sleep for the specified number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get current rate limiter statistics
   */
  getStats(): RateLimitStats {
    return { ...this.stats };
  }

  /**
   * Clear the request queue and reset statistics
   */
  reset(): void {
    // Reject all queued requests and cancel all timers
    for (const request of this.requestQueue) {
      if (request.timeoutHandle) {
        clearTimeout(request.timeoutHandle);
      }
      if (request.retryTimeoutHandle) {
        clearTimeout(request.retryTimeoutHandle);
      }
      request.reject(new Error('Rate limiter reset'));
    }

    this.requestQueue = [];
    this.requestHistory = [];
    this.responseTimes = [];
    this.processing = false;

    this.stats = {
      totalRequests: 0,
      queuedRequests: 0,
      rateLimitHits: 0,
      failedRequests: 0,
      averageResponseTime: 0,
      lastRequestTime: 0,
    };

    this.logger.log('Rate limiter reset');
  }

  /**
   * Get current queue size
   */
  getQueueSize(): number {
    return this.requestQueue.length;
  }

  /**
   * Check if the limiter is currently processing requests
   */
  isProcessing(): boolean {
    return this.processing;
  }
}
