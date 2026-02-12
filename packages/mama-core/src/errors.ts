/**
 * MAMA Error Classes - Typed Error Handling
 *
 * Story 8.3: Typed Error Classes
 * Provides consistent error handling across MCP tools and core modules
 *
 * Error codes follow MCP standard response format:
 * {error: {code: 'ERROR_CODE', message: '...', details: {}}}
 *
 * @module errors
 * @version 1.0
 */

export interface ErrorDetails {
  [key: string]: unknown;
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details: ErrorDetails;
  };
}

export interface ErrorJSON {
  name: string;
  code: string;
  message: string;
  details: ErrorDetails;
  timestamp: string;
  stack?: string;
}

/**
 * Base error class for all MAMA errors
 */
export class MAMAError extends Error {
  code: string;
  details: ErrorDetails;
  timestamp: string;

  constructor(message: string, code = 'MAMA_ERROR', details: ErrorDetails = {}) {
    super(message);
    this.name = 'MAMAError';
    this.code = code;
    this.details = details;
    this.timestamp = new Date().toISOString();

    // Capture stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Convert to MCP-compatible error response format
   */
  toResponse(): ErrorResponse {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
      },
    };
  }

  /**
   * Convert to JSON for logging
   */
  toJSON(): ErrorJSON {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      timestamp: this.timestamp,
      stack: this.stack,
    };
  }
}

/**
 * Error thrown when a decision is not found
 */
export class NotFoundError extends MAMAError {
  constructor(resourceType: string, identifier: string, details: ErrorDetails = {}) {
    super(`${resourceType} not found: ${identifier}`, `${resourceType.toUpperCase()}_NOT_FOUND`, {
      resourceType,
      identifier,
      ...details,
    });
    this.name = 'NotFoundError';
  }
}

/**
 * Error thrown when input validation fails
 */
export class ValidationError extends MAMAError {
  field: string;

  constructor(field: string, message: string, received?: unknown, details: ErrorDetails = {}) {
    super(`Validation failed for '${field}': ${message}`, 'INVALID_INPUT', {
      field,
      received: received !== undefined ? String(received).substring(0, 100) : undefined,
      ...details,
    });
    this.name = 'ValidationError';
    this.field = field;
  }
}

/**
 * Error thrown when database operations fail
 */
export class DatabaseError extends MAMAError {
  operation: string;

  constructor(operation: string, message: string, details: ErrorDetails = {}) {
    super(`Database ${operation} failed: ${message}`, 'DATABASE_ERROR', {
      operation,
      ...details,
    });
    this.name = 'DatabaseError';
    this.operation = operation;
  }
}

/**
 * Error thrown when embedding generation fails
 */
export class EmbeddingError extends MAMAError {
  constructor(message: string, details: ErrorDetails = {}) {
    super(`Embedding generation failed: ${message}`, 'EMBEDDING_ERROR', details);
    this.name = 'EmbeddingError';
  }
}

/**
 * Error thrown when configuration is invalid
 */
export class ConfigurationError extends MAMAError {
  configKey: string;

  constructor(configKey: string, message: string, details: ErrorDetails = {}) {
    super(`Configuration error for '${configKey}': ${message}`, 'CONFIG_ERROR', {
      configKey,
      ...details,
    });
    this.name = 'ConfigurationError';
    this.configKey = configKey;
  }
}

/**
 * Error thrown when a link operation fails
 */
export class LinkError extends MAMAError {
  operation: string;

  constructor(operation: string, message: string, details: ErrorDetails = {}) {
    super(`Link ${operation} failed: ${message}`, 'LINK_ERROR', {
      operation,
      ...details,
    });
    this.name = 'LinkError';
    this.operation = operation;
  }
}

/**
 * Error thrown when rate limit is exceeded
 */
export class RateLimitError extends MAMAError {
  retryAfterMs: number;

  constructor(operation: string, retryAfterMs: number, details: ErrorDetails = {}) {
    super(`Rate limit exceeded for ${operation}. Retry after ${retryAfterMs}ms`, 'RATE_LIMITED', {
      operation,
      retryAfterMs,
      ...details,
    });
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Error thrown when operation times out
 */
export class TimeoutError extends MAMAError {
  timeoutMs: number;

  constructor(operation: string, timeoutMs: number, details: ErrorDetails = {}) {
    super(`Operation '${operation}' timed out after ${timeoutMs}ms`, 'TIMEOUT', {
      operation,
      timeoutMs,
      ...details,
    });
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Error codes enum for reference
 */
export const ErrorCodes = {
  // Resource errors
  DECISION_NOT_FOUND: 'DECISION_NOT_FOUND',
  CHECKPOINT_NOT_FOUND: 'CHECKPOINT_NOT_FOUND',
  LINK_NOT_FOUND: 'LINK_NOT_FOUND',

  // Validation errors
  INVALID_INPUT: 'INVALID_INPUT',
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
  INVALID_FORMAT: 'INVALID_FORMAT',

  // Database errors
  DATABASE_ERROR: 'DATABASE_ERROR',
  CONNECTION_FAILED: 'CONNECTION_FAILED',
  QUERY_FAILED: 'QUERY_FAILED',

  // Processing errors
  EMBEDDING_ERROR: 'EMBEDDING_ERROR',
  CONFIG_ERROR: 'CONFIG_ERROR',
  LINK_ERROR: 'LINK_ERROR',

  // Operational errors
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * Helper function to wrap unknown errors
 */
export function wrapError(error: unknown, context = 'Unknown operation'): MAMAError {
  if (error instanceof MAMAError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  return new MAMAError(`${context}: ${message}`, 'INTERNAL_ERROR', {
    originalError: message,
    originalStack: stack,
  });
}

/**
 * Helper function to check if an error is a MAMA error
 */
export function isMAMAError(error: unknown): error is MAMAError {
  return error instanceof MAMAError;
}
