/**
 * Type definitions for Cron Scheduler
 */

/**
 * Job execution status
 */
export type JobStatus = 'idle' | 'running' | 'completed' | 'failed';

/**
 * Job configuration for registration
 */
export interface JobConfig {
  /** Unique job identifier */
  id: string;
  /** Human-readable job name */
  name: string;
  /** Cron expression (e.g., "0/30 * * * *" for every 30 minutes) */
  cronExpr: string;
  /** Prompt to send to Agent Loop */
  prompt: string;
  /** Whether job is enabled (default: true) */
  enabled?: boolean;
}

/**
 * Full job information including runtime state
 */
export interface CronJob extends JobConfig {
  /** Whether job is currently enabled */
  enabled: boolean;
  /** Whether job is currently running */
  isRunning: boolean;
  /** Last execution time */
  lastRun?: Date;
  /** Next scheduled execution time */
  nextRun?: Date;
  /** Last execution result */
  lastResult?: JobResult;
}

/**
 * Job execution result
 */
export interface JobResult {
  /** Whether execution was successful */
  success: boolean;
  /** Execution start time */
  startedAt: Date;
  /** Execution end time */
  completedAt: Date;
  /** Duration in milliseconds */
  duration: number;
  /** Error message if failed */
  error?: string;
  /** Agent loop response */
  response?: string;
}

/**
 * Scheduler options
 */
export interface SchedulerOptions {
  /** Timezone for cron expressions (default: local) */
  timezone?: string;
  /** Whether to run missed jobs on startup (default: false) */
  runMissedOnStartup?: boolean;
  /** Maximum concurrent jobs (default: 1) */
  maxConcurrent?: number;
}

/**
 * Job event types
 */
export type JobEventType = 'started' | 'completed' | 'failed' | 'skipped';

/**
 * Job event for callbacks
 */
export interface JobEvent {
  type: JobEventType;
  jobId: string;
  timestamp: Date;
  result?: JobResult;
  reason?: string;
}

/**
 * Job event handler
 */
export type JobEventHandler = (event: JobEvent) => void;

/**
 * Scheduler error codes
 */
export type SchedulerErrorCode =
  | 'INVALID_CRON'
  | 'JOB_NOT_FOUND'
  | 'JOB_EXISTS'
  | 'JOB_RUNNING'
  | 'SCHEDULER_ERROR';

/**
 * Custom error class for scheduler errors
 */
export class SchedulerError extends Error {
  constructor(
    message: string,
    public readonly code: SchedulerErrorCode,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'SchedulerError';
  }
}
