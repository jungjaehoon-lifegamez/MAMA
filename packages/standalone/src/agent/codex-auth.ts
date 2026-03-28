export function extractCodexAuthFailure(text: string): string | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (
    normalized.includes('refresh_token_reused') ||
    normalized.includes('failed to refresh token') ||
    normalized.includes('your access token could not be refreshed') ||
    normalized.includes('please log out and sign in again')
  ) {
    return `Codex authentication failed: ${text.trim()}`;
  }

  return null;
}

export function isCodexAuthFailure(text: string): boolean {
  return extractCodexAuthFailure(text) !== null;
}
