/**
 * Haiku Client — Lightweight LLM calls using user's Claude CLI OAuth tokens.
 *
 * Reads ~/.claude/.credentials.json (same file and format as standalone OAuthManager).
 * Format: { claudeAiOauth: { accessToken, refreshToken, expiresAt } }
 *
 * Reuses the proven OAuth pattern from packages/standalone/src/auth/oauth-manager.ts
 * and packages/standalone/src/agent/claude-client.ts.
 *
 * Includes circuit breaker: 3 consecutive failures → disable for 5 minutes.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { warn } from './debug-logger.js';

const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 2048;

// Circuit breaker
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// Token refresh buffer — match standalone OAuthManager (10 min)
const REFRESH_BUFFER_MS = 600_000;

/**
 * OAuth headers — must match standalone/src/agent/claude-client.ts OAUTH_HEADERS
 * CRITICAL: OAuth tokens require these exact headers to work.
 */
const OAUTH_HEADERS: Record<string, string> = {
  accept: 'application/json',
  'anthropic-dangerous-direct-browser-access': 'true',
  'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14',
  'user-agent': 'claude-cli/2.1.2 (external, cli)',
  'x-app': 'cli',
};

/**
 * Required system prompt prefix for OAuth — without this, API rejects with
 * "This credential is only authorized for use with Claude Code"
 */
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Token refresh constants — match standalone OAuthManager
 */
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const CLIENT_ID = 'OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl';

/**
 * Credentials file format — matches standalone/src/auth/types.ts ClaudeCredentialsFile
 */
interface CredentialsFile {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

export class HaikuClient {
  private model: string;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private client: Anthropic | null = null;
  private lastToken: string | null = null;

  constructor(model?: string) {
    this.model = model || process.env.MAMA_SMART_MODEL || DEFAULT_MODEL;
  }

  /**
   * Check if OAuth token is available and circuit breaker is not open.
   */
  available(): boolean {
    if (Date.now() < this.circuitOpenUntil) {
      return false;
    }
    return this.readToken() !== null;
  }

  /**
   * Send a single completion request to Haiku.
   */
  async complete(system: string, user: string): Promise<string> {
    if (Date.now() < this.circuitOpenUntil) {
      throw new Error('Haiku circuit breaker open — retrying in a few minutes');
    }

    const token = await this.getValidToken();
    if (!token) {
      throw new Error('No OAuth token available');
    }

    const client = this.getClient(token);

    try {
      const response = await client.messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        system: CLAUDE_CODE_IDENTITY + '\n\n' + system,
        messages: [{ role: 'user', content: user }],
      });

      this.consecutiveFailures = 0;
      const textBlock = response.content.find((b: { type: string }) => b.type === 'text');
      return (textBlock as { text: string })?.text || '';
    } catch (error) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        this.circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
        warn(
          `[HaikuClient] Circuit breaker opened after ${this.consecutiveFailures} failures. Cooling down for 5 minutes.`
        );
      }
      throw error;
    }
  }

  /**
   * Get or reuse Anthropic client — recreate only when token changes.
   * Pattern from standalone/src/agent/claude-client.ts getClient()
   */
  private getClient(token: string): Anthropic {
    if (this.client && this.lastToken === token) {
      return this.client;
    }

    this.client = new Anthropic({
      apiKey: null as unknown as string, // Must be null for OAuth
      authToken: token,
      defaultHeaders: OAUTH_HEADERS,
      dangerouslyAllowBrowser: true,
    });
    this.lastToken = token;
    return this.client;
  }

  /**
   * Get a valid token, refreshing if needed.
   * Simplified version of standalone OAuthManager.getToken()
   */
  private async getValidToken(): Promise<string | null> {
    const creds = this.readCredentials();
    if (!creds) return null;

    // Check if token needs refresh (within 10-min buffer)
    if (Date.now() >= creds.expiresAt - REFRESH_BUFFER_MS) {
      try {
        const refreshed = await this.refreshToken(creds.refreshToken);
        this.writeCredentials(refreshed);
        return refreshed.accessToken;
      } catch (err) {
        warn(
          `[HaikuClient] Token refresh failed: ${err instanceof Error ? err.message : String(err)}`
        );
        // If refresh fails but token isn't actually expired yet, use it
        if (Date.now() < creds.expiresAt) {
          return creds.accessToken;
        }
        return null;
      }
    }

    return creds.accessToken;
  }

  /**
   * Read OAuth token from ~/.claude/.credentials.json
   * Sync version for available() check.
   */
  private readToken(): string | null {
    const creds = this.readCredentials();
    if (!creds) return null;
    // For sync check, just verify token isn't fully expired
    if (Date.now() > creds.expiresAt) {
      return null;
    }
    return creds.accessToken;
  }

  /**
   * Read credentials from file or macOS Keychain.
   * Priority: 1) ~/.claude/.credentials.json  2) macOS Keychain
   * Format: { claudeAiOauth: { accessToken, refreshToken, expiresAt } }
   */
  private readCredentials(): CredentialsFile['claudeAiOauth'] | null {
    // Try file first (standalone OAuthManager writes here)
    const fileCreds = this.readCredentialsFromFile();
    if (fileCreds) return fileCreds;

    // Fallback: macOS Keychain (Claude Code stores tokens here)
    return this.readCredentialsFromKeychain();
  }

  private readCredentialsFromFile(): CredentialsFile['claudeAiOauth'] | null {
    try {
      if (!existsSync(CREDENTIALS_PATH)) return null;
      const raw = readFileSync(CREDENTIALS_PATH, 'utf-8');
      const data: CredentialsFile = JSON.parse(raw);
      const oauth = data.claudeAiOauth;
      if (!oauth?.accessToken || !oauth?.refreshToken || !oauth?.expiresAt) {
        return null;
      }
      return oauth;
    } catch {
      return null;
    }
  }

  /**
   * Read from macOS Keychain where Claude Code stores OAuth tokens.
   * Entry: "Claude Code-credentials" with same claudeAiOauth format.
   */
  private readCredentialsFromKeychain(): CredentialsFile['claudeAiOauth'] | null {
    if (process.platform !== 'darwin') return null;
    try {
      const raw = execSync(`security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`, {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      const data: CredentialsFile = JSON.parse(raw);
      const oauth = data.claudeAiOauth;
      if (!oauth?.accessToken || !oauth?.refreshToken || !oauth?.expiresAt) {
        return null;
      }
      return oauth;
    } catch {
      return null;
    }
  }

  /**
   * Refresh OAuth token — matches standalone OAuthManager.refreshToken()
   */
  private async refreshToken(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }> {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token refresh failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000 - 300_000, // 5-min buffer
    };
  }

  /**
   * Write refreshed credentials back — matches standalone OAuthManager.writeCredentials()
   */
  private writeCredentials(token: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }): void {
    try {
      const raw = readFileSync(CREDENTIALS_PATH, 'utf-8');
      const data: CredentialsFile = JSON.parse(raw);
      if (!data.claudeAiOauth) return;

      data.claudeAiOauth = {
        ...data.claudeAiOauth,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt,
      };

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { writeFileSync } = require('fs');
      writeFileSync(CREDENTIALS_PATH, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      warn('[HaikuClient] Failed to write refreshed credentials');
    }
  }
}
