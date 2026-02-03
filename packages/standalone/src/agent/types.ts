/**
 * Type definitions for Agent Loop Engine
 *
 * Includes types for:
 * - Claude API request/response
 * - Content blocks (text, tool_use, tool_result)
 * - MCP tool definitions and inputs
 * - Agent loop configuration
 */

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
  | BrowserPdfInput;

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
  | 'browser_close';

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
