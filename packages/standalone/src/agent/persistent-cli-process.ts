/**
 * Persistent Claude CLI Process - Keeps Claude alive for multi-turn conversations
 *
 * WHY THIS EXISTS:
 * - Previous approach spawned new Claude CLI process for each message
 * - Each spawn required ~20K system prompt to be sent every time
 * - Result: Slow responses (16-30 seconds per message)
 *
 * NEW ARCHITECTURE:
 * - Keep Claude process alive using stream-json input/output
 * - Send messages via stdin, receive responses via stdout
 * - Session memory preserved in Claude's context
 * - System prompt sent only once at process start
 *
 * STREAM-JSON PROTOCOL:
 * Input (stdin):
 *   User message: {"type":"user","message":{"role":"user","content":"..."}}
 *   Tool result:  {"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"xxx","content":"...","is_error":false}]}}
 *
 * Output (stdout):
 *   Init:      {"type":"system","subtype":"init",...}
 *   Assistant: {"type":"assistant","message":{...}}
 *   Tool use:  Content block with type="tool_use" in assistant message
 *   Result:    {"type":"result","subtype":"success",...}
 */

import { spawn, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import os from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { EventEmitter } from 'events';
import { HostToolTerminalError, type SessionPolicyStatus } from './model-runner.js';
import {
  ClaudeToolStreamProtocolError,
  McpCompletedMutationInterruptedError,
  McpResultMissingError,
  type CompletedToolExchange,
  type PromptCallbacks,
  type PromptResult,
  type TokenUsageRecord,
  type ToolResultBlock,
  type ToolUseBlock,
} from './types.js';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';
import { getConfig } from '../cli/config/config-manager.js';
import { formatCliArgsForLog } from './cli-arg-redaction.js';
import { ensureCodeActMcpConfigBeforeSpawn } from '../mcp/code-act-mcp-config.js';
import { API_PORT } from '../cli/runtime/utilities.js';
import { createProcessContextKey } from './code-act/run-context-registry.js';
import {
  completedCodeActMutationWasObserved,
  completedCodeActTerminalError,
} from './code-act/completed-terminal-result.js';

const { DebugLogger } = debugLogger as {
  DebugLogger: new (context?: string) => {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};
const persistentLogger = new DebugLogger('PersistentCLI');
const poolLogger = new DebugLogger('ProcessPool');

function supportsThinkingEffortModel(model: string | undefined): boolean {
  if (!model) {
    return false;
  }
  // Adaptive thinking effort: Claude 4.6 and every Claude 5 family model accept --effort.
  return /^claude-(opus|sonnet|haiku|fable)-(4-6|5)(\b|-)/.test(model);
}

function normalizeThinkingEffort(
  model: string | undefined,
  effort: 'low' | 'medium' | 'high' | 'max'
): 'low' | 'medium' | 'high' | 'max' {
  if (effort === 'max' && !(model && /^claude-(opus-4-6|opus-5|fable-5)(\b|-)/.test(model))) {
    return 'high';
  }
  return effort;
}

/**
 * Regex to strip lone Unicode surrogates that cause API 400 errors.
 * Matches high surrogates not followed by a low surrogate, and
 * low surrogates not preceded by a high surrogate.
 */
// eslint-disable-next-line no-control-regex
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export interface PersistentProcessOptions {
  sessionId: string;
  /** Host-computed authority fingerprint bound to this process generation. */
  policyFingerprint?: string;
  model?: string;
  systemPrompt?: string;
  mcpConfigPath?: string;
  /**
   * Skip permission prompts for tool execution
   *
   * @warning SECURITY RISK: Bypasses all permission checks.
   * Only enable in trusted environments where agent actions are pre-approved.
   */
  dangerouslySkipPermissions?: boolean;
  useGatewayTools?: boolean;
  /** Timeout for each request in ms (default: 120000) */
  requestTimeout?: number;
  /** Idle timeout for pooled persistent processes in ms (default: session_ms) */
  idleTimeoutMs?: number;
  /** Cleanup interval for pooled persistent processes in ms (default: session_cleanup_ms) */
  cleanupIntervalMs?: number;
  /** Maximum time to keep a process waiting for host-side tool results (default: max(4 * idleTimeoutMs, 30m)) */
  pendingToolUseTimeoutMs?: number;
  /** Environment variables to pass to the Claude CLI process */
  env?: Record<string, string>;
  /** Bind this process generation's MCP child calls to host-issued run context leases. */
  bindRunContext?: boolean;
  /** Structurally allowed tools (--allowedTools CLI flag) */
  allowedTools?: string[];
  /** Structurally disallowed tools (--disallowedTools CLI flag) */
  disallowedTools?: string[];
  /** Override built-in tool set (--tools CLI flag). Use "" to disable all tools. */
  tools?: string;
  /** Override plugin directory (--plugin-dir CLI flag). Use empty dir to disable plugins. */
  pluginDir?: string;
  /** Optional callback for recording token usage */
  onTokenUsage?: (record: TokenUsageRecord) => void;
  /** Channel key for token usage tracking */
  channelKey?: string;
  /** Agent ID for token usage tracking */
  agentId?: string;
  /** Effort level for Claude 4.6 adaptive thinking */
  effort?: 'low' | 'medium' | 'high' | 'max';
}

export interface PersistentProcessAcquireResult {
  process: PersistentClaudeProcess;
  created: boolean;
}

export type { ToolUseBlock } from './types.js';

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

export interface StreamMessage {
  type: 'system' | 'assistant' | 'result' | 'error' | 'user';
  subtype?: string;
  /**
   * Set by the CLI on events produced INSIDE a subagent (the Agent tool_use id that
   * started it). It is the only non-heuristic way to tell a child's tool calls from the
   * parent's on one stream; absent/null means "this stream position", not "parent".
   */
  parent_tool_use_id?: string | null;
  /** Background-task identity on `system` task_* events; field name varies by CLI build. */
  task_id?: string;
  taskId?: string;
  task?: { id?: string; status?: string; description?: string; agentId?: string };
  agent_id?: string;
  agentId?: string;
  message?: {
    role: string;
    content: ContentBlock[];
    model?: string;
    id?: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  duration_ms?: number;
  num_turns?: number;
  is_error?: boolean;
  error?: string;
}

export type { PromptCallbacks, PromptResult };

type ProcessState = 'idle' | 'busy' | 'starting' | 'dead';

interface PromptToolExchangeState {
  toolUse: ToolUseBlock;
  toolUseFingerprint: string;
  toolResult?: ToolResultBlock;
  toolResultFingerprint?: string;
}

/** The native Claude Code delegation tool. `run_in_background: true` is the delegating shape. */
const BACKGROUND_AGENT_TOOL = 'Agent';
/** Bound on the child's final text carried to the host wake. Mirrors Codex's limit. */
const MAX_SUBAGENT_FINAL_TEXT_CHARS = 4_000;
/**
 * How long a `task_notification` waits for the CLI's own follow-up turn before the host
 * takes the wake itself. Measured: `init` follows the notification immediately.
 */
const AUTONOMOUS_TURN_GRACE_MS = 5_000;
/** Identity, not history: finished children are dropped, live ones are few. */
const MAX_TRACKED_BACKGROUND_AGENTS = 50;

/**
 * One native background Agent spawned by this process's persona, observed from the
 * PARENT stream - the only stream the CLI gives us. The child's tool calls reach the same
 * MCP server with the parent's MAMA_CODE_ACT_CONTEXT_KEY, so they land in the parent's run
 * context and tool traces; this state tracks only identity and the child's final text, so
 * the host can wake the owner.
 */
interface BackgroundAgentState {
  /** The `Agent` tool_use id; the CLI stamps it on the child's own events. */
  itemId: string;
  agentPath: string;
  /** From the launch tool_result text; the child's own id. */
  agentId: string | null;
  /** From `system/task_started`; the fallback identity when no agentId is parsed. */
  taskId: string | null;
  spawnObserved: boolean;
  startFired: boolean;
  notificationSeen: boolean;
  completed: boolean;
  finalText: string;
  /** The spawning turn's callback; `currentCallbacks` is cleared when that turn ends. */
  onSubagentStart?: PromptCallbacks['onSubagentStart'];
}

/** Host-visible spawn/finish of a native background Agent on the Claude stream. */
export interface ClaudeSubagentStreamEvent {
  kind: 'started' | 'completed';
  agentThreadId: string;
  agentPath: string;
  itemId: string;
  status?: 'completed' | 'unknown';
  finalText?: string;
  /**
   * False when the CLI opened its own follow-up turn for the notification: that turn IS
   * the owner reacting, so the host must not enqueue a second one.
   */
  wakeRequired: boolean;
}

/** A turn the CLI begins on its own after a background task notification (no stdin). */
export interface ClaudeAutonomousTurnEvent {
  agentThreadId: string;
  agentPath: string;
  itemId: string;
}

export interface ClaudeAutonomousTurnResultEvent extends ClaudeAutonomousTurnEvent {
  text: string;
  isError: boolean;
}

const MAX_STREAM_TOOL_RESULT_CHARS = 64 * 1024;
const MAX_CODE_ACT_AUDIT_ENTRIES = 50;
const MAX_CODE_ACT_AUDIT_FIELD_CHARS = 48;
const MAX_CODE_ACT_ERROR_MESSAGE_CHARS = 512;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 'undefined' : serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function normalizeStreamToolResultContent(content: ContentBlock['content']): string {
  const normalized =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n')
        : '';
  if (normalized.length <= MAX_STREAM_TOOL_RESULT_CHARS) {
    return normalized;
  }

  try {
    const parsed: unknown = JSON.parse(normalized);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const root = parsed as Record<string, unknown>;
      if (
        root.protocol === 'mama.code_act.result' &&
        root.version === 1 &&
        typeof root.success === 'boolean'
      ) {
        const hostToolExecutions = Array.isArray(root.hostToolExecutions)
          ? root.hostToolExecutions
              .slice(0, MAX_CODE_ACT_AUDIT_ENTRIES)
              .flatMap((entry): Array<Record<string, unknown>> => {
                if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
                  return [];
                }
                const execution = entry as Record<string, unknown>;
                if (typeof execution.name !== 'string' || typeof execution.success !== 'boolean') {
                  return [];
                }
                return [
                  {
                    name: execution.name.slice(0, MAX_CODE_ACT_AUDIT_FIELD_CHARS),
                    success: execution.success,
                    ...(typeof execution.code === 'string'
                      ? { code: execution.code.slice(0, MAX_CODE_ACT_AUDIT_FIELD_CHARS) }
                      : {}),
                  },
                ];
              })
          : [];
        const error =
          typeof root.error === 'object' && root.error !== null && !Array.isArray(root.error)
            ? (root.error as Record<string, unknown>)
            : null;
        return JSON.stringify({
          protocol: 'mama.code_act.result',
          version: 1,
          success: root.success,
          hostToolExecutions,
          hostToolsInvoked: hostToolExecutions
            .filter((execution) => execution.success === true)
            .map((execution) => execution.name),
          payload: { truncated: true, originalChars: normalized.length },
          ...(error
            ? {
                error: {
                  ...(typeof error.code === 'string'
                    ? { code: error.code.slice(0, MAX_CODE_ACT_AUDIT_FIELD_CHARS) }
                    : {}),
                  ...(typeof error.message === 'string'
                    ? { message: error.message.slice(0, MAX_CODE_ACT_ERROR_MESSAGE_CHARS) }
                    : {}),
                },
              }
            : {}),
          ...(typeof root.retryable === 'boolean' ? { retryable: root.retryable } : {}),
          ...(typeof root.abort === 'boolean' ? { abort: root.abort } : {}),
        });
      }
    }
  } catch {
    // Non-JSON results retain the existing bounded text behavior.
  }

  return normalized.slice(0, MAX_STREAM_TOOL_RESULT_CHARS);
}

/**
 * PersistentClaudeProcess - Manages a single long-lived Claude CLI process
 *
 * Features:
 * - Keeps Claude process alive for multiple messages
 * - Uses stream-json for bidirectional communication
 * - Handles tool execution via Gateway Tools
 * - Auto-restarts on process death
 */
export class PersistentClaudeProcess extends EventEmitter {
  private process: ChildProcess | null = null;
  private options: PersistentProcessOptions;
  private state: ProcessState = 'dead';
  private outputBuffer: string = '';
  private currentCallbacks: PromptCallbacks | null = null;
  private currentResolve: ((result: PromptResult) => void) | null = null;
  private currentReject: ((error: Error) => void) | null = null;
  private requestTimeoutHandle: NodeJS.Timeout | null = null;
  private toolUseBlocks: ToolUseBlock[] = [];
  private readonly promptToolExchanges = new Map<string, PromptToolExchangeState>();
  private completedToolExchanges: CompletedToolExchange[] = [];
  private awaitingToolResults = false;
  private pendingToolUseStartedAt: number | null = null;
  private accumulatedText: string = '';
  private startPromise: Promise<void> | null = null;
  private onTokenUsage?: (record: TokenUsageRecord) => void;
  private readonly runContextKey: string | null;
  /** Live + just-finished native background Agents, keyed by their `Agent` tool_use id. */
  private readonly backgroundAgents = new Map<string, BackgroundAgentState>();
  /**
   * True once a turn's `result` resolved while a background child was still running. From
   * then until the next stdin request, unattributed assistant/user events on the stream
   * belong to that child, not to a parent turn that no longer exists.
   */
  private parentTurnEnded = false;
  /** Set between a `task_notification` and the CLI's own follow-up turn. */
  private pendingNotification: { itemId: string; timer: NodeJS.Timeout } | null = null;
  /** The CLI-initiated turn currently running with no stdin request behind it. */
  private autonomousTurn: { state: BackgroundAgentState; text: string } | null = null;

  /**
   * Resolve the effective request timeout in ms.
   * 0 = unlimited (no timeout). Returns the configured or default value.
   */
  private _getRequestTimeoutMs(): number {
    if (this.options.requestTimeout !== undefined && this.options.requestTimeout !== null) {
      return Math.max(0, this.options.requestTimeout);
    }
    try {
      const configTimeout = getConfig().timeouts?.request_ms;
      return Math.max(0, configTimeout ?? 120_000);
    } catch {
      return 120_000;
    }
  }

  constructor(options: PersistentProcessOptions) {
    super();
    this.options = options;
    this.onTokenUsage = options.onTokenUsage;
    this.runContextKey = options.bindRunContext ? createProcessContextKey() : null;

    // Register default error handler to prevent Node crash if no listeners attached
    this.on('error', (err) => {
      console.error('[PersistentCLI] Unhandled error event:', err);
    });
  }

  /**
   * Start the Claude CLI process
   *
   * Note: The CLI only emits the 'init' event after receiving the first user message.
   * So we don't wait for init here - we just start the process and let it run.
   * The first sendMessage() call will handle init as part of its response flow.
   */
  async start(): Promise<void> {
    // Serialize concurrent start() calls — if already starting, wait for that to finish
    if (this.startPromise) {
      return this.startPromise;
    }

    if (this.state !== 'dead') {
      persistentLogger.info(`[PersistentCLI] Process already in state: ${this.state}`);
      return;
    }

    this.startPromise = this.doStart();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async doStart(): Promise<void> {
    this.state = 'starting';
    persistentLogger.info(
      `[PersistentCLI] Starting process for session: ${this.options.sessionId}`
    );

    const args = this.buildArgs();
    persistentLogger.info(
      `[PersistentCLI] Spawning: claude ${formatClaudeArgsForLog(args).join(' ')}`
    );

    // Clean environment: Remove conflicting MAMA_* variables before merging
    const cleanEnv = { ...process.env };
    delete cleanEnv.MAMA_CODE_ACT_CONTEXT_KEY;
    const processOptionsEnv = { ...(this.options.env || {}) };
    delete processOptionsEnv.MAMA_CODE_ACT_CONTEXT_KEY;
    if (this.options.env) {
      // If we're setting MAMA_DISABLE_HOOKS, remove MAMA_HOOK_FEATURES
      if ('MAMA_DISABLE_HOOKS' in this.options.env) {
        delete cleanEnv.MAMA_HOOK_FEATURES;
      }
      // If we're setting MAMA_HOOK_FEATURES, remove MAMA_DISABLE_HOOKS
      if ('MAMA_HOOK_FEATURES' in this.options.env) {
        delete cleanEnv.MAMA_DISABLE_HOOKS;
      }
    }

    // ============================================================
    // ⚠️ MAMA OS AGENT ISOLATION — DO NOT MODIFY ⚠️
    // ============================================================
    // MAMA OS agents must operate only within the .mama scope, not globally.
    //
    // WHY: Claude Code CLI traverses upward from cwd to find CLAUDE.md.
    //   cwd=os.homedir() → ~/CLAUDE.md gets injected (user's personal config leaks into agent)
    //   cwd=~/.mama/workspace + git boundary → traversal stops here
    //
    // HOW: Create .mama/workspace/.git/HEAD so Claude Code treats it as a git repo root.
    //   This prevents Claude Code from searching for CLAUDE.md above this directory.
    //
    // FILE ACCESS: cwd only restricts CLAUDE.md discovery. If --dangerously-skip-permissions
    //   is enabled, the agent can still access all files on the system.
    //
    // Reverting cwd to os.homedir() or removing the git boundary will cause
    // ~/CLAUDE.md + global plugins to be re-injected every turn, wasting tokens.
    // ============================================================
    const workspaceDir = join(os.homedir(), '.mama', 'workspace');
    if (!existsSync(workspaceDir)) {
      mkdirSync(workspaceDir, { recursive: true });
    }
    const gitDir = join(workspaceDir, '.git');
    if (!existsSync(gitDir)) {
      mkdirSync(gitDir, { recursive: true });
    }
    const headFile = join(gitDir, 'HEAD');
    if (!existsSync(headFile)) {
      writeFileSync(headFile, 'ref: refs/heads/main\n');
    }
    // ⚠️ 2026-09-10: a rewritten ~/.mama/mama-mcp-config.json pointing at a
    // non-existent code-act server left this persona with NO gateway tools for
    // the whole life of the process. Repair the entry right before spawn, or
    // fail loudly — never spawn a tool-less persona silently.
    if (this.options.mcpConfigPath) {
      let changed: boolean;
      try {
        ({ changed } = ensureCodeActMcpConfigBeforeSpawn({
          mcpConfigPath: this.options.mcpConfigPath,
          apiPort: API_PORT,
          logger: persistentLogger,
        }));
      } catch (error) {
        // A failed repair must leave the process startable again, not stuck in 'starting'.
        this.state = 'dead';
        throw error;
      }
      if (changed) {
        persistentLogger.warn(
          `[mcp] code-act entry regenerated in ${this.options.mcpConfigPath} before spawn`
        );
      }
    }

    this.process = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: workspaceDir, // ⚠️ NEVER change to os.homedir() — breaks agent isolation
      env: {
        ...cleanEnv,
        ...processOptionsEnv,
        ...(this.runContextKey ? { MAMA_CODE_ACT_CONTEXT_KEY: this.runContextKey } : {}),
      },
    });

    // Set up event handlers
    this.process.stdout?.on('data', (chunk) => this.handleStdout(chunk));
    this.process.stderr?.on('data', (chunk) => this.handleStderr(chunk));
    this.process.on('close', (code) => this.handleClose(code));
    this.process.on('error', (error) => this.handleError(error));

    // Don't wait for init - CLI only emits it after first user message
    // Just wait a brief moment for the process to stabilize
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Guard: Only set idle if still in starting state AND process is alive
    // handleClose could have been called during the setTimeout above (→ state='dead')
    // Note: TS can't track async state mutations from event handlers, so cast is needed
    const currentState = this.state as ProcessState;
    const pid = this.process?.pid;
    if (currentState === 'starting' && pid && !this.process?.killed) {
      this.state = 'idle';
      persistentLogger.info(`[PersistentCLI] Process started and waiting for first message`);
    } else {
      this.state = 'dead';
      throw new Error('Process failed to start');
    }
  }

  /**
   * Build CLI arguments for stream-json mode
   */
  private buildArgs(): string[] {
    const args = [
      '--print',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--session-id',
      this.options.sessionId,
      // ============================================================
      // ⚠️ BLOCK GLOBAL SETTINGS — DO NOT REMOVE ⚠️
      // ============================================================
      // Excluding 'user' from --setting-sources prevents loading ~/.claude/settings.json.
      // That file contains enabledPlugins, so including 'user' causes global plugins
      // (superpowers, bmad, etc.) to be injected every turn.
      // --plugin-dir alone is NOT sufficient (it's additive, not an override).
      // ============================================================
      '--setting-sources',
      'project,local',
    ];

    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    if (this.options.systemPrompt) {
      args.push('--system-prompt', this.options.systemPrompt);
    }

    // Hybrid mode: MCP + Gateway can both be enabled
    if (this.options.mcpConfigPath) {
      args.push('--mcp-config', this.options.mcpConfigPath);
      args.push('--strict-mcp-config');
      persistentLogger.info('MCP enabled:', this.options.mcpConfigPath);
    }
    if (this.options.useGatewayTools) {
      persistentLogger.info('Gateway Tools mode enabled');
    }

    if (this.options.effort && supportsThinkingEffortModel(this.options.model)) {
      args.push('--effort', normalizeThinkingEffort(this.options.model, this.options.effort));
    }

    if (this.options.dangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    // Override built-in tool set (e.g. --tools "" to disable all)
    if (this.options.tools !== undefined) {
      args.push('--tools', this.options.tools);
    }

    // ============================================================
    // ⚠️ PLUGIN ISOLATION — DO NOT REMOVE ⚠️
    // ============================================================
    // Points --plugin-dir to an empty directory so Claude Code cannot load
    // global plugins. MAMA already includes everything needed via --system-prompt,
    // so loading plugins would cause duplicate injection of the same content.
    //
    // Removing this causes skills/CLAUDE.md to be re-injected as system-reminder
    // every turn, wasting thousands of tokens.
    // ============================================================
    const pluginDir = this.options.pluginDir ?? join(os.homedir(), '.mama', '.empty-plugins');
    if (!existsSync(pluginDir)) {
      mkdirSync(pluginDir, { recursive: true });
    }
    args.push('--plugin-dir', pluginDir);

    // Structural tool enforcement via CLI flags
    if (this.options.allowedTools?.length) {
      args.push('--allowedTools', ...this.options.allowedTools);
    }
    if (this.options.disallowedTools?.length) {
      args.push('--disallowedTools', ...this.options.disallowedTools);
    }

    return args;
  }

  /**
   * Send a user message to Claude
   */
  async sendMessage(content: string, callbacks?: PromptCallbacks): Promise<PromptResult> {
    if (this.state === 'dead') {
      await this.start();
    }

    // If another caller is starting, wait for it to finish
    if (this.startPromise) {
      await this.startPromise;
    }

    // Prevent concurrent requests during active processing
    if (this.state === 'busy') {
      throw new Error('Process is busy with another request');
    }

    if (this.state === 'starting' || this.state === 'dead') {
      throw new Error(`Process is not ready (state: ${this.state})`);
    }

    this.state = 'busy';
    this.awaitingToolResults = false;
    this.pendingToolUseStartedAt = null;
    this.currentCallbacks = callbacks || null;
    this.toolUseBlocks = [];
    this.promptToolExchanges.clear();
    this.completedToolExchanges = [];
    this.accumulatedText = '';
    // A live child keeps running, but this turn's own events are the parent's again.
    this.parentTurnEnded = false;

    return new Promise((resolve, reject) => {
      this.currentResolve = resolve;
      this.currentReject = reject;

      // Set request timeout (0 = unlimited, skip timeout entirely)
      const timeoutMs = this._getRequestTimeoutMs();
      if (timeoutMs > 0) {
        this.requestTimeoutHandle = setTimeout(() => {
          this.handleTimeout();
        }, timeoutMs);
      }

      // Strip lone surrogates to prevent API 400 errors
      const safeContent = content.replace(LONE_SURROGATE_RE, '');

      const message = {
        type: 'user',
        message: {
          role: 'user',
          content: safeContent,
        },
      };

      const jsonLine = JSON.stringify(message) + '\n';
      persistentLogger.info(`[PersistentCLI] Sending message (${content.length} chars)`);

      if (!this.process?.stdin?.writable) {
        this.handleError(new Error('Process stdin not writable'));
        return;
      }

      this.process.stdin.write(jsonLine, (err) => {
        if (err) {
          this.handleError(err);
        }
      });
    });
  }

  /**
   * Send a tool result back to Claude
   */
  async sendToolResult(
    toolUseId: string,
    result: string,
    isError: boolean = false,
    callbacks?: PromptCallbacks
  ): Promise<PromptResult> {
    return this.sendToolResults(
      [{ tool_use_id: toolUseId, content: result, is_error: isError }],
      callbacks
    );
  }

  /**
   * Send multiple tool results back to Claude in a single message.
   * Required when Claude requests multiple tools in one turn.
   */
  async sendToolResults(
    results: Array<{ tool_use_id: string; content: string; is_error: boolean }>,
    callbacks?: PromptCallbacks
  ): Promise<PromptResult> {
    if (this.state === 'dead') {
      throw new Error('Cannot send tool result: process is dead');
    }

    if (this.state !== 'idle') {
      throw new Error(`Cannot send tool result in state: ${this.state}`);
    }

    this.state = 'busy';
    this.awaitingToolResults = false;
    this.pendingToolUseStartedAt = null;
    this.currentCallbacks = callbacks || null;
    this.toolUseBlocks = [];
    this.promptToolExchanges.clear();
    this.completedToolExchanges = [];
    this.accumulatedText = '';
    // A live child keeps running, but this turn's own events are the parent's again.
    this.parentTurnEnded = false;

    return new Promise((resolve, reject) => {
      this.currentResolve = resolve;
      this.currentReject = reject;

      // Set request timeout (0 = unlimited, skip timeout entirely)
      const timeoutMs = this._getRequestTimeoutMs();
      if (timeoutMs > 0) {
        this.requestTimeoutHandle = setTimeout(() => {
          this.handleTimeout();
        }, timeoutMs);
      }

      // Strip lone surrogates from tool results to prevent API 400 errors
      const message = {
        type: 'user',
        message: {
          role: 'user',
          content: results.map((r) => ({
            type: 'tool_result',
            tool_use_id: r.tool_use_id,
            content: r.content.replace(LONE_SURROGATE_RE, ''),
            is_error: r.is_error,
          })),
        },
      };

      const jsonLine = JSON.stringify(message) + '\n';
      persistentLogger.info(
        `[PersistentCLI] Sending ${results.length} tool_result(s): ${results.map((r) => r.tool_use_id).join(', ')}`
      );

      if (!this.process?.stdin?.writable) {
        this.handleError(new Error('Process stdin not writable'));
        return;
      }

      this.process.stdin.write(jsonLine, (err) => {
        if (err) {
          this.handleError(err);
        }
      });
    });
  }

  /**
   * Handle stdout data
   */
  private handleStdout(chunk: Buffer): void {
    this.outputBuffer += chunk.toString();

    // Process complete lines
    const lines = this.outputBuffer.split('\n');
    this.outputBuffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line) as StreamMessage;
        this.processEvent(event);
      } catch {
        console.warn(`[PersistentCLI] Failed to parse JSON: ${line.substring(0, 100)}...`);
      }
    }

    // Try to parse buffer as complete JSON (handles case where line doesn't end with newline)
    // This is needed because Claude CLI may not flush a trailing newline when waiting for stdin
    if (this.outputBuffer.trim()) {
      try {
        const event = JSON.parse(this.outputBuffer) as StreamMessage;
        this.processEvent(event);
        this.outputBuffer = ''; // Clear buffer after successful parse
      } catch {
        // Not complete JSON yet, wait for more data
      }
    }
  }

  /**
   * Process a parsed event from stdout
   */
  private processEvent(event: StreamMessage): void {
    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') {
          // A notification followed by `init` with no stdin request behind it is the CLI
          // opening its OWN turn for the finished child. It must be surfaced BEFORE its
          // assistant text arrives, so the host can bind it to a run.
          if (this.pendingNotification && this.currentResolve === null) {
            this.beginAutonomousTurn();
          }
          persistentLogger.info(`[PersistentCLI] Received init event`);
          // Init event received (logged for debugging)
          this.emit('init', event);
        } else if (event.subtype === 'hook_response') {
          // Hook responses - could extract context if needed
          persistentLogger.info(`[PersistentCLI] Hook response received`);
        } else if (event.subtype === 'task_started') {
          this.recordBackgroundTaskStarted(event);
        } else if (event.subtype === 'task_notification') {
          this.recordBackgroundTaskNotification(event);
        }
        break;

      case 'assistant':
        if (this.autonomousTurn) {
          // The CLI's own follow-up turn: its text is that turn's answer, never this
          // process's next stdin result, and its tool calls are not parent tool uses.
          for (const block of event.message?.content ?? []) {
            if (block.type === 'text') {
              this.autonomousTurn.text += block.text || '';
            } else if (block.type === 'tool_use') {
              persistentLogger.info(
                `[PersistentCLI] autonomous turn tool use: ${block.name ?? 'unknown'}`
              );
            }
          }
          break;
        }
        {
          const child = this.childAgentFor(event);
          if (child) {
            this.absorbChildAssistant(child, event);
            break;
          }
        }
        // Process assistant message content
        if (event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'text') {
              this.accumulatedText += block.text || '';
              this.currentCallbacks?.onDelta?.(block.text || '');
            } else if (block.type === 'tool_use') {
              const toolName = block.name ?? 'unknown';
              const toolUse: ToolUseBlock = {
                type: 'tool_use',
                id: block.id || `tool_${randomUUID()}`,
                name: toolName,
                input: block.input || {},
              };
              if (!this.recordToolUse(toolUse)) {
                return;
              }
            }
          }
        }
        break;

      case 'user':
        if (this.autonomousTurn) {
          break;
        }
        {
          const child = this.childAgentFor(event);
          if (child) {
            for (const block of event.message?.content ?? []) {
              if (block.type === 'tool_result' && block.tool_use_id) {
                this.currentCallbacks?.onToolComplete?.(
                  'subagent',
                  block.tool_use_id,
                  block.is_error === true
                );
              }
            }
            break;
          }
        }
        if (event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'tool_result' && !this.recordToolResult(block)) {
              return;
            }
          }
        }
        break;

      case 'result':
        // A CLI-initiated turn's result belongs to THAT turn. It must never resolve a
        // stdin request (its own, or a later one) and must not clear its timeout.
        if (this.autonomousTurn) {
          this.finishAutonomousTurn(event);
          break;
        }
        // Request complete
        this.clearRequestTimeout();

        if (event.subtype === 'success') {
          const unresolvedToolUses = [...this.toolUseBlocks];
          const completedToolExchanges = [...this.completedToolExchanges];
          const terminalError = completedCodeActTerminalError(completedToolExchanges);
          const hasToolUse = unresolvedToolUses.length > 0;
          const result: PromptResult = {
            response: event.result || this.accumulatedText,
            session_id: event.session_id || this.options.sessionId,
            cost_usd: event.total_cost_usd,
            duration_ms: event.duration_ms,
            usage: {
              input_tokens: event.usage?.input_tokens || 0,
              output_tokens: event.usage?.output_tokens || 0,
              cache_creation_input_tokens: event.usage?.cache_creation_input_tokens,
              cache_read_input_tokens: event.usage?.cache_read_input_tokens,
            },
            toolUseBlocks: hasToolUse ? unresolvedToolUses : undefined,
            hasToolUse,
            completedToolExchanges,
            ...(terminalError ? { terminalError } : {}),
          };

          // Record token usage
          if (this.onTokenUsage) {
            try {
              this.onTokenUsage({
                channel_key: this.options.channelKey || 'cli',
                agent_id: this.options.agentId || undefined,
                input_tokens: event.usage?.input_tokens || 0,
                output_tokens: event.usage?.output_tokens || 0,
                cache_read_tokens: event.usage?.cache_read_input_tokens || 0,
                cost_usd: event.total_cost_usd || undefined,
              });
            } catch {
              /* ignore recording errors */
            }
          }

          persistentLogger.info(
            `[PersistentCLI] Request complete (${event.duration_ms}ms, ${unresolvedToolUses.length} unresolved tools, ${completedToolExchanges.length} completed tools)`
          );
          if (terminalError) {
            this.currentCallbacks?.onError?.(
              new HostToolTerminalError(terminalError.code, terminalError.message)
            );
          } else {
            this.currentCallbacks?.onFinal?.({
              content: result.response,
              toolUseBlocks: unresolvedToolUses,
            });
          }
          this.state = 'idle';
          this.awaitingToolResults = hasToolUse;
          this.pendingToolUseStartedAt = hasToolUse ? Date.now() : null;
          // The parent turn is over but a background child is still running: from here on
          // the stream is the child's until the next stdin request.
          this.parentTurnEnded = this.hasLiveBackgroundAgents();
          this.currentResolve?.(result);
          this.resetRequestState();
          this.emit('idle'); // F7: Trigger message queue drain (after resolve/cleanup)
        } else if (event.is_error) {
          const error = this.promptTerminalError(new Error(event.error || 'Unknown error'));
          this.currentCallbacks?.onError?.(error);
          this.state = 'idle';
          this.awaitingToolResults = false;
          this.pendingToolUseStartedAt = null;
          this.currentReject?.(error);
          this.resetRequestState();
          this.emit('idle'); // F7: Trigger message queue drain (after reject/cleanup)
        }
        break;

      case 'error': {
        this.clearRequestTimeout();
        const error = this.promptTerminalError(new Error(event.error || 'Unknown error'));
        this.currentCallbacks?.onError?.(error);
        this.state = 'idle';
        this.awaitingToolResults = false;
        this.pendingToolUseStartedAt = null;
        this.currentReject?.(error);
        this.resetRequestState();
        this.emit('idle'); // F7: Trigger message queue drain (after reject/cleanup)
        break;
      }
    }
  }

  private recordToolUse(toolUse: ToolUseBlock): boolean {
    const fingerprint = stableJson({ name: toolUse.name, input: toolUse.input });
    const current = this.promptToolExchanges.get(toolUse.id);
    if (current) {
      if (current.toolResult) {
        this.failToolStreamProtocol(`Completed tool id was reused: ${toolUse.id}`);
        return false;
      }
      if (current.toolUseFingerprint !== fingerprint) {
        this.failToolStreamProtocol(`Conflicting tool_use payload for id: ${toolUse.id}`);
        return false;
      }
      return true;
    }

    this.promptToolExchanges.set(toolUse.id, {
      toolUse,
      toolUseFingerprint: fingerprint,
    });
    this.toolUseBlocks.push(toolUse);
    // Callback-only metadata pairs overlapping native calls by provider identity;
    // preserve the original tool input and exchange fingerprint unchanged.
    this.currentCallbacks?.onToolUse?.(toolUse.name, {
      ...toolUse.input,
      nativeToolUseId: toolUse.id,
    });
    persistentLogger.info(`[PersistentCLI] Tool use: ${toolUse.name}`);
    if (toolUse.name === BACKGROUND_AGENT_TOOL && toolUse.input?.run_in_background === true) {
      this.trackBackgroundAgent(toolUse);
    }
    return true;
  }

  // ─── Native background Agent observation ───────────────────────────────
  //
  // The CLI gives one stream. A `run_in_background: true` Agent tool_use, the
  // "Async agent launched" tool_result that names the child, `system/task_*` events, the
  // child's own tool calls, its final text, `task_notification`, and - measured - a whole
  // turn the CLI opens by itself all arrive on it. These helpers separate those without
  // inventing anything the stream does not say.

  private trackBackgroundAgent(toolUse: ToolUseBlock): void {
    const description = toolUse.input?.description;
    const state: BackgroundAgentState = {
      itemId: toolUse.id,
      agentPath: typeof description === 'string' && description.trim() ? description : toolUse.id,
      agentId: null,
      taskId: null,
      spawnObserved: false,
      startFired: false,
      notificationSeen: false,
      completed: false,
      finalText: '',
      onSubagentStart: this.currentCallbacks?.onSubagentStart,
    };
    this.backgroundAgents.set(toolUse.id, state);
    this.pruneBackgroundAgents();
  }

  private pruneBackgroundAgents(): void {
    if (this.backgroundAgents.size <= MAX_TRACKED_BACKGROUND_AGENTS) return;
    for (const [id, state] of this.backgroundAgents) {
      if (this.backgroundAgents.size <= MAX_TRACKED_BACKGROUND_AGENTS) break;
      if (state.completed) this.backgroundAgents.delete(id);
    }
  }

  /** The newest tracked agent matching a predicate; `system` task events carry no item id. */
  private latestBackgroundAgent(
    match: (state: BackgroundAgentState) => boolean
  ): BackgroundAgentState | null {
    let found: BackgroundAgentState | null = null;
    for (const state of this.backgroundAgents.values()) {
      if (match(state)) found = state;
    }
    return found;
  }

  private taskIdentityOf(event: StreamMessage): string | null {
    return (
      event.task_id ?? event.taskId ?? event.task?.id ?? event.agent_id ?? event.agentId ?? null
    );
  }

  private recordBackgroundTaskStarted(event: StreamMessage): void {
    const state = this.latestBackgroundAgent((candidate) => !candidate.spawnObserved);
    if (!state) {
      console.warn('[PersistentCLI] task_started with no tracked background Agent tool_use');
      return;
    }
    state.spawnObserved = true;
    state.taskId = this.taskIdentityOf(event) ?? state.taskId;
    // The spawn is not reported here: `task_started` precedes the launch tool_result, and
    // that result is what names the child. The task id stays as the fallback identity.
  }

  /** Lift the child's id out of the "Async agent launched" tool_result text. */
  private recordBackgroundLaunchResult(state: BackgroundAgentState, content: string): void {
    const match = /agentId["'\s:=]+([A-Za-z0-9_-]{4,})/.exec(content);
    if (match) {
      state.agentId = match[1];
    } else if (!state.taskId) {
      console.warn(
        `[PersistentCLI] background Agent launch result carried no agentId (item=${state.itemId})`
      );
    }
    this.fireSubagentStart(state);
  }

  private fireSubagentStart(state: BackgroundAgentState): void {
    if (state.startFired) return;
    const agentThreadId = state.agentId ?? state.taskId;
    if (!agentThreadId) return;
    state.startFired = true;
    try {
      state.onSubagentStart?.({
        agentThreadId,
        agentPath: state.agentPath,
        itemId: state.itemId,
      });
    } catch (error) {
      console.error(
        `[PersistentCLI] onSubagentStart callback failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    const emitted: ClaudeSubagentStreamEvent = {
      kind: 'started',
      agentThreadId,
      agentPath: state.agentPath,
      itemId: state.itemId,
      wakeRequired: false,
    };
    this.emit('subagent', emitted);
  }

  /**
   * Which background child an assistant/user event belongs to, or null for the parent.
   *
   * `parent_tool_use_id` is authoritative when the CLI stamps it. Without it the only
   * honest signal is position: the parent turn already ended and exactly one child is
   * live. Two live children and no stamp is ambiguous, so the event stays with the parent
   * and says so rather than being silently attributed.
   */
  private childAgentFor(event: StreamMessage): BackgroundAgentState | null {
    const stamped = event.parent_tool_use_id;
    if (typeof stamped === 'string' && stamped) {
      return this.backgroundAgents.get(stamped) ?? null;
    }
    if (!this.parentTurnEnded) return null;
    const live = [...this.backgroundAgents.values()].filter((state) => !state.completed);
    if (live.length === 1) return live[0];
    if (live.length > 1) {
      console.warn(
        `[PersistentCLI] ${live.length} live background agents and no parent_tool_use_id; ` +
          'event left with the parent'
      );
    }
    return null;
  }

  private absorbChildAssistant(child: BackgroundAgentState, event: StreamMessage): void {
    for (const block of event.message?.content ?? []) {
      if (block.type === 'text') {
        // Only the child's LAST answer matters to the wake, but the stream does not mark
        // it, so text accumulates bounded, like the Codex child's final_answer buffer.
        child.finalText = (child.finalText + (block.text || '')).slice(
          0,
          MAX_SUBAGENT_FINAL_TEXT_CHARS
        );
      } else if (block.type === 'tool_use') {
        // Observed, never counted as a parent tool use awaiting a host result. The call
        // itself already reached the MCP server under the parent's context key.
        this.currentCallbacks?.onToolUse?.(block.name ?? 'unknown', {
          ...(block.input ?? {}),
          nativeToolUseId: block.id,
          subagentItemId: child.itemId,
        });
      }
    }
  }

  private recordBackgroundTaskNotification(event: StreamMessage): void {
    const identity = this.taskIdentityOf(event);
    const state =
      (identity
        ? this.latestBackgroundAgent(
            (candidate) => candidate.agentId === identity || candidate.taskId === identity
          )
        : null) ?? this.latestBackgroundAgent((candidate) => !candidate.completed);
    if (!state) {
      console.warn('[PersistentCLI] task_notification with no tracked background Agent');
      return;
    }
    if (state.notificationSeen) return;
    state.notificationSeen = true;
    // The CLI may answer the notification itself. Give it that window; if it does not, the
    // host takes the wake so a finished child is never dropped.
    const timer = setTimeout(() => {
      this.pendingNotification = null;
      this.completeBackgroundAgent(state, true);
    }, AUTONOMOUS_TURN_GRACE_MS);
    timer.unref?.();
    this.pendingNotification = { itemId: state.itemId, timer };
  }

  private beginAutonomousTurn(): void {
    const pending = this.pendingNotification;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingNotification = null;
    const state = this.backgroundAgents.get(pending.itemId);
    if (!state) return;
    this.autonomousTurn = { state, text: '' };
    const event: ClaudeAutonomousTurnEvent = {
      agentThreadId: state.agentId ?? state.taskId ?? state.itemId,
      agentPath: state.agentPath,
      itemId: state.itemId,
    };
    persistentLogger.info(
      `[PersistentCLI] autonomous turn opened for finished child ${event.agentThreadId}`
    );
    this.emit('autonomousTurn', event);
  }

  private finishAutonomousTurn(event: StreamMessage): void {
    const active = this.autonomousTurn;
    if (!active) return;
    this.autonomousTurn = null;
    const state = active.state;
    const resultEvent: ClaudeAutonomousTurnResultEvent = {
      agentThreadId: state.agentId ?? state.taskId ?? state.itemId,
      agentPath: state.agentPath,
      itemId: state.itemId,
      text: event.result || active.text,
      isError: event.is_error === true || event.subtype !== 'success',
    };
    // The CLI's own turn IS the owner reacting, so the host must not wake it again.
    this.completeBackgroundAgent(state, false);
    this.emit('autonomousTurnResult', resultEvent);
  }

  private completeBackgroundAgent(
    state: BackgroundAgentState,
    wakeRequired: boolean,
    status: 'completed' | 'unknown' = 'completed'
  ): void {
    if (state.completed) return;
    state.completed = true;
    const emitted: ClaudeSubagentStreamEvent = {
      kind: 'completed',
      agentThreadId: state.agentId ?? state.taskId ?? state.itemId,
      agentPath: state.agentPath,
      itemId: state.itemId,
      // The stream reports a notification, not an exit code; a child cut off by a dead CLI
      // is `unknown`, never success.
      status,
      finalText: state.finalText,
      wakeRequired,
    };
    if (!this.hasLiveBackgroundAgents()) {
      this.parentTurnEnded = false;
    }
    this.emit('subagent', emitted);
  }

  /** Whether a spawned background child has not been reported finished yet. */
  hasLiveBackgroundAgents(): boolean {
    for (const state of this.backgroundAgents.values()) {
      if (!state.completed) return true;
    }
    return false;
  }

  private recordToolResult(block: ContentBlock): boolean {
    const toolUseId = block.tool_use_id;
    if (!toolUseId) {
      this.failToolStreamProtocol('tool_result is missing tool_use_id');
      return false;
    }
    const current = this.promptToolExchanges.get(toolUseId);
    if (!current) {
      this.failToolStreamProtocol(`tool_result arrived before tool_use: ${toolUseId}`);
      return false;
    }
    const toolResult: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: normalizeStreamToolResultContent(block.content),
      is_error: block.is_error === true,
    };
    const fingerprint = stableJson({
      content: toolResult.content,
      is_error: toolResult.is_error,
    });
    if (current.toolResult) {
      if (current.toolResultFingerprint !== fingerprint) {
        this.failToolStreamProtocol(`Conflicting tool_result payload for id: ${toolUseId}`);
        return false;
      }
      return true;
    }

    current.toolResult = toolResult;
    current.toolResultFingerprint = fingerprint;
    this.toolUseBlocks = this.toolUseBlocks.filter((toolUse) => toolUse.id !== toolUseId);
    this.completedToolExchanges.push({ toolUse: current.toolUse, toolResult });
    this.currentCallbacks?.onToolComplete?.(
      current.toolUse.name,
      toolUseId,
      toolResult.is_error === true
    );
    const backgroundAgent = this.backgroundAgents.get(toolUseId);
    if (backgroundAgent) {
      // "Async agent launched successfully…" - the one event that reliably names the child.
      this.recordBackgroundLaunchResult(backgroundAgent, toolResult.content);
    }
    return true;
  }

  private failToolStreamProtocol(message: string): void {
    const error = this.promptTerminalError(new ClaudeToolStreamProtocolError(message));
    this.currentCallbacks?.onError?.(error);
    this.handleError(error);
  }

  private promptTerminalError(error: Error): Error {
    if (
      error instanceof McpCompletedMutationInterruptedError ||
      error instanceof HostToolTerminalError
    ) {
      return error;
    }
    const terminalError = completedCodeActTerminalError(this.completedToolExchanges);
    if (terminalError) {
      return new HostToolTerminalError(terminalError.code, terminalError.message, [
        ...this.completedToolExchanges,
      ]);
    }
    if (completedCodeActMutationWasObserved(this.completedToolExchanges)) {
      return new McpCompletedMutationInterruptedError([...this.completedToolExchanges]);
    }
    if (error instanceof McpResultMissingError) {
      return error;
    }
    const unresolvedMcpToolUseIds = this.toolUseBlocks
      .filter((toolUse) => toolUse.name === 'mcp__code-act__code_act')
      .map((toolUse) => toolUse.id);
    return unresolvedMcpToolUseIds.length > 0
      ? new McpResultMissingError(unresolvedMcpToolUseIds)
      : error;
  }

  /**
   * Handle stderr data
   */
  private handleStderr(chunk: Buffer): void {
    const text = chunk.toString().trim();
    if (text) {
      console.error(`[PersistentCLI:stderr] ${text}`);
    }
  }

  /**
   * Handle process close
   */
  private handleClose(code: number | null): void {
    persistentLogger.info(`[PersistentCLI] Process closed with code ${code}`);
    this.state = 'dead';
    this.process = null;
    this.awaitingToolResults = false;
    this.pendingToolUseStartedAt = null;
    // A child cannot outlive the CLI that ran it. Report the ones still open as unknown
    // rather than leaving the host waiting for a notification that can never arrive.
    if (this.pendingNotification) {
      clearTimeout(this.pendingNotification.timer);
      this.pendingNotification = null;
    }
    this.autonomousTurn = null;
    for (const state of [...this.backgroundAgents.values()]) {
      if (!state.completed) {
        this.completeBackgroundAgent(state, true, 'unknown');
      }
    }

    // Reject any pending request
    if (this.currentReject) {
      this.currentReject(this.promptTerminalError(new Error(`Process exited with code ${code}`)));
      this.resetRequestState();
    }

    this.emit('close', code);
  }

  /**
   * Handle process error
   */
  private handleError(error: Error): void {
    const terminalError = this.promptTerminalError(error);
    console.error(`[PersistentCLI] Process error:`, terminalError.message);

    if (this.currentReject) {
      this.currentReject(terminalError);
      this.resetRequestState();
    }

    // Transition to idle so subsequent requests aren't blocked
    if (this.state === 'busy') {
      this.state = 'idle';
      this.awaitingToolResults = false;
      this.pendingToolUseStartedAt = null;
      this.emit('idle');
    }

    this.emit('error', terminalError);
  }

  /**
   * Handle request timeout
   */
  private handleTimeout(): void {
    console.error(`[PersistentCLI] Request timeout — killing process to prevent zombie`);

    if (this.currentReject) {
      this.currentReject(this.promptTerminalError(new Error('Request timeout')));
      this.resetRequestState();
    }

    // ⚠️ Timed-out processes MUST be killed.
    // Setting state to 'idle' without killing leaves zombie processes consuming memory.
    // When SessionPool creates new sessions without cleaning up old processes,
    // Claude processes accumulate and exhaust system memory.
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
      // If SIGTERM doesn't work, force kill after 3 seconds
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 3000);
    }
    this.state = 'dead';
    this.awaitingToolResults = false;
    this.pendingToolUseStartedAt = null;
    this.emit('idle'); // F7: Trigger message queue drain (after cleanup)
  }

  /**
   * Clear request timeout
   */
  private clearRequestTimeout(): void {
    if (this.requestTimeoutHandle) {
      clearTimeout(this.requestTimeoutHandle);
      this.requestTimeoutHandle = null;
    }
  }

  /**
   * Reset request state
   */
  private resetRequestState(): void {
    this.clearRequestTimeout();
    this.currentCallbacks = null;
    this.currentResolve = null;
    this.currentReject = null;
    this.toolUseBlocks = [];
    this.promptToolExchanges.clear();
    this.completedToolExchanges = [];
    this.accumulatedText = '';
  }

  /**
   * Stop the process
   */
  stop(): void {
    persistentLogger.info(`[PersistentCLI] Stopping process`);

    // Reject any pending request BEFORE resetting state
    // This ensures promises are resolved even if process is already dead
    if (this.currentReject) {
      this.currentReject(this.promptTerminalError(new Error('Process stopped by user')));
    }

    if (this.process) {
      const child = this.process;
      let exited = false;
      const markExited = () => {
        exited = true;
      };
      if (typeof child.once === 'function') {
        child.once('exit', markExited);
        child.once('close', markExited);
      }
      this.clearRequestTimeout();
      child.stdin?.end();
      child.kill('SIGTERM');
      const forceKillTimer = setTimeout(() => {
        if (!exited) {
          child.kill('SIGKILL');
        }
      }, 3000);
      forceKillTimer.unref();
      this.process = null;
    }

    this.state = 'dead';
    this.awaitingToolResults = false;
    this.pendingToolUseStartedAt = null;
    this.resetRequestState();
  }

  /**
   * Check if process is alive
   */
  isAlive(): boolean {
    return this.state !== 'dead';
  }

  /**
   * Check if process is ready for new messages
   */
  isReady(): boolean {
    return this.state === 'idle';
  }

  /**
   * True while Claude has requested tools and the host has not sent tool_result yet.
   * The process is technically idle during host-side tool execution, but it must not
   * be reclaimed because the next prompt depends on this live Claude context.
   */
  hasPendingToolUse(): boolean {
    return this.awaitingToolResults;
  }

  getPendingToolUseStartedAt(): number | null {
    return this.pendingToolUseStartedAt;
  }

  /**
   * Get current state
   */
  getState(): ProcessState {
    return this.state;
  }

  /**
   * Get session ID
   */
  getSessionId(): string {
    return this.options.sessionId;
  }

  /** Process-generation key inherited by the Code-Act MCP child, never a routing/session ID. */
  getRunContextKey(): string | null {
    return this.runContextKey;
  }
}

export function formatClaudeArgsForLog(args: readonly string[]): string[] {
  return formatCliArgsForLog(args);
}

/**
 * PersistentProcessPool - Manages multiple persistent Claude processes
 *
 * Features:
 * - One process per channel/session
 * - Automatic process lifecycle management
 * - Process reuse for multi-turn conversations
 */
export class PersistentProcessPool {
  private processes: Map<
    string,
    {
      process: PersistentClaudeProcess;
      lastUsedAt: number;
      pendingToolUseSince?: number;
      policyFingerprint?: string;
    }
  > = new Map();
  private defaultOptions: Partial<PersistentProcessOptions>;
  private idleTimeoutMs: number;
  private cleanupIntervalMs: number;
  private pendingToolUseTimeoutMs: number;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(defaultOptions: Partial<PersistentProcessOptions> = {}) {
    this.defaultOptions = defaultOptions;
    this.idleTimeoutMs = this.resolveIdleTimeoutMs(defaultOptions);
    this.cleanupIntervalMs = this.resolveCleanupIntervalMs(defaultOptions);
    this.pendingToolUseTimeoutMs = this.resolvePendingToolUseTimeoutMs(defaultOptions);
    this.startCleanupTimer();
  }

  private resolveIdleTimeoutMs(defaultOptions: Partial<PersistentProcessOptions>): number {
    if (defaultOptions.idleTimeoutMs !== undefined) {
      return Math.max(0, defaultOptions.idleTimeoutMs);
    }
    try {
      return Math.max(
        0,
        (getConfig().timeouts?.persistent_process_idle_ms as number | undefined) ??
          getConfig().timeouts?.session_ms ??
          1_800_000
      );
    } catch {
      return 1_800_000;
    }
  }

  private resolveCleanupIntervalMs(defaultOptions: Partial<PersistentProcessOptions>): number {
    if (defaultOptions.cleanupIntervalMs !== undefined) {
      return Math.max(0, defaultOptions.cleanupIntervalMs);
    }
    try {
      return Math.max(
        0,
        (getConfig().timeouts?.persistent_process_cleanup_ms as number | undefined) ??
          getConfig().timeouts?.session_cleanup_ms ??
          300_000
      );
    } catch {
      return 300_000;
    }
  }

  private resolvePendingToolUseTimeoutMs(
    defaultOptions: Partial<PersistentProcessOptions>
  ): number {
    if (defaultOptions.pendingToolUseTimeoutMs !== undefined) {
      return Math.max(0, defaultOptions.pendingToolUseTimeoutMs);
    }
    try {
      return Math.max(
        0,
        (getConfig().timeouts?.persistent_process_pending_tool_ms as number | undefined) ??
          Math.max(this.idleTimeoutMs * 4, 1_800_000)
      );
    } catch {
      return Math.max(this.idleTimeoutMs * 4, 1_800_000);
    }
  }

  private startCleanupTimer(): void {
    if (this.cleanupTimer || this.cleanupIntervalMs === 0) {
      return;
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanupIdleProcesses();
    }, this.cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  /**
   * Get or create a process for a channel
   */
  async getProcess(
    channelKey: string,
    options?: Partial<PersistentProcessOptions>
  ): Promise<PersistentClaudeProcess> {
    return (await this.getProcessWithStatus(channelKey, options)).process;
  }

  /**
   * Get or create a process for a channel and report whether this call created it.
   */
  async getProcessWithStatus(
    channelKey: string,
    options?: Partial<PersistentProcessOptions>
  ): Promise<PersistentProcessAcquireResult> {
    this.startCleanupTimer();
    const now = Date.now();
    const entry = this.processes.get(channelKey);
    let process = entry?.process;
    let created = false;

    if (!process || !process.isAlive()) {
      // Create new process
      const mergedOptions: PersistentProcessOptions = {
        sessionId: randomUUID(),
        ...this.defaultOptions,
        ...options,
      };

      poolLogger.info(`Creating new process for channel: ${channelKey}`);
      const createdProcess = new PersistentClaudeProcess(mergedOptions);
      process = createdProcess;

      // Handle process errors - prevent unhandled 'error' event crash
      const removeIfCurrent = () => {
        const current = this.processes.get(channelKey);
        if (current?.process === createdProcess) {
          this.processes.delete(channelKey);
        }
      };

      const touchIfCurrent = () => {
        const current = this.processes.get(channelKey);
        if (!current || current.process !== createdProcess) {
          return;
        }
        current.lastUsedAt = Date.now();
        if (createdProcess.hasPendingToolUse()) {
          current.pendingToolUseSince =
            createdProcess.getPendingToolUseStartedAt() ?? current.lastUsedAt;
        } else {
          current.pendingToolUseSince = undefined;
        }
      };

      createdProcess.on('error', (err) => {
        poolLogger.error(`Process error for ${channelKey}:`, err);
        // An errored generation is no longer reusable. Stop it before dropping
        // the pool reference so it cannot survive as an untracked child.
        createdProcess.stop();
        removeIfCurrent();
      });

      // Handle process death - remove from pool
      createdProcess.on('close', () => {
        poolLogger.info(`Process for ${channelKey} closed, removing from pool`);
        removeIfCurrent();
      });
      createdProcess.on('idle', touchIfCurrent);

      this.processes.set(channelKey, {
        process: createdProcess,
        lastUsedAt: now,
        policyFingerprint: mergedOptions.policyFingerprint,
      });
      await createdProcess.start();
      created = true;
    } else if (entry) {
      entry.lastUsedAt = now;
    }

    return { process, created };
  }

  /**
   * Stop idle ready processes that have outlived the configured idle timeout.
   */
  cleanupIdleProcesses(now: number = Date.now()): number {
    let cleaned = 0;

    for (const [key, entry] of this.processes) {
      const process = entry.process;
      if (!process.isAlive()) {
        this.processes.delete(key);
        cleaned++;
        continue;
      }

      if (process.hasPendingToolUse()) {
        entry.pendingToolUseSince =
          process.getPendingToolUseStartedAt() ?? entry.pendingToolUseSince ?? now;
        if (
          this.pendingToolUseTimeoutMs === 0 ||
          now - entry.pendingToolUseSince <= this.pendingToolUseTimeoutMs
        ) {
          continue;
        }

        poolLogger.warn(`Stopping process with expired pending tool result wait for: ${key}`);
        process.stop();
        this.processes.delete(key);
        cleaned++;
        continue;
      }
      entry.pendingToolUseSince = undefined;

      if (
        this.idleTimeoutMs > 0 &&
        process.isReady() &&
        now - entry.lastUsedAt > this.idleTimeoutMs
      ) {
        poolLogger.info(`Stopping idle process for: ${key}`);
        process.stop();
        this.processes.delete(key);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Stop a specific process
   */
  stopProcess(channelKey: string): void {
    const entry = this.processes.get(channelKey);
    if (entry) {
      entry.process.stop();
      this.processes.delete(channelKey);
    }
  }

  getSessionPolicyStatus(
    channelKey: string,
    policyFingerprint: string | undefined
  ): SessionPolicyStatus {
    const entry = this.processes.get(channelKey);
    if (!entry?.process.isAlive()) {
      return 'missing';
    }
    return entry.policyFingerprint === policyFingerprint ? 'compatible' : 'mismatch';
  }

  /**
   * Stop the exact process generation acquired by the caller. Only remove the pool entry when it
   * still points at that generation, so stale cleanup cannot stop or evict a replacement. The
   * expected process may already be absent after its error listener ran; it still must be stopped
   * or the child would remain alive outside pool lifecycle management.
   */
  retireProcess(channelKey: string, expectedProcess: PersistentClaudeProcess): boolean {
    const entry = this.processes.get(channelKey);
    const removedCurrentGeneration = entry?.process === expectedProcess;
    if (removedCurrentGeneration) {
      this.processes.delete(channelKey);
    }
    expectedProcess.stop();
    return removedCurrentGeneration;
  }

  /**
   * Stop all processes
   */
  stopAll(): void {
    for (const [key, entry] of this.processes) {
      poolLogger.info(`Stopping process for: ${key}`);
      entry.process.stop();
    }
    this.processes.clear();
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Get number of active processes
   */
  getActiveCount(): number {
    return this.processes.size;
  }

  /**
   * Get all channel keys with active processes
   */
  getActiveChannels(): string[] {
    return Array.from(this.processes.keys());
  }

  /**
   * Get states of all active processes
   * @returns Map of channelKey → ProcessState
   */
  getProcessStates(): Map<string, string> {
    const states = new Map<string, string>();
    for (const [key, entry] of this.processes) {
      states.set(key, entry.process.getState());
    }
    return states;
  }
}
