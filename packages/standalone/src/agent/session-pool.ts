/**
 * Session Pool - Claude CLI Session Reuse Manager
 *
 * Manages Claude CLI session IDs per channel to enable conversation continuity.
 * Instead of creating new sessions for each message, reuses existing sessions
 * so Claude CLI maintains its own conversation history.
 *
 * Benefits:
 * - 6x token reduction (no manual history injection needed)
 * - Natural conversation flow (Claude remembers context)
 * - Automatic summarization by Claude when context fills up
 */

import { randomUUID } from 'crypto';

/**
 * Session entry with metadata
 */
interface SessionEntry {
  /** Claude CLI session ID */
  sessionId: string;
  /** Last activity timestamp */
  lastActive: number;
  /** Message count in this session */
  messageCount: number;
  /** Creation timestamp */
  createdAt: number;
  /** Whether session is currently in use (locked) */
  inUse: boolean;
  /** Cumulative input tokens for this session */
  totalInputTokens: number;
}

/**
 * Context window threshold (80% of 200K)
 * When exceeded, session will be reset on next request
 */
const CONTEXT_THRESHOLD_TOKENS = 160000;

/**
 * Session Pool configuration
 */
export interface SessionPoolConfig {
  /** Session timeout in milliseconds (default: 30 minutes) */
  sessionTimeoutMs?: number;
  /** Maximum sessions to keep in pool (default: 100) */
  maxSessions?: number;
  /** Cleanup interval in milliseconds (default: 5 minutes) */
  cleanupIntervalMs?: number;
}

const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Session Pool for Claude CLI session management
 *
 * Key design:
 * - Channel key format: "{source}:{channelId}" (e.g., "discord:123456")
 * - Sessions expire after timeout (default 30 min)
 * - Automatic cleanup of stale sessions
 */
export class SessionPool {
  private sessions: Map<string, SessionEntry> = new Map();
  private config: Required<SessionPoolConfig>;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(config: SessionPoolConfig = {}) {
    this.config = {
      sessionTimeoutMs: config.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
      maxSessions: config.maxSessions ?? DEFAULT_MAX_SESSIONS,
      cleanupIntervalMs: config.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS,
    };

    // Start periodic cleanup
    this.startCleanupTimer();
  }

  /**
   * Get or create session ID for a channel
   *
   * With --no-session-persistence flag, Claude CLI doesn't lock session IDs.
   * This allows session reuse for conversation continuity.
   *
   * Auto-resets session when context window reaches 80% (160K tokens).
   *
   * @param channelKey - Channel identifier (format: "{source}:{channelId}")
   * @returns Object with sessionId and isNew flag
   */
  getSession(channelKey: string): { sessionId: string; isNew: boolean } {
    const existing = this.sessions.get(channelKey);
    const now = Date.now();

    // Check if existing session is still valid
    if (existing) {
      const isExpired = now - existing.lastActive > this.config.sessionTimeoutMs;
      const isContextFull = existing.totalInputTokens >= CONTEXT_THRESHOLD_TOKENS;

      if (isExpired) {
        this.sessions.delete(channelKey);
        console.log(`[SessionPool] Session expired for ${channelKey}, creating new one`);
      } else if (isContextFull) {
        this.sessions.delete(channelKey);
        console.log(
          `[SessionPool] Context 80% full (${existing.totalInputTokens} tokens) for ${channelKey}, creating fresh session`
        );
      } else if (existing.inUse) {
        // Session is currently in use - DON'T delete it!
        // Create a temporary unique session to avoid CLI lock conflict
        // Use a unique key so it doesn't overwrite the existing session
        const tempKey = `${channelKey}:temp:${randomUUID()}`;
        const tempSessionId = randomUUID();
        const entry: SessionEntry = {
          sessionId: tempSessionId,
          lastActive: now,
          messageCount: 1,
          createdAt: now,
          inUse: true,
          totalInputTokens: 0,
        };
        this.sessions.set(tempKey, entry);
        console.log(
          `[SessionPool] Session in use for ${channelKey}, using temp session: ${tempSessionId}`
        );
        return { sessionId: tempSessionId, isNew: true };
      } else {
        // Reuse existing session
        existing.lastActive = now;
        existing.messageCount++;
        existing.inUse = true; // Lock the session
        const usagePercent = Math.round((existing.totalInputTokens / 200000) * 100);
        console.log(
          `[SessionPool] Reusing session for ${channelKey}: ${existing.sessionId} (msg #${existing.messageCount}, ${usagePercent}% context)`
        );
        return { sessionId: existing.sessionId, isNew: false };
      }
    }

    // Create new session
    const sessionId = this.createSession(channelKey);
    return { sessionId, isNew: true };
  }

  /**
   * Update token usage for a session
   * Called after each Claude CLI response
   *
   * @param channelKey - Channel identifier
   * @param inputTokens - Input tokens from this request
   * @returns Current total tokens and whether threshold is approaching
   */
  updateTokens(
    channelKey: string,
    inputTokens: number
  ): { totalTokens: number; nearThreshold: boolean } {
    const existing = this.sessions.get(channelKey);
    if (!existing) {
      return { totalTokens: 0, nearThreshold: false };
    }

    // Use latest value, not cumulative - Claude API returns total context tokens per request
    existing.totalInputTokens = Math.max(existing.totalInputTokens, inputTokens);
    const nearThreshold = existing.totalInputTokens >= CONTEXT_THRESHOLD_TOKENS * 0.9; // 90% of threshold

    if (nearThreshold) {
      console.log(
        `[SessionPool] ⚠️ Context approaching limit: ${existing.totalInputTokens} tokens (${Math.round((existing.totalInputTokens / 200000) * 100)}% of 200K)`
      );
    }

    return {
      totalTokens: existing.totalInputTokens,
      nearThreshold,
    };
  }

  /**
   * Get current token usage for a session
   */
  getTokenUsage(channelKey: string): number {
    const existing = this.sessions.get(channelKey);
    return existing?.totalInputTokens ?? 0;
  }

  /**
   * Legacy method for backward compatibility
   * @deprecated Use getSession() instead
   */
  getSessionId(channelKey: string): string {
    return this.getSession(channelKey).sessionId;
  }

  /**
   * Release a session after use
   * This allows the session to be reused by future requests
   */
  releaseSession(channelKey: string): void {
    const existing = this.sessions.get(channelKey);
    if (existing) {
      existing.inUse = false;
      console.log(`[SessionPool] Released session for ${channelKey}: ${existing.sessionId}`);
    }
  }

  /**
   * Override session ID for a channel (e.g., when backend returns its own thread ID)
   */
  setSessionId(channelKey: string, sessionId: string): void {
    const existing = this.sessions.get(channelKey);
    const now = Date.now();

    if (existing) {
      existing.sessionId = sessionId;
      existing.lastActive = now;
      existing.inUse = true;
      console.log(`[SessionPool] Updated session for ${channelKey}: ${sessionId}`);
      return;
    }

    const entry: SessionEntry = {
      sessionId,
      lastActive: now,
      messageCount: 1,
      createdAt: now,
      inUse: true,
      totalInputTokens: 0,
    };
    this.sessions.set(channelKey, entry);
    console.log(`[SessionPool] Created session for ${channelKey}: ${sessionId}`);
  }

  /**
   * Create a new session for a channel
   */
  private createSession(channelKey: string): string {
    const now = Date.now();
    const sessionId = randomUUID();

    // Enforce max sessions limit
    if (this.sessions.size >= this.config.maxSessions) {
      this.evictOldestSession();
    }

    const entry: SessionEntry = {
      sessionId,
      lastActive: now,
      messageCount: 1,
      createdAt: now,
      inUse: true, // Lock on creation
      totalInputTokens: 0,
    };

    this.sessions.set(channelKey, entry);
    console.log(`[SessionPool] Created new session for ${channelKey}: ${sessionId}`);

    return sessionId;
  }

  /**
   * Force create a new session (for /clear command)
   */
  resetSession(channelKey: string): string {
    this.sessions.delete(channelKey);
    return this.createSession(channelKey);
  }

  /**
   * Check if a session exists and is active
   */
  hasActiveSession(channelKey: string): boolean {
    const existing = this.sessions.get(channelKey);
    if (!existing) return false;

    const isExpired = Date.now() - existing.lastActive > this.config.sessionTimeoutMs;
    return !isExpired;
  }

  /**
   * Get session info for a channel
   */
  getSessionInfo(channelKey: string): SessionEntry | null {
    return this.sessions.get(channelKey) || null;
  }

  /**
   * Get all active sessions (for debugging/monitoring)
   */
  listSessions(): Map<string, SessionEntry> {
    return new Map(this.sessions);
  }

  /**
   * Get active session count
   */
  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Evict the oldest (least recently used) session
   */
  private evictOldestSession(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.sessions) {
      if (entry.lastActive < oldestTime) {
        oldestTime = entry.lastActive;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.sessions.delete(oldestKey);
      console.log(`[SessionPool] Evicted oldest session: ${oldestKey}`);
    }
  }

  /**
   * Clean up expired sessions
   */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.sessions) {
      if (now - entry.lastActive > this.config.sessionTimeoutMs) {
        this.sessions.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[SessionPool] Cleaned up ${cleaned} expired sessions`);
    }

    return cleaned;
  }

  /**
   * Start periodic cleanup timer
   */
  private startCleanupTimer(): void {
    if (this.cleanupTimer) return;

    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupIntervalMs);

    // Don't prevent process exit
    this.cleanupTimer.unref();
  }

  /**
   * Stop cleanup timer and clear all sessions
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessions.clear();
  }
}

/**
 * Global session pool instance
 */
let globalSessionPool: SessionPool | null = null;

/**
 * Get global session pool instance
 */
export function getSessionPool(): SessionPool {
  if (!globalSessionPool) {
    globalSessionPool = new SessionPool();
  }
  return globalSessionPool;
}

/**
 * Set global session pool instance (for testing)
 */
export function setSessionPool(pool: SessionPool): void {
  globalSessionPool = pool;
}

/**
 * Build channel key from source and channel ID
 */
export function buildChannelKey(source: string, channelId: string): string {
  return `${source}:${channelId}`;
}
