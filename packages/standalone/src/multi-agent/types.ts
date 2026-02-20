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
   * Optional dedicated Slack bot token for this agent (xoxb-...)
   * If provided, this agent will use its own Slack bot
   */
  slack_bot_token?: string;

  /**
   * Optional Slack app token for Socket Mode (xapp-...)
   * Required alongside slack_bot_token for Slack multi-bot support
   */
  slack_app_token?: string;

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
   * Model to use for this agent
   * If not specified, uses the global agent.model setting
   */
  model?: string;

  /**
   * Effort level for Claude 4.6 adaptive thinking
   * 'max' is only available on Opus 4.6
   * If not specified, uses the global agent.effort setting
   */
  effort?: 'low' | 'medium' | 'high' | 'max';

  /**
   * Runtime backend for this agent.
   * - 'claude': Claude CLI (uses PersistentCLI for fast responses)
   * - 'codex-mcp': Codex via MCP protocol
   * If not specified, uses global runtime backend.
   */
  backend?: 'claude' | 'codex-mcp' | 'gemini';

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

  /**
   * Agent tier level
   * - Tier 1: Full access, can delegate to others
   * - Tier 2: Read/analyze tools only (no write/edit/bash)
   * - Tier 3: Scoped execution (limited tools per agent config)
   * @default 1 (backward compat: existing agents keep full access)
   */
  tier?: 1 | 2 | 3;

  /**
   * Whether this agent can delegate tasks to other agents
   * Only effective for Tier 1 agents
   * @default false
   */
  can_delegate?: boolean;

  /**
   * Marks this agent as the planning orchestrator (BMAD context injection target)
   * @default false
   */
  is_planning_agent?: boolean;

  /**
   * CamelCase alias for is_planning_agent
   * @default false
   */
  isPlanningAgent?: boolean;

  /**
   * Enable automatic task continuation when response is incomplete
   * @default false
   */
  auto_continue?: boolean;

  /**
   * Explicit tool permissions for this agent
   * Overrides tier defaults when specified
   */
  tool_permissions?: {
    /** Allowed tools (supports wildcards like "mama_*") */
    allowed?: string[];
    /** Blocked tools (takes precedence over allowed) */
    blocked?: string[];
  };

  /**
   * Git identity for commits made by this agent
   * Used in PR review workspaces to attribute commits to specific bots
   */
  git_identity?: {
    /** Git user.name for commits */
    name: string;
    /** Git user.email for commits */
    email: string;
  };

  /**
   * Enable Code-Act mode for this agent
   * LLM writes JS code blocks to compose multiple tools in a single sandbox execution
   * Forced disabled for Tier 3 agents
   * @default false
   */
  useCodeAct?: boolean;
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
   * @deprecated Use council_plan for multi-agent discussions instead
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

  /**
   * Category-based routing rules
   * Checked after explicit triggers, before keyword matching
   */
  categories?: CategoryConfig[];

  /**
   * UltraWork autonomous session configuration
   */
  ultrawork?: UltraWorkConfig;

  /**
   * Task continuation configuration
   */
  task_continuation?: TaskContinuationConfig;

  /**
   * Skip permission prompts for all agent processes
   *
   * @warning SECURITY RISK: Bypasses all permission checks for tool use.
   * Only enable in trusted environments where agent actions are pre-approved.
   * In production, consider setting to false to enforce user consent for sensitive operations.
   *
   * @default false
   */
  dangerouslySkipPermissions?: boolean;

  /**
   * Enable @mention-based delegation between agents via Discord messages
   * Instead of internal DELEGATE:: pattern, agents mention each other with <@BOT_USER_ID>
   * @default false
   */
  mention_delegation?: boolean;

  /**
   * Maximum depth of @mention delegation chains
   * Prevents infinite agent-to-agent mention loops
   * @default 3
   */
  max_mention_depth?: number;

  /**
   * Explicit delegation rules controlling which agents can delegate to which
   * If not set, all delegation is allowed (backward compatible)
   */
  delegation_rules?: DelegationRule[];

  /**
   * Dynamic workflow orchestration configuration
   * When enabled, Conductor can generate workflow_plan blocks
   * that spawn ephemeral agents to execute multi-step tasks.
   */
  workflow?: import('./workflow-types.js').WorkflowConfig;

  /**
   * Council mode configuration
   * When enabled, Conductor can generate council_plan blocks
   * to initiate multi-round discussions among existing named agents.
   */
  council?: import('./workflow-types.js').CouncilConfig;
}

/**
 * Runtime-only options for multi-agent process execution backend.
 * Not persisted in config.yaml (derived from current agent runtime).
 */
export interface MultiAgentRuntimeOptions {
  /**
   * Backend for agent execution
   * - 'claude': Claude CLI (uses PersistentCLI for fast responses)
   * - 'codex-mcp': Codex via MCP protocol
   */
  backend?: 'claude' | 'codex-mcp' | 'gemini';
  model?: string;
  /** Effort level for Claude 4.6 adaptive thinking */
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** Timeout in milliseconds for each agent process request */
  requestTimeout?: number;
  /** Codex working directory (for codex-mcp backend) */
  codexCwd?: string;
  /** Explicit Codex binary/command path (for codex-mcp backend) */
  codexCommand?: string;
  /** Codex sandbox mode (for codex-mcp backend) */
  codexSandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
}

/**
 * Delegation rule: controls which agent can delegate to which targets
 */
export interface DelegationRule {
  /** Source agent ID */
  from: string;
  /** Allowed target agent IDs */
  to: string[];
}

/**
 * Category routing configuration
 * Maps message patterns to specific agents
 */
export interface CategoryConfig {
  /** Category name for logging */
  name: string;
  /** Regex patterns to match against message content */
  patterns: string[];
  /** Agent IDs to route matching messages to */
  agent_ids: string[];
  /** Priority (higher = checked first) @default 0 */
  priority?: number;
}

/**
 * UltraWork autonomous session configuration
 */
export interface UltraWorkConfig {
  /** Enable UltraWork mode */
  enabled: boolean;
  /** Trigger keywords to start UltraWork session */
  trigger_keywords?: string[];
  /** Maximum session duration in milliseconds @default 1800000 (30min) */
  max_duration?: number;
  /** Maximum autonomous steps @default 20 */
  max_steps?: number;
  /** Enable file-based state persistence (Ralph Loop pattern) @default true */
  persist_state?: boolean;
  /** Enable 3-phase structured loop (plan->build->retrospective) @default true */
  phased_loop?: boolean;
}

/**
 * Task continuation configuration
 */
export interface TaskContinuationConfig {
  /** Enable task continuation */
  enabled: boolean;
  /** Maximum continuation attempts per response @default 3 */
  max_retries?: number;
  /** Completion markers that indicate task is done */
  completion_markers?: string[];
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
  reason:
    | 'explicit_trigger'
    | 'keyword_match'
    | 'default_agent'
    | 'free_chat'
    | 'category_match'
    | 'delegation'
    | 'ultrawork'
    | 'mention_chain'
    | 'none';
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
  /** Agent IDs mentioned via <@USER_ID> in the message content */
  mentionedAgentIds?: string[];
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
  global_cooldown_ms: 1000,
  chain_window_ms: 60000,
};

/**
 * Default multi-agent configuration (disabled by default)
 */
export const DEFAULT_MULTI_AGENT_CONFIG: MultiAgentConfig = {
  enabled: false,
  agents: {},
  loop_prevention: DEFAULT_LOOP_PREVENTION,
  workflow: { enabled: true },
};
