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

// fs imports removed - using minimal system prompt, CLAUDE.md loaded by Claude Code
import { ClaudeCLIWrapper } from './claude-cli-wrapper.js';
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
} from './types.js';
import { AgentError } from './types.js';

/**
 * Default configuration
 */
const DEFAULT_MAX_TURNS = 10;

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
 * Load composed system prompt with persona layers + CLAUDE.md
 * Tries to load persona files from ~/.mama/ in order:
 * 1. SOUL.md (philosophical principles)
 * 2. IDENTITY.md (role and character)
 * 3. USER.md (user preferences)
 * 4. CLAUDE.md (base instructions)
 *
 * If persona files are missing, logs warning and continues with CLAUDE.md alone.
 */
export function loadComposedSystemPrompt(verbose = false): string {
  const { readFileSync, existsSync } = require('fs');
  const { join } = require('path');
  const { homedir } = require('os');

  const mamaHome = join(homedir(), '.mama');
  const layers: string[] = [];

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

  const claudeMd = loadSystemPrompt(verbose);
  layers.push(claudeMd);

  return layers.join('\n\n---\n\n');
}

/**
 * Load Gateway Tools prompt from MD file
 * These tools are executed by GatewayToolExecutor, NOT MCP
 */
export function getGatewayToolsPrompt(): string {
  const { readFileSync, existsSync } = require('fs');
  const { join } = require('path');

  const gatewayToolsPath = join(__dirname, 'gateway-tools.md');

  if (existsSync(gatewayToolsPath)) {
    return readFileSync(gatewayToolsPath, 'utf-8');
  }

  console.warn('[AgentLoop] gateway-tools.md not found, using minimal prompt');
  return `
## Gateway Tools

To call a Gateway Tool, output a JSON block:

\`\`\`tool_call
{"name": "tool_name", "input": {"param1": "value1"}}
\`\`\`

Available: mama_search, mama_save, mama_update, mama_load_checkpoint,
browser_navigate, browser_screenshot, browser_click, browser_type,
discord_send, Read, Write, Bash
`;
}

export class AgentLoop {
  private readonly agent: ClaudeCLIWrapper;
  private readonly claudeCLI: ClaudeCLIWrapper | null = null;
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

  constructor(
    _oauthManager: OAuthManager,
    options: AgentLoopOptions = {},
    _clientOptions?: ClaudeClientOptions,
    executorOptions?: GatewayToolExecutorOptions
  ) {
    const mcpConfigPath = join(homedir(), '.mama/mama-mcp-config.json');
    const sessionId = randomUUID();

    // Build system prompt with Gateway Tools definitions
    const basePrompt = options.systemPrompt || loadComposedSystemPrompt();
    const gatewayToolsPrompt = getGatewayToolsPrompt();
    const defaultSystemPrompt = `${basePrompt}\n\n---\n\n${gatewayToolsPrompt}`;

    this.claudeCLI = new ClaudeCLIWrapper({
      model: options.model ?? 'claude-sonnet-4-20250514',
      sessionId,
      systemPrompt: defaultSystemPrompt,
      mcpConfigPath, // Keep for fallback, but useGatewayTools takes precedence
      dangerouslySkipPermissions: true,
      useGatewayTools: true, // Use GatewayToolExecutor instead of MCP
    });
    console.log('[AgentLoop] Gateway Tools mode enabled - tools executed via GatewayToolExecutor');
    this.agent = this.claudeCLI;

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

    // Use session pool for conversation continuity (instead of resetting each time)
    // This allows Claude CLI to maintain its own conversation history
    if (this.claudeCLI) {
      const cliSessionId = this.sessionPool.getSessionId(channelKey);
      this.claudeCLI.setSessionId(cliSessionId);
      console.log(`[AgentLoop] Using session pool: ${channelKey} → ${cliSessionId}`);
    }

    try {
      if (options?.systemPrompt) {
        console.log(
          `[AgentLoop] Setting systemPrompt: ${options.systemPrompt.length} chars, starts with: ${options.systemPrompt.substring(0, 100)}...`
        );
        this.agent.setSystemPrompt(options.systemPrompt);
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
          piResult = await this.agent.prompt(promptText, callbacks);
        } catch (error) {
          console.error('[AgentLoop] Claude CLI error:', error);
          throw new AgentError(
            `Claude CLI error: ${error instanceof Error ? error.message : String(error)}`,
            'CLI_ERROR',
            error instanceof Error ? error : undefined,
            true // retryable
          );
        }

        // Build content blocks - include tool_use blocks if present
        const contentBlocks: ContentBlock[] = [];

        // Parse tool_call blocks from text response (Gateway Tools mode)
        const parsedToolCalls = this.parseToolCallsFromText(piResult.response || '');
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

        // Also add tool_use blocks from Claude CLI if present (MCP fallback)
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
        const hasToolUse = piResult.hasToolUse || parsedToolCalls.length > 0;

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
              // Claude Code can use Read tool to view the image
              if (block.localPath) {
                parts.push(
                  `[Image attached: ${block.localPath}]\nUse the Read tool to view this image.`
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
                    `[Image attached: ${imagePath}]\nUse the Read tool to view this image.`
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
