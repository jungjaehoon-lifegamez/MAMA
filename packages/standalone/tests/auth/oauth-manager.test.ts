/**
 * Unit tests for OAuthManager
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OAuthManager, OAuthError } from '../../src/auth/index.js';

describe('OAuthManager', () => {
  let testDir: string;
  let credentialsPath: string;

  // Mock credentials data
  const mockCredentials = {
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-test-access-token',
      refreshToken: 'sk-ant-ort01-test-refresh-token',
      expiresAt: Date.now() + 3600000, // 1 hour from now
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
    },
  };

  // Mock fetch response
  const mockRefreshResponse = {
    access_token: 'sk-ant-oat01-new-access-token',
    refresh_token: 'sk-ant-ort01-new-refresh-token',
    expires_in: 3600, // 1 hour in seconds
    token_type: 'Bearer',
  };

  beforeEach(async () => {
    // Create temp directory for test credentials
    testDir = join(tmpdir(), `mama-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    credentialsPath = join(testDir, 'credentials.json');
  });

  afterEach(async () => {
    // Clean up temp directory
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('getToken()', () => {
    it('should read token from credentials file', async () => {
      // Arrange
      await writeFile(credentialsPath, JSON.stringify(mockCredentials));
      const manager = new OAuthManager({ credentialsPath });

      // Act
      const token = await manager.getToken();

      // Assert
      expect(token).toBe(mockCredentials.claudeAiOauth.accessToken);
    });

    it('should return cached token within TTL', async () => {
      // Arrange
      await writeFile(credentialsPath, JSON.stringify(mockCredentials));
      const manager = new OAuthManager({ credentialsPath, cacheTtlMs: 60000 });

      // Act
      const token1 = await manager.getToken();

      // Modify the file (simulating external change)
      const modifiedCredentials = {
        ...mockCredentials,
        claudeAiOauth: {
          ...mockCredentials.claudeAiOauth,
          accessToken: 'different-token',
        },
      };
      await writeFile(credentialsPath, JSON.stringify(modifiedCredentials));

      const token2 = await manager.getToken();

      // Assert - should return cached token, not the modified one
      expect(token1).toBe(token2);
      expect(token1).toBe(mockCredentials.claudeAiOauth.accessToken);
    });

    it('should throw error when credentials file not found', async () => {
      // Arrange
      const manager = new OAuthManager({
        credentialsPath: '/nonexistent/path/credentials.json',
      });

      // Act & Assert
      await expect(manager.getToken()).rejects.toThrow(OAuthError);
      await expect(manager.getToken()).rejects.toMatchObject({
        code: 'CREDENTIALS_NOT_FOUND',
      });
    });

    it('should throw error when claudeAiOauth is missing', async () => {
      // Arrange
      await writeFile(credentialsPath, JSON.stringify({ other: 'data' }));
      const manager = new OAuthManager({ credentialsPath });

      // Act & Assert
      await expect(manager.getToken()).rejects.toThrow(OAuthError);
      await expect(manager.getToken()).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
      });
    });

    it('should refresh token when close to expiry', async () => {
      // Arrange - token expires in 5 minutes (within 10 minute buffer)
      const expiringCredentials = {
        claudeAiOauth: {
          ...mockCredentials.claudeAiOauth,
          expiresAt: Date.now() + 300000, // 5 minutes
        },
      };
      await writeFile(credentialsPath, JSON.stringify(expiringCredentials));

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockRefreshResponse),
      });

      const manager = new OAuthManager({
        credentialsPath,
        refreshBufferMs: 600000, // 10 minutes
        fetchFn: mockFetch as typeof fetch,
      });

      // Act
      const token = await manager.getToken();

      // Assert
      expect(mockFetch).toHaveBeenCalledWith(
        'https://console.anthropic.com/v1/oauth/token',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );
      expect(token).toBe(mockRefreshResponse.access_token);
    });
  });

  describe('getStatus()', () => {
    it('should return valid status for active token', async () => {
      // Arrange
      await writeFile(credentialsPath, JSON.stringify(mockCredentials));
      const manager = new OAuthManager({ credentialsPath });

      // Act
      const status = await manager.getStatus();

      // Assert
      expect(status.valid).toBe(true);
      expect(status.expiresAt).toBe(mockCredentials.claudeAiOauth.expiresAt);
      expect(status.expiresIn).toBeGreaterThan(0);
      expect(status.subscriptionType).toBe('max');
      expect(status.rateLimitTier).toBe('default_claude_max_20x');
    });

    it('should return invalid status for expired token', async () => {
      // Arrange
      const expiredCredentials = {
        claudeAiOauth: {
          ...mockCredentials.claudeAiOauth,
          expiresAt: Date.now() - 1000, // Expired 1 second ago
        },
      };
      await writeFile(credentialsPath, JSON.stringify(expiredCredentials));
      const manager = new OAuthManager({ credentialsPath });

      // Act
      const status = await manager.getStatus();

      // Assert
      expect(status.valid).toBe(false);
      expect(status.expiresIn).toBe(0);
    });

    it('should return needsRefresh when within refresh buffer', async () => {
      // Arrange - token expires in 5 minutes
      const nearExpiryCredentials = {
        claudeAiOauth: {
          ...mockCredentials.claudeAiOauth,
          expiresAt: Date.now() + 300000, // 5 minutes
        },
      };
      await writeFile(credentialsPath, JSON.stringify(nearExpiryCredentials));
      const manager = new OAuthManager({
        credentialsPath,
        refreshBufferMs: 600000, // 10 minutes
      });

      // Act
      const status = await manager.getStatus();

      // Assert
      expect(status.valid).toBe(true);
      expect(status.needsRefresh).toBe(true);
    });

    it('should return error status when credentials not found', async () => {
      // Arrange
      const manager = new OAuthManager({
        credentialsPath: '/nonexistent/credentials.json',
      });

      // Act
      const status = await manager.getStatus();

      // Assert
      expect(status.valid).toBe(false);
      expect(status.error).toBeDefined();
      expect(status.expiresAt).toBeNull();
    });
  });

  describe('forceRefresh()', () => {
    it('should refresh token and write to file', async () => {
      // Arrange
      await writeFile(credentialsPath, JSON.stringify(mockCredentials));

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockRefreshResponse),
      });

      const manager = new OAuthManager({
        credentialsPath,
        fetchFn: mockFetch as typeof fetch,
      });

      // Act
      const newToken = await manager.forceRefresh();

      // Assert
      expect(newToken).toBe(mockRefreshResponse.access_token);
      expect(mockFetch).toHaveBeenCalled();

      // Verify file was updated
      const { readFile } = await import('node:fs/promises');
      const updatedContent = await readFile(credentialsPath, 'utf-8');
      const updatedData = JSON.parse(updatedContent);
      expect(updatedData.claudeAiOauth.accessToken).toBe(mockRefreshResponse.access_token);
      expect(updatedData.claudeAiOauth.refreshToken).toBe(mockRefreshResponse.refresh_token);
    });

    it('should throw error when refresh API fails', async () => {
      // Arrange
      await writeFile(credentialsPath, JSON.stringify(mockCredentials));

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Invalid refresh token'),
      });

      const manager = new OAuthManager({
        credentialsPath,
        fetchFn: mockFetch as typeof fetch,
      });

      // Act & Assert
      await expect(manager.forceRefresh()).rejects.toThrow(OAuthError);
      await expect(manager.forceRefresh()).rejects.toMatchObject({
        code: 'REFRESH_FAILED',
      });
    });

    it('should throw error on network failure', async () => {
      // Arrange
      await writeFile(credentialsPath, JSON.stringify(mockCredentials));

      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const manager = new OAuthManager({
        credentialsPath,
        fetchFn: mockFetch as typeof fetch,
      });

      // Act & Assert
      await expect(manager.forceRefresh()).rejects.toThrow(OAuthError);
      await expect(manager.forceRefresh()).rejects.toMatchObject({
        code: 'NETWORK_ERROR',
      });
    });
  });

  describe('clearCache()', () => {
    it('should clear the token cache', async () => {
      // Arrange
      await writeFile(credentialsPath, JSON.stringify(mockCredentials));
      const manager = new OAuthManager({ credentialsPath, cacheTtlMs: 60000 });

      // First call to populate cache
      await manager.getToken();

      // Modify file
      const modifiedCredentials = {
        claudeAiOauth: {
          ...mockCredentials.claudeAiOauth,
          accessToken: 'modified-token',
        },
      };
      await writeFile(credentialsPath, JSON.stringify(modifiedCredentials));

      // Clear cache
      manager.clearCache();

      // Act - should read from file now
      const token = await manager.getToken();

      // Assert
      expect(token).toBe('modified-token');
    });
  });

  describe('Token refresh request format', () => {
    it('should send correct refresh request to Anthropic', async () => {
      // Arrange
      await writeFile(credentialsPath, JSON.stringify(mockCredentials));

      let capturedBody: string | undefined;
      const mockFetch = vi.fn().mockImplementation(async (_url, options) => {
        capturedBody = options?.body;
        return {
          ok: true,
          json: () => Promise.resolve(mockRefreshResponse),
        };
      });

      const manager = new OAuthManager({
        credentialsPath,
        fetchFn: mockFetch as typeof fetch,
      });

      // Act
      await manager.forceRefresh();

      // Assert
      const parsedBody = JSON.parse(capturedBody!);
      expect(parsedBody).toEqual({
        grant_type: 'refresh_token',
        client_id: 'OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl',
        refresh_token: mockCredentials.claudeAiOauth.refreshToken,
      });
    });
  });
});
