/**
 * Error handling middleware for API
 */

import type { Request, Response, NextFunction } from 'express';
import { ApiError, type ApiErrorResponse } from './types.js';

// Re-export ApiError for convenience
export { ApiError } from './types.js';
import { SchedulerError } from '../scheduler/types.js';

/**
 * Express error handling middleware
 */
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  console.error('API Error:', err);

  // Handle ApiError instances
  if (err instanceof ApiError) {
    res.status(err.statusCode).json(err.toResponse());
    return;
  }

  // Handle SchedulerError instances
  if (err instanceof SchedulerError) {
    const statusCode = getStatusCodeForSchedulerError(err.code);
    const response: ApiErrorResponse = {
      error: err.message,
      code: mapSchedulerErrorCode(err.code),
    };
    res.status(statusCode).json(response);
    return;
  }

  // Handle generic errors
  const response: ApiErrorResponse = {
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  };
  res.status(500).json(response);
}

/**
 * Map SchedulerError code to HTTP status code
 */
function getStatusCodeForSchedulerError(code: string): number {
  switch (code) {
    case 'INVALID_CRON':
    case 'JOB_EXISTS':
      return 400;
    case 'JOB_NOT_FOUND':
      return 404;
    case 'JOB_RUNNING':
      return 409;
    default:
      return 500;
  }
}

/**
 * Map SchedulerError code to ApiErrorCode
 */
function mapSchedulerErrorCode(code: string): ApiErrorResponse['code'] {
  switch (code) {
    case 'INVALID_CRON':
    case 'JOB_EXISTS':
      return 'VALIDATION_ERROR';
    case 'JOB_NOT_FOUND':
      return 'NOT_FOUND';
    case 'JOB_RUNNING':
      return 'JOB_RUNNING';
    default:
      return 'INTERNAL_ERROR';
  }
}

/**
 * Async handler wrapper to catch promise rejections
 */
export function asyncHandler<T>(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<T>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Validate required fields in request body
 */
export function validateRequired(body: Record<string, unknown>, fields: string[]): void {
  const missing = fields.filter((field) => body[field] === undefined);
  if (missing.length > 0) {
    throw new ApiError(`Missing required fields: ${missing.join(', ')}`, 400, 'BAD_REQUEST', {
      missing,
    });
  }
}

/**
 * 404 handler for unmatched routes
 */
export function notFoundHandler(req: Request, res: Response, _next: NextFunction): void {
  const response: ApiErrorResponse = {
    error: `Route not found: ${req.method} ${req.path}`,
    code: 'NOT_FOUND',
  };
  res.status(404).json(response);
}
