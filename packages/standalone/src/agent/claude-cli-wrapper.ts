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

export interface ClaudeCLIWrapperOptions {
  model?: string;
  sessionId?: string;
  systemPrompt?: string;
  mcpConfigPath?: string;
  dangerouslySkipPermissions?: boolean;
}

export interface PromptCallbacks {
  onDelta?: (text: string) => void;
  onToolUse?: (name: string, input: any) => void;
  onFinal?: (response: any) => void;
  onError?: (error: Error) => void;
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
   * @returns PromptResult with response and usage
   */
  async prompt(content: string, callbacks?: PromptCallbacks): Promise<PromptResult> {
    return new Promise((resolve, reject) => {
      const args = [
        '-p',
        content,
        '--output-format',
        'json',
        '--session-id',
        this.sessionId,
        '--no-session-persistence', // Prevent "session already in use" errors
      ];

      if (this.options.systemPrompt) {
        args.push('--system-prompt', this.options.systemPrompt);
      }

      if (this.options.mcpConfigPath) {
        args.push('--mcp-config', this.options.mcpConfigPath);
        args.push('--strict-mcp-config');
      }

      if (this.options.dangerouslySkipPermissions) {
        args.push('--dangerously-skip-permissions');
      }

      console.log(`[ClaudeCLI] Spawning: claude ${args.join(' ')}`);
      console.log(`[ClaudeCLI] Args count: ${args.length}`);
      console.log(`[ClaudeCLI] Content length: ${content.length} chars`);
      if (this.options.systemPrompt) {
        console.log(`[ClaudeCLI] SystemPrompt length: ${this.options.systemPrompt.length} chars`);
      }

      const claude = spawn('claude', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Close stdin immediately - we use -p flag, not stdin input
      // Without this, Claude CLI hangs waiting for stdin input
      claude.stdin.end();

      let stdout = '';
      let stderr = '';
      let lastDelta = '';

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
              callbacks?.onToolUse?.(event.name, event.input);
            }
          } catch (e) {
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
            };

            callbacks?.onFinal?.({ content: promptResult.response });
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
  }

  /**
   * Set session ID (for channel-specific conversations)
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
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
