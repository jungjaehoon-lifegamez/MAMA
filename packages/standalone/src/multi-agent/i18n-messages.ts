/**
 * Multi-Agent message templates
 *
 * Simple English message templates with variable substitution.
 */

export interface I18nMessages {
  busy_message: string;
  rate_limit_warning: string;
  chain_blocked: string;
  chain_depth_exceeded: string;
  agent_not_found: string;
  timeout_error: string;
  processing_error: string;
  delegation_error: string;
  bot_initialization_error: string;
}

const messages: I18nMessages = {
  busy_message:
    '*{agentName}*: Currently processing a previous request. Please try again shortly. ⏳',
  rate_limit_warning: 'Rate limit exceeded. Please wait {seconds} seconds before trying again.',
  chain_blocked: 'Mention chain blocked in channel {channelId}',
  chain_depth_exceeded: 'Mention chain depth limit ({maxDepth}) exceeded in channel {channelId}',
  agent_not_found: 'Agent not found: {agentId}',
  timeout_error: 'Agent {agentId} timed out after {seconds} seconds',
  processing_error: 'Error processing request for agent {agentId}: {error}',
  delegation_error: 'Failed to delegate to agent {agentId}',
  bot_initialization_error: 'Failed to initialize bot for agent {agentId}',
};

/**
 * Get message with variable substitution
 */
export function t(
  key: keyof I18nMessages,
  variables: Record<string, string | number> = {}
): string {
  const messageTemplate = messages[key];

  if (!messageTemplate) {
    return `[Missing message: ${key}]`;
  }

  return messageTemplate.replace(/\{(\w+)\}/g, (match, varName) => {
    const value = variables[varName];
    return value !== undefined ? String(value) : match;
  });
}

/**
 * @deprecated Use the `t` function directly instead.
 */
export class I18n {
  t(key: keyof I18nMessages, variables: Record<string, string | number> = {}): string {
    return t(key, variables);
  }

  /** @deprecated No-op — only English is supported */
  setLanguage(_language: string): void {}
  getLanguage(): string {
    return 'en';
  }
  /** @deprecated Removed — always returns 'en' */
  static detectLanguage(_locale?: string): string {
    return 'en';
  }
}

/** @deprecated Use the `t` function directly */
export const defaultI18n = new I18n();
export type SupportedLanguage = string;
