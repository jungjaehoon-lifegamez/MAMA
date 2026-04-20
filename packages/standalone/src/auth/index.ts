/**
 * Auth module - OAuth Token Management for MAMA Standalone
 */

export { OAuthManager } from './oauth-manager.js';
export { getClaudeCodeAuthStatus } from './claude-code-auth.js';

export type {
  ClaudeCredentialsFile,
  ClaudeAiOAuth,
  OAuthToken,
  TokenRefreshResponse,
  TokenStatus,
  OAuthManagerOptions,
  CachedToken,
  OAuthErrorCode,
} from './types.js';
export type { ClaudeCodeAuthStatus } from './claude-code-auth.js';

export { OAuthError } from './types.js';
