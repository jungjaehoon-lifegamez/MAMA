/**
 * Task Continuation Enforcer
 *
 * Analyzes agent responses to detect incomplete tasks and
 * automatically sends continuation prompts to resume work.
 *
 * Completion detection uses markers like "DONE", "완료", "✅",
 * while incomplete detection uses truncation signals and "I'll continue".
 */

import type { TaskContinuationConfig } from './types.js';

/**
 * Result of analyzing a response for continuation
 */
export interface ContinuationResult {
  /** Whether the response appears complete */
  isComplete: boolean;
  /** Reason for the determination */
  reason: string;
  /** Current continuation attempt number */
  attempt: number;
  /** Whether max retries have been reached */
  maxRetriesReached: boolean;
}

/**
 * Per-channel continuation state
 */
interface ChannelContinuationState {
  /** Current attempt count */
  attempts: number;
  /** Agent ID currently being continued */
  agentId: string;
}

/**
 * Default completion markers
 */
const DEFAULT_COMPLETION_MARKERS = ['DONE', '완료', '✅', 'TASK_COMPLETE'];

/**
 * Patterns that suggest a response is incomplete
 */
const INCOMPLETE_PATTERNS = [
  /I'll continue/i,
  /계속하겠/,
  /계속할게/,
  /to be continued/i,
  /let me continue/i,
  /next,?\s*I('ll| will)/i,
  /이어서/,
  /다음으로/,
];

/**
 * Task Continuation Enforcer
 */
export class TaskContinuationEnforcer {
  private config: TaskContinuationConfig;
  private maxRetries: number;
  private completionMarkers: string[];

  /** Per-channel continuation state */
  private channelStates: Map<string, ChannelContinuationState> = new Map();

  constructor(config: TaskContinuationConfig) {
    this.config = config;
    this.maxRetries = config.max_retries ?? 3;
    this.completionMarkers = config.completion_markers ?? DEFAULT_COMPLETION_MARKERS;
  }

  /**
   * Analyze an agent response to determine if continuation is needed.
   */
  analyzeResponse(agentId: string, channelId: string, response: string): ContinuationResult {
    const state = this.getOrCreateState(channelId, agentId);

    // Check if response contains completion markers
    if (this.isResponseComplete(response)) {
      this.resetAttempts(channelId);
      return {
        isComplete: true,
        reason: 'completion_marker_found',
        attempt: state.attempts,
        maxRetriesReached: false,
      };
    }

    // Check if response appears truncated or explicitly incomplete
    if (this.isResponseIncomplete(response)) {
      state.attempts++;
      this.channelStates.set(channelId, state);

      const maxReached = state.attempts >= this.maxRetries;
      return {
        isComplete: false,
        reason: maxReached ? 'max_retries_reached' : 'incomplete_response',
        attempt: state.attempts,
        maxRetriesReached: maxReached,
      };
    }

    // Response seems normal (no explicit completion or continuation signals)
    // Treat as complete by default
    this.resetAttempts(channelId);
    return {
      isComplete: true,
      reason: 'normal_response',
      attempt: state.attempts,
      maxRetriesReached: false,
    };
  }

  /**
   * Build a continuation prompt to resume an incomplete task.
   */
  buildContinuationPrompt(previousResponse: string): string {
    // Take last 200 chars as context
    const tail = previousResponse.length > 200 ? previousResponse.slice(-200) : previousResponse;

    return `Continue from where you left off. Your previous response ended with:
---
${tail}
---
Continue the task. When done, end your response with "DONE" or "완료".`;
  }

  /**
   * Reset continuation attempts for a channel.
   */
  resetAttempts(channelId: string): void {
    this.channelStates.delete(channelId);
  }

  /**
   * Get current attempt count for a channel.
   */
  getAttemptCount(channelId: string): number {
    return this.channelStates.get(channelId)?.attempts ?? 0;
  }

  /**
   * Check if continuation is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Update configuration.
   */
  updateConfig(config: TaskContinuationConfig): void {
    this.config = config;
    this.maxRetries = config.max_retries ?? 3;
    this.completionMarkers = config.completion_markers ?? DEFAULT_COMPLETION_MARKERS;
  }

  /**
   * Check if a response contains completion markers.
   */
  private isResponseComplete(response: string): boolean {
    const lower = response.toLowerCase();
    for (const marker of this.completionMarkers) {
      if (lower.includes(marker.toLowerCase())) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if a response appears incomplete/truncated.
   */
  private isResponseIncomplete(response: string): boolean {
    // Check for explicit continuation patterns
    for (const pattern of INCOMPLETE_PATTERNS) {
      if (pattern.test(response)) {
        return true;
      }
    }

    // Check for truncation (response near Discord's 2000 char limit)
    if (response.length >= 1800) {
      // Check if response ends mid-sentence (no terminal punctuation)
      const trimmed = response.trimEnd();
      const lastChar = trimmed[trimmed.length - 1];
      if (lastChar && !'.!?。！？…'.includes(lastChar)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get or create channel continuation state.
   */
  private getOrCreateState(channelId: string, agentId: string): ChannelContinuationState {
    const existing = this.channelStates.get(channelId);
    if (existing && existing.agentId === agentId) {
      return existing;
    }

    // New agent or new channel - reset
    const state: ChannelContinuationState = { attempts: 0, agentId };
    this.channelStates.set(channelId, state);
    return state;
  }
}
