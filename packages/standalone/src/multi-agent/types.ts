/**
 * Multi-Agent Discord Chat System - Type Definitions
 *
 * Enables multiple AI agents (personas) to interact in Discord channels,
 * with automatic conversation flow and loop prevention.
 */

/**
 * Individual agent persona configuration
 */
export interface AgentPersonaConfig {
  /**
   * Internal agent ID (used in code)
   * @example "developer", "reviewer", "pm"
   */
  id: string;

  /**
   * Display name shown in Discord messages
   * @example "DevBot", "Reviewer"
   */
  name: string;

  /**
   * Display name with emoji prefix
   * @example "🔧 DevBot", "📝 Reviewer"
   */
  display_name: string;

  /**
   * Command prefix to explicitly trigger this agent
   * @example "!dev", "!review", "!pm"
   */
  trigger_prefix: string;

  /**
   * Path to persona markdown file with system prompt
   * @example "~/.mama/personas/developer.md"
   */
  persona_file: string;

  /**
   * Optional dedicated Discord bot token for this agent
   * If provided, this agent will use its own bot instead of the main bot
   * @example "MTQ2OTAyNTkxMTg2MDEwMTMzMg.xxx.yyy"
   */
  bot_token?: string;

  /**
   * Keywords that auto-trigger this agent's response
   * @example ["bug", "error", "code", "fix"]
   */
  auto_respond_keywords?: string[];

  /**
   * Cooldown between responses in milliseconds
   * Prevents spam when multiple triggers match
   * @default 5000
   */
  cooldown_ms?: number;

  /**
   * Claude model to use for this agent
   * If not specified, uses the global agent.model setting
   */
  model?: string;

  /**
   * Maximum turns for this agent
   * If not specified, uses the global agent.max_turns setting
   */
  max_turns?: number;

  /**
   * Whether this agent is enabled
   * @default true
   */
  enabled?: boolean;
}

/**
 * Loop prevention configuration
 * Prevents infinite agent-to-agent conversation loops
 */
export interface LoopPreventionConfig {
  /**
   * Maximum consecutive agent responses without human intervention
   * After this limit, agents will stop responding until a human speaks
   * @default 3
   */
  max_chain_length: number;

  /**
   * Minimum time between any agent responses in milliseconds
   * Applies globally across all agents
   * @default 2000
   */
  global_cooldown_ms: number;

  /**
   * Time window for counting chain length in milliseconds
   * Chain resets if no agent responds within this window
   * @default 60000 (1 minute)
   */
  chain_window_ms: number;
}

/**
 * Multi-agent system configuration
 */
export interface MultiAgentConfig {
  /**
   * Enable/disable multi-agent system
   * @default false
   */
  enabled: boolean;

  /**
   * Agent definitions
   * Key is agent ID, value is persona config
   */
  agents: Record<string, Omit<AgentPersonaConfig, 'id'>>;

  /**
   * Loop prevention settings
   */
  loop_prevention: LoopPreventionConfig;

  /**
   * Free chat mode - all agents respond to every human message
   * regardless of keyword matching or explicit triggers
   * @default false
   */
  free_chat?: boolean;

  /**
   * Default agent ID for channels without explicit triggers
   * If not set, requires explicit trigger or keyword match
   */
  default_agent?: string;

  /**
   * Channel-specific agent configurations
   * Key is channelId, value is configuration
   */
  channel_overrides?: Record<
    string,
    {
      /** Default agent for this channel */
      default_agent?: string;
      /** Agents allowed in this channel (empty = all) */
      allowed_agents?: string[];
      /** Agents disabled in this channel */
      disabled_agents?: string[];
    }
  >;
}

/**
 * Agent response tracking for loop prevention
 */
export interface AgentResponseRecord {
  /** Agent ID that responded */
  agentId: string;
  /** Channel ID where response occurred */
  channelId: string;
  /** Timestamp of response */
  timestamp: number;
  /** Message ID of the response */
  messageId?: string;
}

/**
 * Chain state for a channel
 */
export interface ChainState {
  /** Current chain length (consecutive agent responses) */
  length: number;
  /** Timestamp of last agent response */
  lastResponseTime: number;
  /** ID of last responding agent */
  lastAgentId: string | null;
  /** Whether chain is blocked (waiting for human) */
  blocked: boolean;
}

/**
 * Agent selection result
 */
export interface AgentSelectionResult {
  /** Selected agent IDs that should respond */
  selectedAgents: string[];
  /** Reason for selection (for logging/debugging) */
  reason: 'explicit_trigger' | 'keyword_match' | 'default_agent' | 'free_chat' | 'none';
  /** Whether response is blocked by loop prevention */
  blocked: boolean;
  /** Block reason if blocked */
  blockReason?: string;
}

/**
 * Message context for agent selection
 */
export interface MessageContext {
  /** Channel ID */
  channelId: string;
  /** User ID of message sender */
  userId: string;
  /** Message content (cleaned) */
  content: string;
  /** Whether sender is a bot */
  isBot: boolean;
  /** If bot, the agent ID that sent it (extracted from display name) */
  senderAgentId?: string;
  /** Message ID */
  messageId?: string;
  /** Timestamp */
  timestamp: number;
}

/**
 * Default loop prevention settings
 */
export const DEFAULT_LOOP_PREVENTION: LoopPreventionConfig = {
  max_chain_length: 3,
  global_cooldown_ms: 2000,
  chain_window_ms: 60000,
};

/**
 * Default multi-agent configuration (disabled by default)
 */
export const DEFAULT_MULTI_AGENT_CONFIG: MultiAgentConfig = {
  enabled: false,
  agents: {},
  loop_prevention: DEFAULT_LOOP_PREVENTION,
};
