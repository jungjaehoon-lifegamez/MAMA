/**
 * CLI Runner
 *
 * Executes prompts via Claude Code CLI subprocess.
 * Based on OpenClaw's cli-runner.js implementation.
 *
 * Features:
 * - Calls `claude -p --output-format json`
 * - Supports session continuity via --session-id
 * - Parses JSON output for response and usage
 * - Handles timeouts and errors
 *
 * @example
 * ```typescript
 * const runner = new CliRunner();
 * const result = await runner.run('Hello!', { model: 'sonnet' });
 * console.log(result.text);
 * ```
 */

import { execSync } from 'child_process';
import type { Runner, RunnerOptions, RunnerResult, CliBackendConfig } from './types.js';
import { DEFAULT_CLAUDE_BACKEND } from './types.js';

/**
 * CLI Runner implementation
 */
export class CliRunner implements Runner {
  readonly type = 'cli' as const;

  private config: Required<Pick<CliBackendConfig, 'command' | 'args' | 'timeoutMs'>> &
    Omit<CliBackendConfig, 'command' | 'args' | 'timeoutMs'>;

  constructor(config?: Partial<CliBackendConfig>) {
    this.config = {
      command: config?.command ?? DEFAULT_CLAUDE_BACKEND.command,
      args: config?.args ?? DEFAULT_CLAUDE_BACKEND.args,
      timeoutMs: config?.timeoutMs ?? DEFAULT_CLAUDE_BACKEND.timeoutMs!,
      modelArg: config?.modelArg ?? DEFAULT_CLAUDE_BACKEND.modelArg,
      sessionArg: config?.sessionArg ?? DEFAULT_CLAUDE_BACKEND.sessionArg,
      systemPromptArg: config?.systemPromptArg ?? DEFAULT_CLAUDE_BACKEND.systemPromptArg,
      serialize: config?.serialize ?? DEFAULT_CLAUDE_BACKEND.serialize,
      modelAliases: config?.modelAliases ?? DEFAULT_CLAUDE_BACKEND.modelAliases,
    };
  }

  /**
   * Run a prompt via CLI
   */
  async run(prompt: string, options?: RunnerOptions): Promise<RunnerResult> {
    const args = this.buildArgs(prompt, options);
    const result = await this.executeCommand(args, options);
    return this.parseOutput(result.stdout);
  }

  /**
   * Build CLI arguments
   */
  private buildArgs(prompt: string, options?: RunnerOptions): string[] {
    const args = [...this.config.args];

    // Add model argument
    if (this.config.modelArg && options?.model) {
      const model = this.resolveModelAlias(options.model);
      args.push(this.config.modelArg, model);
    }

    // Add session ID argument
    if (this.config.sessionArg && options?.sessionId) {
      args.push(this.config.sessionArg, options.sessionId);
    }

    // Add system prompt argument
    if (this.config.systemPromptArg && options?.systemPrompt) {
      args.push(this.config.systemPromptArg, options.systemPrompt);
    }

    // Add prompt as the final argument
    args.push(prompt);

    return args;
  }

  /**
   * Resolve model alias to actual model name
   */
  private resolveModelAlias(model: string): string {
    return this.config.modelAliases?.[model] ?? model;
  }

  /**
   * Execute CLI command with timeout
   *
   * Uses execSync for reliable execution with Claude CLI
   */
  private async executeCommand(
    args: string[],
    options?: RunnerOptions
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const timeout = options?.timeoutMs ?? this.config.timeoutMs;
    const cwd = options?.workspaceDir ?? process.cwd();

    // Build command string with proper escaping
    const escapedArgs = args.map((arg) => {
      // Escape single quotes and wrap in single quotes
      if (arg.includes("'") || arg.includes('"') || arg.includes(' ') || arg.includes('\n')) {
        return `'${arg.replace(/'/g, "'\\''")}'`;
      }
      return arg;
    });

    const command = `${this.config.command} ${escapedArgs.join(' ')}`;

    // Environment without ANTHROPIC_API_KEY so CLI uses its own auth
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    // Use execSync wrapped in Promise for async interface
    // This is needed because promisified exec has issues with Claude CLI
    return new Promise((resolve, reject) => {
      // Run in next tick to not block the event loop setup
      setImmediate(() => {
        try {
          const stdout = execSync(command, {
            cwd,
            env,
            timeout,
            maxBuffer: 10 * 1024 * 1024, // 10MB buffer
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          resolve({ stdout, stderr: '', code: 0 });
        } catch (error: any) {
          // execSync throws on non-zero exit or timeout
          if (error.killed) {
            reject(new Error(`CLI timeout after ${timeout}ms`));
            return;
          }

          if (error.status !== undefined && error.status !== 0) {
            const errorMessage =
              error.stderr?.toString().trim() ||
              error.stdout?.toString().trim() ||
              `CLI exited with code ${error.status}`;
            reject(new Error(errorMessage));
            return;
          }

          reject(new Error(`Failed to execute CLI: ${error.message}`));
        }
      });
    });
  }

  /**
   * Parse CLI JSON output
   */
  private parseOutput(stdout: string): RunnerResult {
    try {
      const json = JSON.parse(stdout.trim());

      return {
        text: json.result ?? json.response ?? json.text ?? stdout.trim(),
        sessionId: json.session_id ?? json.sessionId ?? json.conversation_id,
        usage: json.usage
          ? {
              inputTokens: json.usage.input_tokens ?? 0,
              outputTokens: json.usage.output_tokens ?? 0,
            }
          : undefined,
      };
    } catch {
      // JSON parsing failed, return raw output
      console.warn('[CliRunner] Failed to parse JSON output, returning raw text');
      return { text: stdout.trim() };
    }
  }

  /**
   * Check if CLI is available
   */
  static async isAvailable(command = 'claude'): Promise<boolean> {
    try {
      execSync(`${command} --version`, {
        timeout: 5000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get CLI version
   */
  static async getVersion(command = 'claude'): Promise<string | null> {
    try {
      const stdout = execSync(`${command} --version`, {
        timeout: 5000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return stdout.trim();
    } catch {
      return null;
    }
  }
}
