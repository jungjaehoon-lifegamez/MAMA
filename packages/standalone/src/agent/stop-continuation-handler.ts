/**
 * Stop Continuation Handler for Single-Agent AgentLoop
 *
 * Opt-in handler that detects incomplete responses from the agent,
 * decides whether to auto-continue, and prevents infinite loops.
 *
 * Unlike TaskContinuationEnforcer (multi-agent swarm), this is designed
 * for the single-agent AgentLoop with manual stop support and
 * channel-level state tracking.
 *
 * Disabled by default — must be explicitly enabled via config.
 */

/**
 * Configuration for the StopContinuationHandler.
 * Disabled by default to preserve backward compatibility.
 */
export interface StopContinuationConfig {
  /** Whether continuation detection is enabled. @default false */
  enabled: boolean;
  /** Maximum number of auto-continuation retries per channel. @default 3 */
  maxRetries: number;
  /** Markers that indicate the response is complete (checked in last 3 lines). */
  completionMarkers: string[];
}

/**
 * Result of analyzing a response for continuation need.
 */
export interface ContinuationDecision {
  /** Whether the handler recommends continuing. */
  shouldContinue: boolean;
  /** Human-readable reason for the decision. */
  reason: string;
  /** Prompt to send for continuation (only set when shouldContinue is true). */
  continuationPrompt?: string;
  /** Current attempt number for this channel. */
  attempt: number;
  /** Whether maxRetries has been reached. */
  maxRetriesReached: boolean;
}

const DEFAULT_CONFIG: StopContinuationConfig = {
  enabled: false,
  maxRetries: 3,
  completionMarkers: ['DONE', '완료', '✅', 'TASK_COMPLETE'],
};

/**
 * Patterns that suggest a response is incomplete and needs continuation.
 * Supports both English and Korean patterns.
 */
const INCOMPLETE_PATTERNS: RegExp[] = [
  /I'll continue/i,
  /계속하겠/,
  /계속할게/,
  /to be continued/i,
  /let me continue/i,
  /이어서/,
  /다음으로/,
];

/**
 * Minimum response length to trigger truncation-based incomplete detection.
 * Responses shorter than this are not considered truncated.
 */
const TRUNCATION_LENGTH_THRESHOLD = 1800;

/**
 * Terminal punctuation characters that indicate a sentence ended normally.
 */
const TERMINAL_PUNCTUATION = '.!?。！？…';

/**
 * Number of trailing lines to check for completion markers.
 */
const COMPLETION_CHECK_LINES = 3;

/**
 * Maximum characters from the end of a response used as context
 * in the continuation prompt.
 */
const CONTINUATION_CONTEXT_LENGTH = 200;

/**
 * StopContinuationHandler
 *
 * Manages auto-continuation state for single-agent AgentLoop channels.
 * Tracks per-channel attempt counts and manual stop state.
 */
export class StopContinuationHandler {
  private readonly config: StopContinuationConfig;

  /** Per-channel continuation attempt counts. Key = channelKey. */
  private readonly attempts: Map<string, number> = new Map();

  /** Channels that have been manually stopped. */
  private readonly stoppedChannels: Set<string> = new Set();

  constructor(config?: Partial<StopContinuationConfig>) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
  }

  /**
   * Analyze a response and decide whether to auto-continue.
   *
   * Decision flow:
   * 1. If handler is disabled → return disabled decision
   * 2. If channel is manually stopped → return manually_stopped
   * 3. If response has completion marker in last 3 lines → reset + complete
   * 4. If max retries reached → reset + complete (safety valve)
   * 5. If response looks incomplete → increment attempt + continue
   * 6. Otherwise → normal completion
   */
  analyzeResponse(channelKey: string, response: string): ContinuationDecision {
    // 1. Disabled check
    if (!this.config.enabled) {
      return {
        shouldContinue: false,
        reason: 'disabled',
        attempt: 0,
        maxRetriesReached: false,
      };
    }

    // 2. Manual stop check
    if (this.stoppedChannels.has(channelKey)) {
      return {
        shouldContinue: false,
        reason: 'manually_stopped',
        attempt: this.attempts.get(channelKey) ?? 0,
        maxRetriesReached: false,
      };
    }

    // 3. Completion marker check (last 3 lines, case-insensitive)
    if (this.hasCompletionMarker(response)) {
      this.resetChannel(channelKey);
      return {
        shouldContinue: false,
        reason: 'complete',
        attempt: 0,
        maxRetriesReached: false,
      };
    }

    const currentAttempt = this.attempts.get(channelKey) ?? 0;

    // 4. Max retries safety valve
    if (currentAttempt >= this.config.maxRetries) {
      this.resetChannel(channelKey);
      return {
        shouldContinue: false,
        reason: 'max_retries_reached',
        attempt: currentAttempt,
        maxRetriesReached: true,
      };
    }

    // 5. Incomplete detection
    if (this.isIncomplete(response)) {
      const nextAttempt = currentAttempt + 1;
      this.attempts.set(channelKey, nextAttempt);
      return {
        shouldContinue: true,
        reason: 'incomplete_response',
        continuationPrompt: this.buildContinuationPrompt(response),
        attempt: nextAttempt,
        maxRetriesReached: nextAttempt >= this.config.maxRetries,
      };
    }

    // 6. Normal response — no continuation needed
    this.resetChannel(channelKey);
    return {
      shouldContinue: false,
      reason: 'normal_completion',
      attempt: 0,
      maxRetriesReached: false,
    };
  }

  /**
   * Mark a channel as manually stopped.
   * Prevents further auto-continuation until resetChannel is called.
   */
  markStopped(channelKey: string): void {
    this.stoppedChannels.add(channelKey);
  }

  /**
   * Reset all state for a channel (attempts + stopped).
   */
  resetChannel(channelKey: string): void {
    this.attempts.delete(channelKey);
    this.stoppedChannels.delete(channelKey);
  }

  /**
   * Check whether the handler is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get current attempt count for a channel.
   */
  getAttemptCount(channelKey: string): number {
    return this.attempts.get(channelKey) ?? 0;
  }

  /**
   * Check whether a channel is manually stopped.
   */
  isStopped(channelKey: string): boolean {
    return this.stoppedChannels.has(channelKey);
  }

  /**
   * Check if the last 3 lines of a response contain a completion marker.
   * Case-insensitive comparison.
   */
  private hasCompletionMarker(response: string): boolean {
    const lines = response.split('\n');
    const lastLines = lines.slice(-COMPLETION_CHECK_LINES).join('\n').toLowerCase();

    for (const marker of this.config.completionMarkers) {
      if (lastLines.includes(marker.toLowerCase())) {
        return true;
      }
    }
    return false;
  }

  /**
   * Determine if a response appears incomplete.
   *
   * Checks two heuristics:
   * 1. Explicit continuation patterns (English + Korean)
   * 2. Truncation: response >= 1800 chars and ends without terminal punctuation
   */
  private isIncomplete(response: string): boolean {
    // Check explicit continuation patterns
    for (const pattern of INCOMPLETE_PATTERNS) {
      if (pattern.test(response)) {
        return true;
      }
    }

    // Check truncation heuristic
    if (response.length >= TRUNCATION_LENGTH_THRESHOLD) {
      const trimmed = response.trimEnd();
      const lastChar = trimmed[trimmed.length - 1];
      if (lastChar && !TERMINAL_PUNCTUATION.includes(lastChar)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Build a continuation prompt from the tail of the previous response.
   * Includes the last 200 characters as context and instructs the agent
   * to finish with a completion marker.
   */
  private buildContinuationPrompt(previousResponse: string): string {
    const tail =
      previousResponse.length > CONTINUATION_CONTEXT_LENGTH
        ? previousResponse.slice(-CONTINUATION_CONTEXT_LENGTH)
        : previousResponse;

    return (
      `Continue from where you left off. Your previous response ended with:\n` +
      `---\n` +
      `${tail}\n` +
      `---\n` +
      `Continue the task. When done, end your response with "DONE" or "완료".`
    );
  }
}
