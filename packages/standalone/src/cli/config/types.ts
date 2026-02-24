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
      model: 'claude-sonnet-4-6', // Full-featured model for OS control
      maxTurns: 20,
      allowedTools: ['*'],
      allowedPaths: ['~/**'],
      systemControl: true,
      sensitiveAccess: true,
    },
    chat_bot: {
      model: 'claude-sonnet-4-6', // Balanced model for chat
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
 * Effort level for Claude Opus 4.6 adaptive thinking
 * Controls how much thinking the model does before responding
 * @see https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

/**
 * Agent configuration
 */
export interface AgentConfig {
  /**
   * Backend for agent execution
   * - 'claude': Claude CLI (uses PersistentCLI for fast responses)
   * - 'codex-mcp': Codex via MCP protocol
   */
  backend: 'claude' | 'codex-mcp';
  /** Claude model to use */
  model: string;
  /**
   * Effort level for Opus 4.6 adaptive thinking
   * Only applies when model is 'claude-opus-4-6'
   * @default 'medium'
   */
  effort?: EffortLevel;
  /** Maximum conversation turns */
  max_turns: number;
  /** Request timeout in milliseconds */
  timeout: number;
  /**
   * Tool routing configuration
   * If not specified, all tools use Gateway mode (default)
   */
  tools?: ToolsConfig;
  /** Codex home directory for configuration/cache */
  codex_home?: string;
  /** Codex working directory */
  codex_cwd?: string;
  /** Codex sandbox mode */
  codex_sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Skip git repo check for Codex */
  codex_skip_git_repo_check?: boolean;
  /** Ephemeral mode for Codex (no session persistence) */
  codex_ephemeral?: boolean;
  /** Use persistent CLI process (for Claude backend) */
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
  /** Mention mode - only respond when mentioned */
  mention_mode?: boolean;
  /** Per-guild configuration for mention requirements */
  guilds?: Record<string, unknown>;
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
 *
 * @see packages/standalone/src/multi-agent/types.ts
 * Note: This is intentionally duplicated from runtime types for CLI config parsing.
 * CLI config layer uses this for validation, runtime uses multi-agent/types.ts.
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
  /** Backend for this agent (inherits from agent.backend if not set) */
  backend?: 'claude' | 'codex-mcp' | 'gemini';
  /** Claude model to use for this agent */
  model?: string;
  /** Maximum turns for this agent */
  max_turns?: number;
  /** Whether this agent is enabled */
  enabled?: boolean;
  /** Agent tier level (1=full, 2=limited, 3=scoped execution) @default 1 */
  tier?: 1 | 2 | 3;
  /** Whether this agent can delegate tasks (Tier 1 only) */
  can_delegate?: boolean;
  /** Enable automatic task continuation */
  auto_continue?: boolean;
  /** Explicit tool permissions (overrides tier defaults) */
  tool_permissions?: { allowed?: string[]; blocked?: string[] };
  /** Git identity for commits made by this agent */
  git_identity?: { name: string; email: string };
  /** Enable Code-Act sandbox mode for this agent */
  useCodeAct?: boolean;
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
 *
 * @see packages/standalone/src/multi-agent/types.ts
 * Note: This is intentionally duplicated from runtime types for CLI config parsing.
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
    /** Enable file-based state persistence (Ralph Loop pattern) @default true */
    persist_state?: boolean;
    /** Enable 3-phase structured loop (plan->build->retrospective) @default true */
    phased_loop?: boolean;
  };
  /** Task continuation configuration */
  task_continuation?: {
    enabled: boolean;
    max_retries?: number;
    completion_markers?: string[];
  };
  /**
   * Skip permission prompts for all agent processes
   *
   * @warning SECURITY RISK: Bypasses all permission checks for tool use.
   * Only enable in trusted environments where agent actions are pre-approved.
   *
   * @default true
   */
  dangerouslySkipPermissions?: boolean;
  /** Enable @mention-based delegation between agents @default false */
  mention_delegation?: boolean;
  /** Maximum depth of @mention delegation chains @default 3 */
  max_mention_depth?: number;
  /** Explicit delegation rules controlling which agents can delegate to which */
  delegation_rules?: Array<{ from: string; to: string[] }>;
  /** Dynamic workflow orchestration @default enabled */
  workflow?: {
    enabled: boolean;
    max_ephemeral_agents?: number;
    max_duration_ms?: number;
    max_concurrent_steps?: number;
    backend_balancing?: boolean;
  };
  /** Council mode — multi-round discussions among named agents @default enabled */
  council?: {
    enabled: boolean;
    max_rounds?: number;
    max_duration_ms?: number;
  };
}

/**
 * Integrations configuration
 */
export interface IntegrationsConfig {
  /** Heartbeat report settings */
  heartbeat?: HeartbeatIntegrationConfig;
}

// ============================================================================
// Tuning Configuration Types (Sprint 1 — Config Externalization)
// ============================================================================

/**
 * Prompt size limits (currently hardcoded in prompt-size-monitor.ts, agent-loop.ts)
 * Note: values are in characters until Sprint 2 token migration (STORY-006/007)
 */
export interface PromptConfig {
  /** Warn threshold in chars @default 15000 */
  warn_chars: number;
  /** Truncate threshold in chars @default 25000 */
  truncate_chars: number;
  /** Hard limit in chars @default 40000 */
  hard_limit_chars: number;
  /** Max skill file chars @default 4000 */
  skill_max_chars: number;
}

/**
 * Timeout settings (currently hardcoded across 6+ files)
 */
export interface TimeoutsConfig {
  /** CLI request timeout @default 120000 */
  request_ms: number;
  /** Codex MCP request timeout @default 180000 */
  codex_request_ms: number;
  /** MCP initialize timeout @default 60000 */
  initialize_ms: number;
  /** Session idle timeout @default 1800000 */
  session_ms: number;
  /** Session cleanup interval @default 300000 */
  session_cleanup_ms: number;
  /** Agent execution timeout @default 300000 */
  agent_ms: number;
  /** UltraWork execution timeout @default 300000 */
  ultrawork_ms: number;
  /** Retry delay when agent is busy @default 5000 */
  busy_retry_ms: number;
}

/**
 * Gateway-related timing settings (dedup, TTL, intervals)
 */
export interface GatewayConfig {
  /** Dedup TTL for Slack messages @default 30000 */
  dedup_ttl_ms: number;
  /** Mention tracking TTL @default 300000 */
  mention_ttl_ms: number;
  /** Message queue TTL @default 1200000 */
  message_ttl_ms: number;
  /** Cleanup interval for gateway state @default 60000 */
  cleanup_interval_ms: number;
  /** Heartbeat interval for Slack typing @default 60000 */
  heartbeat_interval_ms: number;
  /** Channel history cleanup interval @default 3600000 */
  history_cleanup_interval_ms: number;
  /** Tool status throttle @default 3000 */
  tool_status_throttle_ms: number;
  /** Tool status initial delay @default 5000 */
  tool_status_initial_delay_ms: number;
}

/**
 * IO and data size limits
 */
export interface IOConfig {
  /** Max bytes for file reads @default 200000 */
  max_read_bytes: number;
  /** Max chars for dynamic context injection @default 4000 */
  max_dynamic_context_chars: number;
  /** Context warning threshold in tokens @default 160000 */
  context_threshold_tokens: number;
  /** Max context tokens before forced rotation @default 200000 */
  max_context_tokens: number;
}

/**
 * Metrics collection settings (Sprint 4 — EPIC-006)
 */
export interface MetricsConfig {
  /** Enable metrics collection @default true */
  enabled: boolean;
  /** Days to retain metrics data @default 7 */
  retention_days: number;
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
  /** Enable automatic process killing on port conflicts (default: false) */
  enable_auto_kill_port?: boolean;
  /** Prompt size limits */
  prompt?: PromptConfig;
  /** Timeout settings */
  timeouts?: TimeoutsConfig;
  /** Gateway timing settings */
  gateway_tuning?: GatewayConfig;
  /** IO and data size limits */
  io?: IOConfig;
  /** Metrics collection settings */
  metrics?: MetricsConfig;
  /** Preserve user-defined sections (scheduling, custom integrations, etc.) */
  [key: string]: unknown;
}

/**
 * Default configuration values
 * SECURITY: Includes safe defaults for all optional fields
 */
export const DEFAULT_CONFIG: MAMAConfig = {
  version: 1,
  agent: {
    backend: 'claude',
    model: 'claude-sonnet-4-6',
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
  enable_auto_kill_port: false,
  prompt: {
    warn_chars: 15_000,
    truncate_chars: 25_000,
    hard_limit_chars: 40_000,
    skill_max_chars: 4_000,
  },
  timeouts: {
    request_ms: 120_000,
    codex_request_ms: 180_000,
    initialize_ms: 60_000,
    session_ms: 1_800_000,
    session_cleanup_ms: 300_000,
    agent_ms: 300_000,
    ultrawork_ms: 300_000,
    busy_retry_ms: 5_000,
  },
  gateway_tuning: {
    dedup_ttl_ms: 30_000,
    mention_ttl_ms: 300_000,
    message_ttl_ms: 1_200_000,
    cleanup_interval_ms: 60_000,
    heartbeat_interval_ms: 60_000,
    history_cleanup_interval_ms: 3_600_000,
    tool_status_throttle_ms: 3_000,
    tool_status_initial_delay_ms: 5_000,
  },
  io: {
    max_read_bytes: 200_000,
    max_dynamic_context_chars: 4_000,
    context_threshold_tokens: 160_000,
    max_context_tokens: 200_000,
  },
  metrics: {
    enabled: true,
    retention_days: 7,
  },
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
