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
 * Platform-specific guidelines for message formatting
 */
const PLATFORM_GUIDELINES: Record<AgentPlatform, string> = {
  viewer: `
- You are running in the MAMA Viewer (web interface)
- You have OS-level permissions and can perform system administration tasks
- You can add/remove bots, modify configuration, and access sensitive data
- Format responses with full markdown support
- Use code blocks for technical output`,

  discord: `
- You are running as a Discord bot
- Keep responses under 2000 characters (Discord limit)
- Use Discord markdown: **bold**, *italic*, \`code\`, \`\`\`code blocks\`\`\`
- Use embeds sparingly for better formatting
- Avoid using complex tables (they render poorly)
- React with emojis when appropriate`,

  telegram: `
- You are running as a Telegram bot
- Keep responses concise (Telegram users expect quick responses)
- Use Telegram HTML formatting: <b>bold</b>, <i>italic</i>, <code>code</code>
- Use <pre> for code blocks
- Avoid very long messages; split if necessary`,

  slack: `
- You are running as a Slack bot
- Use Slack mrkdwn: *bold*, _italic_, \`code\`, \`\`\`code blocks\`\`\`
- Keep responses focused and professional
- Use thread replies for long conversations
- Mention users with <@USER_ID> format`,

  chatwork: `
- You are running as a Chatwork bot
- Use Chatwork markup: [info]...[/info], [code]...[/code]
- Keep responses business-appropriate
- Tag users with [To:USER_ID]`,

  cli: `
- You are running in CLI mode
- Use terminal-friendly formatting
- Avoid excessive decorations
- Use clear section headers for organization`,
};

/**
 * Build the context prompt section for system messages
 * @param context - Agent context with role and platform information
 * @returns Formatted markdown string for system prompt
 */
export function buildContextPrompt(context: AgentContext): string {
  const lines: string[] = [];

  // Header
  lines.push('## Current Agent Context');
  lines.push('');

  // Identity section
  lines.push('### Identity');
  lines.push(`- **Platform**: ${formatPlatformName(context.platform)}`);
  lines.push(`- **Role**: ${context.roleName} (${getRoleDescription(context.roleName)})`);
  lines.push(`- **Session**: ${context.session.sessionId.slice(0, 8)}...`);
  if (context.session.userName) {
    lines.push(`- **User**: ${context.session.userName}`);
  }
  if (context.session.channelId) {
    lines.push(`- **Channel**: ${context.session.channelId}`);
  }
  lines.push('');

  // Capabilities section
  lines.push('### Capabilities');
  if (context.capabilities.length > 0) {
    for (const cap of context.capabilities) {
      lines.push(`- ${cap}`);
    }
  } else {
    lines.push('- Limited capabilities');
  }
  lines.push('');

  // Limitations section
  if (context.limitations.length > 0) {
    lines.push('### Limitations');
    for (const limit of context.limitations) {
      lines.push(`- ${limit}`);
    }
    lines.push('');
  }

  // Platform-specific guidelines
  const guidelines = PLATFORM_GUIDELINES[context.platform];
  if (guidelines) {
    lines.push('### Platform Guidelines');
    lines.push(guidelines.trim());
    lines.push('');
  }

  // Permission reminders
  lines.push('### Permission Reminders');
  if (context.role.systemControl) {
    lines.push('- You CAN perform system control operations (restart bots, modify config)');
  } else {
    lines.push('- You CANNOT perform system control operations');
  }
  if (context.role.sensitiveAccess) {
    lines.push('- You CAN access sensitive data (tokens, credentials)');
  } else {
    lines.push('- You CANNOT access sensitive data (tokens will be masked)');
  }
  lines.push('');

  return lines.join('\n');
}

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
 * Get human-readable platform name
 */
function formatPlatformName(platform: AgentPlatform): string {
  const names: Record<AgentPlatform, string> = {
    viewer: 'MAMA Viewer (Web)',
    discord: 'Discord',
    telegram: 'Telegram',
    slack: 'Slack',
    chatwork: 'Chatwork',
    cli: 'Command Line',
  };
  return names[platform] || platform;
}

/**
 * Get role description for display
 */
function getRoleDescription(roleName: string): string {
  const descriptions: Record<string, string> = {
    os_agent: 'full system access',
    chat_bot: 'limited permissions',
    restricted: 'minimal permissions',
  };
  return descriptions[roleName] || 'custom role';
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
