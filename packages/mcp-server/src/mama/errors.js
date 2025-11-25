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
 * @date 2025-11-25
 */

/**
 * Base error class for all MAMA errors
 *
 * @class MAMAError
 * @extends Error
 */
class MAMAError extends Error {
  /**
   * @param {string} message - Error message
   * @param {string} code - Error code (e.g., 'DECISION_NOT_FOUND')
   * @param {Object} details - Additional error details
   */
  constructor(message, code = 'MAMA_ERROR', details = {}) {
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
   *
   * @returns {Object} {error: {code, message, details}}
   */
  toResponse() {
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
   *
   * @returns {Object} JSON representation
   */
  toJSON() {
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
 *
 * @class NotFoundError
 * @extends MAMAError
 */
class NotFoundError extends MAMAError {
  /**
   * @param {string} resourceType - Type of resource (e.g., 'decision', 'checkpoint')
   * @param {string} identifier - Resource identifier
   * @param {Object} details - Additional details
   */
  constructor(resourceType, identifier, details = {}) {
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
 *
 * @class ValidationError
 * @extends MAMAError
 */
class ValidationError extends MAMAError {
  /**
   * @param {string} field - Field that failed validation
   * @param {string} message - Validation error message
   * @param {*} received - Received value
   * @param {Object} details - Additional details
   */
  constructor(field, message, received = undefined, details = {}) {
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
 *
 * @class DatabaseError
 * @extends MAMAError
 */
class DatabaseError extends MAMAError {
  /**
   * @param {string} operation - Database operation (e.g., 'insert', 'query', 'update')
   * @param {string} message - Error message
   * @param {Object} details - Additional details
   */
  constructor(operation, message, details = {}) {
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
 *
 * @class EmbeddingError
 * @extends MAMAError
 */
class EmbeddingError extends MAMAError {
  /**
   * @param {string} message - Error message
   * @param {Object} details - Additional details (model, input length, etc.)
   */
  constructor(message, details = {}) {
    super(`Embedding generation failed: ${message}`, 'EMBEDDING_ERROR', details);
    this.name = 'EmbeddingError';
  }
}

/**
 * Error thrown when configuration is invalid
 *
 * @class ConfigurationError
 * @extends MAMAError
 */
class ConfigurationError extends MAMAError {
  /**
   * @param {string} configKey - Configuration key
   * @param {string} message - Error message
   * @param {Object} details - Additional details
   */
  constructor(configKey, message, details = {}) {
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
 *
 * @class LinkError
 * @extends MAMAError
 */
class LinkError extends MAMAError {
  /**
   * @param {string} operation - Link operation (e.g., 'propose', 'approve', 'reject')
   * @param {string} message - Error message
   * @param {Object} details - Additional details (from_id, to_id, etc.)
   */
  constructor(operation, message, details = {}) {
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
 *
 * @class RateLimitError
 * @extends MAMAError
 */
class RateLimitError extends MAMAError {
  /**
   * @param {string} operation - Operation that was rate limited
   * @param {number} retryAfterMs - Time to wait before retry (ms)
   * @param {Object} details - Additional details
   */
  constructor(operation, retryAfterMs, details = {}) {
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
 *
 * @class TimeoutError
 * @extends MAMAError
 */
class TimeoutError extends MAMAError {
  /**
   * @param {string} operation - Operation that timed out
   * @param {number} timeoutMs - Timeout duration (ms)
   * @param {Object} details - Additional details
   */
  constructor(operation, timeoutMs, details = {}) {
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
const ErrorCodes = {
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
};

/**
 * Helper function to wrap unknown errors
 *
 * @param {Error|unknown} error - Error to wrap
 * @param {string} context - Context for the error
 * @returns {MAMAError} Wrapped MAMA error
 */
function wrapError(error, context = 'Unknown operation') {
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
 *
 * @param {unknown} error - Error to check
 * @returns {boolean} True if MAMA error
 */
function isMAMAError(error) {
  return error instanceof MAMAError;
}

module.exports = {
  // Base class
  MAMAError,

  // Specific error types
  NotFoundError,
  ValidationError,
  DatabaseError,
  EmbeddingError,
  ConfigurationError,
  LinkError,
  RateLimitError,
  TimeoutError,

  // Utilities
  ErrorCodes,
  wrapError,
  isMAMAError,
};
