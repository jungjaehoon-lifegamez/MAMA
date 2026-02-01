/**
 * Lane-based Concurrency System Types
 * Based on OpenClaw's command-queue.js architecture
 */

/**
 * State of a single lane (queue)
 */
export interface LaneState {
  /** Lane identifier (e.g., "session:user1", "main") */
  lane: string;
  /** Pending tasks in queue */
  queue: QueueEntry<unknown>[];
  /** Number of currently executing tasks */
  active: number;
  /** Maximum concurrent tasks allowed */
  maxConcurrent: number;
  /** Whether the lane is currently draining */
  draining: boolean;
}

/**
 * Entry in the task queue
 */
export interface QueueEntry<T> {
  /** Async task to execute */
  task: () => Promise<T>;
  /** Resolve callback for the promise */
  resolve: (value: T) => void;
  /** Reject callback for the promise */
  reject: (error: Error) => void;
  /** Timestamp when task was enqueued */
  enqueuedAt: number;
  /** Threshold for warning about long wait times */
  warnAfterMs: number;
  /** Optional callback when wait time exceeds threshold */
  onWait?: (waitedMs: number, queueLength: number) => void;
}

/**
 * Configuration for LaneManager
 */
export interface LaneManagerConfig {
  /** Default max concurrent tasks per lane (default: 1) */
  defaultMaxConcurrent?: number;
  /** Warn after this many ms of waiting (default: 2000) */
  warnAfterMs?: number;
  /** Logger function for warnings */
  logger?: LaneLogger;
}

/**
 * Options for enqueuing a task
 */
export interface EnqueueOptions {
  /** Override warn threshold for this task */
  warnAfterMs?: number;
  /** Callback when wait exceeds threshold */
  onWait?: (waitedMs: number, queueLength: number) => void;
}

/**
 * Logger interface for lane events
 */
export interface LaneLogger {
  debug: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

/**
 * Default console logger
 */
export const defaultLogger: LaneLogger = {
  debug: (msg) => console.debug(`[Lane] ${msg}`),
  warn: (msg) => console.warn(`[Lane] ${msg}`),
  error: (msg) => console.error(`[Lane] ${msg}`),
};
