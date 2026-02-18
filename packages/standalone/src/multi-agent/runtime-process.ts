import { EventEmitter } from 'events';
import {
  CodexMCPProcess,
  type CodexMCPOptions,
  type PromptCallbacks as CodexPromptCallbacks,
} from '../agent/codex-mcp-process.js';
import type {
  PromptCallbacks as ClaudePromptCallbacks,
  PromptResult as ClaudePromptResult,
} from '../agent/persistent-cli-process.js';

export interface AgentRuntimeProcess {
  sendMessage(content: string, callbacks?: ClaudePromptCallbacks): Promise<ClaudePromptResult>;
  isReady(): boolean;
  stop(): void;
  getSessionId?(): string;
  on(event: 'idle' | 'close' | 'error', listener: (...args: unknown[]) => void): this;
}

export interface CodexRuntimeProcessOptions {
  model?: string;
  systemPrompt?: string;
  cwd?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  requestTimeout?: number;
  codexHome?: string;
  command?: string;
  // Legacy options (from old CLI approach - some may not be supported in MCP mode)
  profile?: string;
  ephemeral?: boolean;
  addDirs?: string[];
  configOverrides?: string[];
  skipGitRepoCheck?: boolean;
}

/**
 * Session-persistent Codex wrapper with the same minimal contract used by
 * multi-agent runtime (sendMessage/isReady/stop + idle events).
 *
 * Uses CodexMCPProcess for persistent MCP communication.
 */
export class CodexRuntimeProcess extends EventEmitter implements AgentRuntimeProcess {
  private wrapper: CodexMCPProcess;
  private state: 'idle' | 'busy' | 'dead' = 'idle';
  private stoppedDuringExecution = false;

  constructor(options: CodexRuntimeProcessOptions) {
    super();
    const wrapperOptions: CodexMCPOptions = {
      model: options.model,
      systemPrompt: options.systemPrompt,
      cwd: options.cwd,
      sandbox: options.sandbox,
      command: options.command,
      compactPrompt: 'Summarize the conversation concisely, preserving key decisions and context.',
      timeoutMs: options.requestTimeout,
    };
    this.wrapper = new CodexMCPProcess(wrapperOptions);
  }

  async sendMessage(
    content: string,
    callbacks?: ClaudePromptCallbacks
  ): Promise<ClaudePromptResult> {
    if (this.state === 'dead') {
      throw new Error('Process is dead');
    }
    if (this.state === 'busy') {
      throw new Error('Process is busy with another request');
    }

    this.state = 'busy';
    try {
      const codexCallbacks: CodexPromptCallbacks | undefined = callbacks
        ? {
            onDelta: callbacks.onDelta,
            onError: callbacks.onError,
          }
        : undefined;

      const result = await this.wrapper.prompt(content, codexCallbacks);

      const normalized: ClaudePromptResult = {
        response: result.response,
        usage: {
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          cache_read_input_tokens: result.usage.cached_input_tokens,
        },
        session_id: result.session_id || this.wrapper.getSessionId(),
        cost_usd: result.cost_usd,
        toolUseBlocks: undefined,
        hasToolUse: false,
      };

      callbacks?.onFinal?.({ content: normalized.response, toolUseBlocks: [] });
      return normalized;
    } finally {
      // Only reset to idle if not stopped during execution
      if (!this.stoppedDuringExecution) {
        this.state = 'idle';
        this.emit('idle');
      }
    }
  }

  isReady(): boolean {
    return this.state === 'idle';
  }

  stop(): void {
    this.stoppedDuringExecution = this.state === 'busy';
    this.state = 'dead';
    this.wrapper.stop();
    this.emit('close', 0);
  }

  getSessionId(): string {
    return this.wrapper.getSessionId();
  }
}
