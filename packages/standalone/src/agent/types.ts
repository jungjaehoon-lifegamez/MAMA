/**
 * Type definitions for Agent Loop Engine
 *
 * Includes types for:
 * - Claude API request/response
 * - Content blocks (text, tool_use, tool_result)
 * - MCP tool definitions and inputs
 * - Agent loop configuration
 * - Agent context and role awareness
 */

import type { RoleConfig } from '../cli/config/types.js';

// ============================================================================
// Agent Context Types (Role Awareness)
// ============================================================================

/**
 * Platform identifiers for agent context
 */
export type AgentPlatform = 'viewer' | 'discord' | 'telegram' | 'slack' | 'chatwork' | 'cli';

/**
 * Session information for agent context
 */
export interface SessionInfo {
  /** Unique session identifier */
  sessionId: string;
  /** Channel or conversation ID */
  channelId?: string;
  /** User ID who initiated the interaction */
  userId?: string;
  /** Username for display purposes */
  userName?: string;
  /** Timestamp when session started */
  startedAt: Date;
}

/**
 * Agent context for role-aware execution
 * Provides information about the agent's current operating environment
 */
export interface AgentContext {
  /**
   * Message source identifier
   * @example "discord", "viewer", "telegram"
   */
  source: string;

  /**
   * Platform type (normalized)
   */
  platform: AgentPlatform;

  /**
   * Role name for this context
   * @example "os_agent", "chat_bot"
   */
  roleName: string;

  /**
   * Role configuration with permissions
   */
  role: RoleConfig;

  /**
   * Session information
   */
  session: SessionInfo;

  /**
   * Human-readable capabilities summary
   * @example ["mama_search", "mama_save", "Read", "discord_send"]
   */
  capabilities: string[];

  /**
   * Human-readable limitations summary
   * @example ["Cannot execute Bash", "Cannot write files", "Limited path access"]
   */
  limitations: string[];
}

// ============================================================================
// Claude API Types
// ============================================================================

/**
 * Claude API message role
 */
export type MessageRole = 'user' | 'assistant';

/**
 * Content block types in Claude API
 */
export type ContentBlockType = 'text' | 'image' | 'document' | 'tool_use' | 'tool_result';

/**
 * Text content block
 */
export interface TextBlock {
  type: 'text';
  text: string;
}

/**
 * Image source for base64 encoded images
 */
export interface ImageSourceBase64 {
  type: 'base64';
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string;
}

/**
 * Image content block for multimodal input
 */
export interface ImageBlock {
  type: 'image';
  source: ImageSourceBase64;
}

/**
 * Document content block for document understanding
 */
export interface DocumentBlock {
  type: 'document';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

/**
 * Tool use content block (Claude requesting tool execution)
 */
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Tool result content block (response to tool_use)
 */
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/**
 * Union type for all content blocks
 */
export type ContentBlock = TextBlock | ImageBlock | DocumentBlock | ToolUseBlock | ToolResultBlock;

/**
 * Message in conversation history
 */
export interface Message {
  role: MessageRole;
  content: ContentBlock[] | string;
}

/**
 * Stop reasons from Claude API
 */
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';

/**
 * Usage information from Claude API
 */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

/**
 * Claude API response
 */
export interface ClaudeResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: ContentBlock[];
  model: string;
  stop_reason: StopReason;
  stop_sequence: string | null;
  usage: Usage;
}

/**
 * Claude API error response
 */
export interface ClaudeErrorResponse {
  type: 'error';
  error: {
    type: string;
    message: string;
  };
}

/**
 * Claude API request body
 */
export interface ClaudeRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Message[];
  tools?: ToolDefinition[];
  stream?: boolean;
}

/**
 * Streaming event types
 */
export type StreamEventType =
  | 'message_start'
  | 'content_block_start'
  | 'content_block_delta'
  | 'content_block_stop'
  | 'message_delta'
  | 'message_stop';

/**
 * Content block delta for streaming
 */
export interface ContentBlockDelta {
  type: 'text_delta' | 'input_json_delta';
  text?: string;
  partial_json?: string;
}

/**
 * Streaming callbacks for real-time updates
 */
export interface StreamCallbacks {
  /** Called when text delta arrives (OpenClaw-style, 150ms throttled by caller) */
  onDelta?: (text: string) => void;
  /** Called when a tool use starts */
  onToolUse?: (toolName: string, input: Record<string, unknown>) => void;
  /** Called when final message arrives */
  onFinal?: (response: ClaudeResponse) => void;
  /** Called on error */
  onError?: (error: Error) => void;
}

// ============================================================================
// Tool Definition Types
// ============================================================================

/**
 * JSON Schema for tool input
 */
export interface ToolInputSchema {
  type: 'object';
  properties: Record<
    string,
    {
      type: string;
      description?: string;
      enum?: string[];
      items?: { type: string };
      minimum?: number;
      maximum?: number;
    }
  >;
  required?: string[];
}

/**
 * Tool definition for Claude API
 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
}

// ============================================================================
// MCP Tool Input Types
// ============================================================================

/**
 * Input for save tool (decision)
 */
export interface SaveDecisionInput {
  type: 'decision';
  topic: string;
  decision: string;
  reasoning: string;
  confidence?: number;
}

/**
 * Input for save tool (checkpoint)
 */
export interface SaveCheckpointInput {
  type: 'checkpoint';
  summary: string;
  next_steps?: string;
  open_files?: string[];
}

/**
 * Union type for save tool input
 */
export type SaveInput = SaveDecisionInput | SaveCheckpointInput;

/**
 * Input for search tool
 */
export interface SearchInput {
  query?: string;
  type?: 'all' | 'decision' | 'checkpoint';
  limit?: number;
}

/**
 * Input for update tool
 */
export interface UpdateInput {
  id: string;
  outcome: 'success' | 'failed' | 'partial' | 'SUCCESS' | 'FAILED' | 'PARTIAL';
  reason?: string;
}

/**
 * Input for load_checkpoint tool (no input required)
 */
export type LoadCheckpointInput = Record<string, never>;

/**
 * Input for translate_image tool
 */
export interface TranslateImageInput {
  /** Base64-encoded image data */
  image_data: string;
  /** MIME type (image/jpeg, image/png, etc.) */
  media_type: string;
  /** Source language (auto-detect if not provided) */
  source_lang?: string;
  /** Target language (default: Korean) */
  target_lang?: string;
  /** Discord channel ID for screenshot delivery */
  channel_id?: string;
}

/**
 * Result from translate_image tool
 */
export interface TranslateImageResult {
  /** Whether translation succeeded */
  success: boolean;
  /** Translated text content */
  translation?: string;
  /** Path to generated HTML file */
  html_path?: string;
  /** Path to screenshot (if Discord channel provided) */
  screenshot_path?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Browser navigate input
 */
export interface BrowserNavigateInput {
  /** URL to navigate to */
  url: string;
}

/**
 * Browser screenshot input
 */
export interface BrowserScreenshotInput {
  /** Optional filename (auto-generated if not provided) */
  filename?: string;
  /** Take full page screenshot */
  full_page?: boolean;
}

/**
 * Browser click input
 */
export interface BrowserClickInput {
  /** CSS selector to click */
  selector: string;
}

/**
 * Browser type input
 */
export interface BrowserTypeInput {
  /** CSS selector of input element */
  selector: string;
  /** Text to type */
  text: string;
}

/**
 * Browser scroll input
 */
export interface BrowserScrollInput {
  /** Scroll direction */
  direction: 'up' | 'down' | 'top' | 'bottom';
  /** Scroll amount in pixels (default: 500) */
  amount?: number;
}

/**
 * Browser wait for input
 */
export interface BrowserWaitForInput {
  /** CSS selector to wait for */
  selector: string;
  /** Timeout in milliseconds (default: 10000) */
  timeout?: number;
}

/**
 * Browser evaluate input
 */
export interface BrowserEvaluateInput {
  /** JavaScript code to evaluate */
  script: string;
}

/**
 * Browser PDF input
 */
export interface BrowserPdfInput {
  /** Optional filename */
  filename?: string;
}

// ============================================================================
// OS Management Tool Input Types (viewer-only)
// ============================================================================

/**
 * Bot platform types
 */
export type BotPlatform = 'discord' | 'telegram' | 'slack' | 'chatwork';

/**
 * Input for os_add_bot tool
 */
export interface AddBotInput {
  /** Platform to add bot for */
  platform: BotPlatform;
  /** Bot token (Discord, Telegram) or API token (Chatwork) */
  token?: string;
  /** Slack bot token */
  bot_token?: string;
  /** Slack app token (for socket mode) */
  app_token?: string;
  /** Default channel ID for notifications (optional) */
  default_channel_id?: string;
  /** Allowed chat IDs for Telegram (optional, empty = allow all) */
  allowed_chats?: string[];
  /** Room IDs for Chatwork (optional) */
  room_ids?: string[];
}

/**
 * Input for os_set_permissions tool
 */
export interface SetPermissionsInput {
  /** Role name to modify */
  role: string;
  /** Tools to allow (supports wildcards) */
  allowedTools?: string[];
  /** Tools to block (takes precedence) */
  blockedTools?: string[];
  /** Paths to allow (glob patterns) */
  allowedPaths?: string[];
  /** Enable system control */
  systemControl?: boolean;
  /** Enable access to sensitive data (e.g., tokens) */
  sensitiveAccess?: boolean;
  /** Map a source (e.g., 'discord', 'telegram') to this role */
  mapSource?: string;
}

/**
 * Input for os_set_model tool
 */
export interface SetModelInput {
  /** Role to update (e.g., 'os_agent', 'chat_bot'). If not specified, updates global agent model */
  role?: string;
  /** Model name to use (e.g., 'claude-opus-4-20250514', 'claude-sonnet-4-20250514') */
  model: string;
  /** Optional max turns for this role */
  maxTurns?: number;
  /** Optional timeout in milliseconds */
  timeout?: number;
}

/**
 * Input for os_get_config tool
 */
export interface GetConfigInput {
  /** Section to retrieve (optional, returns all if not specified) */
  section?:
    | 'agent'
    | 'database'
    | 'logging'
    | 'roles'
    | 'discord'
    | 'telegram'
    | 'slack'
    | 'chatwork';
  /** Include sensitive data (tokens) - only works for viewer */
  includeSensitive?: boolean;
}

/**
 * Input for os_list_bots tool
 */
export interface ListBotsInput {
  /** Filter by platform (optional) */
  platform?: BotPlatform;
}

/**
 * Bot status information
 */
export interface BotStatus {
  platform: BotPlatform;
  enabled: boolean;
  configured: boolean;
  status: 'running' | 'stopped' | 'error' | 'not_configured';
  error?: string;
}

/**
 * Input for os_restart_bot tool
 */
export interface RestartBotInput {
  /** Platform to restart */
  platform: BotPlatform;
}

/**
 * Input for os_stop_bot tool
 */
export interface StopBotInput {
  /** Platform to stop */
  platform: BotPlatform;
}

/**
 * Union type for all MCP tool inputs
 */
export type GatewayToolInput =
  | SaveInput
  | SearchInput
  | UpdateInput
  | LoadCheckpointInput
  | TranslateImageInput
  | BrowserNavigateInput
  | BrowserScreenshotInput
  | BrowserClickInput
  | BrowserTypeInput
  | BrowserScrollInput
  | BrowserWaitForInput
  | BrowserEvaluateInput
  | BrowserPdfInput
  // OS Management tools
  | AddBotInput
  | SetPermissionsInput
  | GetConfigInput
  | SetModelInput
  // OS Monitoring tools
  | ListBotsInput
  | RestartBotInput
  | StopBotInput;

/**
 * MAMA tool names (Gateway tools, NOT MCP protocol)
 */
export type GatewayToolName =
  | 'mama_save'
  | 'mama_search'
  | 'mama_update'
  | 'mama_load_checkpoint'
  | 'Read'
  | 'Write'
  | 'Bash'
  | 'discord_send'
  | 'translate_image'
  | 'save_integration_token'
  | 'browser_navigate'
  | 'browser_screenshot'
  | 'browser_click'
  | 'browser_type'
  | 'browser_get_text'
  | 'browser_scroll'
  | 'browser_wait_for'
  | 'browser_evaluate'
  | 'browser_pdf'
  | 'browser_close'
  // OS Management tools (viewer-only)
  | 'os_add_bot'
  | 'os_set_permissions'
  | 'os_get_config'
  | 'os_set_model'
  // OS Monitoring tools (viewer-only)
  | 'os_list_bots'
  | 'os_restart_bot'
  | 'os_stop_bot';

// ============================================================================
// MCP Tool Output Types
// ============================================================================

/**
 * Save tool result
 */
export interface SaveResult {
  success: boolean;
  id?: string;
  type?: 'decision' | 'checkpoint';
  message?: string;
  similar_decisions?: Array<{
    id: string;
    topic: string;
    decision: string;
    similarity: number;
    created_at: string;
  }>;
  warning?: string;
  collaboration_hint?: string;
}

/**
 * Search result item
 */
export interface SearchResultItem {
  id: string;
  topic?: string;
  decision?: string;
  reasoning?: string;
  summary?: string;
  similarity?: number;
  created_at: string;
  type: 'decision' | 'checkpoint';
}

/**
 * Search tool result
 */
export interface SearchResult {
  success: boolean;
  results: SearchResultItem[];
  count: number;
}

/**
 * Update tool result
 */
export interface UpdateResult {
  success: boolean;
  message?: string;
}

/**
 * Load checkpoint result
 */
export interface LoadCheckpointResult {
  success: boolean;
  summary?: string;
  next_steps?: string;
  open_files?: string[];
  message?: string;
}

/**
 * Union type for all MCP tool results
 */
export type GatewayToolResult =
  | SaveResult
  | SearchResult
  | UpdateResult
  | LoadCheckpointResult
  | TranslateImageResult;

// ============================================================================
// Streaming Types
// ============================================================================

/**
 * Streaming context for image-based requests
 */
export interface StreamingContext {
  useStreaming: boolean;
  placeholderMessage?: any;
}

// ============================================================================
// Agent Loop Types
// ============================================================================

/**
 * Agent loop configuration options
 */
export interface AgentLoopOptions {
  /** System prompt for Claude */
  systemPrompt?: string;
  /** Maximum number of conversation turns (default: 10) */
  maxTurns?: number;
  /** Maximum tokens per response (default: 4096) */
  maxTokens?: number;
  /** Claude model to use (default: claude-sonnet-4-20250514) */
  model?: string;
  /** Callback for each turn */
  onTurn?: (turn: TurnInfo) => void;
  /** Callback for tool execution */
  onToolUse?: (toolName: string, input: unknown, result: unknown) => void;
  /** Session key for lane-based concurrency (e.g., "discord:channel:user") */
  sessionKey?: string;
  /** Enable lane-based concurrency (default: false for backward compatibility) */
  useLanes?: boolean;
  /** Disable auto-recall memory injection (for skill execution) */
  disableAutoRecall?: boolean;
  /** Message source for session pool (e.g., "discord", "slack", "viewer") */
  source?: string;
  /** Channel ID for session pool */
  channelId?: string;
  /**
   * Agent context for role-aware execution
   * Provides platform, role, and permission information
   */
  agentContext?: AgentContext;
  /**
   * Tool routing configuration for hybrid Gateway/MCP mode
   * If not specified, all tools use Gateway mode (default)
   */
  toolsConfig?: {
    /** Tools executed via GatewayToolExecutor (supports wildcards: "browser_*") */
    gateway?: string[];
    /** Tools routed to MCP server (supports wildcards: "mama_*") */
    mcp?: string[];
    /** Path to MCP config file */
    mcp_config?: string;
  };
  /**
   * Resume existing CLI session instead of starting new one
   * When true, uses --resume flag and skips system prompt injection
   * (CLI already has context from previous requests)
   */
  resumeSession?: boolean;
  /**
   * CLI session ID from MessageRouter
   * When provided, AgentLoop uses this instead of calling getSession() again
   * This prevents double-locking of the session pool
   */
  cliSessionId?: string;
  /**
   * Use persistent CLI process for faster responses (experimental)
   * When true, keeps Claude process alive for multi-turn conversations
   * Response time: ~2-3s instead of ~16-30s
   */
  usePersistentCLI?: boolean;

  /**
   * PostToolUse handler configuration
   * Auto-extracts API contracts after Write/Edit tool execution and saves to MAMA
   */
  postToolUse?: {
    enabled: boolean;
    contractSaveLimit?: number;
  };

  /**
   * PreCompact handler configuration
   * Detects unsaved decisions before context window reset
   */
  preCompact?: {
    enabled: boolean;
    maxDecisionsToDetect?: number;
  };

  /**
   * Stop/Continuation handler configuration
   * Auto-resumes when agent stops with incomplete work (opt-in)
   */
  stopContinuation?: {
    enabled: boolean;
    maxRetries?: number;
    completionMarkers?: string[];
  };
}

/**
 * Information about each turn in the agent loop
 */
export interface TurnInfo {
  turn: number;
  role: MessageRole;
  content: ContentBlock[];
  stopReason?: StopReason;
  usage?: Usage;
}

/**
 * Agent loop run result
 */
export interface AgentLoopResult {
  /** Final text response from Claude */
  response: string;
  /** Total number of turns */
  turns: number;
  /** Full conversation history */
  history: Message[];
  /** Total token usage */
  totalUsage: {
    input_tokens: number;
    output_tokens: number;
  };
  /** Stop reason for the final turn */
  stopReason: StopReason;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Error codes for agent loop errors
 */
export type AgentErrorCode =
  | 'API_ERROR'
  | 'CLI_ERROR'
  | 'AUTH_ERROR'
  | 'RATE_LIMIT'
  | 'MAX_TOKENS'
  | 'MAX_TURNS'
  | 'EMERGENCY_MAX_TURNS'
  | 'INFINITE_LOOP_DETECTED'
  | 'NETWORK_ERROR'
  | 'TOOL_ERROR'
  | 'UNKNOWN_TOOL'
  | 'INVALID_RESPONSE';

/**
 * Custom error class for agent loop errors
 */
export class AgentError extends Error {
  constructor(
    message: string,
    public readonly code: AgentErrorCode,
    public readonly cause?: Error,
    public readonly retryable: boolean = false
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

// ============================================================================
// Claude Client Types
// ============================================================================

/**
 * Claude client configuration options
 */
export interface ClaudeClientOptions {
  /** Custom fetch function for testing */
  fetchFn?: typeof fetch;
  /** Maximum retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay between retries in ms (default: 30000) */
  maxDelayMs?: number;
}

/**
 * Claude API headers
 */
export type ClaudeHeaders = Record<string, string>;

// ============================================================================
// MCP Executor Types
// ============================================================================

/**
 * MCP Executor configuration options
 */
export interface GatewayToolExecutorOptions {
  /** Database path for MAMA (default: ~/.claude/mama-memory.db) */
  mamaDbPath?: string;
  /** Session store for checkpoint conversation access */
  sessionStore?: any;
  /** Custom MAMA API instance for testing */
  mamaApi?: MAMAApiInterface;
}

/**
 * Interface for MAMA API (for dependency injection)
 */
export interface MAMAApiInterface {
  save(input: SaveDecisionInput | Omit<SaveCheckpointInput, 'type'>): Promise<SaveResult>;
  saveCheckpoint(
    summary: string,
    openFiles: string[],
    nextSteps: string,
    recentConversation?: any[]
  ): Promise<SaveResult>;
  listDecisions(options?: { limit?: number }): Promise<unknown[]>;
  suggest(query: string, options?: { limit?: number }): Promise<SearchResult>;
  updateOutcome(
    id: string,
    input: { outcome: string; failure_reason?: string }
  ): Promise<UpdateResult>;
  loadCheckpoint(): Promise<LoadCheckpointResult>;
}
