/**
 * OAuth Token Types for MAMA Standalone
 *
 * Based on Claude Code credentials structure (~/.claude/.credentials.json)
 */

/**
 * Raw credentials file structure from Claude Code
 */
export interface ClaudeCredentialsFile {
  claudeAiOauth?: ClaudeAiOAuth;
}

/**
 * Claude AI OAuth credentials object
 */
export interface ClaudeAiOAuth {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp in milliseconds
  scopes?: string[];
  subscriptionType?: string; // 'max', 'pro', etc.
  rateLimitTier?: string;
}

/**
 * Internal token representation
 */
export interface OAuthToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp in milliseconds
}

/**
 * Token refresh response from Anthropic
 */
export interface TokenRefreshResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  token_type: string;
}

/**
 * Token status information
 */
export interface TokenStatus {
  valid: boolean;
  expiresAt: number | null;
  expiresIn: number | null; // seconds until expiration
  needsRefresh: boolean;
  subscriptionType?: string;
  rateLimitTier?: string;
  error?: string;
}

/**
 * OAuth Manager configuration options
 */
export interface OAuthManagerOptions {
  /**
   * Path to credentials file (default: ~/.claude/.credentials.json)
   */
  credentialsPath?: string;

  /**
   * Cache TTL in milliseconds (default: 60000 = 1 minute)
   */
  cacheTtlMs?: number;

  /**
   * Refresh buffer in milliseconds - refresh token this much before expiry
   * (default: 600000 = 10 minutes)
   */
  refreshBufferMs?: number;

  /**
   * Custom fetch function for testing
   */
  fetchFn?: typeof fetch;
}

/**
 * Cached token with metadata
 */
export interface CachedToken {
  token: OAuthToken;
  cachedAt: number;
  subscriptionType?: string;
  rateLimitTier?: string;
}

/**
 * Error types for OAuth operations
 */
export class OAuthError extends Error {
  constructor(
    message: string,
    public readonly code: OAuthErrorCode,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export type OAuthErrorCode =
  | 'CREDENTIALS_NOT_FOUND'
  | 'INVALID_CREDENTIALS'
  | 'TOKEN_EXPIRED'
  | 'REFRESH_FAILED'
  | 'NETWORK_ERROR'
  | 'FILE_WRITE_ERROR';
