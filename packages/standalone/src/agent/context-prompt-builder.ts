/**
 * Context Prompt Builder
 *
 * Builds system prompt context sections based on AgentContext.
 * Helps the agent understand its current role, capabilities, and limitations.
 */

import type { AgentContext, AgentPlatform } from './types.js';

/**
 * Valid agent platforms (Set for O(1) lookup)
 */
const VALID_PLATFORMS = new Set<AgentPlatform>([
  'viewer',
  'discord',
  'telegram',
  'slack',
  'chatwork',
  'cli',
]);

/**
 * Build a minimal context summary for token-efficient injection
 * @param context - Agent context
 * @returns Short context summary
 */
export function buildMinimalContext(context: AgentContext): string {
  const caps = context.capabilities.slice(0, 3).join(', ');
  const extra = context.capabilities.length > 3 ? ` +${context.capabilities.length - 3} more` : '';

  return `[Context: ${context.platform}/${context.roleName}, tools: ${caps}${extra}]`;
}

/**
 * Create AgentContext from source and role information
 * Helper function to build context from RoleManager output
 */
export function createAgentContext(
  source: string,
  roleName: string,
  role: import('../cli/config/types.js').RoleConfig,
  sessionInfo: {
    sessionId: string;
    channelId?: string;
    userId?: string;
    userName?: string;
  },
  capabilities: string[],
  limitations: string[]
): AgentContext {
  return {
    source,
    platform: normalizePlatform(source),
    roleName,
    role,
    session: {
      ...sessionInfo,
      startedAt: new Date(),
    },
    capabilities,
    limitations,
  };
}

/**
 * Normalize source string to AgentPlatform
 */
function normalizePlatform(source: string): AgentPlatform {
  const normalized = source.toLowerCase();

  if (VALID_PLATFORMS.has(normalized as AgentPlatform)) {
    return normalized as AgentPlatform;
  }

  // Default to cli for unknown sources
  return 'cli';
}
