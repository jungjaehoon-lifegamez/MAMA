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
import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { EventEmitter } from 'events';
import { type SessionPolicyStatus } from './types.js';
import {
  ClaudeToolStreamProtocolError,
  NativeInputUncertainError,
  type CompletedToolExchange,
  type PromptCallbacks,
  type PromptResult,
  type TokenUsageRecord,
  type ToolResultBlock,
  type ToolUseBlock,
} from './types.js';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';
import { claudeConfiguredSecrets, SecretRedactingStream } from './cli-secret-redaction.js';
import { formatCliArgsForLog } from './cli-arg-redaction.js';
import { claudeEffortArgs, type ThinkingEffort } from './claude-effort.js';

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

/**
 * Regex to strip lone Unicode surrogates that cause API 400 errors.
 * Matches high surrogates not followed by a low surrogate, and
 * low surrogates not preceded by a high surrogate.
 */
// eslint-disable-next-line no-control-regex
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export interface PersistentProcessOptions {
  sessionId: string;
  /**
   * Timeouts the product states. A driver does not read a config file: the
   * numbers arrive with the options, and the defaults below are what a caller
   * that states nothing gets.
   */
  /**
   * The isolated workspace this process runs in, and the empty plugin
   * directory that keeps the host's global plugins out of every turn. The
   * product states both; the driver only creates and uses them. The values
   * are a product decision recorded in its CLAUDE.md — a driver that invented
   * them would be deciding where another system keeps its files.
   */
  /**
   * Where this run keeps its files. Required: a driver does not know a product's
   * directory name, and the default it used to compute spelled one out.
   */
  workspaceDir: string;
  timeouts?: {
    requestMs?: number;
    idleMs?: number;
    sessionMs?: number;
    cleanupMs?: number;
    pendingToolMs?: number;
  };
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
  /** Noninteractive consumers use dontAsk with explicit permission rules. */
  permissionMode?: 'default' | 'acceptEdits' | 'dontAsk' | 'plan';
  useGatewayTools?: boolean;
  /**
   * How long a request may go without any output from the CLI, in ms (default: 120000; 0 = no
   * limit). Every event the CLI prints restarts it, so a request that keeps working is not cut.
   */
  requestTimeout?: number;
  /** The longest one request may run in all, in ms (absent or 0 = no limit). */
  requestMaxMs?: number;
  /** Idle timeout for pooled persistent processes in ms (default: session_ms) */
  idleTimeoutMs?: number;
  /** Cleanup interval for pooled persistent processes in ms (default: session_cleanup_ms) */
  cleanupIntervalMs?: number;
  /** Maximum time to keep a process waiting for host-side tool results (default: max(4 * idleTimeoutMs, 30m)) */
  pendingToolUseTimeoutMs?: number;
  /** Environment variables to pass to the Claude CLI process */
  env?: Record<string, string>;
  /** Complete inherited environment supplied by the consumer; env is applied afterward. */
  processEnv?: NodeJS.ProcessEnv;
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
  /** Thinking effort passed as --effort on models that accept it. */
  effort?: ThinkingEffort;
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
  uuid?: string;
  origin?: { kind: string };
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
    content: ContentBlock[] | string;
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
 * PARENT stream - the only stream the CLI gives us. This state tracks only identity and
 * the child's final text, so the host can wake the owner.
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
  onToolUse?: PromptCallbacks['onToolUse'];
  onToolComplete?: PromptCallbacks['onToolComplete'];
  nativeItems: Map<string, { name: string; completed: boolean }>;
  onSubagentStart?: PromptCallbacks['onSubagentStart'];
  /** The spawning turn's follow-up sink: the CLI's own later answer goes back to that request. */
  onFollowUp?: PromptCallbacks['onFollowUp'];
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
  /**
   * The most recent request that offered a follow-up sink. A CLI turn that no stdin request
   * and no tracked child explains (a grandchild's task notification, measured 2026-09-10)
   * still answers SOMEONE: the last request that asked.
   */
  private lastFollowUp: PromptCallbacks['onFollowUp'] | undefined;
  private currentResolve: ((result: PromptResult) => void) | null = null;
  private currentReject: ((error: Error) => void) | null = null;
  private currentInputUuid: string | null = null;
  private inputAcknowledged = false;
  private requestTimeoutHandle: NodeJS.Timeout | null = null;
  private requestMaxHandle: NodeJS.Timeout | null = null;
  private toolUseBlocks: ToolUseBlock[] = [];
  private readonly promptToolExchanges = new Map<string, PromptToolExchangeState>();
  private completedToolExchanges: CompletedToolExchange[] = [];
  private awaitingToolResults = false;
  private pendingToolUseStartedAt: number | null = null;
  private accumulatedText: string = '';
  private compactionCount = 0;
  private startPromise: Promise<void> | null = null;
  private onTokenUsage?: (record: TokenUsageRecord) => void;
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
    return Math.max(0, this.options.timeouts?.requestMs ?? 120_000);
  }

  constructor(options: PersistentProcessOptions) {
    super();
    this.options = options;
    this.onTokenUsage = options.onTokenUsage;

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
    const cleanEnv = { ...(this.options.processEnv ?? process.env) };
    const processOptionsEnv = { ...(this.options.env || {}) };
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
    //   cwd = the user's home → ~/CLAUDE.md gets injected (their personal config leaks
    //     into the agent)
    //   cwd = <host workspace> + git boundary → traversal stops here
    //
    // HOW: Create <host workspace>/.git/HEAD so Claude Code treats it as a git repo root.
    //   This prevents Claude Code from searching for CLAUDE.md above this directory.
    //
    // FILE ACCESS: cwd only restricts CLAUDE.md discovery. If --dangerously-skip-permissions
    //   is enabled, the agent can still access all files on the system.
    //
    // Pointing cwd back at the user's home, or removing the git boundary, will cause
    // ~/CLAUDE.md + global plugins to be re-injected every turn, wasting tokens.
    // (This driver does not know where that home is, and must not: the workspace is
    // the caller's to state.)
    // ============================================================
    const workspaceDir = this.options.workspaceDir;
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
    const stderrRedactor = new SecretRedactingStream(
      claudeConfiguredSecrets(this.options.mcpConfigPath, {
        ...(this.options.processEnv ?? process.env),
        ...this.options.env,
      }),
      (safe) => {
        if (safe.trim()) console.error(`[PersistentCLI:stderr] ${safe.trim()}`);
      }
    );
    this.process = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // ⚠️ NEVER spawn in the user's home directory — it breaks agent isolation.
      cwd: workspaceDir,
      env: {
        ...cleanEnv,
        ...processOptionsEnv,
      },
    });

    // Set up event handlers
    this.process.stdout?.on('data', (chunk) => this.handleStdout(chunk));
    this.process.stderr?.on('data', (chunk) => stderrRedactor.write(chunk));
    this.process.stderr?.on('end', () => stderrRedactor.end());
    this.process.on('close', (code) => {
      stderrRedactor.end();
      this.handleClose(code);
    });
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
      '--replay-user-messages',
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

    args.push(...claudeEffortArgs(this.options.model, this.options.effort));

    if (this.options.permissionMode) {
      args.push('--permission-mode', this.options.permissionMode);
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
    const pluginDir = this.options.pluginDir ?? join(this.options.workspaceDir, '.empty-plugins');
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
  async sendMessage(
    content: string,
    callbacks?: PromptCallbacks,
    nativeInputId?: string
  ): Promise<PromptResult> {
    if (
      nativeInputId !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeInputId)
    ) {
      throw new Error('Native input ID must be a UUID');
    }
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
    this.currentInputUuid = nativeInputId ?? randomUUID();
    this.inputAcknowledged = false;
    this.toolUseBlocks = [];
    this.promptToolExchanges.clear();
    this.completedToolExchanges = [];
    this.accumulatedText = '';
    this.compactionCount = 0;
    // A live child keeps running, but this turn's own events are the parent's again.
    this.parentTurnEnded = false;

    return new Promise((resolve, reject) => {
      this.currentResolve = resolve;
      this.currentReject = reject;

      this.armRequestTimeouts();

      // Strip lone surrogates to prevent API 400 errors
      const safeContent = content.replace(LONE_SURROGATE_RE, '');

      const message = {
        type: 'user',
        uuid: this.currentInputUuid,
        session_id: this.options.sessionId,
        parent_tool_use_id: null,
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

      try {
        callbacks?.onInputDispatch?.({
          backend: 'claude',
          sessionId: this.options.sessionId,
          inputId: this.currentInputUuid!,
        });
      } catch (error) {
        this.handleError(error instanceof Error ? error : new Error(String(error)));
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
    this.compactionCount = 0;
    // A live child keeps running, but this turn's own events are the parent's again.
    this.parentTurnEnded = false;

    return new Promise((resolve, reject) => {
      this.currentResolve = resolve;
      this.currentReject = reject;

      this.armRequestTimeouts();

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
    // Output is progress: a request that keeps printing keeps running.
    this.refreshRequestIdleTimeout();
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
        } else if (event.subtype === 'compact_boundary' && this.currentResolve) {
          this.compactionCount += 1;
        }
        break;

      case 'assistant':
        if (this.autonomousTurn) {
          // The CLI's own follow-up turn: its text is that turn's answer, never this
          // process's next stdin result, and its tool calls are not parent tool uses.
          for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
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
        if (Array.isArray(event.message?.content)) {
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
        if (
          this.currentInputUuid !== null &&
          event.uuid === this.currentInputUuid &&
          event.session_id === this.options.sessionId &&
          !event.parent_tool_use_id &&
          event.message?.role === 'user' &&
          (!event.origin || event.origin.kind === 'human')
        ) {
          if (!this.inputAcknowledged) {
            this.inputAcknowledged = true;
            const receipt = {
              backend: 'claude' as const,
              sessionId: event.session_id,
              inputId: this.currentInputUuid,
            };
            try {
              this.currentCallbacks?.onAccepted?.(receipt);
            } catch (error) {
              this.handleError(
                new NativeInputUncertainError(
                  'Native receipt observer failed after acceptance',
                  receipt,
                  error
                )
              );
              this.stop();
            }
          }
          break;
        }
        if (this.autonomousTurn) {
          break;
        }
        {
          const child = this.childAgentFor(event);
          if (child) {
            for (const block of Array.isArray(event.message?.content)
              ? event.message.content
              : []) {
              if (block.type === 'tool_result' && block.tool_use_id) {
                const tool = child.nativeItems.get(block.tool_use_id);
                if (tool && !tool.completed) {
                  tool.completed = true;
                  child.onToolComplete?.(tool.name, block.tool_use_id, block.is_error === true);
                }
              }
            }
            break;
          }
        }
        if (Array.isArray(event.message?.content)) {
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
        if (this.currentResolve === null && this.toolUseBlocks.length === 0) {
          // A finished CLI turn nobody requested and no tracked child explains (e.g. a
          // grandchild's task notification). A turn still waiting on host tool results is
          // not finished and keeps the normal path; a finished one is an answer for the
          // last request that asked.
          const text = event.result || '';
          persistentLogger.info(
            `[PersistentCLI] unrequested CLI turn ended (${event.duration_ms ?? 0}ms); ` +
              (this.lastFollowUp
                ? 'handing its text to the last request'
                : 'no request to hand it to')
          );
          this.lastFollowUp?.({
            agentThreadId: 'untracked',
            agentPath: 'cli-turn',
            itemId: 'untracked',
            text,
            isError: event.subtype !== 'success',
          });
          break;
        }
        if (this.currentInputUuid && this.currentCallbacks?.onAccepted && !this.inputAcknowledged) {
          this.handleError(
            new NativeInputUncertainError('Native input acknowledgement was not observed', {
              backend: 'claude',
              sessionId: this.options.sessionId,
              inputId: this.currentInputUuid,
            })
          );
          this.stop();
          break;
        }
        // Request complete
        this.clearRequestTimeout();

        if (event.subtype === 'success') {
          const unresolvedToolUses = [...this.toolUseBlocks];
          const completedToolExchanges = [...this.completedToolExchanges];
          const hasToolUse = unresolvedToolUses.length > 0;
          const result: PromptResult = {
            response: event.result || this.accumulatedText,
            session_id: event.session_id || this.options.sessionId,
            cost_usd: event.total_cost_usd,
            duration_ms: event.duration_ms,
            usage: {
              input_tokens: event.usage?.input_tokens,
              output_tokens: event.usage?.output_tokens,
              cache_creation_input_tokens: event.usage?.cache_creation_input_tokens,
              cache_read_input_tokens: event.usage?.cache_read_input_tokens,
              compaction_count: this.compactionCount,
            },
            toolUseBlocks: hasToolUse ? unresolvedToolUses : undefined,
            hasToolUse,
            completedToolExchanges,
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
          this.currentCallbacks?.onFinal?.({
            content: result.response,
            toolUseBlocks: unresolvedToolUses,
          });
          this.state = 'idle';
          this.awaitingToolResults = hasToolUse;
          this.pendingToolUseStartedAt = hasToolUse ? Date.now() : null;
          // The parent turn is over but a background child is still running: from here on
          // the stream is the child's until the next stdin request.
          this.parentTurnEnded = this.hasLiveBackgroundAgents();
          this.currentResolve?.(result);
          this.resetRequestState();
          this.emit('idle'); // F7: Trigger message queue drain (after resolve/cleanup)
        } else {
          // Every result ends the request: one that is neither success nor flagged as an error
          // would otherwise leave it waiting with its timers already cleared.
          const error = this.withPromptUsage(
            new Error(event.error || `Claude CLI ended the turn: ${event.subtype}`),
            event.usage
          );
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
        const error = this.withPromptUsage(new Error(event.error || 'Unknown error'), event.usage);
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
    // Every Agent spawn is tracked from here; its LAUNCH RESULT decides whether it is a
    // background child ("Async agent launched") or a synchronous one (dropped on result).
    // Measured 2026-09-10 21:06 KST: the CLI launched async without run_in_background, the
    // flag-gated tracker missed it, and the child lost the run context mid-flight.
    if (toolUse.name === BACKGROUND_AGENT_TOOL) {
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
      onToolUse: this.currentCallbacks?.onToolUse,
      onToolComplete: this.currentCallbacks?.onToolComplete,
      nativeItems: new Map(),
      onSubagentStart: this.currentCallbacks?.onSubagentStart,
      onFollowUp: this.currentCallbacks?.onFollowUp,
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
    if (!/async agent launched/i.test(content)) {
      // A synchronous child: its result IS its answer, inside the parent turn. Nothing to hold.
      this.backgroundAgents.delete(state.itemId);
      return;
    }
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
    for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
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
        if (!block.id || child.nativeItems.has(block.id)) continue;
        child.nativeItems.set(block.id, { name: block.name ?? 'unknown', completed: false });
        child.onToolUse?.(block.name ?? 'unknown', {
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
    // The answer belongs to the request that spawned the child: hand it back there.
    (state.onFollowUp ?? this.lastFollowUp)?.(resultEvent);
  }

  private completeBackgroundAgent(
    state: BackgroundAgentState,
    wakeRequired: boolean,
    status: 'completed' | 'unknown' = 'completed'
  ): void {
    if (state.completed) return;
    state.completed = true;
    for (const [callId, item] of state.nativeItems) {
      if (item.completed) continue;
      item.completed = true;
      try {
        state.onToolComplete?.(item.name, callId, true, 'unknown');
      } catch {
        console.warn('[PersistentCLI] native observation failed');
      }
    }
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
    const error = new ClaudeToolStreamProtocolError(message);
    this.currentCallbacks?.onError?.(error);
    this.handleError(error);
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
      this.currentReject(this.withPromptUsage(new Error(`Process exited with code ${code}`)));
      this.resetRequestState();
    }

    this.emit('close', code);
  }

  /** Attach the interrupted prompt's usage, so a failed run still records what it consumed. */
  private withPromptUsage(error: Error, usage?: PromptResult['usage']): Error {
    return Object.assign(error, { usage: { ...usage, compaction_count: this.compactionCount } });
  }

  /**
   * Handle process error
   */
  private handleError(error: Error): void {
    console.error(`[PersistentCLI] Process error:`, error.message);

    if (this.currentReject) {
      this.currentReject(this.withPromptUsage(error));
      this.resetRequestState();
    }

    // Transition to idle so subsequent requests aren't blocked
    if (this.state === 'busy') {
      this.state = 'idle';
      this.awaitingToolResults = false;
      this.pendingToolUseStartedAt = null;
      this.emit('idle');
    }

    this.emit('error', error);
  }

  /**
   * Handle request timeout
   */
  private handleTimeout(reason: string): void {
    console.error(
      `[PersistentCLI] Request timeout (${reason}) — killing process to prevent zombie`
    );

    if (this.currentReject) {
      this.currentReject(this.withPromptUsage(new Error(`Request timeout: ${reason}`)));
      this.resetRequestState();
    }

    // ⚠️ Timed-out processes MUST be killed.
    // Setting state to 'idle' without killing leaves zombie processes consuming memory.
    // When SessionPool creates new sessions without cleaning up old processes,
    // Claude processes accumulate and exhaust system memory.
    if (this.process && !this.process.killed) {
      // `killed` turns true as soon as SIGTERM is sent, so escalation must watch the exit itself.
      const child = this.process;
      let exited = false;
      const markExited = () => {
        exited = true;
      };
      if (typeof child.once === 'function') {
        child.once('exit', markExited);
        child.once('close', markExited);
      }
      child.kill('SIGTERM');
      const forceKillTimer = setTimeout(() => {
        if (!exited) child.kill('SIGKILL');
      }, 3000);
      forceKillTimer.unref?.();
    }
    this.state = 'dead';
    this.awaitingToolResults = false;
    this.pendingToolUseStartedAt = null;
    this.emit('idle'); // F7: Trigger message queue drain (after cleanup)
  }

  /** A request stops after `requestTimeout` without output, or after `requestMaxMs` in all. */
  private armRequestTimeouts(): void {
    const idleMs = this._getRequestTimeoutMs();
    if (idleMs > 0) {
      this.requestTimeoutHandle = setTimeout(
        () => this.handleTimeout(`no output for ${idleMs} ms`),
        idleMs
      );
    }
    const maxMs = Math.max(0, this.options.requestMaxMs ?? 0);
    if (maxMs > 0) {
      this.requestMaxHandle = setTimeout(
        () => this.handleTimeout(`running longer than ${maxMs} ms`),
        maxMs
      );
    }
  }

  private refreshRequestIdleTimeout(): void {
    if (this.requestTimeoutHandle === null) return;
    clearTimeout(this.requestTimeoutHandle);
    const idleMs = this._getRequestTimeoutMs();
    this.requestTimeoutHandle = setTimeout(
      () => this.handleTimeout(`no output for ${idleMs} ms`),
      idleMs
    );
  }

  /**
   * Clear request timeout
   */
  private clearRequestTimeout(): void {
    if (this.requestTimeoutHandle) {
      clearTimeout(this.requestTimeoutHandle);
      this.requestTimeoutHandle = null;
    }
    if (this.requestMaxHandle) {
      clearTimeout(this.requestMaxHandle);
      this.requestMaxHandle = null;
    }
  }

  /**
   * Reset request state
   */
  private resetRequestState(): void {
    this.clearRequestTimeout();
    // The request is over, but the runner may still answer it later (its own follow-up turn):
    // keep the sink the request offered.
    if (this.currentCallbacks?.onFollowUp) this.lastFollowUp = this.currentCallbacks.onFollowUp;
    this.currentCallbacks = null;
    this.currentResolve = null;
    this.currentReject = null;
    this.currentInputUuid = null;
    this.inputAcknowledged = false;
    this.toolUseBlocks = [];
    this.promptToolExchanges.clear();
    this.completedToolExchanges = [];
    this.accumulatedText = '';
    this.compactionCount = 0;
  }

  /**
   * Stop the process
   */
  stop(): void {
    persistentLogger.info(`[PersistentCLI] Stopping process`);

    // Reject any pending request BEFORE resetting state
    // This ensures promises are resolved even if process is already dead
    if (this.currentReject) {
      this.currentReject(this.withPromptUsage(new Error('Process stopped by user')));
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
  private defaultOptions: Partial<PersistentProcessOptions> & { workspaceDir: string };
  private idleTimeoutMs: number;
  private cleanupIntervalMs: number;
  private pendingToolUseTimeoutMs: number;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(defaultOptions: Partial<PersistentProcessOptions> & { workspaceDir: string }) {
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
    return Math.max(
      0,
      defaultOptions.timeouts?.idleMs ?? defaultOptions.timeouts?.sessionMs ?? 1_800_000
    );
  }

  private resolveCleanupIntervalMs(defaultOptions: Partial<PersistentProcessOptions>): number {
    if (defaultOptions.cleanupIntervalMs !== undefined) {
      return Math.max(0, defaultOptions.cleanupIntervalMs);
    }
    return Math.max(0, defaultOptions.timeouts?.cleanupMs ?? 300_000);
  }

  private resolvePendingToolUseTimeoutMs(
    defaultOptions: Partial<PersistentProcessOptions>
  ): number {
    if (defaultOptions.pendingToolUseTimeoutMs !== undefined) {
      return Math.max(0, defaultOptions.pendingToolUseTimeoutMs);
    }
    return Math.max(
      0,
      defaultOptions.timeouts?.pendingToolMs ?? Math.max(this.idleTimeoutMs * 4, 1_800_000)
    );
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
        // A per-call override may omit it; the pool's own workspace is the floor.
        workspaceDir: options?.workspaceDir ?? this.defaultOptions.workspaceDir,
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
