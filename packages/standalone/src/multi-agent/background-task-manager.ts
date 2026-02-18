/**
 * Background Task Manager
 *
 * Manages background task delegation for the multi-agent swarm system.
 * Queues tasks, enforces concurrency limits per agent, tracks lifecycle,
 * stores results, and emits events on completion/failure.
 *
 * Features:
 * - Per-agent concurrency limits (configurable)
 * - Global concurrency cap
 * - Task lifecycle: pending → running → completed → failed
 * - Result storage with recent-completed retention (last 50)
 * - EventEmitter for task-started / task-completed / task-failed
 * - Stale task detection with configurable timeout
 * - Queue size limits to prevent unbounded growth
 *
 * @module background-task-manager
 * @version 1.0
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

/**
 * Task status lifecycle
 */
export type BackgroundTaskStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * A background task tracked by the manager
 */
export interface BackgroundTask {
  /** Unique task ID with bg_ prefix (e.g. bg_a1b2c3d4) */
  id: string;
  /** Current lifecycle status */
  status: BackgroundTaskStatus;
  /** Human-readable task description */
  description: string;
  /** Full prompt to send to the executing agent */
  prompt: string;
  /** Agent ID that executes this task */
  agentId: string;
  /** Agent ID that requested this task */
  requestedBy: string;
  /** Source channel ID */
  channelId: string;
  /** Platform source */
  source: 'discord' | 'slack';
  /** Timestamp when task was queued */
  queuedAt: number;
  /** Timestamp when task started executing */
  startedAt?: number;
  /** Timestamp when task completed or failed */
  completedAt?: number;
  /** Agent response on success */
  result?: string;
  /** Error message on failure */
  error?: string;
  /** Execution duration in milliseconds */
  duration?: number;
  /** Number of retry attempts due to busy process */
  retryCount?: number;
}

/**
 * Options for submitting a new background task
 */
export interface BackgroundTaskSubmitOptions {
  /** Human-readable task description */
  description: string;
  /** Full prompt to send to the executing agent */
  prompt: string;
  /** Agent ID that executes this task */
  agentId: string;
  /** Agent ID that requested this task */
  requestedBy: string;
  /** Source channel ID */
  channelId: string;
  /** Platform source */
  source: 'discord' | 'slack';
}

/**
 * Configuration options for BackgroundTaskManager
 */
export interface BackgroundTaskManagerOptions {
  /** Maximum concurrent tasks per agent (default: 2) */
  maxConcurrentPerAgent?: number;
  /** Maximum total concurrent tasks across all agents (default: 5) */
  maxTotalConcurrent?: number;
  /** Timeout in ms after which a running task is considered stale (default: 300000 = 5min) */
  staleTimeoutMs?: number;
  /** Maximum number of pending tasks in the queue (default: 20) */
  maxQueueSize?: number;
}

/**
 * Aggregate task statistics
 */
export interface BackgroundTaskStats {
  /** Number of tasks waiting to execute */
  pending: number;
  /** Number of tasks currently running */
  running: number;
  /** Number of successfully completed tasks */
  completed: number;
  /** Number of failed tasks */
  failed: number;
  /** Total tasks submitted since manager creation */
  totalSubmitted: number;
}

/**
 * Event payload emitted on task lifecycle transitions
 */
export interface BackgroundTaskEvent {
  /** The task that triggered the event */
  task: BackgroundTask;
}

const MAX_COMPLETED_RETENTION = 50;
const LOG_PREFIX = '[BackgroundTaskManager]';

/**
 * Background Task Manager
 *
 * Manages background task execution for the multi-agent swarm.
 * Tasks are queued, executed respecting concurrency limits, and
 * results are stored for later retrieval.
 *
 * @example
 * ```typescript
 * const manager = new BackgroundTaskManager(
 *   async (agentId, prompt) => {
 *     const response = await agentProcess.sendMessage(prompt);
 *     return response.text;
 *   },
 *   { maxConcurrentPerAgent: 2, maxTotalConcurrent: 5 }
 * );
 *
 * const task = manager.submit({
 *   description: 'Analyze auth module',
 *   prompt: 'Review the auth module for security issues',
 *   agentId: 'reviewer',
 *   requestedBy: 'conductor',
 *   channelId: '123456789',
 *   source: 'discord',
 * });
 *
 * manager.on('task-completed', ({ task }) => {
 *   console.log(`Task ${task.id} done: ${task.result}`);
 * });
 * ```
 */
export class BackgroundTaskManager extends EventEmitter {
  private tasks: Map<string, BackgroundTask> = new Map();
  private pendingQueue: string[] = [];
  private runningSet: Set<string> = new Set();
  private completedList: string[] = [];
  private totalSubmitted: number = 0;
  private options: Required<BackgroundTaskManagerOptions>;
  private executeTask: (agentId: string, prompt: string) => Promise<string>;

  constructor(
    executeTask: (agentId: string, prompt: string) => Promise<string>,
    options?: BackgroundTaskManagerOptions
  ) {
    super();
    this.executeTask = executeTask;
    this.options = {
      maxConcurrentPerAgent: options?.maxConcurrentPerAgent ?? 2,
      maxTotalConcurrent: options?.maxTotalConcurrent ?? 5,
      staleTimeoutMs: options?.staleTimeoutMs ?? 300000,
      maxQueueSize: options?.maxQueueSize ?? 20,
    };
  }

  /**
   * Submit a new background task
   *
   * Creates a task with status='pending' and schedules queue processing.
   *
   * @param opts - Task submission options
   * @returns The created BackgroundTask with status='pending'
   * @throws Error if the queue is full
   *
   * @example
   * ```typescript
   * const task = manager.submit({
   *   description: 'Fix auth bug',
   *   prompt: 'Find and fix the JWT validation bug in auth.ts',
   *   agentId: 'developer',
   *   requestedBy: 'conductor',
   *   channelId: '999888777',
   *   source: 'discord',
   * });
   * console.log(task.id); // "bg_a1b2c3d4"
   * ```
   */
  submit(opts: BackgroundTaskSubmitOptions): BackgroundTask {
    if (this.pendingQueue.length >= this.options.maxQueueSize) {
      throw new Error(
        `${LOG_PREFIX} Queue full (${this.pendingQueue.length}/${this.options.maxQueueSize}), cannot submit task`
      );
    }

    const task: BackgroundTask = {
      id: `bg_${randomUUID().slice(0, 8)}`,
      status: 'pending',
      description: opts.description,
      prompt: opts.prompt,
      agentId: opts.agentId,
      requestedBy: opts.requestedBy,
      channelId: opts.channelId,
      source: opts.source,
      queuedAt: Date.now(),
    };

    this.tasks.set(task.id, task);
    this.pendingQueue.push(task.id);
    this.totalSubmitted++;

    console.log(
      `${LOG_PREFIX} Task submitted: ${task.id} (agent=${task.agentId}, queue=${this.pendingQueue.length}/${this.options.maxQueueSize})`
    );

    queueMicrotask(() => {
      this._processQueue();
    });

    return task;
  }

  /**
   * Get a task by ID
   *
   * @param taskId - Task ID to look up
   * @returns The task or undefined if not found
   */
  getTask(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get the result string of a completed task
   *
   * @param taskId - Task ID to look up
   * @returns The result string or undefined if not found/not completed
   */
  getResult(taskId: string): string | undefined {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'completed') {
      return undefined;
    }
    return task.result;
  }

  /**
   * Cancel a pending or running task
   *
   * Pending tasks are removed from the queue.
   * Running tasks are marked as failed with a cancellation error.
   *
   * @param taskId - Task ID to cancel
   * @returns true if the task was cancelled, false if not found or already terminal
   */
  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) {
      return false;
    }

    if (task.status === 'completed' || task.status === 'failed') {
      return false;
    }

    if (task.status === 'pending') {
      const idx = this.pendingQueue.indexOf(taskId);
      if (idx !== -1) {
        this.pendingQueue.splice(idx, 1);
      }
    }

    if (task.status === 'running') {
      this.runningSet.delete(taskId);
    }

    task.status = 'failed';
    task.error = 'Cancelled';
    task.completedAt = Date.now();
    if (task.startedAt) {
      task.duration = task.completedAt - task.startedAt;
    }

    this._addToCompleted(taskId);

    console.log(`${LOG_PREFIX} Task cancelled: ${task.id}`);
    this.emit('task-failed', { task } satisfies BackgroundTaskEvent);
    this._processQueue();

    return true;
  }

  /**
   * Get all pending tasks (ordered by queue position)
   *
   * @returns Array of pending BackgroundTask objects
   */
  getQueuedTasks(): BackgroundTask[] {
    const tasks: BackgroundTask[] = [];
    for (const id of this.pendingQueue) {
      const task = this.tasks.get(id);
      if (task && task.status === 'pending') {
        tasks.push(task);
      }
    }
    return tasks;
  }

  /**
   * Get all currently running tasks
   *
   * @returns Array of running BackgroundTask objects
   */
  getRunningTasks(): BackgroundTask[] {
    const tasks: BackgroundTask[] = [];
    for (const id of this.runningSet) {
      const task = this.tasks.get(id);
      if (task && task.status === 'running') {
        tasks.push(task);
      }
    }
    return tasks;
  }

  /**
   * Get recently completed tasks (last 50)
   *
   * Includes both completed and failed tasks, ordered newest first.
   *
   * @returns Array of completed/failed BackgroundTask objects
   */
  getCompletedTasks(): BackgroundTask[] {
    const tasks: BackgroundTask[] = [];
    for (let i = this.completedList.length - 1; i >= 0; i--) {
      const task = this.tasks.get(this.completedList[i]);
      if (task) {
        tasks.push(task);
      }
    }
    return tasks;
  }

  /**
   * Get aggregate task statistics
   *
   * @returns Task counts by status and total submitted
   */
  getStats(): BackgroundTaskStats {
    let pending = 0;
    let running = 0;
    let completed = 0;
    let failed = 0;

    for (const task of this.tasks.values()) {
      switch (task.status) {
        case 'pending':
          pending++;
          break;
        case 'running':
          running++;
          break;
        case 'completed':
          completed++;
          break;
        case 'failed':
          failed++;
          break;
      }
    }

    return { pending, running, completed, failed, totalSubmitted: this.totalSubmitted };
  }

  /**
   * Clean up stale running tasks
   *
   * Marks running tasks that have exceeded the stale timeout as failed.
   * Call this periodically (e.g., every 60 seconds).
   *
   * @returns Number of stale tasks cleaned up
   */
  cleanupStale(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const taskId of Array.from(this.runningSet)) {
      const task = this.tasks.get(taskId);
      if (!task || !task.startedAt) {
        continue;
      }

      const elapsed = now - task.startedAt;
      if (elapsed > this.options.staleTimeoutMs) {
        console.warn(
          `${LOG_PREFIX} Stale task detected: ${task.id} (agent=${task.agentId}, running for ${Math.floor(elapsed / 1000)}s)`
        );

        task.status = 'failed';
        task.error = `Stale: exceeded ${Math.floor(this.options.staleTimeoutMs / 1000)}s timeout`;
        task.completedAt = now;
        task.duration = elapsed;

        this.runningSet.delete(taskId);
        this._addToCompleted(taskId);

        this.emit('task-failed', { task } satisfies BackgroundTaskEvent);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`${LOG_PREFIX} Cleaned up ${cleaned} stale task(s)`);
      this._processQueue();
    }

    return cleaned;
  }

  private _processQueue(): void {
    while (this.pendingQueue.length > 0) {
      if (this.runningSet.size >= this.options.maxTotalConcurrent) {
        break;
      }

      const nextId = this.pendingQueue[0];
      const task = this.tasks.get(nextId);

      if (!task || task.status !== 'pending') {
        this.pendingQueue.shift();
        continue;
      }

      const agentRunning = this._getRunningCountForAgent(task.agentId);
      if (agentRunning >= this.options.maxConcurrentPerAgent) {
        // FIFO queue — no reordering; agent at capacity blocks further dequeuing
        break;
      }

      this.pendingQueue.shift();
      this._startTask(task);
    }
  }

  private _startTask(task: BackgroundTask): void {
    task.status = 'running';
    task.startedAt = Date.now();
    this.runningSet.add(task.id);

    console.log(
      `${LOG_PREFIX} Task started: ${task.id} (agent=${task.agentId}, running=${this.runningSet.size}/${this.options.maxTotalConcurrent})`
    );
    this.emit('task-started', { task } satisfies BackgroundTaskEvent);

    const MAX_BUSY_RETRIES = 5;
    const BUSY_RETRY_DELAY_MS = 5000;

    Promise.resolve()
      .then(() => this.executeTask(task.agentId, task.prompt))
      .then((result) => {
        this._completeTask(task, result);
      })
      .catch((err: unknown) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const isBusy = errorMessage.includes('Process is busy');
        const retries = task.retryCount ?? 0;

        if (isBusy && retries < MAX_BUSY_RETRIES) {
          // Re-queue: revert to pending and retry after delay
          task.status = 'pending';
          task.startedAt = undefined;
          task.retryCount = retries + 1;
          this.runningSet.delete(task.id);
          this.pendingQueue.unshift(task.id);
          console.log(
            `${LOG_PREFIX} Task ${task.id} agent busy, re-queued (retry ${task.retryCount}/${MAX_BUSY_RETRIES})`
          );
          setTimeout(() => this._processQueue(), BUSY_RETRY_DELAY_MS);
        } else {
          this._failTask(task, errorMessage);
        }
      });
  }

  /**
   * Mark a task as completed with result
   *
   * @param task - The task to complete
   * @param result - Agent response string
   */
  private _completeTask(task: BackgroundTask, result: string): void {
    if (task.status !== 'running') {
      return;
    }

    const now = Date.now();
    task.status = 'completed';
    task.result = result;
    task.completedAt = now;
    task.duration = task.startedAt ? now - task.startedAt : 0;

    this.runningSet.delete(task.id);
    this._addToCompleted(task.id);

    console.log(
      `${LOG_PREFIX} Task completed: ${task.id} (agent=${task.agentId}, duration=${task.duration}ms)`
    );
    this.emit('task-completed', { task } satisfies BackgroundTaskEvent);

    this._processQueue();
  }

  private _failTask(task: BackgroundTask, errorMessage: string): void {
    if (task.status !== 'running') {
      return;
    }

    const now = Date.now();
    task.status = 'failed';
    task.error = errorMessage;
    task.completedAt = now;
    task.duration = task.startedAt ? now - task.startedAt : 0;

    this.runningSet.delete(task.id);
    this._addToCompleted(task.id);

    console.error(
      `${LOG_PREFIX} Task failed: ${task.id} (agent=${task.agentId}, error=${errorMessage})`
    );
    this.emit('task-failed', { task } satisfies BackgroundTaskEvent);

    this._processQueue();
  }

  private _addToCompleted(taskId: string): void {
    this.completedList.push(taskId);

    while (this.completedList.length > MAX_COMPLETED_RETENTION) {
      const evictedId = this.completedList.shift();
      if (evictedId) {
        this.tasks.delete(evictedId);
      }
    }
  }

  private _getRunningCountForAgent(agentId: string): number {
    let count = 0;
    for (const taskId of this.runningSet) {
      const task = this.tasks.get(taskId);
      if (task && task.agentId === agentId) {
        count++;
      }
    }
    return count;
  }

  destroy(): void {
    for (const taskId of [...this.pendingQueue]) {
      this.cancelTask(taskId);
    }
    for (const taskId of [...this.runningSet]) {
      this.cancelTask(taskId);
    }
    this.tasks.clear();
    this.pendingQueue = [];
    this.completedList = [];
    this.removeAllListeners();
    console.log(`${LOG_PREFIX} Destroyed — all tasks cancelled, listeners removed`);
  }
}
