/**
 * Codex CLI Subprocess Wrapper
 *
 * Uses Codex CLI as a backend runner (CLI mode).
 * - Executes `codex exec --json` for new sessions
 * - Executes `codex exec resume <session_id> --json` for resumed sessions
 * - Captures final message via --output-last-message for reliable text extraction
 *
 * Notes:
 * - Codex CLI does not provide token-level streaming in exec mode.
 * - Tool use blocks are not supported in this wrapper.
 */

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { readFileSync, existsSync, unlinkSync, mkdirSync, copyFileSync, statSync } from 'fs';
import os from 'os';
import { dirname, join } from 'path';

export interface CodexCLIWrapperOptions {
  model?: string;
  sessionId?: string;
  systemPrompt?: string;
  /** Codex home directory (config/sessions/skills) */
  codexHome?: string;
  /** Working directory for Codex process */
  cwd?: string;
  /** Sandbox mode for Codex CLI */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Codex profile from config.toml */
  profile?: string;
  /** Run Codex in ephemeral mode (no session persistence) */
  ephemeral?: boolean;
  /** Additional writable directories */
  addDirs?: string[];
  /** Raw -c key=value config overrides */
  configOverrides?: string[];
  /** Skip Git repo check in Codex CLI */
  skipGitRepoCheck?: boolean;
  /** Timeout for each request in ms (default: 120000) */
  timeoutMs?: number;
}

export interface PromptCallbacks {
  onDelta?: (text: string) => void;
  onToolUse?: (name: string, input: Record<string, unknown>) => void;
  onFinal?: (response: { response: string }) => void;
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
  session_id?: string;
  cost_usd?: number;
}

interface CodexUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export class CodexCLIWrapper {
  private sessionId: string;
  private options: CodexCLIWrapperOptions;

  constructor(options: CodexCLIWrapperOptions = {}) {
    this.options = options;
    this.sessionId = options.sessionId || randomUUID();
  }

  /**
   * Send a prompt to Codex CLI
   */
  async prompt(
    content: string,
    callbacks?: PromptCallbacks,
    options?: { model?: string; resumeSession?: boolean }
  ): Promise<PromptResult> {
    const promptText = this.buildPrompt(content);
    const useOutputFile = !options?.resumeSession;
    const tmpFile = useOutputFile ? join(os.tmpdir(), `codex_last_${randomUUID()}.txt`) : '';
    const args = this.buildArgs(options, tmpFile);

    const stdout = await this.execute(args, promptText);
    const parsed = this.parseJsonl(stdout);

    const response = useOutputFile
      ? (this.readLastMessage(tmpFile) ?? parsed.lastMessage ?? '')
      : (parsed.lastMessage ?? '');

    if (parsed.threadId) {
      this.sessionId = parsed.threadId;
    }

    callbacks?.onFinal?.({ response });

    return {
      response,
      usage: {
        input_tokens: parsed.usage?.input_tokens ?? 0,
        output_tokens: parsed.usage?.output_tokens ?? 0,
        cache_creation_input_tokens: parsed.usage?.cache_creation_input_tokens,
        cache_read_input_tokens:
          parsed.usage?.cache_read_input_tokens ?? parsed.usage?.cached_input_tokens,
      },
      session_id: parsed.threadId,
    };
  }

  /**
   * Get current session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Set session ID (for channel-specific conversations)
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /**
   * Set system prompt (prefixed to first prompt of a new session)
   */
  setSystemPrompt(prompt: string): void {
    this.options.systemPrompt = prompt;
  }

  private buildPrompt(content: string): string {
    if (this.options.systemPrompt) {
      return `${this.options.systemPrompt}\n\n${content}`;
    }
    return content;
  }

  private buildArgs(
    options: { model?: string; resumeSession?: boolean } | undefined,
    outputFile: string
  ): string[] {
    const args: string[] = [];
    const model = options?.model ?? this.options.model;
    const skipGitRepoCheck = this.options.skipGitRepoCheck ?? true;
    const sandbox = this.options.sandbox ?? 'read-only';
    const profile = this.options.profile;
    const ephemeral = this.options.ephemeral ?? false;
    const addDirs = this.options.addDirs ?? [];
    const configOverrides = this.options.configOverrides ?? [];
    const cwd = this.options.cwd;

    if (options?.resumeSession) {
      args.push('exec', 'resume');
      if (this.sessionId) {
        args.push(this.sessionId);
      } else {
        args.push('--last');
      }
    } else {
      args.push('exec');
    }

    if (options?.resumeSession) {
      // Codex resume supports a limited flag set
      args.push('--json');
      if (skipGitRepoCheck) {
        args.push('--skip-git-repo-check');
      }
      if (sandbox === 'danger-full-access') {
        args.push('--dangerously-bypass-approvals-and-sandbox');
      }
    } else {
      args.push('--json', '--output-last-message', outputFile, '--color', 'never');

      // Apply sandbox mode based on configuration
      if (sandbox === 'danger-full-access') {
        args.push('--dangerously-bypass-approvals-and-sandbox');
      } else if (sandbox === 'workspace-write') {
        args.push('--sandbox', 'workspace-write');
      } else if (sandbox === 'read-only') {
        args.push('--sandbox', 'read-only');
      }

      if (skipGitRepoCheck) {
        args.push('--skip-git-repo-check');
      }
    }

    // `codex exec resume` supports a narrower option set than `codex exec`.
    if (!options?.resumeSession && profile) {
      args.push('--profile', profile);
    }
    if (!options?.resumeSession && cwd) {
      args.push('--cd', cwd);
    }
    if (ephemeral && !options?.resumeSession) {
      args.push('--ephemeral');
    }
    if (!options?.resumeSession) {
      for (const dir of addDirs) {
        if (dir) {
          args.push('--add-dir', dir);
        }
      }
    }
    for (const override of configOverrides) {
      if (override) {
        args.push('-c', override);
      }
    }
    if (model) {
      args.push('--model', model);
    }

    // Read prompt from stdin to avoid arg length issues
    args.push('-');
    return args;
  }

  private execute(args: string[], promptText: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.prepareCodexHome();
      const { CODEX_THREAD_ID: _ignoredThreadId, ...baseEnv } = process.env;
      const spawnEnv = {
        ...baseEnv,
        ...(this.options.codexHome ? { CODEX_HOME: this.options.codexHome } : {}),
      };
      const child = spawn('codex', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: spawnEnv,
        cwd: this.options.cwd ?? process.cwd(),
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const timeoutMs = this.options.timeoutMs ?? 120000;
      const timeout = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        reject(new Error(`Codex CLI timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
      child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));

      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to execute Codex CLI: ${error.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timeout);
        const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
        if (code !== 0) {
          reject(new Error(stderr || `Codex CLI exited with code ${code}`));
          return;
        }
        resolve(stdout);
      });

      child.stdin.write(promptText);
      child.stdin.end();
    });
  }

  private prepareCodexHome(): void {
    const codexHome = this.options.codexHome;
    if (!codexHome) {
      return;
    }

    try {
      mkdirSync(codexHome, { recursive: true });
      const legacyHome = join(os.homedir(), '.codex');
      const filesToMigrate = ['auth.json', 'config.toml', 'version.json'];
      for (const relPath of filesToMigrate) {
        const src = join(legacyHome, relPath);
        const dest = join(codexHome, relPath);
        if (!existsSync(src)) {
          continue;
        }

        let shouldCopy = !existsSync(dest);
        if (!shouldCopy) {
          try {
            shouldCopy = statSync(src).mtimeMs > statSync(dest).mtimeMs;
          } catch {
            shouldCopy = true;
          }
        }

        if (shouldCopy) {
          mkdirSync(dirname(dest), { recursive: true });
          copyFileSync(src, dest);
        }
      }
    } catch {
      // Non-fatal: Codex may still run with existing defaults.
    }
  }

  private readLastMessage(outputFile: string): string | null {
    try {
      if (!existsSync(outputFile)) {
        return null;
      }
      const text = readFileSync(outputFile, 'utf-8').trim();
      if (!text) {
        return null;
      }
      return text;
    } catch {
      return null;
    } finally {
      try {
        if (existsSync(outputFile)) unlinkSync(outputFile);
      } catch {
        // ignore cleanup errors
      }
    }
  }

  private parseJsonl(stdout: string): {
    threadId?: string;
    usage?: CodexUsage;
    lastMessage?: string;
  } {
    const lines = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    let threadId: string | undefined;
    let usage: CodexUsage | undefined;
    let lastMessage: string | undefined;

    for (const line of lines) {
      try {
        const evt = JSON.parse(line) as {
          type?: string;
          thread_id?: string;
          usage?: CodexUsage;
          item?: { type?: string; text?: string };
        };
        if (evt.type === 'thread.started' && evt.thread_id) {
          threadId = evt.thread_id;
        }
        if (evt.type === 'turn.completed' && evt.usage) {
          usage = evt.usage;
        }
        if (evt.type === 'item.completed' && evt.item?.type === 'agent_message') {
          lastMessage = evt.item.text;
        }
      } catch {
        // Ignore malformed lines
      }
    }

    return { threadId, usage, lastMessage };
  }
}
