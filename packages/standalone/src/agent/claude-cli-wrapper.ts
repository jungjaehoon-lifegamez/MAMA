/**
 * Claude CLI Subprocess Wrapper - ToS-Compliant Alternative to Pi Agent
 *
 * WHY THIS EXISTS:
 * - Current Pi Agent uses OAuth token directly via API (ToS violation, ban risk)
 * - Claude CLI is official Anthropic tool (ToS compliant)
 * - Keeps $200/month subscription benefits vs $1000+/month API costs
 *
 * ARCHITECTURE:
 * - Spawns `claude` CLI as subprocess
 * - Communicates via stdin (prompts) / stdout (JSON responses)
 * - Uses --output-format json for structured data
 * - Session continuity via --session-id flag
 *
 * TRADEOFFS:
 * + ✅ ToS compliant (official Claude tool)
 * + ✅ Keeps subscription pricing
 * + ✅ Real usage tracking (cost, tokens)
 * - ⚠️ More complex than direct API
 * - ⚠️ Requires claude CLI installed
 * - ⚠️ Tool integration via MCP (future work)
 */

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';

const { DebugLogger } = debugLogger as {
  DebugLogger: new (context?: string) => {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};

const logger = new DebugLogger('ClaudeCLI');

function supportsThinkingEffortModel(model: string | undefined): boolean {
  if (!model) {
    return false;
  }
  return model.startsWith('claude-opus-4-6') || model.startsWith('claude-sonnet-4-6');
}

function normalizeThinkingEffort(
  model: string | undefined,
  effort: 'low' | 'medium' | 'high' | 'max'
): 'low' | 'medium' | 'high' | 'max' {
  if (effort === 'max' && !model?.startsWith('claude-opus-4-6')) {
    return 'high';
  }
  return effort;
}

export interface ClaudeCLIWrapperOptions {
  model?: string;
  /**
   * Effort level for Claude 4.6 adaptive thinking
   * Applies to claude-opus-4-6 and claude-sonnet-4-6
   * 'max' is only available on Opus 4.6
   */
  effort?: 'low' | 'medium' | 'high' | 'max';
  sessionId?: string;
  systemPrompt?: string;
  mcpConfigPath?: string;
  /**
   * Skip permission prompts for tool execution
   *
   * @warning SECURITY RISK: Bypasses all permission checks.
   * Only enable in trusted environments where agent actions are pre-approved.
   */
  dangerouslySkipPermissions?: boolean;
  /** If true, use GatewayToolExecutor instead of MCP (default: false) */
  useGatewayTools?: boolean;
  /** Request timeout in ms (default: 120000). Increase for complex/long tasks. */
  requestTimeout?: number;
  /** Override built-in tool set (--tools CLI flag). Use "" to disable all tools. */
  tools?: string;
  /** Override plugin directory (--plugin-dir CLI flag). Use empty dir to disable plugins. */
  pluginDir?: string;
  /** Structurally disallowed tools (--disallowedTools CLI flag) */
  disallowedTools?: string[];
}

export interface PromptCallbacks {
  onDelta?: (text: string) => void;
  onToolUse?: (name: string, input: Record<string, unknown>) => void;
  onToolComplete?: (tool: string, toolUseId: string, isError: boolean) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onFinal?: (response: any) => void;
  onError?: (error: Error) => void;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface PromptResult {
  response: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  session_id: string;
  cost_usd?: number;
  /** Tool use blocks if Claude requested tools */
  toolUseBlocks?: ToolUseBlock[];
  /** True if Claude requested tool use */
  hasToolUse?: boolean;
}

/**
 * ClaudeCLIWrapper - Wraps Claude CLI for programmatic use
 *
 * Usage:
 *   const wrapper = new ClaudeCLIWrapper({ sessionId: 'my-session' });
 *   const result = await wrapper.prompt('Hello, Claude!', {
 *     onDelta: (text) => console.log('Delta:', text)
 *   });
 *
 * Key Features:
 * - Session continuity (multi-turn conversations)
 * - Real-time streaming (--output-format json streams)
 * - Usage tracking (tokens, cost)
 * - ToS compliant (official CLI)
 *
 * IMPORTANT:
 * - Requires `claude` CLI in PATH
 * - Uses subscription credentials from ~/.claude/.credentials.json
 * - Tools not yet supported (future: via MCP)
 */
export class ClaudeCLIWrapper {
  private sessionId: string;
  private options: ClaudeCLIWrapperOptions;
  private turnCount = 0;

  constructor(options: ClaudeCLIWrapperOptions = {}) {
    this.options = options;
    this.sessionId = options.sessionId || randomUUID();
  }

  /**
   * Send a prompt to Claude CLI
   *
   * Workflow:
   * 1. Spawn `claude -p "<prompt>" --output-format json`
   * 2. Parse JSON output (type: result | error | delta)
   * 3. Aggregate deltas for streaming
   * 4. Return final result with usage stats
   *
   * @param content - Prompt text (images not yet supported)
   * @param callbacks - Streaming callbacks
   * @param options - Optional per-request overrides (model, etc.)
   * @returns PromptResult with response and usage
   */
  async prompt(
    content: string,
    callbacks?: PromptCallbacks,
    options?: { model?: string; resumeSession?: boolean }
  ): Promise<PromptResult> {
    return new Promise((resolve, reject) => {
      // Use stdin for large content to avoid E2BIG error (ARG_MAX exceeded)
      const useStdin = content.length > 50000; // 50KB threshold
      const args = useStdin
        ? ['--output-format', 'json']
        : ['-p', content, '--output-format', 'json'];

      if (useStdin) {
        console.log(`[ClaudeCLI] Using stdin mode (content: ${content.length} chars)`);
      }

      // Session persistence: keeps context across turns, avoids re-injecting system prompt
      args.push('--session-id', this.sessionId);
      // ⚠️ BLOCK GLOBAL SETTINGS — exclude 'user' to prevent loading ~/.claude/settings.json
      // Prevents global plugins from enabledPlugins being injected every turn
      args.push('--setting-sources', 'project,local');
      console.log(`[ClaudeCLI] Session: ${this.sessionId}`);

      // Add model flag - per-request override takes precedence
      const model = options?.model || this.options.model;
      if (model) {
        args.push('--model', model);
      }

      // Add effort level for Claude 4.6 adaptive thinking.
      if (this.options.effort && supportsThinkingEffortModel(model)) {
        const effort = normalizeThinkingEffort(model, this.options.effort);
        args.push('--effort', effort);
        logger.debug('Effort level:', effort);
      }

      // System prompt: first turn only (session persistence keeps it across turns)
      if (this.options.systemPrompt && this.turnCount === 0) {
        args.push('--system-prompt', this.options.systemPrompt);
        console.log(
          `[ClaudeCLI] System prompt injected (${this.options.systemPrompt.length} chars, first turn)`
        );
      }
      this.turnCount++;

      // Hybrid mode: MCP + Gateway can both be enabled
      if (this.options.mcpConfigPath) {
        args.push('--mcp-config', this.options.mcpConfigPath);
        args.push('--strict-mcp-config');
        logger.debug('MCP enabled:', this.options.mcpConfigPath);
      }
      if (this.options.useGatewayTools) {
        logger.debug('Gateway Tools mode enabled');
      }

      if (this.options.dangerouslySkipPermissions) {
        args.push('--dangerously-skip-permissions');
      }

      // ============================================================
      // ⚠️ MAMA OS AGENT ISOLATION — DO NOT MODIFY ⚠️
      // ============================================================
      // Sets cwd to ~/.mama/workspace and creates a git boundary to prevent
      // Claude Code from traversing up to ~/CLAUDE.md and other parent configs.
      // File access is controlled separately via --add-dir and --dangerously-skip-permissions.
      // Removing this causes global settings to be re-injected every turn, wasting tokens.
      // ============================================================
      const mamaWorkspace = path.join(os.homedir(), '.mama', 'workspace');
      if (!existsSync(mamaWorkspace)) {
        mkdirSync(mamaWorkspace, { recursive: true });
      }
      const gitDir = path.join(mamaWorkspace, '.git');
      if (!existsSync(gitDir)) {
        mkdirSync(gitDir, { recursive: true });
      }
      const headFile = path.join(gitDir, 'HEAD');
      if (!existsSync(headFile)) {
        writeFileSync(headFile, 'ref: refs/heads/main\n');
      }
      args.push('--add-dir', mamaWorkspace);

      console.log(`[ClaudeCLI] Spawning: claude ${args.join(' ')}`);
      console.log(`[ClaudeCLI] Args count: ${args.length}`);

      const claude = spawn('claude', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: mamaWorkspace, // ⚠️ NEVER change to os.homedir() — breaks agent isolation
      });

      // Handle stdin: write content if using stdin mode, otherwise close immediately
      if (useStdin) {
        // Write content to stdin with backpressure handling
        // For large content (150KB+), synchronous write can block due to buffer pressure
        // Solution: check write() return value and wait for 'drain' if needed
        const writeContent = () => {
          const canContinue = claude.stdin.write(content);
          if (canContinue) {
            // Buffer had space, content written, close stdin
            claude.stdin.end();
            console.log(`[ClaudeCLI] Content written to stdin (immediate)`);
          } else {
            // Buffer was full, wait for drain before closing
            console.log(`[ClaudeCLI] Stdin buffer full, waiting for drain...`);
            claude.stdin.once('drain', () => {
              claude.stdin.end();
              console.log(`[ClaudeCLI] Content written to stdin (after drain)`);
            });
          }
        };

        // Handle stdin errors to prevent unhandled exceptions
        claude.stdin.on('error', (err) => {
          console.error(`[ClaudeCLI] stdin error:`, err.message);
          // Don't reject here - let the close handler deal with it
        });

        writeContent();
      } else {
        // Close stdin immediately - we use -p flag, not stdin input
        // Without this, Claude CLI hangs waiting for stdin input
        claude.stdin.end();
      }

      let stdout = '';
      let stderr = '';
      let lastDelta = '';
      const toolUseBlocks: ToolUseBlock[] = [];

      claude.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderr += text;
        console.error(`[ClaudeCLI:stderr] ${text.trim()}`);
      });

      claude.stdout.on('data', (chunk) => {
        stdout += chunk.toString();

        const lines = stdout.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const event = JSON.parse(line);

            if (event.type === 'delta' && event.delta) {
              lastDelta += event.delta;
              callbacks?.onDelta?.(lastDelta);
            } else if (event.type === 'tool_use') {
              // Collect tool_use blocks for GatewayToolExecutor
              toolUseBlocks.push({
                type: 'tool_use',
                id: event.id || `tool_${randomUUID()}`,
                name: event.name,
                input: event.input || {},
              });
              callbacks?.onToolUse?.(event.name, event.input);
              console.log(`[ClaudeCLI] Tool use detected: ${event.name}`);
            }
          } catch {
            // Not JSON yet, accumulate more
          }
        }
      });

      claude.on('close', (code) => {
        if (code !== 0) {
          const error = new Error(`Claude CLI exited with code ${code}: ${stderr}`);
          callbacks?.onError?.(error);
          reject(error);
          return;
        }

        try {
          // Parse final JSON output
          const result = JSON.parse(stdout.trim());

          if (result.type === 'result' && result.subtype === 'success') {
            const promptResult: PromptResult = {
              response: result.result || '',
              session_id: result.session_id || this.sessionId,
              cost_usd: result.total_cost_usd,
              usage: {
                input_tokens: result.usage?.input_tokens || 0,
                output_tokens: result.usage?.output_tokens || 0,
                cache_creation_input_tokens: result.usage?.cache_creation_input_tokens,
                cache_read_input_tokens: result.usage?.cache_read_input_tokens,
              },
              toolUseBlocks: toolUseBlocks.length > 0 ? toolUseBlocks : undefined,
              hasToolUse: toolUseBlocks.length > 0,
            };

            if (toolUseBlocks.length > 0) {
              console.log(`[ClaudeCLI] Returning ${toolUseBlocks.length} tool_use blocks`);
            }

            callbacks?.onFinal?.({ content: promptResult.response, toolUseBlocks });
            resolve(promptResult);
          } else {
            throw new Error(`Unexpected result type: ${result.type}`);
          }
        } catch (parseError) {
          const error = new Error(`Failed to parse Claude CLI output: ${parseError}`);
          callbacks?.onError?.(error);
          reject(error);
        }
      });

      claude.on('error', (error) => {
        callbacks?.onError?.(error);
        reject(error);
      });
    });
  }

  /**
   * Get current session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Create a new session (resets conversation history)
   */
  resetSession(): void {
    this.sessionId = randomUUID();
    this.turnCount = 0; // Reset so system prompt is injected on next turn
  }

  /**
   * Set session ID (for channel-specific conversations)
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
    this.turnCount = 0; // Reset so system prompt is injected on next turn
  }

  /**
   * Set system prompt (updates options for next prompt)
   */
  setSystemPrompt(prompt: string): void {
    this.options.systemPrompt = prompt;
  }

  /**
   * Get current options (for debugging)
   */
  getOptions(): ClaudeCLIWrapperOptions {
    return { ...this.options };
  }
}

/**
 * Usage Example:
 *
 * const wrapper = new ClaudeCLIWrapper({ sessionId: 'discord-channel-123' });
 *
 * // First message
 * const result1 = await wrapper.prompt('Hello, what is 2+2?', {
 *   onDelta: (text) => console.log('Streaming:', text)
 * });
 *
 * console.log(result1.response); // "4"
 * console.log(result1.usage.input_tokens); // 3
 * console.log(result1.cost_usd); // 0.045
 *
 * // Follow-up (same session)
 * const result2 = await wrapper.prompt('What about 3+3?');
 * console.log(result2.response); // "6"
 *
 * // Cost Tracking Example:
 * let totalCost = 0;
 * const result = await wrapper.prompt('...');
 * totalCost += result.cost_usd || 0;
 * console.log(`Total spent: $${totalCost.toFixed(4)}`);
 */
