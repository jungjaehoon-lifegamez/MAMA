/**
 * Type definitions for Heartbeat API
 */

import type { CronJob, JobResult } from '../scheduler/types.js';

// ============================================================================
// Cron API Types
// ============================================================================

/**
 * API representation of a cron job
 */
export interface ApiCronJob {
  id: string;
  name: string;
  cron_expr: string;
  prompt: string;
  enabled: boolean;
  last_run: number | null;
  next_run: number | null;
}

/**
 * Request body for creating a cron job
 */
export interface CreateCronJobRequest {
  name: string;
  cron_expr: string;
  prompt: string;
  enabled?: boolean;
}

/**
 * Request body for updating a cron job
 */
export interface UpdateCronJobRequest {
  name?: string;
  cron_expr?: string;
  prompt?: string;
  enabled?: boolean;
}

/**
 * Response for cron job list
 */
export interface ListCronJobsResponse {
  jobs: ApiCronJob[];
}

/**
 * Response for single cron job
 */
export interface GetCronJobResponse {
  job: ApiCronJob;
}

/**
 * Response for cron job creation
 */
export interface CreateCronJobResponse {
  id: string;
  created: boolean;
}

/**
 * Response for cron job update
 */
export interface UpdateCronJobResponse {
  updated: boolean;
}

/**
 * Response for cron job deletion
 */
export interface DeleteCronJobResponse {
  deleted: boolean;
}

/**
 * Response for immediate job execution
 */
export interface RunCronJobResponse {
  execution_id: string;
  started: boolean;
}

/**
 * Execution log entry
 */
export interface ExecutionLog {
  id: string;
  started_at: number;
  finished_at: number | null;
  status: 'running' | 'success' | 'failed';
  output: string | null;
  error: string | null;
}

/**
 * Response for execution logs
 */
export interface GetLogsResponse {
  logs: ExecutionLog[];
}

/**
 * Query parameters for logs endpoint
 */
export interface GetLogsQuery {
  limit?: number;
  offset?: number;
}

// ============================================================================
// Heartbeat API Types
// ============================================================================

/**
 * Last execution info for heartbeat status
 */
export interface LastExecution {
  id: string;
  started_at: number;
  status: 'success' | 'failed';
}

/**
 * Response for heartbeat status
 */
export interface HeartbeatStatusResponse {
  status: 'active' | 'inactive';
  active_jobs: number;
  last_execution: LastExecution | null;
}

/**
 * Request body for manual heartbeat trigger
 */
export interface TriggerHeartbeatRequest {
  prompt?: string;
}

/**
 * Response for heartbeat trigger
 */
export interface TriggerHeartbeatResponse {
  execution_id: string;
  started: boolean;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * API error codes
 */
export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'JOB_RUNNING'
  | 'INTERNAL_ERROR';

/**
 * API error response
 */
export interface ApiErrorResponse {
  error: string;
  code?: ApiErrorCode;
  details?: Record<string, unknown>;
}

/**
 * Custom API error class
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: ApiErrorCode = 'INTERNAL_ERROR',
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toResponse(): ApiErrorResponse {
    return {
      error: this.message,
      code: this.code,
      details: this.details,
    };
  }
}

// ============================================================================
// Conversion Utilities
// ============================================================================

/**
 * Convert internal CronJob to API format
 */
export function toApiCronJob(job: CronJob): ApiCronJob {
  return {
    id: job.id,
    name: job.name,
    cron_expr: job.cronExpr,
    prompt: job.prompt,
    enabled: job.enabled,
    last_run: job.lastRun ? job.lastRun.getTime() : null,
    next_run: job.nextRun ? job.nextRun.getTime() : null,
  };
}

/**
 * Convert JobResult to ExecutionLog format
 */
export function toExecutionLog(id: string, result: JobResult): ExecutionLog {
  return {
    id,
    started_at: result.startedAt.getTime(),
    finished_at: result.completedAt.getTime(),
    status: result.success ? 'success' : 'failed',
    output: result.response || null,
    error: result.error || null,
  };
}
