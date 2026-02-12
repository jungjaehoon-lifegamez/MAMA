/**
 * Lightweight Anthropic client factory using OAuth tokens.
 * Deduplicates the OAuth + Anthropic init pattern used in image-analyzer.ts
 * and other places that need a one-shot API call.
 *
 * For full agent loop usage, use src/agent/claude-client.ts (ClaudeClient class) instead.
 */

const CLAUDE_CODE_VERSION = '2.1.2';
const OAUTH_HEADERS: Record<string, string> = {
  'anthropic-dangerous-direct-browser-access': 'true',
  'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
  'user-agent': `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
  'x-app': 'cli',
};

/**
 * Create a one-shot Anthropic client with OAuth authentication.
 */
export async function createClaudeClient(): Promise<unknown> {
  const AnthropicSDK = (await import('@anthropic-ai/sdk')).default;
  const { OAuthManager } = await import('./index.js');
  const oauthManager = new OAuthManager();
  const token = await oauthManager.getToken();

  if (!token) {
    throw new Error('No access token available. Please run: mama login');
  }

  return new AnthropicSDK({
    apiKey: null as unknown as string,
    authToken: token,
    defaultHeaders: OAUTH_HEADERS,
    dangerouslyAllowBrowser: true,
  });
}
