/**
 * Utility for sanitizing sensitive information from logs
 * Helps prevent exposure of Bot IDs, User IDs, tokens, and other sensitive data
 */

export interface SanitizationOptions {
  /** Whether to mask bot IDs (default: true) */
  maskBotIds?: boolean;
  /** Whether to mask user IDs (default: true) */
  maskUserIds?: boolean;
  /** Whether to redact tokens completely (default: true) */
  redactTokens?: boolean;
  /** Custom patterns to sanitize */
  customPatterns?: Array<{ pattern: RegExp; replacement: string }>;
}

const DEFAULT_OPTIONS: Required<SanitizationOptions> = {
  maskBotIds: true,
  maskUserIds: true,
  redactTokens: true,
  customPatterns: [],
};

/**
 * Masks a Slack Bot ID (B12345678 → B123****)
 */
export function maskBotId(botId: string): string {
  if (!botId || typeof botId !== 'string') return botId;
  if (botId.startsWith('B') && botId.length >= 9) {
    return botId.substring(0, 4) + '****';
  }
  return botId;
}

/**
 * Masks a Slack User ID (U12345678 → U123****)
 */
export function maskUserId(userId: string): string {
  if (!userId || typeof userId !== 'string') return userId;
  if (userId.startsWith('U') && userId.length >= 9) {
    return userId.substring(0, 4) + '****';
  }
  return userId;
}

/**
 * Redacts tokens (xoxb-*, xapp-*, xoxp-*)
 */
export function redactToken(token: string): string {
  if (!token || typeof token !== 'string') return token;
  if (token.startsWith('xoxb-') || token.startsWith('xapp-') || token.startsWith('xoxp-')) {
    return token.substring(0, 8) + '***[REDACTED]***';
  }
  return token;
}

/**
 * Sanitizes a single string value
 */
export function sanitizeString(value: string, options: SanitizationOptions = {}): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let sanitized = value;

  if (opts.maskBotIds) {
    // Match Bot IDs: B followed by 8+ alphanumeric characters
    sanitized = sanitized.replace(/B[A-Z0-9]{8,}/g, (match) => maskBotId(match));
  }

  if (opts.maskUserIds) {
    // Match User IDs: U followed by 8+ alphanumeric characters
    sanitized = sanitized.replace(/U[A-Z0-9]{8,}/g, (match) => maskUserId(match));
  }

  if (opts.redactTokens) {
    // Match Slack tokens: xoxb-, xapp-, xoxp-
    sanitized = sanitized.replace(/xo(?:xb|xp|xa)p?-[a-zA-Z0-9-]+/g, (match) => redactToken(match));
  }

  // Apply custom patterns
  for (const pattern of opts.customPatterns) {
    sanitized = sanitized.replace(pattern.pattern, pattern.replacement);
  }

  return sanitized;
}

/**
 * Recursively sanitizes an object, preserving structure but sanitizing string values
 */
export function sanitizeObject(obj: any, options: SanitizationOptions = {}): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    return sanitizeString(obj, options);
  }

  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item, options));
  }

  if (typeof obj === 'object') {
    const sanitized: any = {};
    for (const [key, value] of Object.entries(obj)) {
      // Sanitize both key and value
      const sanitizedKey = sanitizeString(key, options);
      sanitized[sanitizedKey] = sanitizeObject(value, options);
    }
    return sanitized;
  }

  return obj;
}

/**
 * Main sanitization function for logging
 * Accepts any type and returns a sanitized version safe for logging
 */
export function sanitizeForLogging(data: any, options: SanitizationOptions = {}): any {
  return sanitizeObject(data, options);
}

/**
 * Safe console.log that automatically sanitizes all arguments
 */
export function safeLog(message: string, ...args: any[]): void {
  const sanitizedMessage = sanitizeString(message);
  const sanitizedArgs = args.map((arg) => sanitizeForLogging(arg));
  console.log(sanitizedMessage, ...sanitizedArgs);
}

/**
 * Safe console.error that automatically sanitizes all arguments
 */
export function safeError(message: string, ...args: any[]): void {
  const sanitizedMessage = sanitizeString(message);
  const sanitizedArgs = args.map((arg) => sanitizeForLogging(arg));
  console.error(sanitizedMessage, ...sanitizedArgs);
}

/**
 * Safe console.warn that automatically sanitizes all arguments
 */
export function safeWarn(message: string, ...args: any[]): void {
  const sanitizedMessage = sanitizeString(message);
  const sanitizedArgs = args.map((arg) => sanitizeForLogging(arg));
  console.warn(sanitizedMessage, ...sanitizedArgs);
}

/**
 * Log levels enum
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4,
}

/**
 * Get log level from environment variable
 */
export function getLogLevelFromEnv(): LogLevel {
  const envLevel = process.env.MAMA_LOG_LEVEL?.toUpperCase();
  switch (envLevel) {
    case 'DEBUG':
      return LogLevel.DEBUG;
    case 'INFO':
      return LogLevel.INFO;
    case 'WARN':
      return LogLevel.WARN;
    case 'ERROR':
      return LogLevel.ERROR;
    case 'NONE':
      return LogLevel.NONE;
    default:
      // Default to INFO in production, DEBUG in development
      return process.env.NODE_ENV === 'production' ? LogLevel.INFO : LogLevel.DEBUG;
  }
}

/**
 * Create a logger that automatically sanitizes all outputs with log level support
 */
export function createSafeLogger(prefix?: string) {
  const logPrefix = prefix ? `[${prefix}] ` : '';
  const currentLogLevel = getLogLevelFromEnv();

  return {
    debug: (message: string, ...args: any[]) => {
      if (currentLogLevel <= LogLevel.DEBUG) {
        safeLog(logPrefix + '[DEBUG] ' + message, ...args);
      }
    },
    log: (message: string, ...args: any[]) => {
      if (currentLogLevel <= LogLevel.INFO) {
        safeLog(logPrefix + message, ...args);
      }
    },
    info: (message: string, ...args: any[]) => {
      if (currentLogLevel <= LogLevel.INFO) {
        safeLog(logPrefix + '[INFO] ' + message, ...args);
      }
    },
    warn: (message: string, ...args: any[]) => {
      if (currentLogLevel <= LogLevel.WARN) {
        safeWarn(logPrefix + message, ...args);
      }
    },
    error: (message: string, ...args: any[]) => {
      if (currentLogLevel <= LogLevel.ERROR) {
        safeError(logPrefix + message, ...args);
      }
    },
  };
}
