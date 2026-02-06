/**
 * Swarm Task Learner
 *
 * Subscribes to SwarmTaskRunner events and saves task outcomes to MAMA DB.
 * Enables learning from task execution results to improve future decisions.
 *
 * Features:
 * - Subscribes to task-completed and task-failed events
 * - Saves task outcomes to MAMA memory for future reference
 * - Fire-and-forget pattern (non-blocking, graceful failures)
 * - Optional verbose logging
 *
 * @module swarm-task-learner
 * @version 1.0
 */

import type { SwarmTaskRunner, TaskExecutionResult } from './swarm-task-runner.js';

/**
 * Save function signature for MAMA save operation
 */
type SaveFunction = (params: {
  type: string;
  topic: string;
  decision: string;
  reasoning?: string;
  confidence: number;
  outcome?: string;
}) => Promise<{ success: boolean; id?: string }>;

/**
 * Configuration options for SwarmTaskLearner
 */
export interface SwarmTaskLearnerOptions {
  /** Enable/disable learning (default: true) */
  enabled?: boolean;
  /** Enable verbose logging (default: false) */
  verbose?: boolean;
  /** Optional save function for testing (if not provided, uses mama-core) */
  saveFn?: SaveFunction;
}

/**
 * Swarm Task Learner
 *
 * Listens to SwarmTaskRunner events and saves task outcomes to MAMA DB.
 * Uses fire-and-forget pattern to avoid blocking task execution.
 *
 * @example
 * ```typescript
 * const learner = new SwarmTaskLearner(taskRunner, {
 *   enabled: true,
 *   verbose: true
 * });
 *
 * learner.start(); // Begin learning
 * // ...
 * learner.stop(); // Stop learning
 * ```
 */
export class SwarmTaskLearner {
  private runner: SwarmTaskRunner;
  private options: Required<Omit<SwarmTaskLearnerOptions, 'saveFn'>> & {
    saveFn?: SaveFunction;
  };
  private isStarted = false;
  private mamaAvailable = true;

  // Event handler references (needed for removeListener)
  private taskCompletedHandler: ((result: TaskExecutionResult) => void) | null = null;
  private taskFailedHandler: ((result: TaskExecutionResult) => void) | null = null;

  constructor(runner: SwarmTaskRunner, options?: SwarmTaskLearnerOptions) {
    this.runner = runner;
    this.options = {
      enabled: options?.enabled ?? true,
      verbose: options?.verbose ?? false,
      saveFn: options?.saveFn,
    };

    // Check mama-core availability if no saveFn provided
    if (!this.options.saveFn) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mama = require('@jungjaehoon/mama-core/mama-api');
        if (!mama || !mama.save) {
          console.warn('[SwarmTaskLearner] mama-core save() not available, learning disabled');
          this.mamaAvailable = false;
        }
      } catch (error) {
        console.warn('[SwarmTaskLearner] mama-core not available, learning disabled:', error);
        this.mamaAvailable = false;
      }
    }
  }

  /**
   * Start listening to SwarmTaskRunner events
   *
   * Registers event handlers for task lifecycle events.
   * Idempotent - calling multiple times has no effect.
   */
  start(): void {
    if (this.isStarted) {
      console.warn('[SwarmTaskLearner] Already started, ignoring duplicate start() call');
      return;
    }

    if (!this.options.enabled) {
      console.log('[SwarmTaskLearner] Learning disabled, not starting');
      return;
    }

    if (!this.mamaAvailable && !this.options.saveFn) {
      console.warn('[SwarmTaskLearner] mama-core not available, cannot start');
      return;
    }

    // task-completed event
    this.taskCompletedHandler = (result: TaskExecutionResult) => {
      this.saveTaskCompleted(result);
    };
    this.runner.on('task-completed', this.taskCompletedHandler);

    // task-failed event (only final failures, not retries)
    this.taskFailedHandler = (result: TaskExecutionResult) => {
      this.saveTaskFailed(result);
    };
    this.runner.on('task-failed', this.taskFailedHandler);

    this.isStarted = true;
    if (this.options.verbose) {
      console.log('[SwarmTaskLearner] Started learning from task outcomes');
    }
  }

  /**
   * Stop listening to SwarmTaskRunner events
   *
   * Removes all registered event handlers.
   * Idempotent - calling multiple times has no effect.
   */
  stop(): void {
    if (!this.isStarted) {
      console.warn('[SwarmTaskLearner] Not started, ignoring stop() call');
      return;
    }

    if (this.taskCompletedHandler) {
      this.runner.removeListener('task-completed', this.taskCompletedHandler);
      this.taskCompletedHandler = null;
    }

    if (this.taskFailedHandler) {
      this.runner.removeListener('task-failed', this.taskFailedHandler);
      this.taskFailedHandler = null;
    }

    this.isStarted = false;
    if (this.options.verbose) {
      console.log('[SwarmTaskLearner] Stopped learning');
    }
  }

  /**
   * Save task completion to MAMA DB
   */
  private saveTaskCompleted(result: TaskExecutionResult): void {
    const decision = this.truncate(result.result || 'Task completed', 200);
    const topic = `swarm:${result.agentId}:completed`;

    const saveParams = {
      type: 'decision',
      topic,
      decision,
      outcome: 'success',
      confidence: 0.8,
    };

    this.saveToMama(saveParams, 'completed', result.taskId);
  }

  /**
   * Save task failure to MAMA DB
   */
  private saveTaskFailed(result: TaskExecutionResult): void {
    const taskIdShort = result.taskId.substring(0, 8);
    const retryCount = result.retryCount || 0;
    const decision = `Task ${taskIdShort} failed after ${retryCount} retries`;
    const topic = `swarm:${result.agentId}:failed`;

    const saveParams = {
      type: 'decision',
      topic,
      decision,
      reasoning: result.error || 'Unknown error',
      outcome: 'failed',
      confidence: 0.9,
    };

    this.saveToMama(saveParams, 'failed', result.taskId);
  }

  /**
   * Save to MAMA DB with error handling (fire-and-forget)
   */
  private saveToMama(params: any, eventType: string, taskId: string): void {
    const saveFn = this.options.saveFn || this.getMamaSave();

    if (!saveFn) {
      if (this.options.verbose) {
        console.warn(
          `[SwarmTaskLearner] Cannot save ${eventType} for task ${taskId}: no save function`
        );
      }
      return;
    }

    void saveFn(params)
      .then((result) => {
        if (this.options.verbose) {
          if (result.success) {
            console.log(
              `[SwarmTaskLearner] Saved ${eventType} for task ${taskId.substring(0, 8)} (id: ${result.id})`
            );
          } else {
            console.warn(
              `[SwarmTaskLearner] Save returned success=false for ${eventType}, task ${taskId.substring(0, 8)}`
            );
          }
        }
      })
      .catch((error) => {
        if (this.options.verbose) {
          console.warn(`[SwarmTaskLearner] Failed to save ${eventType} for task ${taskId}:`, error);
        }
      });
  }

  /**
   * Get mama-core save function
   */
  private getMamaSave(): SaveFunction | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mama = require('@jungjaehoon/mama-core/mama-api');
      return mama?.save || null;
    } catch {
      return null;
    }
  }

  /**
   * Truncate text to max length with ellipsis
   */
  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }
    return text.substring(0, maxLength - 3) + '...';
  }
}
