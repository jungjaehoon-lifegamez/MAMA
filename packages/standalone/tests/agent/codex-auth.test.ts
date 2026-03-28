import { describe, expect, it } from 'vitest';

import { extractCodexAuthFailure } from '../../src/agent/codex-auth.js';

describe('Story: Codex auth extraction', () => {
  describe('AC #1: ignores unrelated stderr', () => {
    it('returns null for unrelated stderr', () => {
      expect(extractCodexAuthFailure('WARN shell snapshot missing')).toBeNull();
    });
  });

  describe('AC #2: detects refresh_token_reused', () => {
    it('detects refresh_token_reused errors', () => {
      const failure = extractCodexAuthFailure(
        'ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {"error":{"code":"refresh_token_reused"}}'
      );

      expect(failure).toContain('refresh_token_reused');
    });
  });

  describe('AC #3: detects human-readable refresh failures', () => {
    it('detects human-readable token refresh failures', () => {
      const failure = extractCodexAuthFailure(
        'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.'
      );

      expect(failure).toContain('Codex authentication failed');
    });
  });
});
