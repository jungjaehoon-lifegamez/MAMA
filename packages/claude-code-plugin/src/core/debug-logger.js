/**
 * DebugLogger - Centralized logging for MAMA hooks
 *
 * CLAUDE.md Compliant:
 * - NO console.log (use DebugLogger.info instead)
 * - console.error/warn allowed but wrapped for consistency
 *
 * Features:
 * - Log levels (DEBUG, INFO, WARN, ERROR)
 * - Timestamp formatting
 * - Environment-based filtering
 * - Module/context tagging
 */

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  NONE: 4,
};

class DebugLogger {
  constructor(context = 'MAMA') {
    this.context = context;
    this.level = this._getLogLevel();
  }

  _getLogLevel() {
    // Changed default from 'INFO' to 'ERROR' for cleaner output
    // Users can override with MAMA_LOG_LEVEL env var
    const env = process.env.MAMA_LOG_LEVEL || 'ERROR';
    return LOG_LEVELS[env.toUpperCase()] ?? LOG_LEVELS.ERROR;
  }

  _shouldLog(level) {
    return LOG_LEVELS[level] >= this.level;
  }

  _formatMessage(level, ...args) {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${this.context}] [${level}]`;
    return [prefix, ...args];
  }

  debug(...args) {
    if (!this._shouldLog('DEBUG')) {
      return;
    }
    console.error(...this._formatMessage('DEBUG', ...args));
  }

  info(...args) {
    if (!this._shouldLog('INFO')) {
      return;
    }
    console.error(...this._formatMessage('INFO', ...args));
  }

  warn(...args) {
    if (!this._shouldLog('WARN')) {
      return;
    }
    console.warn(...this._formatMessage('WARN', ...args));
  }

  error(...args) {
    if (!this._shouldLog('ERROR')) {
      return;
    }
    console.error(...this._formatMessage('ERROR', ...args));
  }
}

// Export singleton with default context
const logger = new DebugLogger('MAMA');

// Export class for custom contexts
module.exports = {
  DebugLogger,
  default: logger,
  debug: (...args) => logger.debug(...args),
  info: (...args) => logger.info(...args),
  warn: (...args) => logger.warn(...args),
  error: (...args) => logger.error(...args),
};
