/**
 * Configuration types for MAMA Standalone CLI
 */

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
