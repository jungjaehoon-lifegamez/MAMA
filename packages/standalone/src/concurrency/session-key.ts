/**
 * Session Key Utilities
 *
 * Provides consistent session key generation for lane-based concurrency.
 */

import type { MessageSource } from '../gateways/types.js';

/**
 * Build a session key from message source, channel, and user
 *
 * @param source - Message source (discord, slack, chatwork, etc.)
 * @param channelId - Channel/room identifier
 * @param userId - User identifier
 * @returns Session key in format "{source}:{channelId}:{userId}"
 *
 * @example
 * ```typescript
 * buildSessionKey('discord', '123456789', '987654321')
 * // → 'discord:123456789:987654321'
 * ```
 */
export function buildSessionKey(
  source: MessageSource | string,
  channelId: string,
  userId: string
): string {
  return `${source}:${channelId}:${userId}`;
}

/**
 * Build a channel-level session key (shared by all users in a channel)
 *
 * @param source - Message source
 * @param channelId - Channel/room identifier
 * @returns Session key in format "{source}:{channelId}"
 */
export function buildChannelSessionKey(source: MessageSource | string, channelId: string): string {
  return `${source}:${channelId}`;
}

/**
 * Parse a session key into its components
 *
 * @param sessionKey - Session key to parse
 * @returns Parsed components or null if invalid
 */
export function parseSessionKey(sessionKey: string): {
  source: string;
  channelId: string;
  userId?: string;
} | null {
  const parts = sessionKey.split(':');

  if (parts.length < 2) {
    return null;
  }

  if (parts.length === 2) {
    return {
      source: parts[0],
      channelId: parts[1],
    };
  }

  return {
    source: parts[0],
    channelId: parts[1],
    userId: parts.slice(2).join(':'), // Handle userIds with colons
  };
}
