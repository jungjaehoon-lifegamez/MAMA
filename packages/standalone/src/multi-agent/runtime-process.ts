import { EventEmitter } from 'events';
import {
  CodexCLIWrapper,
  type CodexCLIWrapperOptions,
  type PromptCallbacks as CodexPromptCallbacks,
} from '../agent/codex-cli-wrapper.js';
import type {
  PromptCallbacks as ClaudePromptCallbacks,
  PromptResult as ClaudePromptResult,
} from '../agent/persistent-cli-process.js';

export interface AgentRuntimeProcess {
  sendMessage(content: string, callbacks?: ClaudePromptCallbacks): Promise<ClaudePromptResult>;
  isReady(): boolean;
  stop(): void;
  on(event: 'idle' | 'close' | 'error', listener: (...args: unknown[]) => void): this;
}

export interface CodexRuntimeProcessOptions {
  model?: string;
  systemPrompt?: string;
  codexHome?: string;
  cwd?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  profile?: string;
  ephemeral?: boolean;
  addDirs?: string[];
  configOverrides?: string[];
  skipGitRepoCheck?: boolean;
  requestTimeout?: number;
}

/**
 * Session-persistent Codex wrapper with the same minimal contract used by
 * multi-agent runtime (sendMessage/isReady/stop + idle events).
 */
export class CodexRuntimeProcess extends EventEmitter implements AgentRuntimeProcess {
  private wrapper: CodexCLIWrapper;
  private state: 'idle' | 'busy' | 'dead' = 'idle';
  private seeded = false;
  private readonly systemPrompt?: string;

  constructor(options: CodexRuntimeProcessOptions) {
    super();
    const wrapperOptions: CodexCLIWrapperOptions = {
      model: options.model,
      systemPrompt: undefined,
      codexHome: options.codexHome,
      cwd: options.cwd,
      sandbox: options.sandbox,
      profile: options.profile,
      ephemeral: options.ephemeral,
      addDirs: options.addDirs,
      configOverrides: options.configOverrides,
      skipGitRepoCheck: options.skipGitRepoCheck,
      timeoutMs: options.requestTimeout,
    };
    this.wrapper = new CodexCLIWrapper(wrapperOptions);
    this.systemPrompt = options.systemPrompt;
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
      const prompt =
        !this.seeded && this.systemPrompt ? `${this.systemPrompt}\n\n${content}` : content;
      const codexCallbacks: CodexPromptCallbacks | undefined = callbacks
        ? {
            onDelta: callbacks.onDelta,
            onToolUse: callbacks.onToolUse,
            onError: callbacks.onError,
          }
        : undefined;

      const result = await this.wrapper.prompt(prompt, codexCallbacks, {
        resumeSession: this.seeded,
      });
      this.seeded = true;

      const normalized: ClaudePromptResult = {
        response: result.response,
        usage: {
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          cache_creation_input_tokens: result.usage.cache_creation_input_tokens,
          cache_read_input_tokens: result.usage.cache_read_input_tokens,
        },
        session_id: result.session_id || this.wrapper.getSessionId(),
        cost_usd: result.cost_usd,
        toolUseBlocks: undefined,
        hasToolUse: false,
      };

      callbacks?.onFinal?.({ content: normalized.response, toolUseBlocks: [] });
      return normalized;
    } finally {
      this.state = 'idle';
      this.emit('idle');
    }
  }

  isReady(): boolean {
    return this.state === 'idle';
  }

  stop(): void {
    this.state = 'dead';
    this.emit('close', 0);
  }
}
