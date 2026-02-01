/**
 * Agent Module for MAMA Standalone
 *
 * Exports:
 * - AgentLoop - Main agent loop orchestrator
 * - GatewayToolExecutor - Gateway tool executor (NOT MCP)
 * - Types - All type definitions
 */

export { AgentLoop } from './agent-loop.js';
export { GatewayToolExecutor } from './gateway-tool-executor.js';

// Export types
export type {
  // Claude API types
  MessageRole,
  ContentBlockType,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ContentBlock,
  Message,
  StopReason,
  Usage,
  ClaudeResponse,
  ClaudeErrorResponse,
  ClaudeRequest,

  // Tool definition types
  ToolInputSchema,
  ToolDefinition,

  // Gateway tool input types
  SaveDecisionInput,
  SaveCheckpointInput,
  SaveInput,
  SearchInput,
  UpdateInput,
  LoadCheckpointInput,
  GatewayToolInput,
  GatewayToolName,

  // Gateway tool result types
  SaveResult,
  SearchResultItem,
  SearchResult,
  UpdateResult,
  LoadCheckpointResult,
  GatewayToolResult,

  // Agent loop types
  AgentLoopOptions,
  TurnInfo,
  AgentLoopResult,

  // Configuration types
  ClaudeClientOptions,
  ClaudeHeaders,
  GatewayToolExecutorOptions,
  MAMAApiInterface,

  // Error types
  AgentErrorCode,

  // Streaming callback types
  StreamCallbacks,
} from './types.js';

export { AgentError } from './types.js';
