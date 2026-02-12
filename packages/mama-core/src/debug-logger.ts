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

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'NONE';

const LOG_LEVELS: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  NONE: 4,
};

export class DebugLogger {
  private context: string;
  private level: number;

  constructor(context = 'MAMA') {
    this.context = context;
    this.level = this._getLogLevel();
  }

  private _getLogLevel(): number {
    // Changed default from 'INFO' to 'ERROR' for cleaner output
    // Users can override with MAMA_LOG_LEVEL env var
    const env = (process.env.MAMA_LOG_LEVEL || 'ERROR').toUpperCase() as LogLevel;
    return LOG_LEVELS[env] ?? LOG_LEVELS.ERROR;
  }

  private _shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= this.level;
  }

  private _formatMessage(level: LogLevel, ...args: unknown[]): unknown[] {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${this.context}] [${level}]`;
    return [prefix, ...args];
  }

  debug(...args: unknown[]): void {
    if (!this._shouldLog('DEBUG')) {
      return;
    }
    console.error(...this._formatMessage('DEBUG', ...args));
  }

  info(...args: unknown[]): void {
    if (!this._shouldLog('INFO')) {
      return;
    }
    console.error(...this._formatMessage('INFO', ...args));
  }

  warn(...args: unknown[]): void {
    if (!this._shouldLog('WARN')) {
      return;
    }
    console.warn(...this._formatMessage('WARN', ...args));
  }

  error(...args: unknown[]): void {
    if (!this._shouldLog('ERROR')) {
      return;
    }
    console.error(...this._formatMessage('ERROR', ...args));
  }
}

// Export singleton with default context
const logger = new DebugLogger('MAMA');

// Export convenience functions
export const debug = (...args: unknown[]): void => logger.debug(...args);
export const info = (...args: unknown[]): void => logger.info(...args);
export const warn = (...args: unknown[]): void => logger.warn(...args);
export const error = (...args: unknown[]): void => logger.error(...args);

export default logger;
