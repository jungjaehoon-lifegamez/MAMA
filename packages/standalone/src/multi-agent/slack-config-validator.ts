/**
 * Slack Configuration Validator
 *
 * Validates Slack bot and app tokens to ensure proper format
 * and prevent configuration errors during runtime.
 */

export interface SlackTokenValidation {
  isValid: boolean;
  error?: string;
  tokenType?: 'bot' | 'app' | 'user' | 'unknown';
}

export interface SlackConfigValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Slack Token Format Patterns
 */
const TOKEN_PATTERNS = {
  bot: /^xoxb-[0-9]+-[0-9]+-[0-9]+-[a-zA-Z0-9]{24}$/,
  app: /^xapp-[0-9]+-[A-Z0-9]+-[0-9]+-[a-zA-Z0-9]{64}$/,
  user: /^xoxp-[0-9]+-[0-9]+-[0-9]+-[a-zA-Z0-9]{24}$/,
  legacy_bot: /^xoxb-[a-zA-Z0-9-]+$/,
  legacy_app: /^xapp-[a-zA-Z0-9-]+$/,
} as const;

/**
 * Validate individual Slack token
 */
export function validateSlackToken(token: string): SlackTokenValidation {
  if (!token || typeof token !== 'string') {
    return {
      isValid: false,
      error: 'Token is required and must be a string',
    };
  }

  // Remove any whitespace
  const cleanToken = token.trim();

  if (cleanToken.length === 0) {
    return {
      isValid: false,
      error: 'Token cannot be empty',
    };
  }

  // Check bot token
  if (TOKEN_PATTERNS.bot.test(cleanToken) || TOKEN_PATTERNS.legacy_bot.test(cleanToken)) {
    return {
      isValid: true,
      tokenType: 'bot',
    };
  }

  // Check app token
  if (TOKEN_PATTERNS.app.test(cleanToken) || TOKEN_PATTERNS.legacy_app.test(cleanToken)) {
    return {
      isValid: true,
      tokenType: 'app',
    };
  }

  // Check user token (less common)
  if (TOKEN_PATTERNS.user.test(cleanToken)) {
    return {
      isValid: true,
      tokenType: 'user',
    };
  }

  // Check for common mistakes
  if (cleanToken.startsWith('xox')) {
    return {
      isValid: false,
      error:
        "Token format appears to be Slack but doesn't match expected patterns. Please check for typos.",
      tokenType: 'unknown',
    };
  }

  return {
    isValid: false,
    error:
      'Token does not appear to be a valid Slack token. Expected format: xoxb-* (bot) or xapp-* (app)',
    tokenType: 'unknown',
  };
}

/**
 * Validate Slack configuration for an agent
 */
export function validateSlackAgentConfig(config: {
  slack_bot_token?: string;
  slack_app_token?: string;
  agent_id?: string;
}): SlackConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const agentPrefix = config.agent_id ? `[${config.agent_id}] ` : '';

  // Check if at least one token is provided
  if (!config.slack_bot_token && !config.slack_app_token) {
    return {
      isValid: true, // Allow no Slack config (agent might not use Slack)
      errors: [],
      warnings: [`${agentPrefix}No Slack tokens configured - agent will not be available on Slack`],
    };
  }

  // Validate bot token if provided
  if (config.slack_bot_token) {
    const botValidation = validateSlackToken(config.slack_bot_token);
    if (!botValidation.isValid) {
      errors.push(`${agentPrefix}Invalid slack_bot_token: ${botValidation.error}`);
    } else if (botValidation.tokenType !== 'bot') {
      warnings.push(
        `${agentPrefix}slack_bot_token appears to be a ${botValidation.tokenType} token, not a bot token`
      );
    }
  }

  // Validate app token if provided
  if (config.slack_app_token) {
    const appValidation = validateSlackToken(config.slack_app_token);
    if (!appValidation.isValid) {
      errors.push(`${agentPrefix}Invalid slack_app_token: ${appValidation.error}`);
    } else if (appValidation.tokenType !== 'app') {
      warnings.push(
        `${agentPrefix}slack_app_token appears to be a ${appValidation.tokenType} token, not an app token`
      );
    }
  }

  // Check for common configuration issues
  if (config.slack_bot_token && !config.slack_app_token) {
    warnings.push(
      `${agentPrefix}Bot token provided without app token - Socket Mode features will not work. ` +
        `Consider adding slack_app_token for real-time mentions.`
    );
  }

  if (config.slack_app_token && !config.slack_bot_token) {
    errors.push(
      `${agentPrefix}App token provided without bot token - bot cannot send messages. ` +
        `slack_bot_token is required for Slack integration.`
    );
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate entire multi-agent Slack configuration
 */
export function validateMultiAgentSlackConfig(config: {
  agents?: Record<
    string,
    {
      slack_bot_token?: string;
      slack_app_token?: string;
    }
  >;
}): SlackConfigValidationResult {
  const allErrors: string[] = [];
  const allWarnings: string[] = [];

  if (!config.agents) {
    return {
      isValid: true,
      errors: [],
      warnings: ['No agents configured'],
    };
  }

  // Validate each agent's Slack configuration
  for (const [agentId, agentConfig] of Object.entries(config.agents)) {
    const validation = validateSlackAgentConfig({
      ...agentConfig,
      agent_id: agentId,
    });

    allErrors.push(...validation.errors);
    allWarnings.push(...validation.warnings);
  }

  // Check for duplicate tokens (security issue)
  const botTokens = new Map<string, string[]>();
  const appTokens = new Map<string, string[]>();

  for (const [agentId, agentConfig] of Object.entries(config.agents)) {
    if (agentConfig.slack_bot_token) {
      const agents = botTokens.get(agentConfig.slack_bot_token) || [];
      agents.push(agentId);
      botTokens.set(agentConfig.slack_bot_token, agents);
    }

    if (agentConfig.slack_app_token) {
      const agents = appTokens.get(agentConfig.slack_app_token) || [];
      agents.push(agentId);
      appTokens.set(agentConfig.slack_app_token, agents);
    }
  }

  // Report duplicate tokens
  for (const [_token, agents] of botTokens.entries()) {
    if (agents.length > 1) {
      allErrors.push(
        `Duplicate slack_bot_token shared by agents: ${agents.join(', ')}. ` +
          `Each agent must have a unique bot token.`
      );
    }
  }

  for (const [_token, agents] of appTokens.entries()) {
    if (agents.length > 1) {
      allWarnings.push(
        `Duplicate slack_app_token shared by agents: ${agents.join(', ')}. ` +
          `This may cause Socket Mode connection conflicts.`
      );
    }
  }

  return {
    isValid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
  };
}

/**
 * Mask token for safe logging
 */
export function maskSlackToken(token: string): string {
  if (!token || token.length < 8) {
    return '[INVALID_TOKEN]';
  }

  const prefix = token.substring(0, 4);
  const suffix = token.substring(token.length - 4);
  const masked = '*'.repeat(Math.max(4, token.length - 8));

  return `${prefix}${masked}${suffix}`;
}
