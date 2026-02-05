/**
 * Agent Loop Engine for MAMA Standalone
 *
 * Main orchestrator that:
 * - Maintains conversation history
 * - Calls Claude API via ClaudeClient
 * - Parses tool_use blocks from responses
 * - Executes tools via MCPExecutor
 * - Sends tool_result back to Claude
 * - Loops until stop_reason is "end_turn" or max turns reached
 */

import { readFileSync, existsSync } from 'fs';
import { ClaudeCLIWrapper } from './claude-cli-wrapper.js';
import { PersistentCLIAdapter } from './persistent-cli-adapter.js';
import { GatewayToolExecutor } from './gateway-tool-executor.js';
import { LaneManager, getGlobalLaneManager } from '../concurrency/index.js';
import { SessionPool, getSessionPool, buildChannelKey } from './session-pool.js';
import type { OAuthManager } from '../auth/index.js';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type {
  Message,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ToolDefinition,
  AgentLoopOptions,
  AgentLoopResult,
  TurnInfo,
  ClaudeResponse,
  GatewayToolInput,
  ClaudeClientOptions,
  GatewayToolExecutorOptions,
  StreamCallbacks,
  AgentContext,
} from './types.js';
import { AgentError } from './types.js';
import { buildContextPrompt } from './context-prompt-builder.js';

/**
 * Default configuration
 */
const DEFAULT_MAX_TURNS = 20; // Increased from 10 to allow more complex tool chains

/**
 * Default tools configuration - all tools via Gateway (self-contained)
 */
const DEFAULT_TOOLS_CONFIG = {
  gateway: ['*'],
  mcp: [] as string[],
  mcp_config: '~/.mama/mama-mcp-config.json',
};

/**
 * Check if a tool name matches a pattern (supports wildcards like "browser_*")
 * Reserved for future hybrid tool routing
 */
function _matchToolPattern(toolName: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return toolName.startsWith(prefix);
  }
  return toolName === pattern;
}

// _matchToolPattern is reserved for future hybrid routing
void _matchToolPattern;

/**
 * Load CLAUDE.md system prompt
 * Tries multiple paths: project root, ~/.mama, /etc/mama
 */
function loadSystemPrompt(verbose = false): string {
  const { readFileSync, existsSync } = require('fs');
  const { join } = require('path');
  const { homedir } = require('os');

  const searchPaths = [
    // User home - MAMA standalone config (priority)
    join(homedir(), '.mama/CLAUDE.md'),
    // System config
    '/etc/mama/CLAUDE.md',
    // Project root (monorepo) - fallback only for development
    join(__dirname, '../../../../CLAUDE.md'),
  ];

  for (const path of searchPaths) {
    if (existsSync(path)) {
      if (verbose) console.log(`[AgentLoop] Loaded system prompt from: ${path}`);
      return readFileSync(path, 'utf-8');
    }
  }

  console.warn('[AgentLoop] CLAUDE.md not found, using default identity');
  return "You are Claude Code, Anthropic's official CLI for Claude.";
}

/**
 * Load composed system prompt with persona layers + CLAUDE.md + optional context
 * Tries to load persona files from ~/.mama/ in order:
 * 1. SOUL.md (philosophical principles)
 * 2. IDENTITY.md (role and character)
 * 3. USER.md (user preferences)
 * 4. **Context Prompt** (if AgentContext provided - role awareness)
 * 5. CLAUDE.md (base instructions)
 *
 * If persona files are missing, logs warning and continues with CLAUDE.md alone.
 *
 * @param verbose - Enable verbose logging
 * @param context - Optional AgentContext for role-aware prompt injection
 */
export function loadComposedSystemPrompt(verbose = false, context?: AgentContext): string {
  const { readFileSync, existsSync } = require('fs');
  const { join } = require('path');
  const { homedir } = require('os');

  const mamaHome = join(homedir(), '.mama');
  const layers: string[] = [];

  // Load persona files: SOUL.md, IDENTITY.md, USER.md
  const personaFiles = ['SOUL.md', 'IDENTITY.md', 'USER.md'];
  for (const file of personaFiles) {
    const path = join(mamaHome, file);
    if (existsSync(path)) {
      if (verbose) console.log(`[AgentLoop] Loaded persona: ${file}`);
      const content = readFileSync(path, 'utf-8');
      layers.push(content);
    } else {
      if (verbose) console.log(`[AgentLoop] Persona file not found (skipping): ${file}`);
    }
  }

  // Add context prompt if AgentContext is provided (role awareness)
  if (context) {
    const contextPrompt = buildContextPrompt(context);
    if (verbose)
      console.log(
        `[AgentLoop] Injecting context prompt for ${context.roleName}@${context.platform}`
      );
    layers.push(contextPrompt);
  }

  // Load CLAUDE.md (base instructions)
  const claudeMd = loadSystemPrompt(verbose);
  layers.push(claudeMd);

  return layers.join('\n\n---\n\n');
}

/**
 * Load Gateway Tools prompt from MD file
 * These tools are executed by GatewayToolExecutor, NOT MCP
 */
export function getGatewayToolsPrompt(): string {
  const gatewayToolsPath = join(__dirname, 'gateway-tools.md');

  if (existsSync(gatewayToolsPath)) {
    return readFileSync(gatewayToolsPath, 'utf-8');
  }

  // TODO: Consider generating both gateway-tools.md and this fallback from a single source
  // to prevent tool list drift (CodeRabbit review suggestion)
  console.warn('[AgentLoop] gateway-tools.md not found, using minimal prompt');
  return `
## Gateway Tools

To call a Gateway Tool, output a JSON block:

\`\`\`tool_call
{"name": "tool_name", "input": {"param1": "value1"}}
\`\`\`

**MAMA Memory:** mama_search, mama_save, mama_update, mama_load_checkpoint
**Browser:** browser_navigate, browser_screenshot, browser_click, browser_type, browser_get_text, browser_scroll, browser_wait_for, browser_evaluate, browser_pdf, browser_close
**Utility:** discord_send, Read, Write, Bash
`;
}

export class AgentLoop {
  private readonly agent: ClaudeCLIWrapper | PersistentCLIAdapter;
  private readonly claudeCLI: ClaudeCLIWrapper | null = null;
  private readonly persistentCLI: PersistentCLIAdapter | null = null;
  private readonly mcpExecutor: GatewayToolExecutor;
  private systemPromptOverride?: string;
  private readonly maxTurns: number;
  private readonly model: string;
  private readonly onTurn?: (turn: TurnInfo) => void;
  private readonly onToolUse?: (toolName: string, input: unknown, result: unknown) => void;
  private readonly laneManager: LaneManager;
  private readonly useLanes: boolean;
  private sessionKey: string;
  private readonly sessionPool: SessionPool;
  private readonly toolsConfig: typeof DEFAULT_TOOLS_CONFIG;
  private readonly isGatewayMode: boolean;
  private readonly usePersistentCLI: boolean;

  constructor(
    _oauthManager: OAuthManager,
    options: AgentLoopOptions = {},
    _clientOptions?: ClaudeClientOptions,
    executorOptions?: GatewayToolExecutorOptions
  ) {
    // Initialize tools config (hybrid Gateway/MCP routing)
    this.toolsConfig = {
      ...DEFAULT_TOOLS_CONFIG,
      ...options.toolsConfig,
    };

    const mcpConfigPath =
      this.toolsConfig.mcp_config?.replace('~', homedir()) ||
      join(homedir(), '.mama/mama-mcp-config.json');
    const sessionId = randomUUID();

    // Determine tool mode: Gateway (default) or MCP
    // Currently only '*' (all tools) is supported for mode selection
    // Partial patterns like 'mama_*' or 'browser_*' are reserved for future hybrid routing
    const mcpTools = this.toolsConfig.mcp || [];
    const gatewayTools = this.toolsConfig.gateway || [];

    // Warn if partial patterns are used (not yet supported)
    const hasPartialPattern = (arr: string[]) => arr.some((t) => t.includes('*') && t !== '*');
    if (hasPartialPattern(mcpTools) || hasPartialPattern(gatewayTools)) {
      console.warn(
        '[AgentLoop] Warning: Partial patterns (e.g., "mama_*") are not yet supported. ' +
          'Use "*" for all tools or specific tool names. Falling back to Gateway mode.'
      );
    }

    const useMCPMode = mcpTools.includes('*');
    const useGatewayMode = !useMCPMode;
    this.isGatewayMode = useGatewayMode;

    // Build system prompt
    const basePrompt = options.systemPrompt || loadComposedSystemPrompt();
    // Only include Gateway Tools prompt if using Gateway mode
    const gatewayToolsPrompt = useGatewayMode ? getGatewayToolsPrompt() : '';
    const defaultSystemPrompt = gatewayToolsPrompt
      ? `${basePrompt}\n\n---\n\n${gatewayToolsPrompt}`
      : basePrompt;

    // Choose CLI mode: Persistent (fast, experimental) or Standard (stable)
    this.usePersistentCLI = options.usePersistentCLI ?? false;

    if (this.usePersistentCLI) {
      // Persistent CLI mode: keeps Claude process alive for multi-turn conversations
      // Response time: ~2-3s instead of ~16-30s
      this.persistentCLI = new PersistentCLIAdapter({
        model: options.model ?? 'claude-sonnet-4-20250514',
        sessionId,
        systemPrompt: defaultSystemPrompt,
        mcpConfigPath: useMCPMode ? mcpConfigPath : undefined,
        dangerouslySkipPermissions: true,
        useGatewayTools: useGatewayMode,
      });
      this.agent = this.persistentCLI;
      console.log('[AgentLoop] 🚀 Persistent CLI mode enabled - faster responses');
    } else {
      // Standard CLI mode: spawns new process per message
      this.claudeCLI = new ClaudeCLIWrapper({
        model: options.model ?? 'claude-sonnet-4-20250514',
        sessionId,
        systemPrompt: defaultSystemPrompt,
        mcpConfigPath: useMCPMode ? mcpConfigPath : undefined,
        dangerouslySkipPermissions: true,
        useGatewayTools: useGatewayMode,
      });
      this.agent = this.claudeCLI;
    }

    // Log tool mode for transparency
    if (useMCPMode) {
      console.log('[AgentLoop] MCP mode enabled - tools via MCP server (' + mcpConfigPath + ')');
    } else {
      console.log('[AgentLoop] Gateway mode enabled - tools via GatewayToolExecutor');
    }
    console.log(
      '[AgentLoop] Config: gateway=' +
        JSON.stringify(this.toolsConfig.gateway) +
        ' mcp=' +
        JSON.stringify(this.toolsConfig.mcp)
    );

    this.mcpExecutor = new GatewayToolExecutor(executorOptions);
    this.systemPromptOverride = options.systemPrompt;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.model = options.model ?? 'claude-opus-4-20250514';
    this.onTurn = options.onTurn;
    this.onToolUse = options.onToolUse;

    this.laneManager = getGlobalLaneManager();
    this.useLanes = options.useLanes ?? false;
    this.sessionKey = options.sessionKey ?? 'default';
    this.sessionPool = getSessionPool();

    if (!this.systemPromptOverride) {
      loadComposedSystemPrompt(true);
    }
  }

  /**
   * Set session key for lane-based concurrency
   * Use format: "{source}:{channelId}:{userId}"
   */
  setSessionKey(key: string): void {
    this.sessionKey = key;
  }

  /**
   * Get current session key
   */
  getSessionKey(): string {
    return this.sessionKey;
  }

  /**
   * Set system prompt override (for per-message context injection)
   */
  setSystemPrompt(prompt: string | undefined): void {
    this.systemPromptOverride = prompt;
  }

  /**
   * Set Discord gateway for discord_send tool
   */
  setDiscordGateway(gateway: {
    sendMessage(channelId: string, message: string): Promise<void>;
    sendFile(channelId: string, filePath: string, caption?: string): Promise<void>;
    sendImage(channelId: string, imagePath: string, caption?: string): Promise<void>;
  }): void {
    this.mcpExecutor.setDiscordGateway(gateway);
  }

  /**
   * Run the agent loop with a user prompt
   *
   * Uses lane-based concurrency when useLanes is enabled:
   * - Same session messages are processed in order
   * - Different sessions can run in parallel
   * - Global lane limits total concurrent API calls
   *
   * @param prompt - User prompt to process
   * @param options - Execution options (systemPrompt, disableAutoRecall, etc.)
   * @returns Agent loop result with final response and history
   * @throws AgentError on errors
   */
  async run(prompt: string, options?: AgentLoopOptions): Promise<AgentLoopResult> {
    // Convert string prompt to text content block
    const content: ContentBlock[] = [{ type: 'text', text: prompt }];

    // Use lane-based queueing if enabled
    if (this.useLanes) {
      return this.laneManager.enqueueWithSession(this.sessionKey, () =>
        this.runWithContentInternal(content, options)
      );
    }

    // Direct execution for backward compatibility
    return this.runWithContentInternal(content, options);
  }

  /**
   * Run the agent loop with multimodal content blocks
   *
   * Uses lane-based concurrency when useLanes is enabled.
   *
   * @param content - Array of content blocks (text, images, documents)
   * @param options - Execution options (systemPrompt, disableAutoRecall, etc.)
   * @returns Agent loop result with final response and history
   * @throws AgentError on errors
   */
  async runWithContent(
    content: ContentBlock[],
    options?: AgentLoopOptions
  ): Promise<AgentLoopResult> {
    const sessionKey = options?.sessionKey || this.sessionKey;

    // Use lane-based queueing if enabled
    if (this.useLanes) {
      return this.laneManager.enqueueWithSession(sessionKey, () =>
        this.runWithContentInternal(content, options)
      );
    }

    // Direct execution for backward compatibility
    return this.runWithContentInternal(content, options);
  }

  /**
   * Internal implementation of runWithContent (without lane queueing)
   */
  private async runWithContentInternal(
    content: ContentBlock[],
    options?: AgentLoopOptions
  ): Promise<AgentLoopResult> {
    const history: Message[] = [];
    let totalUsage = { input_tokens: 0, output_tokens: 0 };
    let turn = 0;
    let stopReason: ClaudeResponse['stop_reason'] = 'end_turn';

    // Track channel key for session release
    const channelKey = buildChannelKey(
      options?.source ?? 'default',
      options?.channelId ?? this.sessionKey
    );

    // Use session pool for conversation continuity
    // IMPORTANT: If caller passes cliSessionId, use it directly to avoid double-locking
    // MessageRouter already calls getSession() and passes the result via options
    let sessionIsNew = options?.resumeSession === undefined ? true : !options.resumeSession;

    // Set session ID on the agent (works for both ClaudeCLIWrapper and PersistentCLIAdapter)
    if (options?.cliSessionId) {
      this.agent.setSessionId(options.cliSessionId);
      console.log(
        `[AgentLoop] Using caller session: ${channelKey} → ${options.cliSessionId} (${sessionIsNew ? 'NEW' : 'RESUME'})`
      );
    } else {
      // Fallback: get session from pool (for direct AgentLoop usage)
      const { sessionId: cliSessionId, isNew } = this.sessionPool.getSession(channelKey);
      sessionIsNew = isNew;
      this.agent.setSessionId(cliSessionId);
      console.log(
        `[AgentLoop] Session pool: ${channelKey} → ${cliSessionId} (${isNew ? 'NEW' : 'RESUME'})`
      );
    }

    try {
      if (options?.systemPrompt) {
        // Append Gateway Tools to the provided system prompt
        // This ensures tools are always available regardless of what MessageRouter provides
        const gatewayToolsPrompt = this.isGatewayMode ? getGatewayToolsPrompt() : '';
        const fullPrompt = gatewayToolsPrompt
          ? `${options.systemPrompt}\n\n---\n\n${gatewayToolsPrompt}`
          : options.systemPrompt;
        console.log(
          `[AgentLoop] Setting systemPrompt: ${fullPrompt.length} chars (base: ${options.systemPrompt.length}, tools: ${gatewayToolsPrompt.length})`
        );
        this.agent.setSystemPrompt(fullPrompt);
      } else {
        console.log(`[AgentLoop] No systemPrompt in options, using default`);
      }

      // Add initial user message with content blocks
      history.push({
        role: 'user',
        content,
      });

      while (turn < this.maxTurns) {
        turn++;

        let response: ClaudeResponse;

        const callbacks: StreamCallbacks = {
          onDelta: (text: string) => {
            console.log('[Streaming] Delta received:', text.length, 'chars');
          },
          onToolUse: (name: string, _input: Record<string, unknown>) => {
            console.log(`[Streaming] Tool called: ${name}`);
          },
          onFinal: (_finalResponse: ClaudeResponse) => {
            console.log('[Streaming] Stream complete');
          },
          onError: (error: Error) => {
            console.error('[Streaming] Error:', error);
            // Don't throw - let the promise rejection handle it
          },
        };

        const promptText = this.formatHistoryAsPrompt(history);
        let piResult;
        try {
          // Pass role-specific model and resume flag based on session state
          // First turn of new session: --session-id (inject system prompt)
          // Subsequent turns (tool loop) or resumed sessions: --resume (skip system prompt)
          const shouldResume = !sessionIsNew || turn > 1;
          piResult = await this.agent.prompt(promptText, callbacks, {
            model: options?.model,
            resumeSession: shouldResume,
          });
          // After first successful call, mark session as not new for subsequent turns
          if (turn === 1) sessionIsNew = false;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error('[AgentLoop] Claude CLI error:', errorMessage);

          // Check if this is a recoverable session error
          // 1. "No conversation found" - CLI session was lost (daemon restart, timeout)
          // 2. "Session ID already in use" - concurrent request conflict
          const isSessionNotFound = errorMessage.includes('No conversation found with session ID');
          const isSessionInUse = errorMessage.includes('is already in use');

          if (isSessionNotFound || isSessionInUse) {
            const reason = isSessionNotFound ? 'not found in CLI' : 'already in use';
            console.log(`[AgentLoop] Session ${reason}, retrying with new session`);

            // Reset session in pool so it creates a new one
            this.sessionPool.resetSession(channelKey);
            const newSessionId = this.sessionPool.getSessionId(channelKey);
            this.agent.setSessionId(newSessionId);

            // Retry with new session (--session-id instead of --resume)
            piResult = await this.agent.prompt(promptText, callbacks, {
              model: options?.model,
              resumeSession: false, // Force new session
            });
            console.log(`[AgentLoop] Retry successful with new session: ${newSessionId}`);
          } else {
            throw new AgentError(
              `Claude CLI error: ${errorMessage}`,
              'CLI_ERROR',
              error instanceof Error ? error : undefined,
              true // retryable
            );
          }
        }

        // Build content blocks - include tool_use blocks if present
        const contentBlocks: ContentBlock[] = [];
        let parsedToolCalls: ToolUseBlock[] = [];

        // Parse tool_call blocks from text response (Gateway Tools mode ONLY)
        if (this.isGatewayMode) {
          parsedToolCalls = this.parseToolCallsFromText(piResult.response || '');
          const textWithoutToolCalls = this.removeToolCallBlocks(piResult.response || '');

          if (textWithoutToolCalls.trim()) {
            contentBlocks.push({ type: 'text', text: textWithoutToolCalls });
          }

          // Add parsed tool_use blocks from text (Gateway Tools - prompt-based)
          if (parsedToolCalls.length > 0) {
            for (const toolCall of parsedToolCalls) {
              contentBlocks.push({
                type: 'tool_use',
                id: toolCall.id,
                name: toolCall.name,
                input: toolCall.input,
              } as ToolUseBlock);
            }
            console.log(
              `[AgentLoop] Parsed ${parsedToolCalls.length} tool calls from text (Gateway Tools mode)`
            );
          }
        } else {
          // MCP mode: use response text as-is
          if (piResult.response?.trim()) {
            contentBlocks.push({ type: 'text', text: piResult.response });
          }
        }

        // Add tool_use blocks from Claude CLI if present (MCP mode)
        if (piResult.toolUseBlocks && piResult.toolUseBlocks.length > 0) {
          for (const toolUse of piResult.toolUseBlocks) {
            contentBlocks.push({
              type: 'tool_use',
              id: toolUse.id,
              name: toolUse.name,
              input: toolUse.input,
            } as ToolUseBlock);
          }
          console.log(`[AgentLoop] Detected ${piResult.toolUseBlocks.length} tool calls from MCP`);
        }

        // Set stop_reason based on whether tools were requested
        // In Gateway mode: check parsed tool calls; in MCP mode: check CLI tool blocks
        const hasToolUse = this.isGatewayMode
          ? parsedToolCalls.length > 0
          : piResult.hasToolUse || false;

        response = {
          id: `msg_${Date.now()}`,
          type: 'message' as const,
          role: 'assistant' as const,
          content: contentBlocks,
          model: this.model,
          stop_reason: hasToolUse ? ('tool_use' as const) : ('end_turn' as const),
          stop_sequence: null,
          usage: piResult.usage,
        };

        // Update usage
        totalUsage.input_tokens += response.usage.input_tokens;
        totalUsage.output_tokens += response.usage.output_tokens;

        // Track tokens in session pool for auto-reset at 80% context
        this.sessionPool.updateTokens(channelKey, response.usage.input_tokens);

        // Add assistant response to history
        history.push({
          role: 'assistant',
          content: response.content,
        });

        // Notify turn callback
        this.onTurn?.({
          turn,
          role: 'assistant',
          content: response.content,
          stopReason: response.stop_reason,
          usage: response.usage,
        });

        stopReason = response.stop_reason;

        // Check stop conditions
        if (response.stop_reason === 'end_turn') {
          break;
        }

        if (response.stop_reason === 'max_tokens') {
          throw new AgentError(
            'Response truncated due to max tokens limit',
            'MAX_TOKENS',
            undefined,
            false
          );
        }

        // Handle tool use
        if (response.stop_reason === 'tool_use') {
          const toolResults = await this.executeTools(response.content);

          // Add tool results to history
          history.push({
            role: 'user',
            content: toolResults,
          });

          // Notify turn callback for tool results
          this.onTurn?.({
            turn,
            role: 'user',
            content: toolResults,
          });
        }
      }

      // Check if we hit max turns
      if (turn >= this.maxTurns && stopReason === 'tool_use') {
        throw new AgentError(
          `Agent loop exceeded maximum turns (${this.maxTurns})`,
          'MAX_TURNS',
          undefined,
          false
        );
      }

      // Extract final text response
      const finalResponse = this.extractTextResponse(history);

      return {
        response: finalResponse,
        turns: turn,
        history,
        totalUsage,
        stopReason,
      };
    } finally {
      // Always release session lock, even on error
      this.sessionPool.releaseSession(channelKey);
    }
  }

  /**
   * Execute tools from response content blocks
   */
  private async executeTools(content: ContentBlock[]): Promise<ToolResultBlock[]> {
    const toolUseBlocks = content.filter(
      (block): block is ToolUseBlock => block.type === 'tool_use'
    );

    const results: ToolResultBlock[] = [];

    for (const toolUse of toolUseBlocks) {
      let result: string;
      let isError = false;

      try {
        const toolResult = await this.mcpExecutor.execute(
          toolUse.name,
          toolUse.input as GatewayToolInput
        );
        result = JSON.stringify(toolResult, null, 2);

        // Notify tool use callback
        this.onToolUse?.(toolUse.name, toolUse.input, toolResult);
      } catch (error) {
        isError = true;
        result = error instanceof Error ? error.message : String(error);

        // Notify tool use callback with error
        this.onToolUse?.(toolUse.name, toolUse.input, { error: result });
      }

      results.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result,
        is_error: isError,
      });
    }

    return results;
  }

  /**
   * Parse tool_call blocks from text response (Gateway Tools mode)
   * Format: ```tool_call\n{"name": "...", "input": {...}}\n```
   */
  private parseToolCallsFromText(text: string): ToolUseBlock[] {
    const toolCalls: ToolUseBlock[] = [];
    const toolCallRegex = /```tool_call\s*\n([\s\S]*?)\n```/g;

    let match;
    while ((match = toolCallRegex.exec(text)) !== null) {
      try {
        const jsonStr = match[1].trim();
        const parsed = JSON.parse(jsonStr);

        if (parsed.name && typeof parsed.name === 'string') {
          toolCalls.push({
            type: 'tool_use',
            id: `gateway_tool_${randomUUID()}`,
            name: parsed.name,
            input: parsed.input || {},
          });
        }
      } catch (e) {
        console.warn(`[AgentLoop] Failed to parse tool_call block: ${e}`);
      }
    }

    return toolCalls;
  }

  /**
   * Remove tool_call blocks from text (to avoid duplication in response)
   */
  private removeToolCallBlocks(text: string): string {
    return text.replace(/```tool_call\s*\n[\s\S]*?\n```/g, '').trim();
  }

  /**
   * Extract text response from the last assistant message
   */
  private extractTextResponse(history: Message[]): string {
    // Find the last assistant message
    for (let i = history.length - 1; i >= 0; i--) {
      const message = history[i];
      if (message.role === 'assistant') {
        const content = message.content;

        if (typeof content === 'string') {
          return content;
        }

        // Extract text blocks
        const textBlocks = (content as ContentBlock[]).filter(
          (block): block is TextBlock => block.type === 'text'
        );

        return textBlocks.map((block) => block.text).join('\n');
      }
    }

    return '';
  }

  /**
   * Format conversation history as prompt text for Claude CLI
   * Note: Claude CLI -p mode only supports text, so images are converted to file paths
   * that Claude Code can read using the Read tool.
   */
  private formatHistoryAsPrompt(history: Message[]): string {
    return history
      .map((msg) => {
        const content = msg.content;
        let text: string;

        if (typeof content === 'string') {
          text = content;
        } else if (Array.isArray(content)) {
          const parts: string[] = [];

          for (const block of content as any[]) {
            if (block.type === 'text') {
              parts.push(block.text);
            } else if (block.type === 'tool_use') {
              // Format tool_use block for Claude to see its previous tool calls
              parts.push(
                `[Tool Call: ${block.name}]\nInput: ${JSON.stringify(block.input, null, 2)}`
              );
            } else if (block.type === 'tool_result') {
              // Format tool_result block for Claude to see tool execution results
              const status = block.is_error ? 'ERROR' : 'SUCCESS';
              parts.push(`[Tool Result: ${status}]\n${block.content}`);
            } else if (block.type === 'image') {
              // Convert image to file path instruction for Claude Code
              // MANDATORY: Claude MUST use Read tool to view the image before responding
              if (block.localPath) {
                parts.push(
                  `**[MANDATORY IMAGE]** The user has attached an image at: ${block.localPath}\n` +
                    `YOU MUST use the Read tool to view this image BEFORE responding to the user's request.\n` +
                    `Do NOT respond without first reading the image. The user expects you to see and analyze the image content.`
                );
              } else if (block.source?.data) {
                // Base64 image - save to workspace and reference it
                const fs = require('fs');
                const path = require('path');
                const mediaDir = path.join(
                  process.env.HOME || '',
                  '.mama',
                  'workspace',
                  'media',
                  'inbound'
                );
                fs.mkdirSync(mediaDir, { recursive: true });
                const imagePath = path.join(mediaDir, `${Date.now()}.jpg`);
                try {
                  fs.writeFileSync(imagePath, Buffer.from(block.source.data, 'base64'));
                  parts.push(
                    `**[MANDATORY IMAGE]** The user has attached an image at: ${imagePath}\n` +
                      `YOU MUST use the Read tool to view this image BEFORE responding to the user's request.\n` +
                      `Do NOT respond without first reading the image. The user expects you to see and analyze the image content.`
                  );
                } catch {
                  parts.push('[Image attached but could not be processed]');
                }
              }
            }
          }

          text = parts.join('\n');
        } else {
          return '';
        }

        if (msg.role === 'user') {
          return `User: ${text}`;
        } else if (msg.role === 'assistant') {
          return `Assistant: ${text}`;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * Get the MAMA tool definitions
   */
  static getToolDefinitions(): ToolDefinition[] {
    return [];
  }

  /**
   * Get the default system prompt (verbose logging)
   */
  static getDefaultSystemPrompt(): string {
    return loadSystemPrompt(true);
  }
}
