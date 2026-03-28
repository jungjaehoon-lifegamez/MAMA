import { describe, expect, it } from 'vitest';

import { extractCodexAuthFailure } from '../../src/agent/codex-auth.js';

describe('extractCodexAuthFailure', () => {
  it('returns null for unrelated stderr', () => {
    expect(extractCodexAuthFailure('WARN shell snapshot missing')).toBeNull();
  });

  it('detects refresh_token_reused errors', () => {
    const failure = extractCodexAuthFailure(
      'ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {"error":{"code":"refresh_token_reused"}}'
    );

    expect(failure).toContain('refresh_token_reused');
  });

  it('detects human-readable token refresh failures', () => {
    const failure = extractCodexAuthFailure(
      'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.'
    );

    expect(failure).toContain('Codex authentication failed');
  });
});
