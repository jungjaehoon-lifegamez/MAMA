/**
 * Input validation and sanitization for Slack events and content
 * Prevents injection attacks and validates event structure
 */

import type { SlackMentionEvent } from '../multi-agent/slack-multi-bot-manager.js';

export interface SlackEventValidationError extends Error {
  name: 'SlackEventValidationError';
  field?: string;
  value?: unknown;
}

export interface ValidationOptions {
  /** Maximum message content length (default: 4000) */
  maxContentLength?: number;
  /** Whether to allow bot messages (default: true) */
  allowBotMessages?: boolean;
  /** Custom forbidden patterns */
  forbiddenPatterns?: RegExp[];
  /** Whether to strip HTML/markdown (default: true) */
  stripMarkdown?: boolean;
  /** Whitelist of allowed characters/patterns (default: null for no whitelist) */
  allowedCharacters?: RegExp;
  /** Whether to use strict whitelist validation (default: false) */
  useWhitelistValidation?: boolean;
}

const DEFAULT_OPTIONS: Required<ValidationOptions> = {
  maxContentLength: 4000,
  allowBotMessages: true,
  forbiddenPatterns: [],
  stripMarkdown: true,
  allowedCharacters: /^[\w\s\-_.,!?@#$%&*()+=[\]{}|\\:";'<>/`~]*$/,
  useWhitelistValidation: false,
};

/**
 * Validates that a value is a non-empty string
 */
function validateStringField(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    const error = new Error(
      `${fieldName} must be a string, got ${typeof value}`
    ) as SlackEventValidationError;
    error.name = 'SlackEventValidationError';
    error.field = fieldName;
    error.value = value;
    throw error;
  }
  if (value.trim().length === 0) {
    const error = new Error(`${fieldName} cannot be empty`) as SlackEventValidationError;
    error.name = 'SlackEventValidationError';
    error.field = fieldName;
    error.value = value;
    throw error;
  }
  return value.trim();
}

/**
 * Validates Slack channel ID format (C followed by alphanumeric)
 */
export function validateChannelId(channelId: string): boolean {
  return /^[C][A-Z0-9]{8,}$/.test(channelId);
}

/**
 * Validates Slack user ID format (U followed by alphanumeric)
 */
export function validateUserId(userId: string): boolean {
  return /^[UW][A-Z0-9]{8,}$/.test(userId);
}

/**
 * Validates Slack bot ID format (B followed by alphanumeric)
 */
export function validateBotId(botId: string): boolean {
  return /^[B][A-Z0-9]{8,}$/.test(botId);
}

/**
 * Validates Slack timestamp format (Unix timestamp with microseconds)
 */
export function validateTimestamp(ts: string): boolean {
  return /^\d+\.\d+$/.test(ts);
}

/**
 * Sanitizes message content by removing potentially dangerous patterns
 */
export function sanitizeMessageContent(content: string, options: ValidationOptions = {}): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let sanitized = content;

  // Length check
  if (sanitized.length > opts.maxContentLength) {
    sanitized = sanitized.substring(0, opts.maxContentLength) + '...';
  }

  // Remove null bytes and other control characters (except newlines and tabs)
  // eslint-disable-next-line no-control-regex
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Basic HTML/script injection prevention
  sanitized = sanitized.replace(/<script[^>]*>.*?<\/script>/gi, '[SCRIPT_REMOVED]');
  sanitized = sanitized.replace(/<iframe[^>]*>.*?<\/iframe>/gi, '[IFRAME_REMOVED]');
  sanitized = sanitized.replace(/javascript:/gi, 'js-protocol-removed:');
  sanitized = sanitized.replace(/data:/gi, 'data-protocol-removed:');

  // Strip Slack markdown if requested
  if (opts.stripMarkdown) {
    // Remove Slack formatting but preserve the text content
    sanitized = sanitized.replace(/[*_`~]/g, '');
    sanitized = sanitized.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }

  // Apply custom forbidden patterns
  for (const pattern of opts.forbiddenPatterns) {
    sanitized = sanitized.replace(pattern, '[FORBIDDEN_PATTERN_REMOVED]');
  }

  // Apply whitelist validation if enabled
  if (opts.useWhitelistValidation && opts.allowedCharacters) {
    // Remove characters not in whitelist
    sanitized = sanitized.replace(
      new RegExp(`[^${opts.allowedCharacters.source.slice(1, -1)}]`, 'g'),
      ''
    );
  }

  // Remove excessive whitespace
  sanitized = sanitized.replace(/\s+/g, ' ').trim();

  return sanitized;
}

/**
 * Validates a Slack mention event structure and sanitizes content
 */
export function validateMentionEvent(
  event: unknown,
  options: ValidationOptions = {}
): SlackMentionEvent {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (!event || typeof event !== 'object') {
    const error = new Error('Event must be an object') as SlackEventValidationError;
    error.name = 'SlackEventValidationError';
    throw error;
  }

  const rawEvent = event as Record<string, unknown>;

  // Required fields
  const type = validateStringField(rawEvent.type, 'type');
  const channel = validateStringField(rawEvent.channel, 'channel');
  const user = validateStringField(rawEvent.user, 'user');
  const text = validateStringField(rawEvent.text, 'text');
  const ts = validateStringField(rawEvent.ts, 'ts');

  // Validate field formats
  if (!validateChannelId(channel)) {
    const error = new Error(`Invalid channel ID format: ${channel}`) as SlackEventValidationError;
    error.name = 'SlackEventValidationError';
    error.field = 'channel';
    error.value = channel;
    throw error;
  }

  if (!validateUserId(user)) {
    const error = new Error(`Invalid user ID format: ${user}`) as SlackEventValidationError;
    error.name = 'SlackEventValidationError';
    error.field = 'user';
    error.value = user;
    throw error;
  }

  if (!validateTimestamp(ts)) {
    const error = new Error(`Invalid timestamp format: ${ts}`) as SlackEventValidationError;
    error.name = 'SlackEventValidationError';
    error.field = 'ts';
    error.value = ts;
    throw error;
  }

  // Optional fields
  let thread_ts: string | undefined;
  if (rawEvent.thread_ts) {
    thread_ts = validateStringField(rawEvent.thread_ts, 'thread_ts');
    if (!validateTimestamp(thread_ts)) {
      const error = new Error(
        `Invalid thread_ts format: ${thread_ts}`
      ) as SlackEventValidationError;
      error.name = 'SlackEventValidationError';
      error.field = 'thread_ts';
      error.value = thread_ts;
      throw error;
    }
  }

  let bot_id: string | undefined;
  if (rawEvent.bot_id) {
    bot_id = validateStringField(rawEvent.bot_id, 'bot_id');
    if (!validateBotId(bot_id)) {
      const error = new Error(`Invalid bot_id format: ${bot_id}`) as SlackEventValidationError;
      error.name = 'SlackEventValidationError';
      error.field = 'bot_id';
      error.value = bot_id;
      throw error;
    }

    // Check if bot messages are allowed
    if (!opts.allowBotMessages) {
      const error = new Error('Bot messages are not allowed') as SlackEventValidationError;
      error.name = 'SlackEventValidationError';
      error.field = 'bot_id';
      error.value = bot_id;
      throw error;
    }
  }

  let channel_type: string | undefined;
  if (rawEvent.channel_type) {
    channel_type = validateStringField(rawEvent.channel_type, 'channel_type');
  }

  // Sanitize text content
  const sanitizedText = sanitizeMessageContent(text, opts);

  return {
    type,
    channel,
    user,
    text: sanitizedText,
    ts,
    thread_ts,
    bot_id,
    channel_type,
  };
}

/**
 * Creates a validation error with consistent structure
 */
export function createValidationError(
  message: string,
  field?: string,
  value?: unknown
): SlackEventValidationError {
  const error = new Error(message) as SlackEventValidationError;
  error.name = 'SlackEventValidationError';
  if (field) error.field = field;
  if (value !== undefined) error.value = value;
  return error;
}

/**
 * Checks if an error is a Slack event validation error
 */
export function isValidationError(error: unknown): error is SlackEventValidationError {
  return error instanceof Error && error.name === 'SlackEventValidationError';
}

/**
 * Safe wrapper for validation that returns result or null on error
 */
export function safeValidateMentionEvent(
  event: unknown,
  options: ValidationOptions = {}
): SlackMentionEvent | null {
  try {
    return validateMentionEvent(event, options);
  } catch (error) {
    if (isValidationError(error)) {
      // Note: Using console.warn here since this is a utility function
      // and we don't have access to a logger instance
    } else {
      // Note: Using console.error here since this is a utility function
      // and we don't have access to a logger instance
    }
    return null;
  }
}

/**
 * Validation presets for different security levels
 */
export const ValidationPresets = {
  /** Strict validation with maximum security */
  STRICT: {
    maxContentLength: 2000,
    allowBotMessages: false,
    forbiddenPatterns: [
      /\b(eval|function|script|import|require)\b/gi,
      /[<>'"]/g,
      /\$\{.*\}/g, // Template literals
    ],
    stripMarkdown: true,
    allowedCharacters: /^[a-zA-Z0-9\s\-_.!?@#%&*()+=[\]{}|:";'/`~]*$/,
    useWhitelistValidation: true,
  } as ValidationOptions,

  /** Standard validation for normal use */
  STANDARD: {
    maxContentLength: 4000,
    allowBotMessages: true,
    forbiddenPatterns: [/<script[^>]*>.*?<\/script>/gi, /javascript:/gi],
    stripMarkdown: true,
    allowedCharacters: /^[\w\s\-_.,!?@#$%&*()+=[\]{}|\\:";'<>/`~]*$/,
    useWhitelistValidation: false,
  } as ValidationOptions,

  /** Permissive validation with basic checks only */
  PERMISSIVE: {
    maxContentLength: 8000,
    allowBotMessages: true,
    forbiddenPatterns: [],
    stripMarkdown: false,
    allowedCharacters: /^.*$/,
    useWhitelistValidation: false,
  } as ValidationOptions,

  /** Whitelist-only validation for ultra-secure environments */
  WHITELIST_ONLY: {
    maxContentLength: 1000,
    allowBotMessages: false,
    forbiddenPatterns: [],
    stripMarkdown: true,
    allowedCharacters: /^[a-zA-Z0-9\s.,!?-]*$/,
    useWhitelistValidation: true,
  } as ValidationOptions,
};
