/**
 * Configuration types for MAMA Standalone CLI
 */

// ============================================================================
// Role-Based Permission Types
// ============================================================================

/**
 * Role configuration for agent permissions
 * Each source (viewer, discord, telegram, etc.) maps to a role
 */
export interface RoleConfig {
  /**
   * Claude model to use for this role
   * If not specified, uses the global agent.model setting
   * @example "claude-opus-4-20250514", "claude-sonnet-4-20250514", "claude-3-haiku-20240307"
   */
  model?: string;

  /**
   * Maximum conversation turns for this role
   * If not specified, uses the global agent.max_turns setting
   */
  maxTurns?: number;

  /**
   * Allowed tools for this role
   * Supports wildcards: "mama_*", "browser_*"
   * Use ["*"] to allow all tools
   * @example ["mama_*", "Read", "discord_send"]
   */
  allowedTools: string[];

  /**
   * Explicitly blocked tools (takes precedence over allowedTools)
   * @example ["Bash", "Write"]
   */
  blockedTools?: string[];

  /**
   * Allowed file paths (glob patterns)
   * @example ["~/.mama/workspace/**", "/tmp/**"]
   */
  allowedPaths?: string[];

  /**
   * Whether this role can perform system control operations
   * (restart, stop, config changes)
   */
  systemControl?: boolean;

  /**
   * Whether this role can access sensitive data
   * (tokens, credentials, full config)
   */
  sensitiveAccess?: boolean;
}

/**
 * Source-to-role mapping
 * Keys: source identifiers (viewer, discord, telegram, slack, chatwork)
 * Values: role names defined in roles
 */
export type SourceRoleMapping = Record<string, string>;

/**
 * Roles configuration section
 * Defines all available roles and their permissions
 */
export interface RolesConfig {
  /**
   * Role definitions
   * @example { os_agent: { allowedTools: ["*"], systemControl: true } }
   */
  definitions: Record<string, RoleConfig>;

  /**
   * Source-to-role mapping
   * @example { viewer: "os_agent", discord: "discord_bot" }
   */
  sourceMapping: SourceRoleMapping;
}

/**
 * Default role configurations
 */
export const DEFAULT_ROLES: RolesConfig = {
  definitions: {
    os_agent: {
      model: 'claude-sonnet-4-20250514', // Full-featured model for OS control
      maxTurns: 20,
      allowedTools: ['*'],
      allowedPaths: ['~/**'],
      systemControl: true,
      sensitiveAccess: true,
    },
    chat_bot: {
      model: 'claude-sonnet-4-20250514', // Balanced model for chat
      maxTurns: 10,
      allowedTools: ['mama_*', 'Read', 'discord_send', 'translate_image'],
      blockedTools: ['Bash', 'Write', 'save_integration_token'],
      allowedPaths: ['~/.mama/workspace/**'],
      systemControl: false,
      sensitiveAccess: false,
    },
  },
  sourceMapping: {
    viewer: 'os_agent',
    discord: 'chat_bot',
    telegram: 'chat_bot',
    slack: 'chat_bot',
    chatwork: 'chat_bot',
  },
};

// ============================================================================
// Tool Routing Types
// ============================================================================

/**
 * Tool routing configuration
 * Allows hybrid Gateway/MCP tool execution
 */
export interface ToolsConfig {
  /**
   * Tools executed directly via GatewayToolExecutor
   * Supports wildcards: "browser_*", "mama_*"
   * @example ["browser_*", "Bash", "Read", "Write"]
   */
  gateway?: string[];
  /**
   * Tools routed to MCP server
   * Supports wildcards: "mama_*"
   * @example ["mama_*"]
   */
  mcp?: string[];
  /**
   * Path to MCP config file (required if mcp tools are defined)
   * @default "~/.mama/mama-mcp-config.json"
   */
  mcp_config?: string;
}

/**
 * Agent configuration
 */
export interface AgentConfig {
  /** Claude model to use */
  model: string;
  /** Maximum conversation turns */
  max_turns: number;
  /** Request timeout in milliseconds */
  timeout: number;
  /**
   * Tool routing configuration
   * If not specified, all tools use Gateway mode (default)
   */
  tools?: ToolsConfig;
  /**
   * Use persistent CLI process for faster responses (experimental)
   * When true, keeps Claude CLI process alive for multi-turn conversations
   * Response time: ~2-3s instead of ~16-30s
   * @default false
   */
  use_persistent_cli?: boolean;
}

/**
 * Database configuration
 */
export interface DatabaseConfig {
  /** Path to SQLite database */
  path: string;
}

/**
 * Logging configuration
 */
export interface LoggingConfig {
  /** Log level: debug, info, warn, error */
  level: 'debug' | 'info' | 'warn' | 'error';
  /** Path to log file */
  file: string;
}

/**
 * Discord gateway configuration
 */
export interface DiscordConfig {
  /** Enable Discord gateway */
  enabled: boolean;
  /** Discord bot token */
  token?: string;
  /** Default channel ID for notifications */
  default_channel_id?: string;
}

/**
 * Heartbeat scheduler configuration
 */
export interface HeartbeatConfig {
  /** Enable heartbeat scheduler */
  enabled?: boolean;
  /** Interval in milliseconds (default: 30 minutes) */
  interval?: number;
  /** Quiet hours start (0-23) */
  quiet_start?: number;
  /** Quiet hours end (0-23) */
  quiet_end?: number;
  /** Channel ID for notifications */
  notify_channel_id?: string;
}

/**
 * Slack gateway configuration
 */
export interface SlackConfig {
  /** Enable Slack gateway */
  enabled: boolean;
  /** Slack bot token */
  bot_token?: string;
  /** Slack app token (for socket mode) */
  app_token?: string;
}

/**
 * Telegram gateway configuration
 */
export interface TelegramConfig {
  /** Enable Telegram gateway */
  enabled: boolean;
  /** Telegram bot token from @BotFather */
  token?: string;
  /** Allowed chat IDs (empty = allow all) */
  allowed_chats?: string[];
}

/**
 * Chatwork gateway configuration
 */
export interface ChatworkConfig {
  /** Enable Chatwork gateway */
  enabled: boolean;
  /** Chatwork API token */
  api_token?: string;
  /** Room IDs to monitor */
  room_ids?: string[];
  /** Polling interval in milliseconds */
  poll_interval?: number;
  /** Whether mention is required */
  mention_required?: boolean;
}

/**
 * Workspace configuration
 */
export interface WorkspaceConfig {
  /** Workspace root path */
  path: string;
  /** Scripts directory */
  scripts: string;
  /** Data directory */
  data: string;
}

/**
 * Heartbeat integration configuration
 */
export interface HeartbeatIntegrationConfig {
  /** Path to data collection script */
  collect_script: string;
  /** Path to collected data JSON file */
  data_file: string;
  /** Path to report template file */
  template_file: string;
}

// ============================================================================
// Multi-Agent Types (imported from multi-agent module)
// ============================================================================

/**
 * Individual agent persona configuration
 */
export interface AgentPersonaConfig {
  /** Internal agent ID (used in code) */
  id: string;
  /** Display name shown in Discord messages */
  name: string;
  /** Display name with emoji prefix */
  display_name: string;
  /** Command prefix to explicitly trigger this agent */
  trigger_prefix: string;
  /** Path to persona markdown file with system prompt */
  persona_file: string;
  /**
   * Optional dedicated Discord bot token for this agent
   * If provided, this agent will use its own bot instead of the main bot
   */
  bot_token?: string;
  /**
   * Optional dedicated Slack bot token (xoxb-...) for this agent
   * If provided, this agent will use its own Slack bot
   */
  slack_bot_token?: string;
  /**
   * Optional dedicated Slack app token (xapp-...) for Socket Mode
   * Required alongside slack_bot_token for Slack multi-bot support
   */
  slack_app_token?: string;
  /** Keywords that auto-trigger this agent's response */
  auto_respond_keywords?: string[];
  /** Cooldown between responses in milliseconds */
  cooldown_ms?: number;
  /** Claude model to use for this agent */
  model?: string;
  /** Maximum turns for this agent */
  max_turns?: number;
  /** Whether this agent is enabled */
  enabled?: boolean;
  /** Agent tier level (1=full, 2=read-only, 3=read-only) @default 1 */
  tier?: 1 | 2 | 3;
  /** Whether this agent can delegate tasks (Tier 1 only) */
  can_delegate?: boolean;
  /** Enable automatic task continuation */
  auto_continue?: boolean;
  /** Explicit tool permissions (overrides tier defaults) */
  tool_permissions?: { allowed?: string[]; blocked?: string[] };
}

/**
 * Loop prevention configuration
 */
export interface LoopPreventionConfig {
  /** Maximum consecutive agent responses without human intervention */
  max_chain_length: number;
  /** Minimum time between any agent responses in milliseconds */
  global_cooldown_ms: number;
  /** Time window for counting chain length in milliseconds */
  chain_window_ms: number;
}

/**
 * Multi-agent system configuration
 */
export interface MultiAgentConfig {
  /** Enable/disable multi-agent system */
  enabled: boolean;
  /** Agent definitions (key is agent ID) */
  agents: Record<string, Omit<AgentPersonaConfig, 'id'>>;
  /** Loop prevention settings */
  loop_prevention: LoopPreventionConfig;
  /** Free chat mode - all agents respond to every human message */
  free_chat?: boolean;
  /** Default agent ID for channels without explicit triggers */
  default_agent?: string;
  /** Channel-specific agent configurations */
  channel_overrides?: Record<
    string,
    {
      default_agent?: string;
      allowed_agents?: string[];
      disabled_agents?: string[];
    }
  >;
  /** Category-based routing rules */
  categories?: Array<{
    name: string;
    patterns: string[];
    agent_ids: string[];
    priority?: number;
  }>;
  /** UltraWork autonomous session configuration */
  ultrawork?: {
    enabled: boolean;
    trigger_keywords?: string[];
    max_duration?: number;
    max_steps?: number;
  };
  /** Task continuation configuration */
  task_continuation?: {
    enabled: boolean;
    max_retries?: number;
    completion_markers?: string[];
  };
  /** Skip permission prompts for all agent processes (default: true) */
  dangerouslySkipPermissions?: boolean;
}

/**
 * Integrations configuration
 */
export interface IntegrationsConfig {
  /** Heartbeat report settings */
  heartbeat?: HeartbeatIntegrationConfig;
}

/**
 * Full MAMA configuration
 */
export interface MAMAConfig {
  /** Config version */
  version: number;
  /** Agent settings */
  agent: AgentConfig;
  /** Database settings */
  database: DatabaseConfig;
  /** Logging settings */
  logging: LoggingConfig;
  /** Role-based permission settings (optional) */
  roles?: RolesConfig;
  /** @deprecated Always uses Claude CLI now (ToS compliance) */
  use_claude_cli?: boolean;
  /** Discord gateway settings (optional) */
  discord?: DiscordConfig;
  /** Slack gateway settings (optional) */
  slack?: SlackConfig;
  /** Telegram gateway settings (optional) */
  telegram?: TelegramConfig;
  /** Chatwork gateway settings (optional) */
  chatwork?: ChatworkConfig;
  /** Workspace settings (optional) */
  workspace?: WorkspaceConfig;
  /** Integrations settings (optional) */
  integrations?: IntegrationsConfig;
  /** Heartbeat scheduler settings (optional) */
  heartbeat?: HeartbeatConfig;
  /** Multi-agent settings (optional) */
  multi_agent?: MultiAgentConfig;
}

/**
 * Default configuration values
 * SECURITY: Includes safe defaults for all optional fields
 */
export const DEFAULT_CONFIG: MAMAConfig = {
  version: 1,
  agent: {
    model: 'claude-sonnet-4-20250514',
    max_turns: 10,
    timeout: 300000, // 5 minutes
    tools: {
      // Default: all tools via Gateway (self-contained, no MCP dependency)
      gateway: ['*'],
      mcp: [],
      mcp_config: '~/.mama/mama-mcp-config.json',
    },
  },
  database: {
    path: '~/.claude/mama-memory.db',
  },
  logging: {
    level: 'info',
    file: '~/.mama/logs/mama.log',
  },
  // Role-based permissions (default)
  roles: DEFAULT_ROLES,
  // Safe defaults for optional fields (used by mergeWithDefaults)
  use_claude_cli: true, // Always use Claude CLI (ToS compliance)
  discord: undefined,
  slack: undefined,
  telegram: undefined,
  chatwork: undefined,
  heartbeat: undefined,
};

/**
 * Paths for MAMA files
 */
export const MAMA_PATHS = {
  /** MAMA home directory */
  HOME: '~/.mama',
  /** Configuration file */
  CONFIG: '~/.mama/config.yaml',
  /** PID file */
  PID: '~/.mama/mama.pid',
  /** Log directory */
  LOGS: '~/.mama/logs',
  /** Log file */
  LOG_FILE: '~/.mama/logs/mama.log',
} as const;
