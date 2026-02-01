/**
 * OAuth Token Manager for MAMA Standalone
 *
 * Manages Claude Pro OAuth tokens from ~/.claude/.credentials.json
 * - Reads tokens from Claude Code credentials file
 * - Caches tokens with TTL
 * - Auto-refreshes tokens before expiry
 * - Writes refreshed tokens back to file
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  ClaudeCredentialsFile,
  ClaudeAiOAuth,
  OAuthToken,
  TokenRefreshResponse,
  TokenStatus,
  OAuthManagerOptions,
  CachedToken,
} from './types.js';

import { OAuthError } from './types.js';

/**
 * Anthropic OAuth constants (from OpenClaw analysis)
 */
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const CLIENT_ID = 'OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl';

/**
 * Default configuration
 */
const DEFAULT_CREDENTIALS_PATH = '.claude/.credentials.json';
const DEFAULT_CACHE_TTL_MS = 60_000; // 1 minute
const DEFAULT_REFRESH_BUFFER_MS = 600_000; // 10 minutes
const EXPIRY_BUFFER_MS = 300_000; // 5 minutes buffer when calculating expiry

export class OAuthManager {
  private readonly credentialsPath: string;
  private readonly cacheTtlMs: number;
  private readonly refreshBufferMs: number;
  private readonly fetchFn: typeof fetch;

  private cache: CachedToken | null = null;

  constructor(options: OAuthManagerOptions = {}) {
    this.credentialsPath = options.credentialsPath ?? join(homedir(), DEFAULT_CREDENTIALS_PATH);
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.refreshBufferMs = options.refreshBufferMs ?? DEFAULT_REFRESH_BUFFER_MS;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /**
   * Get a valid access token, refreshing if necessary
   *
   * @returns Access token string
   * @throws OAuthError if token cannot be obtained
   */
  async getToken(): Promise<string> {
    const now = Date.now();

    // Check cache first
    if (this.cache && now - this.cache.cachedAt < this.cacheTtlMs) {
      // Cache is valid, but check if token needs refresh
      if (!this.needsRefresh(this.cache.token.expiresAt)) {
        return this.cache.token.accessToken;
      }
    }

    // Read credentials from file
    const credentials = await this.readCredentials();

    // Check if refresh is needed
    if (this.needsRefresh(credentials.expiresAt)) {
      const refreshedToken = await this.refreshToken(credentials.refreshToken);
      await this.writeCredentials(refreshedToken);

      this.cache = {
        token: refreshedToken,
        cachedAt: now,
        subscriptionType: credentials.subscriptionType,
        rateLimitTier: credentials.rateLimitTier,
      };

      return refreshedToken.accessToken;
    }

    // Token is still valid, cache it
    this.cache = {
      token: {
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        expiresAt: credentials.expiresAt,
      },
      cachedAt: now,
      subscriptionType: credentials.subscriptionType,
      rateLimitTier: credentials.rateLimitTier,
    };

    return credentials.accessToken;
  }

  /**
   * Get token status information
   *
   * @returns Token status including validity, expiry, and subscription info
   */
  async getStatus(): Promise<TokenStatus> {
    try {
      const credentials = await this.readCredentials();
      const now = Date.now();
      const expiresIn = Math.floor((credentials.expiresAt - now) / 1000);

      return {
        valid: credentials.expiresAt > now,
        expiresAt: credentials.expiresAt,
        expiresIn: expiresIn > 0 ? expiresIn : 0,
        needsRefresh: this.needsRefresh(credentials.expiresAt),
        subscriptionType: credentials.subscriptionType,
        rateLimitTier: credentials.rateLimitTier,
      };
    } catch (error) {
      if (error instanceof OAuthError) {
        return {
          valid: false,
          expiresAt: null,
          expiresIn: null,
          needsRefresh: false,
          error: error.message,
        };
      }
      throw error;
    }
  }

  /**
   * Force refresh the token
   *
   * @returns New access token
   * @throws OAuthError if refresh fails
   */
  async forceRefresh(): Promise<string> {
    const credentials = await this.readCredentials();
    const refreshedToken = await this.refreshToken(credentials.refreshToken);
    await this.writeCredentials(refreshedToken);

    this.cache = {
      token: refreshedToken,
      cachedAt: Date.now(),
      subscriptionType: credentials.subscriptionType,
      rateLimitTier: credentials.rateLimitTier,
    };

    return refreshedToken.accessToken;
  }

  /**
   * Clear the token cache
   */
  clearCache(): void {
    this.cache = null;
  }

  /**
   * Check if token needs refresh (expires within buffer time)
   */
  private needsRefresh(expiresAt: number): boolean {
    return Date.now() >= expiresAt - this.refreshBufferMs;
  }

  /**
   * Read credentials from file
   */
  private async readCredentials(): Promise<ClaudeAiOAuth> {
    if (!existsSync(this.credentialsPath)) {
      throw new OAuthError(
        `Claude Code credentials not found. Please install Claude Code first and log in.\nExpected path: ${this.credentialsPath}`,
        'CREDENTIALS_NOT_FOUND'
      );
    }

    try {
      const content = await readFile(this.credentialsPath, 'utf-8');
      const data: ClaudeCredentialsFile = JSON.parse(content);

      if (!data.claudeAiOauth) {
        throw new OAuthError(
          'Invalid credentials file: claudeAiOauth object not found. Please log in to Claude Code.',
          'INVALID_CREDENTIALS'
        );
      }

      const oauth = data.claudeAiOauth;

      if (!oauth.accessToken || !oauth.refreshToken || !oauth.expiresAt) {
        throw new OAuthError(
          'Invalid credentials: missing required fields (accessToken, refreshToken, expiresAt)',
          'INVALID_CREDENTIALS'
        );
      }

      return oauth;
    } catch (error) {
      if (error instanceof OAuthError) {
        throw error;
      }
      throw new OAuthError(
        `Failed to read credentials file: ${error instanceof Error ? error.message : String(error)}`,
        'INVALID_CREDENTIALS',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Refresh the OAuth token
   */
  private async refreshToken(refreshToken: string): Promise<OAuthToken> {
    try {
      const response = await this.fetchFn(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: CLIENT_ID,
          refresh_token: refreshToken,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new OAuthError(
          `Token refresh failed (${response.status}): ${errorText}`,
          'REFRESH_FAILED'
        );
      }

      const data = (await response.json()) as TokenRefreshResponse;

      // Calculate expiry with 5 minute buffer (matching OpenClaw behavior)
      const expiresAt = Date.now() + data.expires_in * 1000 - EXPIRY_BUFFER_MS;

      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt,
      };
    } catch (error) {
      if (error instanceof OAuthError) {
        throw error;
      }
      throw new OAuthError(
        `Network error during token refresh: ${error instanceof Error ? error.message : String(error)}`,
        'NETWORK_ERROR',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Write refreshed credentials to file
   */
  private async writeCredentials(token: OAuthToken): Promise<void> {
    try {
      // Read existing file to preserve other fields
      const content = await readFile(this.credentialsPath, 'utf-8');
      const data: ClaudeCredentialsFile = JSON.parse(content);

      if (!data.claudeAiOauth) {
        throw new OAuthError(
          'Cannot write credentials: claudeAiOauth object not found',
          'FILE_WRITE_ERROR'
        );
      }

      // Update only the token fields
      data.claudeAiOauth = {
        ...data.claudeAiOauth,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt,
      };

      await writeFile(this.credentialsPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      if (error instanceof OAuthError) {
        throw error;
      }
      throw new OAuthError(
        `Failed to write credentials file: ${error instanceof Error ? error.message : String(error)}`,
        'FILE_WRITE_ERROR',
        error instanceof Error ? error : undefined
      );
    }
  }
}
