/**
 * MAMA Tool Executor for MAMA Standalone
 *
 * Executes MAMA gateway tools (mama_search, mama_save, mama_update, mama_load_checkpoint, Read, discord_send).
 * NOT MCP - uses Claude Messages API tool definitions.
 * Supports both direct API integration and mock API for testing.
 *
 * Role-Based Permission Control:
 * - Each tool execution is checked against the current AgentContext's role
 * - Blocked tools return permission errors instead of executing
 * - Path-based tools (Read, Write) also check path permissions
 */

import {
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  statSync,
  copyFileSync,
  realpathSync,
} from 'fs';
import { AsyncLocalStorage } from 'async_hooks';
import { createHash } from 'crypto';
import { join, dirname, resolve, relative, isAbsolute, basename } from 'path';
import { homedir } from 'os';
import { execSync, spawn, execFile } from 'child_process';
import { promisify } from 'util';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';
import { recordSecurityEvent } from '../security/security-monitor.js';
import { deriveMemoryScopes } from '../memory/scope-context.js';
import type {
  GatewayToolName,
  GatewayToolInput,
  GatewayToolResult,
  SaveInput,
  SearchInput,
  RecallInput,
  UpdateInput,
  LoadCheckpointInput,
  GatewayToolExecutorOptions,
  GatewaySessionStore,
  MAMAApiInterface,
  BrowserNavigateInput,
  BrowserScreenshotInput,
  BrowserClickInput,
  BrowserTypeInput,
  BrowserScrollInput,
  BrowserWaitForInput,
  BrowserEvaluateInput,
  BrowserPdfInput,
  AgentContext,
  AddBotInput,
  SetPermissionsInput,
  GetConfigInput,
  SetModelInput,
  ListBotsInput,
  RestartBotInput,
  StopBotInput,
  BotStatus,
  BotPlatform,
  EnvelopeDenialResult,
} from './types.js';
import { AgentError } from './types.js';
import {
  handleSave,
  handleSearch,
  handleUpdate,
  handleLoadCheckpoint,
} from './mama-tool-handlers.js';
import { getBrowserTool, type BrowserTool } from '../tools/browser-tool.js';
import { RoleManager, getRoleManager } from './role-manager.js';
import { loadConfig, saveConfig, getConfig } from '../cli/config/config-manager.js';
import type { AgentProcessManager } from '../multi-agent/agent-process-manager.js';
import type { DelegationManager } from '../multi-agent/delegation-manager.js';
import type { AgentEventBus } from '../multi-agent/agent-event-bus.js';
import type { SQLiteDatabase } from '../sqlite.js';
import type { UICommandQueue } from '../api/ui-command-handler.js';
import {
  getLatestVersion,
  createAgentVersion,
  compareVersionMetrics,
  getActivity,
  logActivity,
  updateActivityScore,
} from '../db/agent-store.js';
import type { RoleConfig } from '../cli/config/types.js';
import { DEFAULT_ROLES } from '../cli/config/types.js';
import {
  createManagedAgentRuntime,
  updateManagedAgentRuntime,
} from './managed-agent-runtime-sync.js';
import {
  validateManagedAgentCreateInput,
  validateManagedAgentChanges,
} from './managed-agent-validation.js';
import type { ValidationSessionRow } from '../validation/types.js';
import { EnvelopeEnforcer, EnvelopeViolation } from '../envelope/index.js';
import type { Envelope } from '../envelope/index.js';

const { DebugLogger } = debugLogger as unknown as {
  DebugLogger: new (context?: string) => {
    warn: (...args: unknown[]) => void;
  };
};
const securityLogger = new DebugLogger('SecurityAudit');
const TRUTHY_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);
const AGENT_DETAIL_TABS = new Set([
  'config',
  'persona',
  'tools',
  'activity',
  'validation',
  'history',
]);

type GatewayExecutionContext = {
  agentContext?: AgentContext | null;
  agentId?: string;
  source?: string;
  channelId?: string;
  envelope?: Envelope;
};

type ActiveGatewayExecutionContext = {
  agentContext: AgentContext | null;
  agentId: string;
  source: string;
  channelId: string;
  envelope?: Envelope;
};

const managedAgentMutationTails = new Map<string, Promise<void>>();

async function withManagedAgentMutationLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const previous = managedAgentMutationTails.get(agentId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  managedAgentMutationTails.set(agentId, tail);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (managedAgentMutationTails.get(agentId) === tail) {
      managedAgentMutationTails.delete(agentId);
    }
  }
}

function sanitizeCommandForAudit(command: string): { commandHash: string; commandPreview: string } {
  const commandHash = createHash('sha256').update(command).digest('hex');
  const commandPreview = command
    .replace(
      /\b(token|password|secret|key|authorization|auth)\b\s*(=|:)\s*([^\s"'`|;&]+)/gi,
      '$1$2***'
    )
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+\b/gi, '$1 ***')
    .slice(0, 200);

  return { commandHash, commandPreview };
}

function summarizeActivityOutput(output: unknown): string | undefined {
  if (output === undefined || output === null) {
    return undefined;
  }
  if (typeof output === 'string') {
    return output.slice(0, 500);
  }
  try {
    return JSON.stringify(output).slice(0, 500);
  } catch {
    return String(output).slice(0, 500);
  }
}

/**
 * Discord gateway interface for sending messages
 */
export interface DiscordGatewayInterface {
  sendMessage(channelId: string, message: string): Promise<void>;
  sendFile(channelId: string, filePath: string, caption?: string): Promise<void>;
  sendImage(channelId: string, imagePath: string, caption?: string): Promise<void>;
}

/**
 * Slack gateway interface for sending messages and files
 */
export interface SlackGatewayInterface {
  sendMessage(channelId: string, message: string): Promise<void>;
  sendFile(channelId: string, filePath: string, caption?: string): Promise<void>;
  sendImage(channelId: string, imagePath: string, caption?: string): Promise<void>;
}

/**
 * Telegram gateway interface for sending messages and files
 */
export interface TelegramGatewayInterface {
  sendMessage(chatId: string, text: string): Promise<void>;
  sendFile(chatId: string, filePath: string, caption?: string): Promise<void>;
  sendImage(chatId: string, imagePath: string, caption?: string): Promise<void>;
  sendSticker(chatId: string | number, emotion: string): Promise<boolean>;
}

/**
 * Valid MAMA gateway tools — derived from ToolRegistry (SSOT).
 */
import { ToolRegistry } from './tool-registry.js';

const VALID_TOOLS: GatewayToolName[] = ToolRegistry.getValidToolNames();

/**
 * Sensitive patterns that should be masked in config output
 */
const SENSITIVE_KEYS = ['token', 'bot_token', 'app_token', 'api_token', 'api_key', 'secret'];
const execFileAsync = promisify(execFile);

interface GHReviewThread {
  id: string;
  isResolved: boolean;
  comments: {
    nodes: Array<{
      path: string;
      line: number | null;
      body: string;
      author: { login: string } | null;
    }>;
  };
}

interface GHGraphQLResponse {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes?: GHReviewThread[];
        };
      };
    };
  };
}

export class GatewayToolExecutor {
  private mamaApi: MAMAApiInterface | null = null;
  private readonly mamaDbPath?: string;
  private sessionStore?: GatewaySessionStore;
  private discordGateway: DiscordGatewayInterface | null = null;
  private slackGateway: SlackGatewayInterface | null = null;
  private telegramGateway: TelegramGatewayInterface | null = null;
  private browserTool: BrowserTool;
  private roleManager: RoleManager;
  private readonly executionContextStorage = new AsyncLocalStorage<ActiveGatewayExecutionContext>();
  private readonly envelopeEnforcer = new EnvelopeEnforcer();
  private currentContext: AgentContext | null = null;
  private memoryAgentProcessManager: AgentProcessManager | null = null;
  private agentProcessManager: AgentProcessManager | null = null;
  private delegationManagerRef: DelegationManager | null = null;
  private currentAgentId: string = '';
  private currentSource: string = '';
  private currentChannelId: string = '';
  private disallowedGatewayTools: Set<string> = new Set();
  private reportPublisher: ((slots: Record<string, string>) => void) | null = null;
  private wikiPublisher:
    | ((
        pages: Array<{
          path: string;
          title: string;
          type: string;
          content: string;
          sourceIds: string[];
          compiledAt: string;
          confidence: string;
        }>
      ) => void)
    | null = null;
  private obsidianVaultPath: string | null = null;
  setObsidianVaultPath(vaultPath: string): void {
    this.obsidianVaultPath = vaultPath;
  }
  private agentEventBus: AgentEventBus | null = null;
  setAgentEventBus(bus: AgentEventBus): void {
    this.agentEventBus = bus;
  }
  getAgentEventBus(): AgentEventBus | null {
    return this.agentEventBus;
  }
  private sessionsDb: SQLiteDatabase | null = null;
  setSessionsDb(db: SQLiteDatabase): void {
    this.sessionsDb = db;
  }
  private rawStore: import('../connectors/framework/raw-store.js').RawStore | null = null;
  setRawStore(store: import('../connectors/framework/raw-store.js').RawStore): void {
    this.rawStore = store;
  }
  private testInFlight = new Map<string, Promise<GatewayToolResult>>();
  private uiCommandQueue: UICommandQueue | null = null;
  setUICommandQueue(queue: UICommandQueue): void {
    this.uiCommandQueue = queue;
  }
  private applyMultiAgentConfig: ((config: Record<string, unknown>) => Promise<void>) | null = null;
  setApplyMultiAgentConfig(fn: ((config: Record<string, unknown>) => Promise<void>) | null): void {
    this.applyMultiAgentConfig = fn;
  }
  private restartMultiAgentAgent: ((agentId: string) => Promise<void>) | null = null;
  setRestartMultiAgentAgent(fn: ((agentId: string) => Promise<void>) | null): void {
    this.restartMultiAgentAgent = fn;
  }
  private validationService:
    | import('../validation/session-service.js').ValidationSessionService
    | null = null;
  setValidationService(
    svc: import('../validation/session-service.js').ValidationSessionService
  ): void {
    this.validationService = svc;
  }
  setMemoryAgent(processManager: AgentProcessManager): void {
    this.memoryAgentProcessManager = processManager;
  }
  setAgentProcessManager(pm: AgentProcessManager): void {
    this.agentProcessManager = pm;
  }
  setDelegationManager(dm: DelegationManager): void {
    this.delegationManagerRef = dm;
  }
  /** Get AgentProcessManager (for cron/event triggers that need direct process access) */
  getAgentProcessManager(): AgentProcessManager | null {
    return this.agentProcessManager;
  }

  private normalizeExecutionContext(
    executionContext?: GatewayExecutionContext
  ): ActiveGatewayExecutionContext {
    const agentContext = executionContext?.agentContext ?? null;
    const source = executionContext?.source ?? agentContext?.source ?? '';
    const channelId = executionContext?.channelId ?? agentContext?.session?.channelId ?? '';
    const agentId =
      executionContext?.agentId ??
      (source === 'viewer' ? 'os-agent' : (agentContext?.roleName ?? ''));
    return {
      agentContext,
      agentId,
      source,
      channelId,
      envelope: executionContext?.envelope,
    };
  }

  private getExecutionState(): ActiveGatewayExecutionContext {
    const active = this.executionContextStorage.getStore();
    if (active) {
      return active;
    }
    return this.normalizeExecutionContext({
      agentContext: this.currentContext,
      agentId: this.currentAgentId,
      source: this.currentSource,
      channelId: this.currentChannelId,
    });
  }

  private getActiveContext(): AgentContext | null {
    return this.getExecutionState().agentContext;
  }

  private getActiveRouting(): { agentId: string; source: string; channelId: string } {
    const state = this.getExecutionState();
    return {
      agentId: state.agentId,
      source: state.source,
      channelId: state.channelId,
    };
  }

  async withExecutionContext<T>(
    executionContext: GatewayExecutionContext | undefined,
    fn: () => Promise<T>
  ): Promise<T> {
    if (!executionContext) {
      return fn();
    }
    const activeContext = this.normalizeExecutionContext(executionContext);
    return this.executionContextStorage.run(activeContext, fn);
  }

  setCurrentAgentContext(agentId: string, source: string, channelId: string): void {
    this.currentAgentId = agentId;
    this.currentSource = source;
    this.currentChannelId = channelId;
  }
  clearCurrentAgentContext(): void {
    this.currentAgentId = '';
    this.currentSource = '';
    this.currentChannelId = '';
  }
  setDisallowedGatewayTools(tools: string[]): void {
    this.disallowedGatewayTools = new Set(tools);
  }

  private cleanupValidationSessionOnTelemetryFailure(
    session: ValidationSessionRow | null,
    error: unknown,
    label: string
  ): null {
    if (!session || !this.validationService) {
      return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    try {
      this.validationService.finalizeSession(session.id, {
        execution_status: 'failed',
        error_message: `${label}: ${message}`,
      });
    } catch (cleanupErr) {
      securityLogger.warn(
        `[Delegation telemetry] Failed to clean up validation session ${session.id}`,
        cleanupErr
      );
    }
    return null;
  }

  private getPreferredViewerAgentTab(): string {
    if (!this.uiCommandQueue) {
      return 'activity';
    }
    const { channelId } = this.getActiveRouting();
    const currentPageContext = this.uiCommandQueue.getPageContext(channelId || undefined);
    if (!currentPageContext || currentPageContext.currentRoute !== 'agents') {
      return 'activity';
    }
    const pageData = currentPageContext.pageData as Record<string, unknown> | undefined;
    const activeTab = pageData?.activeTab;
    if (typeof activeTab === 'string' && AGENT_DETAIL_TABS.has(activeTab)) {
      return activeTab;
    }
    return 'activity';
  }

  private syncViewerToAgentDetail(agentId: string, preferredTab?: string): void {
    if (!this.uiCommandQueue) {
      return;
    }
    const { source, channelId } = this.getActiveRouting();
    if (source !== 'viewer') {
      return;
    }

    const desiredTab =
      preferredTab && AGENT_DETAIL_TABS.has(preferredTab)
        ? preferredTab
        : this.getPreferredViewerAgentTab();
    const currentPageContext = this.uiCommandQueue.getPageContext(channelId || undefined);
    const currentPageData = currentPageContext?.pageData as Record<string, unknown> | undefined;
    if (
      currentPageContext?.currentRoute === 'agents' &&
      currentPageContext.selectedItem?.type === 'agent' &&
      currentPageContext.selectedItem.id === agentId &&
      currentPageData?.pageType === 'agent-detail' &&
      currentPageData?.activeTab === desiredTab
    ) {
      return;
    }

    this.uiCommandQueue.push({
      type: 'navigate',
      payload: {
        route: 'agents',
        params: {
          id: agentId,
          tab: desiredTab,
        },
      },
    });
  }

  private resolveManagedAgentId(agentId: string): string {
    if (!this.sessionsDb) {
      return agentId;
    }
    const normalized = agentId
      .trim()
      .toLowerCase()
      .replace(/[_\s]+/g, '-');
    const candidates = Array.from(
      new Set([
        agentId,
        agentId.trim(),
        normalized,
        normalized.endsWith('-agent') ? normalized.slice(0, -6) : `${normalized}-agent`,
      ])
    ).filter(Boolean);

    for (const candidate of candidates) {
      if (getLatestVersion(this.sessionsDb, candidate)) {
        return candidate;
      }
    }
    return agentId;
  }

  setReportPublisher(fn: (slots: Record<string, string>) => void): void {
    this.reportPublisher = fn;
  }
  setWikiPublisher(
    fn: (
      pages: Array<{
        path: string;
        title: string;
        type: string;
        content: string;
        sourceIds: string[];
        compiledAt: string;
        confidence: string;
      }>
    ) => void
  ): void {
    this.wikiPublisher = fn;
  }

  /** Check if a memory agent is available for routing memory writes. */
  hasMemoryAgent(): boolean {
    return this.memoryAgentProcessManager !== null;
  }

  /** Check if delegate tool support is available (multi-agent wired). */
  hasDelegateSupport(): boolean {
    return this.agentProcessManager !== null && this.delegationManagerRef !== null;
  }

  /** Retry delay (ms) for delegate backoff. Initialized from config in constructor. */
  private _retryDelayMs: number = 1000;

  constructor(options: GatewayToolExecutorOptions = {}) {
    this.mamaDbPath = options.mamaDbPath;
    this.sessionStore = options.sessionStore;
    this.browserTool = getBrowserTool({
      screenshotDir: join(process.env.HOME || '', '.mama', 'workspace', 'media', 'outbound'),
    });
    // Pass rolesConfig from config.yaml to RoleManager
    this.roleManager = getRoleManager(
      options.rolesConfig ? { rolesConfig: options.rolesConfig } : undefined
    );

    if (options.mamaApi) {
      this.mamaApi = options.mamaApi;
    }

    // Read retry delay from config (safe: falls back to 1000ms if config not yet initialized)
    try {
      this._retryDelayMs = getConfig().timeouts?.busy_retry_ms ?? 1000;
    } catch {
      // Config not initialized yet — keep default 1000ms
    }
  }

  /**
   * Set the current agent context for permission checks
   * @param context - AgentContext with role and permissions
   */
  setAgentContext(context: AgentContext | null): void {
    this.currentContext = context;
  }

  /**
   * Get the current agent context
   */
  getAgentContext(): AgentContext | null {
    return this.getActiveContext();
  }

  setDiscordGateway(gateway: DiscordGatewayInterface): void {
    this.discordGateway = gateway;
  }

  setSlackGateway(gateway: SlackGatewayInterface): void {
    this.slackGateway = gateway;
  }

  setTelegramGateway(gateway: TelegramGatewayInterface): void {
    this.telegramGateway = gateway;
  }

  /**
   * Initialize the MAMA API by importing from mcp-server package
   * Called lazily on first tool execution if not provided in constructor
   */
  private async initializeMAMAApi(): Promise<MAMAApiInterface> {
    if (this.mamaApi) {
      return this.mamaApi;
    }

    try {
      // Set database path if provided
      if (this.mamaDbPath) {
        process.env.MAMA_DB_PATH = this.mamaDbPath;
      }

      // Dynamic import of MAMA mama-core modules
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mama = require('@jungjaehoon/mama-core/mama-api');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { initDB } = require('@jungjaehoon/mama-core/db-manager');

      // Initialize the database before using mama-api functions
      await initDB();

      this.mamaApi = {
        save: mama.save.bind(mama),
        saveCheckpoint: mama.saveCheckpoint.bind(mama),
        listDecisions: mama.list.bind(mama), // Note: mama exports listDecisions as 'list'
        suggest: mama.suggest.bind(mama),
        recallMemory: mama.recallMemory?.bind(mama),
        ingestMemory: mama.ingestMemory?.bind(mama),
        buildProfile: mama.buildProfile?.bind(mama),
        updateOutcome: mama.updateOutcome.bind(mama),
        loadCheckpoint: mama.loadCheckpoint.bind(mama),
      };

      return this.mamaApi;
    } catch (error) {
      throw new AgentError(
        `Failed to initialize MAMA API: ${error instanceof Error ? error.message : String(error)}`,
        'TOOL_ERROR',
        error instanceof Error ? error : undefined,
        false
      );
    }
  }

  /**
   * Check if a tool is allowed for the current context
   * @param toolName - Name of the tool to check
   * @returns Object with allowed status and optional error message
   */
  private checkToolPermission(toolName: string): { allowed: boolean; error?: string } {
    // If no context set, allow all tools (backward compatibility)
    const context = this.getActiveContext();
    if (!context) {
      return { allowed: true };
    }

    const role = context.role;

    if (!this.roleManager.isToolAllowed(role, toolName)) {
      return {
        allowed: false,
        error: `Permission denied: ${toolName} is not allowed for role "${context.roleName}"`,
      };
    }

    return { allowed: true };
  }

  /**
   * Check if a path is allowed for the current context
   * @param path - File path to check
   * @returns Object with allowed status and optional error message
   */
  private checkPathPermission(path: string): { allowed: boolean; error?: string } {
    // If no context set, allow all paths (backward compatibility)
    const context = this.getActiveContext();
    if (!context) {
      return { allowed: true };
    }

    const role = context.role;

    if (!this.roleManager.isPathAllowed(role, path)) {
      return {
        allowed: false,
        error: `Permission denied: Access to "${path}" is not allowed for role "${context.roleName}"`,
      };
    }

    return { allowed: true };
  }

  private enforceEnvelopeForToolCall(
    toolName: string,
    input: GatewayToolInput
  ): GatewayToolResult | undefined {
    const ctx = this.executionContextStorage.getStore();
    const failLoudOnMissing = isTruthyEnv('MAMA_ENVELOPE_FAIL_LOUD');
    const allowLegacyBypass = isTruthyEnv('MAMA_ENVELOPE_ALLOW_LEGACY_BYPASS');

    if (ctx?.envelope) {
      try {
        this.envelopeEnforcer.check(ctx.envelope, toolName, input);
        return undefined;
      } catch (err) {
        if (err instanceof EnvelopeViolation) {
          this.logEnvelopeActivity(ctx, 'envelope_violation', toolName, err.message);
          const denial: EnvelopeDenialResult = {
            success: false,
            error: err.message,
            code: err.code,
            envelope_hash: ctx.envelope.envelope_hash,
          };
          return denial;
        }
        throw err;
      }
    }

    if (failLoudOnMissing) {
      throw new Error(`[envelope] tool ${toolName} called without envelope (fail-loud mode)`);
    }

    if (allowLegacyBypass) {
      if (ctx) {
        securityLogger.warn('[envelope] tool called without envelope (legacy bypass enabled)', {
          toolName,
          agentId: ctx.agentId,
          source: ctx.source,
          channelId: ctx.channelId,
        });
        this.logEnvelopeActivity(ctx, 'envelope_missing_legacy', toolName);
      }

      return undefined;
    }

    const error = `[envelope] tool ${toolName} called without envelope`;
    if (ctx) {
      securityLogger.warn('[envelope] tool denied without envelope', {
        toolName,
        agentId: ctx.agentId,
        source: ctx.source,
        channelId: ctx.channelId,
      });
      this.logEnvelopeActivity(ctx, 'envelope_missing_denied', toolName, error);
    }

    return {
      success: false,
      error,
      code: 'envelope_missing',
    };
  }

  private logEnvelopeActivity(
    ctx: ActiveGatewayExecutionContext,
    type: 'envelope_violation' | 'envelope_missing_legacy' | 'envelope_missing_denied',
    toolName: string,
    errorMessage?: string
  ): void {
    try {
      if (!this.sessionsDb) {
        return;
      }
      logActivity(this.sessionsDb, {
        agent_id: ctx.agentId,
        agent_version: 0,
        type,
        input_summary: toolName,
        output_summary: ctx.envelope?.envelope_hash
          ? `envelope_hash=${ctx.envelope.envelope_hash}`
          : undefined,
        error_message: errorMessage,
        execution_status: errorMessage ? 'failed' : 'completed',
        trigger_reason: 'envelope_enforcer',
      });
    } catch (logErr) {
      securityLogger.warn('[envelope] audit log failed (non-fatal)', logErr);
    }
  }

  /**
   * Execute a gateway tool with permission checks
   *
   * @param toolName - Name of the tool to execute
   * @param input - Tool input parameters
   * @returns Tool execution result
   * @throws AgentError on tool errors or permission denial
   */
  async execute(
    toolName: string,
    input: GatewayToolInput,
    executionContext?: GatewayExecutionContext
  ): Promise<GatewayToolResult> {
    if (executionContext) {
      return this.withExecutionContext(executionContext, () => this.execute(toolName, input));
    }

    if (!VALID_TOOLS.includes(toolName as GatewayToolName)) {
      throw new AgentError(
        `Unknown tool: ${toolName}. Valid tools: ${VALID_TOOLS.join(', ')}`,
        'UNKNOWN_TOOL',
        undefined,
        false
      );
    }

    const envelopeDenied = this.enforceEnvelopeForToolCall(toolName, input);
    if (envelopeDenied) {
      return envelopeDenied;
    }

    // Check structurally disallowed tools (e.g., OS agent can't use sub-agent tools)
    if (this.disallowedGatewayTools.has(toolName)) {
      return {
        success: false,
        error: `Tool "${toolName}" is not available. Use delegate() to assign this work to the appropriate sub-agent.`,
      } as GatewayToolResult;
    }

    // Check tool permission
    const toolPermission = this.checkToolPermission(toolName);
    if (!toolPermission.allowed) {
      return {
        success: false,
        error: toolPermission.error,
      } as GatewayToolResult;
    }

    try {
      // Handle non-MAMA tools first
      switch (toolName) {
        case 'Read':
          return await this.executeRead(input as { path: string });
        case 'Write':
          return await this.executeWrite(input as { path: string; content: string });
        case 'Bash':
          return await this.executeBash(input as { command: string; workdir?: string });
        case 'discord_send':
          return await this.executeDiscordSend(
            input as { channel_id: string; message?: string; image_path?: string }
          );
        case 'slack_send':
          return await this.executeSlackSend(
            input as { channel_id: string; message?: string; file_path?: string }
          );
        case 'telegram_send':
          return await this.executeTelegramSend(
            input as { chat_id: string; message?: string; file_path?: string }
          );
        // Browser tools
        case 'browser_navigate':
          return await this.executeBrowserNavigate(input as BrowserNavigateInput);
        case 'browser_screenshot':
          return await this.executeBrowserScreenshot(input as BrowserScreenshotInput);
        case 'browser_click':
          return await this.executeBrowserClick(input as BrowserClickInput);
        case 'browser_type':
          return await this.executeBrowserType(input as BrowserTypeInput);
        case 'browser_get_text':
          return await this.executeBrowserGetText();
        case 'browser_scroll':
          return await this.executeBrowserScroll(input as BrowserScrollInput);
        case 'browser_wait_for':
          return await this.executeBrowserWaitFor(input as BrowserWaitForInput);
        case 'browser_evaluate':
          return await this.executeBrowserEvaluate(input as BrowserEvaluateInput);
        case 'browser_pdf':
          return await this.executeBrowserPdf(input as BrowserPdfInput);
        case 'browser_close':
          return await this.executeBrowserClose();
        // OS Management tools (viewer-only)
        case 'os_add_bot':
          return await this.executeAddBot(input as AddBotInput);
        case 'os_set_permissions':
          return await this.executeSetPermissions(input as SetPermissionsInput);
        case 'os_get_config':
          return await this.executeGetConfig(input as GetConfigInput);
        case 'os_set_model':
          return await this.executeSetModel(input as SetModelInput);
        // OS Monitoring tools
        case 'os_list_bots':
          return await this.executeListBots(input as ListBotsInput);
        case 'os_restart_bot':
          return await this.executeRestartBot(input as RestartBotInput);
        case 'os_stop_bot':
          return await this.executeStopBot(input as StopBotInput);
        // PR Review tools
        case 'pr_review_threads':
          return await this.executePrReviewThreads(
            input as { pr_url?: string; owner?: string; repo?: string; pr_number?: number }
          );
        // Webchat tools
        case 'webchat_send':
          return await this.executeWebchatSend(
            input as { message?: string; file_path?: string } // session_id omitted: all files use shared outbound dir
          );
        // Code-Act sandbox execution
        case 'code_act':
          return await this.executeCodeAct(input as { code: string });
        // Obsidian vault management via CLI
        case 'obsidian':
          return await this.executeObsidian(
            input as { command: string; args?: Record<string, string> }
          );
        // Agent lifecycle tools
        case 'agent_test':
          return await this.executeAgentTest(
            input as {
              agent_id: string;
              sample_count?: number;
              test_data?: Array<{ input: string; expected?: string }>;
            }
          );
        // Agent management tools (Managed Agents pattern)
        case 'agent_get': {
          if (!this.sessionsDb) {
            return { success: false, error: 'Sessions DB not available' };
          }
          const permError = this.checkViewerOnly();
          if (permError) {
            return { success: false, error: permError };
          }
          const agentId = this.resolveManagedAgentId((input as { agent_id: string }).agent_id);
          const latestVer = getLatestVersion(this.sessionsDb, agentId);
          if (!latestVer) {
            return { success: false, error: `Agent '${agentId}' not found` };
          }
          this.syncViewerToAgentDetail(agentId);
          return {
            success: true,
            agent_id: latestVer.agent_id,
            version: latestVer.version,
            config: JSON.parse(latestVer.snapshot),
            system: latestVer.persona_text,
            change_note: latestVer.change_note,
            created_at: latestVer.created_at,
          };
        }
        case 'agent_activity': {
          if (!this.sessionsDb) {
            return { success: false, error: 'Sessions DB not available' };
          }
          const permError = this.checkViewerOnly();
          if (permError) {
            return { success: false, error: permError };
          }
          const args = input as { agent_id: string; limit?: number };
          const agentId = this.resolveManagedAgentId(args.agent_id);
          const rawLimit = Number.parseInt(String(args.limit ?? 20), 10);
          const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
          const latestVer = getLatestVersion(this.sessionsDb, agentId);
          if (!latestVer) {
            return { success: false, error: `Agent '${args.agent_id}' not found` };
          }
          this.syncViewerToAgentDetail(agentId, 'activity');
          return {
            success: true,
            agent_id: agentId,
            activity: getActivity(this.sessionsDb, agentId, limit),
          };
        }
        case 'agent_update': {
          if (!this.sessionsDb) {
            return { success: false, error: 'Sessions DB not available' };
          }
          const permError = this.checkViewerOnly();
          if (permError) {
            return { success: false, error: permError };
          }
          const updateArgs = input as {
            agent_id: string;
            version: number;
            changes: Record<string, unknown>;
            change_note?: string;
          };
          const updateError = validateManagedAgentChanges(updateArgs.changes);
          if (updateError) {
            return { success: false, error: updateError };
          }
          const agentId = this.resolveManagedAgentId(updateArgs.agent_id);
          const initialLatest = getLatestVersion(this.sessionsDb, agentId);
          if (!initialLatest) {
            return { success: false, error: `Agent '${updateArgs.agent_id}' not found` };
          }
          return withManagedAgentMutationLock(agentId, async () => {
            const updateLatest = getLatestVersion(this.sessionsDb!, agentId);
            if (!updateLatest) {
              return { success: false, error: `Agent '${updateArgs.agent_id}' not found` };
            }
            if (updateLatest.version !== updateArgs.version) {
              return {
                success: false,
                error: `Version conflict: current v${updateLatest.version}, sent v${updateArgs.version}`,
              };
            }
            const synced = await updateManagedAgentRuntime(
              {
                agentId,
                changes: updateArgs.changes,
              },
              {
                loadConfig,
                saveConfig:
                  saveConfig as unknown as import('./managed-agent-runtime-sync.js').ManagedAgentRuntimeSyncOptions['saveConfig'],
                applyMultiAgentConfig: this.applyMultiAgentConfig,
                restartMultiAgentAgent: this.restartMultiAgentAgent,
              }
            );
            const updatedV = createAgentVersion(this.sessionsDb!, {
              agent_id: agentId,
              snapshot: synced.snapshot,
              persona_text: synced.personaText ?? updateLatest.persona_text,
              change_note: updateArgs.change_note,
            });
            return {
              success: true,
              new_version: updatedV.version,
              runtime_reloaded: synced.runtimeReloaded,
            };
          });
        }
        case 'agent_create': {
          if (!this.sessionsDb) {
            return { success: false, error: 'Sessions DB not available' };
          }
          const permError = this.checkViewerOnly();
          if (permError) {
            return { success: false, error: permError };
          }
          const createArgs = input as {
            id: string;
            name: string;
            model: string;
            tier: number;
            system?: string;
            backend?: 'claude' | 'codex' | 'codex-mcp' | 'gemini';
          };
          const createError = validateManagedAgentCreateInput(
            createArgs as unknown as Record<string, unknown>
          );
          if (createError) {
            return { success: false, error: createError };
          }
          return withManagedAgentMutationLock(createArgs.id, async () => {
            const existingAgent = getLatestVersion(this.sessionsDb!, createArgs.id);
            if (existingAgent) {
              return { success: false, error: `Agent '${createArgs.id}' already exists` };
            }

            const synced = await createManagedAgentRuntime(
              {
                id: createArgs.id,
                name: createArgs.name,
                model: createArgs.model,
                tier: createArgs.tier,
                backend: createArgs.backend,
                system: createArgs.system,
              },
              {
                loadConfig,
                saveConfig:
                  saveConfig as unknown as import('./managed-agent-runtime-sync.js').ManagedAgentRuntimeSyncOptions['saveConfig'],
                applyMultiAgentConfig: this.applyMultiAgentConfig,
                restartMultiAgentAgent: this.restartMultiAgentAgent,
              }
            );

            const createdV = createAgentVersion(this.sessionsDb!, {
              agent_id: createArgs.id,
              snapshot: synced.snapshot,
              persona_text: synced.personaText,
              change_note: 'Created via agent_create tool',
            });
            return {
              success: true,
              id: createArgs.id,
              version: createdV.version,
              runtime_reloaded: synced.runtimeReloaded,
            };
          });
        }
        case 'agent_compare': {
          if (!this.sessionsDb) {
            return { success: false, error: 'Sessions DB not available' };
          }
          const permError = this.checkViewerOnly();
          if (permError) {
            return { success: false, error: permError };
          }
          const cmpArgs = input as {
            agent_id: string;
            version_a: number;
            version_b: number;
          };
          const agentId = this.resolveManagedAgentId(cmpArgs.agent_id);
          const cmpResult = compareVersionMetrics(
            this.sessionsDb,
            agentId,
            cmpArgs.version_a,
            cmpArgs.version_b
          );
          this.syncViewerToAgentDetail(agentId, 'validation');
          return { success: true, agent_id: agentId, ...cmpResult };
        }
        // Viewer control tools (SmartStore pattern)
        case 'viewer_state': {
          if (!this.uiCommandQueue) {
            return { success: false, error: 'UI command queue not available' };
          }
          const permError = this.checkViewerOnly();
          if (permError) {
            return { success: false, error: permError };
          }
          const { channelId } = this.getActiveRouting();
          const ctx = this.uiCommandQueue.getPageContext(channelId || undefined);
          return { success: true, context: ctx || { currentRoute: 'unknown', pageData: null } };
        }
        case 'viewer_navigate': {
          if (!this.uiCommandQueue) {
            return { success: false, error: 'UI command queue not available' };
          }
          const permError = this.checkViewerOnly();
          if (permError) {
            return { success: false, error: permError };
          }
          const navArgs = input as { route: string; params?: Record<string, string> };
          this.uiCommandQueue.push({ type: 'navigate', payload: navArgs });
          return { success: true, navigated: navArgs.route };
        }
        case 'viewer_notify': {
          if (!this.uiCommandQueue) {
            return { success: false, error: 'UI command queue not available' };
          }
          const permError = this.checkViewerOnly();
          if (permError) {
            return { success: false, error: permError };
          }
          const args = input as {
            type: string;
            message: string;
            action?: Record<string, unknown>;
          };
          this.uiCommandQueue.push({ type: 'notify', payload: args });
          return { success: true, notified: true };
        }
        // Multi-Agent delegation
        case 'delegate':
          return await this.executeDelegate(
            input as { agentId: string; task: string; background?: boolean }
          );
      }

      // Lazy MAMA API init — only for tools that need it
      const getApi = () => this.initializeMAMAApi();

      switch (toolName as GatewayToolName) {
        case 'mama_save':
          return await handleSave(
            await getApi(),
            input as SaveInput,
            this.sessionStore?.getHistory
              ? () => this.sessionStore!.getHistory!('current')
              : undefined
          );
        case 'mama_search':
          return await handleSearch(await getApi(), input as SearchInput);
        case 'mama_recall':
          return await this.handleMamaRecall(input as RecallInput);
        case 'mama_update':
          return await handleUpdate(await getApi(), input as UpdateInput);
        case 'mama_load_checkpoint':
          return await handleLoadCheckpoint(await getApi(), input as LoadCheckpointInput);
        case 'mama_add':
          return await this.handleMamaAdd(input as { content: string });
        case 'mama_ingest':
          return await this.handleMamaIngest(input as { content: string; scopes?: unknown });
        case 'report_publish': {
          const slotsInput = (input as { slots?: Record<string, string> }).slots;
          if (!slotsInput || typeof slotsInput !== 'object') {
            throw new AgentError(
              'report_publish requires slots object',
              'TOOL_ERROR',
              undefined,
              false
            );
          }
          if (this.reportPublisher) {
            this.reportPublisher(slotsInput);
            const slotNames = Object.keys(slotsInput);

            // Persist report summary to mama memory for Conductor querying
            const slotValues = Object.values(slotsInput).join(' ');
            const textSummary = slotValues
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();
            const truncated =
              textSummary.length > 1500 ? textSummary.substring(0, 1500) + '...' : textSummary;
            void (async () => {
              try {
                const a = await getApi();
                await handleSave(a, {
                  type: 'decision' as const,
                  topic: 'dashboard_briefing',
                  decision: `Dashboard briefing (${new Date().toISOString().split('T')[0]}): ${truncated}`,
                  reasoning: 'Auto-saved by dashboard agent after report_publish',
                  scopes: [{ kind: 'global', id: 'system' }],
                });
              } catch {
                /* non-fatal */
              }
            })();

            return {
              success: true,
              message: `Dashboard updated: ${slotNames.join(', ')} (${slotNames.length} slots)`,
            };
          }
          throw new AgentError('Report publisher not configured', 'TOOL_ERROR', undefined, false);
        }
        case 'wiki_publish': {
          const pagesInput = (
            input as {
              pages?: Array<{
                path: string;
                title: string;
                type: string;
                content: string;
                confidence?: string;
              }>;
            }
          ).pages;
          if (!pagesInput || !Array.isArray(pagesInput)) {
            throw new AgentError(
              'wiki_publish requires pages array',
              'TOOL_ERROR',
              undefined,
              false
            );
          }
          if (this.wikiPublisher) {
            const now = new Date().toISOString();
            const wikiPages = pagesInput.map((p) => ({
              path: p.path,
              title: p.title,
              type: p.type || 'entity',
              content: p.content,
              sourceIds: [] as string[],
              compiledAt: now,
              confidence: p.confidence || 'medium',
            }));
            this.wikiPublisher(wikiPages);

            // Persist wiki compilation summary to mama memory for Conductor querying
            const pageSummary = pagesInput
              .slice(0, 20)
              .map(
                (p: { title?: string; path: string; type?: string }) =>
                  `- ${p.title || p.path} (${p.type || 'page'})`
              )
              .join('\n');
            const wikiSummary = `Wiki compilation (${now.split('T')[0]}): ${pagesInput.length} pages\n${pageSummary}`;
            void (async () => {
              try {
                const a = await getApi();
                await handleSave(a, {
                  type: 'decision' as const,
                  topic: 'wiki_compilation',
                  decision: wikiSummary,
                  reasoning: 'Auto-saved by wiki agent after wiki_publish',
                  scopes: [{ kind: 'global', id: 'system' }],
                });
              } catch {
                /* non-fatal */
              }
            })();

            return {
              success: true,
              message: `Wiki published: ${wikiPages.length} pages`,
            };
          }
          throw new AgentError('Wiki publisher not configured', 'TOOL_ERROR', undefined, false);
        }
        // Kagemusha query tools — progressive business data exploration
        case 'kagemusha_overview': {
          const { getOverview } = await import('../connectors/kagemusha/query-tools.js');
          return { success: true, ...getOverview() };
        }
        case 'kagemusha_entities': {
          const { listEntities } = await import('../connectors/kagemusha/query-tools.js');
          const entityInput = input as {
            channel?: string;
            activeOnly?: boolean;
            limit?: number;
          };
          return { success: true, entities: listEntities(entityInput) };
        }
        case 'kagemusha_tasks': {
          const { queryTasks } = await import('../connectors/kagemusha/query-tools.js');
          const taskInput = input as {
            sourceRoom?: string;
            status?: string;
            priority?: string;
            search?: string;
            limit?: number;
          };
          return { success: true, tasks: queryTasks(taskInput) };
        }
        case 'kagemusha_messages': {
          const { queryMessages } = await import('../connectors/kagemusha/query-tools.js');
          const msgInput = input as {
            channelId: string;
            since?: string;
            limit?: number;
            search?: string;
          };
          if (!msgInput.channelId) {
            throw new AgentError(
              'kagemusha_messages requires channelId',
              'TOOL_ERROR',
              undefined,
              false
            );
          }
          return { success: true, messages: queryMessages(msgInput) };
        }
        case 'agent_notices': {
          const rawLimit = Number((input as { limit?: number }).limit);
          const limit = Number.isFinite(rawLimit)
            ? Math.min(Math.max(Math.floor(rawLimit), 1), 100)
            : 10;
          if (!this.agentEventBus) {
            return { success: false, error: 'Agent event bus not available' } as GatewayToolResult;
          }
          const notices = this.agentEventBus.getRecentNotices(limit);
          return {
            success: true,
            data: {
              notices: notices.map((n) => ({
                agent: n.agent,
                action: n.action,
                target: n.target,
                timestamp: new Date(n.timestamp).toISOString(),
              })),
            },
          };
        }
        default:
          throw new AgentError(`Unknown tool: ${toolName}`, 'UNKNOWN_TOOL', undefined, false);
      }
    } catch (error) {
      if (error instanceof AgentError) {
        throw error;
      }

      throw new AgentError(
        `Tool execution failed (${toolName}): ${error instanceof Error ? error.message : String(error)}`,
        'TOOL_ERROR',
        error instanceof Error ? error : undefined,
        false
      );
    }
  }

  /**
   * Execute read tool - Read file from filesystem
   * Checks path permissions based on current AgentContext
   */
  private async executeRead(input: {
    path?: string;
    file_path?: string;
    file?: string;
  }): Promise<{ success: boolean; content?: string; error?: string }> {
    // Accept common parameter name variations
    const filePath = input.path || input.file_path || input.file;

    if (!filePath) {
      return {
        success: false,
        error: `Path is required. Use: {"name": "Read", "input": {"path": "/file/path"}}`,
      };
    }

    // Expand ~ to home directory
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const expandedPath = filePath.startsWith('~/') ? join(homeDir, filePath.slice(2)) : filePath;

    // Check path permission based on role
    const pathPermission = this.checkPathPermission(expandedPath);
    if (!pathPermission.allowed) {
      return { success: false, error: pathPermission.error };
    }

    // Fallback security for contexts without path restrictions:
    // Only allow reading from ~/.mama/ directory
    const context = this.getActiveContext();
    if (!context?.role.allowedPaths?.length) {
      const mamaDir = resolve(homeDir, '.mama');
      const resolvedPath = resolve(expandedPath);
      // Use path.relative to prevent path traversal (e.g., ~/.mama-evil/)
      const rel = relative(mamaDir, resolvedPath);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        return { success: false, error: `Access denied: Can only read files from ${mamaDir}` };
      }
    }

    if (!existsSync(expandedPath)) {
      return { success: false, error: `File not found: ${expandedPath}` };
    }

    try {
      // Guard against reading huge files (e.g. daemon.log) that would blow up the prompt
      const MAX_READ_BYTES = getConfig().io?.max_read_bytes ?? 200_000;
      const fileSize = statSync(expandedPath).size;
      if (fileSize > MAX_READ_BYTES) {
        const truncated = readFileSync(expandedPath, { encoding: 'utf-8', flag: 'r' }).slice(
          0,
          MAX_READ_BYTES
        );
        return {
          success: true,
          content:
            truncated +
            `\n\n[Truncated: file is ${(fileSize / 1024).toFixed(0)}KB, showing first ${MAX_READ_BYTES / 1000}KB]`,
        };
      }
      const content = readFileSync(expandedPath, 'utf-8');
      return { success: true, content };
    } catch (err) {
      return { success: false, error: `Failed to read file: ${err}` };
    }
  }

  /**
   * Execute Write tool - Write content to a file
   * Checks path permissions based on current AgentContext
   */
  private async executeWrite(input: {
    path: string;
    content: string;
  }): Promise<{ success: boolean; error?: string }> {
    const { path, content } = input;

    if (!path) {
      return { success: false, error: 'path is required' };
    }

    // Expand ~ to home directory
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const expandedPath = path.startsWith('~/') ? join(homeDir, path.slice(2)) : path;

    // Check path permission based on role
    const pathPermission = this.checkPathPermission(expandedPath);
    if (!pathPermission.allowed) {
      return { success: false, error: pathPermission.error };
    }

    // Fallback security for contexts without path restrictions:
    // Only allow writing to ~/.mama/ directory
    const context = this.getActiveContext();
    if (!context?.role.allowedPaths?.length) {
      const mamaDir = resolve(homeDir, '.mama');
      const resolvedPath = resolve(expandedPath);
      // Use path.relative to prevent path traversal (e.g., ~/.mama-evil/)
      const rel = relative(mamaDir, resolvedPath);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        return { success: false, error: `Access denied: Can only write files to ${mamaDir}` };
      }
    }

    try {
      const dir = dirname(expandedPath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(expandedPath, content, 'utf-8');
      return { success: true };
    } catch (err) {
      return { success: false, error: `Failed to write file: ${err}` };
    }
  }

  /**
   * Execute Bash tool - Execute bash command
   */
  private async executeBash(input: {
    command: string;
    workdir?: string;
  }): Promise<{ success: boolean; output?: string; error?: string }> {
    const { command, workdir } = input;

    if (!command) {
      return { success: false, error: 'command is required' };
    }

    // Block destructive commands (stop/kill) - these would permanently kill the agent
    const destructive =
      /(systemctl\s+(?:--user\s+)?(?:stop|disable)\s+mama(?:-os)?\b|(?:kill|pkill|killall)\b[^\n]*\bmama(?:-os)?\b|\brm\b(?:\s+(?:-[^\n\s]*[rf][^\n\s]*|--recursive|--force))+\s+(?:\/(?:\s|$)|~(?:\/|\s|$)|\$HOME(?:\/|\s|$)|\/home(?:\/|\s|$)))/i;
    if (destructive.test(command)) {
      const audit = sanitizeCommandForAudit(command);
      const context = this.getActiveContext();
      const details = {
        category: 'destructive',
        ...audit,
        source: context?.source || null,
        sessionId: context?.session?.sessionId || null,
      };
      securityLogger.warn('[SECURITY] Dangerous Bash command blocked', details);
      recordSecurityEvent({
        type: 'dangerous_bash_blocked',
        severity: 'critical',
        message: 'Dangerous Bash command blocked',
        details,
      });
      return {
        success: false,
        error:
          'Cannot stop mama-os from within the agent. Ask the user to run this command from their terminal.',
      };
    }

    // Block commands that can escape sandbox or escalate privileges
    const dangerousPatterns = [
      /\bsudo\b/i,
      /\bchmod\s+(?:[ugoa]*[+-]s|0?[2-7][0-7]{3})\b/i, // setuid/setgid (symbolic + octal)
      /\bchown\b/i,
      /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sh|bash|zsh|fish)\b/i, // pipe to shell
      /\beval\b/i, // eval in shell
      /\bnc\s+-[el]/i, // netcat listener (reverse shell)
      /\bpython(?:3)?\s+-c\b/i, // python inline code
      /\bnode\s+-e\b/i, // node inline code
      /\bruby\s+-e\b/i, // ruby inline code
      /\bperl\s+-e\b/i, // perl inline code
      /\bphp\s+-r\b/i, // php inline code
      /\b(?:bash|sh|zsh)\b\s+-[cix]\b/i, // shell inline/interactive execution
      />\s*\/dev\/tcp\//i, // bash /dev/tcp reverse shell
      /\bmkfifo\b/i, // named pipe (often used in reverse shells)
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(command)) {
        const audit = sanitizeCommandForAudit(command);
        const context = this.getActiveContext();
        const details = {
          category: 'pattern',
          pattern: pattern.toString(),
          ...audit,
          source: context?.source || null,
          sessionId: context?.session?.sessionId || null,
        };
        securityLogger.warn('[SECURITY] Dangerous Bash pattern blocked', details);
        recordSecurityEvent({
          type: 'dangerous_bash_blocked',
          severity: 'critical',
          message: 'Dangerous Bash pattern blocked',
          details,
        });
        return {
          success: false,
          error: `Blocked: command contains a restricted pattern. Use appropriate MAMA tools instead.`,
        };
      }
    }

    // Block sandbox escape via cd command using path-based validation
    // Check ALL cd occurrences in chained commands (cd foo && cd bar)
    // Also detect bare cd commands (cd, cd;, cd &&) which go to home directory
    const sandboxRoot = join(homedir(), '.mama');
    const cwd = workdir || process.env.MAMA_WORKSPACE || join(sandboxRoot, 'workspace');

    // Pattern to match cd with optional target (handles: cd path, cd "path", cd 'path', bare cd)
    const cdPattern =
      /(?:^|&&|\|\||;)\s*cd(?:\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+)))?(?=\s*(?:$|&&|\|\||;))/g;
    const cdMatches = [...command.matchAll(cdPattern)];

    for (const cdMatch of cdMatches) {
      const cdTarget = cdMatch[1] || cdMatch[2] || cdMatch[3];

      // Expand ~ to home directory for path resolution
      let resolvedTarget: string;
      if (!cdTarget || cdTarget === '~' || cdTarget === '~/') {
        // Bare cd or cd ~ goes to home directory (outside sandbox)
        resolvedTarget = homedir();
      } else if (cdTarget.startsWith('~/')) {
        resolvedTarget = join(homedir(), cdTarget.slice(2));
      } else if (cdTarget.startsWith('/')) {
        resolvedTarget = cdTarget;
      } else {
        resolvedTarget = join(cwd, cdTarget);
      }

      // Resolve any .. or . in the path
      const normalizedTarget = resolve(resolvedTarget);

      // Follow symlinks to prevent sandbox bypass
      let realTarget: string;
      try {
        realTarget = realpathSync(normalizedTarget);
      } catch {
        realTarget = normalizedTarget; // file doesn't exist yet — lexical check is fine
      }

      // Check if target is within sandbox
      // Add trailing separator to prevent path traversal (e.g., ~/.mama vs ~/.mama-evil)
      const sandboxRootWithSep = sandboxRoot.endsWith('/') ? sandboxRoot : sandboxRoot + '/';
      if (!realTarget.startsWith(sandboxRootWithSep) && realTarget !== sandboxRoot) {
        return {
          success: false,
          error:
            'Cannot change directory outside ~/.mama/ sandbox. Use Read/Write tools for files outside sandbox.',
        };
      }
    }

    // Handle restart: deferred restart (agent survives to respond, service restarts after 3s)
    const restartPattern = /systemctl\s+--user\s+restart\s+mama-os/i;
    if (restartPattern.test(command)) {
      const child = spawn('bash', ['-c', 'sleep 3 && systemctl --user restart mama-os'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return {
        success: true,
        output: 'mama-os restart will execute in 3 seconds. Current session will be terminated.',
      };
    }

    try {
      const output = execSync(command, {
        cwd: workdir || process.env.MAMA_WORKSPACE || join(homedir(), '.mama', 'workspace'),
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60000,
      });
      return { success: true, output };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      return {
        success: false,
        error: `Command failed: ${err.message}`,
        output: err.stdout || err.stderr,
      };
    }
  }

  /**
   * Execute discord_send tool - Send message/file to Discord channel
   * Supports images, documents, and any file type
   */
  private async executeDiscordSend(input: {
    channel_id: string;
    message?: string;
    image_path?: string;
    file_path?: string;
  }): Promise<{ success: boolean; error?: string }> {
    const { channel_id, message, image_path, file_path } = input;

    if (!channel_id) {
      return { success: false, error: 'channel_id is required' };
    }

    if (!this.discordGateway) {
      return { success: false, error: 'Discord gateway not configured' };
    }

    try {
      // file_path takes precedence, fallback to image_path for backwards compatibility
      const filePath = file_path || image_path;

      if (filePath) {
        await this.discordGateway.sendFile(channel_id, filePath, message);
      } else if (message) {
        await this.discordGateway.sendMessage(channel_id, message);
      } else {
        return { success: false, error: 'Either message, file_path, or image_path is required' };
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: `Failed to send to Discord: ${err}` };
    }
  }

  /**
   * Execute slack_send tool - Send message/file to Slack channel
   */
  private async executeSlackSend(input: {
    channel_id: string;
    message?: string;
    file_path?: string;
  }): Promise<{ success: boolean; error?: string }> {
    const { channel_id, message, file_path } = input;

    if (!channel_id) {
      return { success: false, error: 'channel_id is required' };
    }

    if (!this.slackGateway) {
      return { success: false, error: 'Slack gateway not configured' };
    }

    try {
      if (file_path) {
        await this.slackGateway.sendFile(channel_id, file_path, message);
      } else if (message) {
        await this.slackGateway.sendMessage(channel_id, message);
      } else {
        return { success: false, error: 'Either message or file_path is required' };
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: `Failed to send to Slack: ${err}` };
    }
  }

  /**
   * Execute telegram_send tool - Send message/file to Telegram chat
   */
  private async executeTelegramSend(input: {
    chat_id: string;
    message?: string;
    file_path?: string;
    sticker_emotion?: string;
  }): Promise<{ success: boolean; error?: string }> {
    const { chat_id, message, file_path, sticker_emotion } = input;

    if (!chat_id) {
      return { success: false, error: 'chat_id is required' };
    }

    if (!this.telegramGateway) {
      return { success: false, error: 'Telegram gateway not configured' };
    }

    try {
      if (sticker_emotion) {
        await this.telegramGateway.sendSticker(chat_id, sticker_emotion);
      } else if (file_path) {
        await this.telegramGateway.sendFile(chat_id, file_path, message);
      } else if (message) {
        await this.telegramGateway.sendMessage(chat_id, message);
      } else {
        return {
          success: false,
          error: 'Either message, file_path, or sticker_emotion is required',
        };
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: `Failed to send to Telegram: ${err}` };
    }
  }

  // ============================================================================
  // Browser Tool Execution
  // ============================================================================

  /**
   * Navigate to a URL
   */
  private async executeBrowserNavigate(
    input: BrowserNavigateInput
  ): Promise<{ success: boolean; title?: string; url?: string; error?: string }> {
    try {
      const result = await this.browserTool.navigate(input.url);
      return { success: true, title: result.title, url: result.url };
    } catch (err) {
      return { success: false, error: `Navigation failed: ${err}` };
    }
  }

  /**
   * Take a screenshot
   */
  private async executeBrowserScreenshot(
    input: BrowserScreenshotInput
  ): Promise<{ success: boolean; path?: string; error?: string }> {
    try {
      const result = input.full_page
        ? await this.browserTool.screenshotFullPage(input.filename)
        : await this.browserTool.screenshot(input.filename);
      return { success: true, path: result.path };
    } catch (err) {
      return { success: false, error: `Screenshot failed: ${err}` };
    }
  }

  /**
   * Click an element
   */
  private async executeBrowserClick(
    input: BrowserClickInput
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await this.browserTool.click(input.selector);
      return { success: true };
    } catch (err) {
      return { success: false, error: `Click failed: ${err}` };
    }
  }

  /**
   * Type text into an element
   */
  private async executeBrowserType(
    input: BrowserTypeInput
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await this.browserTool.type(input.selector, input.text);
      return { success: true };
    } catch (err) {
      return { success: false, error: `Type failed: ${err}` };
    }
  }

  /**
   * Get page text content
   */
  private async executeBrowserGetText(): Promise<{
    success: boolean;
    text?: string;
    error?: string;
  }> {
    try {
      const result = await this.browserTool.getText();
      return { success: true, text: result.text };
    } catch (err) {
      return { success: false, error: `Get text failed: ${err}` };
    }
  }

  /**
   * Scroll the page
   */
  private async executeBrowserScroll(
    input: BrowserScrollInput
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await this.browserTool.scroll(input.direction, input.amount);
      return { success: true };
    } catch (err) {
      return { success: false, error: `Scroll failed: ${err}` };
    }
  }

  /**
   * Wait for element
   */
  private async executeBrowserWaitFor(
    input: BrowserWaitForInput
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await this.browserTool.waitFor(input.selector, input.timeout);
      return { success: true };
    } catch (err) {
      return { success: false, error: `Wait failed: ${err}` };
    }
  }

  /**
   * Evaluate JavaScript in page
   */
  private async executeBrowserEvaluate(
    input: BrowserEvaluateInput
  ): Promise<{ success: boolean; result?: unknown; error?: string }> {
    try {
      const result = await this.browserTool.evaluate(input.script);
      return { success: true, result: result.result };
    } catch (err) {
      return { success: false, error: `Evaluate failed: ${err}` };
    }
  }

  /**
   * Generate PDF of page
   */
  private async executeBrowserPdf(
    input: BrowserPdfInput
  ): Promise<{ success: boolean; path?: string; error?: string }> {
    try {
      const result = await this.browserTool.pdf(input.filename);
      return { success: true, path: result.path };
    } catch (err) {
      return { success: false, error: `PDF failed: ${err}` };
    }
  }

  /**
   * Close the browser
   */
  private async executeBrowserClose(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.browserTool.close();
      return { success: true };
    } catch (err) {
      return { success: false, error: `Close failed: ${err}` };
    }
  }

  // ============================================================================
  // OS Management Tools (viewer-only)
  // ============================================================================

  /**
   * Check if current context is from viewer (OS agent)
   * Returns error message if not allowed
   */
  private checkViewerOnly(): string | null {
    const context = this.getActiveContext();
    if (!context) {
      // No context = backward compatibility, allow
      return null;
    }

    if (context.source !== 'viewer') {
      return `Permission denied: This operation is only available from MAMA OS Viewer. Current source: ${context.source}`;
    }

    if (!context.role.systemControl) {
      return `Permission denied: Role "${context.roleName}" does not have system control permissions`;
    }

    return null;
  }

  /**
   * Execute os_add_bot tool - Add a new bot to config
   * Viewer-only: requires systemControl permission
   */
  private async executeAddBot(
    input: AddBotInput
  ): Promise<{ success: boolean; message?: string; error?: string }> {
    // Check viewer-only permission
    const permError = this.checkViewerOnly();
    if (permError) {
      return { success: false, error: permError };
    }

    const { platform, token, bot_token, app_token, default_channel_id, allowed_chats, room_ids } =
      input;

    if (!platform) {
      return { success: false, error: 'Platform is required (discord, telegram, slack, chatwork)' };
    }

    try {
      const config = await loadConfig();

      switch (platform) {
        case 'discord':
          if (!token) {
            return { success: false, error: 'Discord bot token is required' };
          }
          config.discord = {
            enabled: true,
            token,
            default_channel_id,
          };
          break;

        case 'telegram':
          if (!token) {
            return { success: false, error: 'Telegram bot token is required' };
          }
          config.telegram = {
            enabled: true,
            token,
            allowed_chats,
          };
          break;

        case 'slack':
          if (!bot_token || !app_token) {
            return { success: false, error: 'Slack requires both bot_token and app_token' };
          }
          config.slack = {
            enabled: true,
            bot_token,
            app_token,
          };
          break;

        case 'chatwork':
          if (!token) {
            return { success: false, error: 'Chatwork API token is required' };
          }
          config.chatwork = {
            enabled: true,
            api_token: token,
            room_ids,
          };
          break;

        default:
          return { success: false, error: `Unknown platform: ${platform}` };
      }

      await saveConfig(config);

      return {
        success: true,
        message: `${platform} bot added successfully. Restart MAMA to apply changes.`,
      };
    } catch (err) {
      return { success: false, error: `Failed to add bot: ${err}` };
    }
  }

  /**
   * Execute os_set_permissions tool - Modify role permissions
   * Viewer-only: requires systemControl permission
   */
  private async executeSetPermissions(
    input: SetPermissionsInput
  ): Promise<{ success: boolean; message?: string; error?: string }> {
    // Check viewer-only permission
    const permError = this.checkViewerOnly();
    if (permError) {
      return { success: false, error: permError };
    }

    const {
      role,
      allowedTools,
      blockedTools,
      allowedPaths,
      systemControl,
      sensitiveAccess,
      mapSource,
    } = input;

    if (!role) {
      return { success: false, error: 'Role name is required' };
    }

    try {
      const config = await loadConfig();

      // Initialize roles if not present
      if (!config.roles) {
        config.roles = { ...DEFAULT_ROLES };
      }

      // Get or create role definition
      const existingRole = config.roles.definitions[role] || {
        allowedTools: ['mama_*', 'Read'],
      };

      // Update role properties
      const updatedRole: RoleConfig = {
        allowedTools: allowedTools ?? existingRole.allowedTools,
        blockedTools: blockedTools ?? existingRole.blockedTools,
        allowedPaths: allowedPaths ?? existingRole.allowedPaths,
        systemControl: systemControl ?? existingRole.systemControl,
        sensitiveAccess: sensitiveAccess ?? existingRole.sensitiveAccess,
      };

      // Clean up undefined values
      if (!updatedRole.blockedTools?.length) delete updatedRole.blockedTools;
      if (!updatedRole.allowedPaths?.length) delete updatedRole.allowedPaths;
      if (updatedRole.systemControl === undefined) delete updatedRole.systemControl;
      if (updatedRole.sensitiveAccess === undefined) delete updatedRole.sensitiveAccess;

      config.roles.definitions[role] = updatedRole;

      // Map source to role if specified
      if (mapSource) {
        config.roles.sourceMapping[mapSource] = role;
      }

      await saveConfig(config);

      // Update RoleManager with new config
      this.roleManager.updateRolesConfig(config.roles);

      return {
        success: true,
        message: `Role "${role}" updated successfully.${mapSource ? ` Source "${mapSource}" now maps to this role.` : ''}`,
      };
    } catch (err) {
      return { success: false, error: `Failed to set permissions: ${err}` };
    }
  }

  /**
   * Execute os_get_config tool - Get current configuration
   * Masks sensitive data for non-viewer sources
   */
  private async executeGetConfig(
    input: GetConfigInput
  ): Promise<{ success: boolean; config?: Record<string, unknown>; error?: string }> {
    const { section, includeSensitive } = input;

    try {
      const config = await loadConfig();

      // Determine if we should show sensitive data
      const context = this.getActiveContext();
      const showSensitive =
        includeSensitive && context?.source === 'viewer' && context?.role.sensitiveAccess;

      // Mask sensitive data
      const maskedConfig = this.maskSensitiveData(
        config as unknown as Record<string, unknown>,
        showSensitive
      );

      // Return specific section or full config
      if (section) {
        const sectionData = maskedConfig[section];
        if (sectionData === undefined) {
          return { success: false, error: `Unknown section: ${section}` };
        }
        return { success: true, config: { [section]: sectionData } };
      }

      return { success: true, config: maskedConfig };
    } catch (err) {
      return { success: false, error: `Failed to get config: ${err}` };
    }
  }

  /**
   * Recursively mask sensitive data in config object
   */
  private maskSensitiveData(
    obj: Record<string, unknown>,
    showSensitive: boolean = false
  ): Record<string, unknown> {
    if (showSensitive) {
      return obj;
    }

    const masked: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined) {
        masked[key] = value;
        continue;
      }

      // Check if key is sensitive
      const isSensitive = SENSITIVE_KEYS.some((pattern) =>
        key.toLowerCase().includes(pattern.toLowerCase())
      );

      if (isSensitive && typeof value === 'string' && value.length > 0) {
        // Fully mask sensitive values - don't expose any characters
        // Show only length hint for debugging without revealing content
        masked[key] = `***[${value.length} chars]***`;
      } else if (typeof value === 'object' && !Array.isArray(value)) {
        masked[key] = this.maskSensitiveData(value as Record<string, unknown>, showSensitive);
      } else {
        masked[key] = value;
      }
    }

    return masked;
  }

  /**
   * Execute os_set_model tool - Set model configuration for a role or globally
   * Viewer-only: requires systemControl permission
   *
   * Usage:
   * - Set role-specific model: { role: 'chat_bot', model: 'claude-3-haiku-20240307' }
   * - Set global model: { model: 'claude-sonnet-4-6' }
   */
  private async executeSetModel(
    input: SetModelInput
  ): Promise<{ success: boolean; message?: string; error?: string }> {
    // Check viewer-only permission
    const permError = this.checkViewerOnly();
    if (permError) {
      return { success: false, error: permError };
    }

    const { role, model, maxTurns, timeout } = input;

    if (!model) {
      return { success: false, error: 'Model name is required' };
    }

    // Validate model name format - Claude/Anthropic models only
    // Valid formats per Anthropic API docs:
    // - Pinned snapshots: claude-sonnet-4-20250514, claude-3-5-sonnet-20241022
    // - Rolling aliases: claude-3-7-sonnet-latest, claude-opus-4-latest
    // - Family aliases: claude-opus-4-5, claude-sonnet-4-0
    const claudeModelPattern =
      /^claude-(?:opus|sonnet|haiku|3|3-5|3-7)-?[a-z0-9-]*(?:-\d{8}|-latest)?$/i;
    const isValidModel = claudeModelPattern.test(model);

    if (!isValidModel) {
      return {
        success: false,
        error: `Invalid model name format: ${model}. Expected Claude model format (e.g., claude-sonnet-4-6, claude-opus-4-latest)`,
      };
    }

    if (maxTurns !== undefined && (maxTurns < 1 || maxTurns > 100)) {
      return { success: false, error: 'maxTurns must be between 1 and 100' };
    }

    if (timeout !== undefined && (timeout < 10000 || timeout > 600000)) {
      return { success: false, error: 'timeout must be between 10000ms and 600000ms (10s-10min)' };
    }

    try {
      const config = await loadConfig();

      // If role is specified, update that role's model
      if (role) {
        // Initialize roles if not present
        if (!config.roles) {
          config.roles = { ...DEFAULT_ROLES };
        }

        // Check if role exists
        if (!config.roles.definitions[role]) {
          return {
            success: false,
            error: `Role "${role}" not found. Available roles: ${Object.keys(config.roles.definitions).join(', ')}`,
          };
        }

        // Update role-specific settings
        config.roles.definitions[role].model = model;
        if (maxTurns !== undefined) {
          config.roles.definitions[role].maxTurns = maxTurns;
        }

        await saveConfig(config);

        // Update RoleManager with new config
        this.roleManager.updateRolesConfig(config.roles);

        const changes = [`model: ${model}`];
        if (maxTurns !== undefined) changes.push(`maxTurns: ${maxTurns}`);

        return {
          success: true,
          message: `Role "${role}" updated: ${changes.join(', ')}. New conversations for this role will use these settings.`,
        };
      }

      // No role specified - update global agent config
      if (!config.agent) {
        config.agent = {
          backend: 'claude',
          model: 'claude-sonnet-4-6',
          max_turns: 10,
          timeout: 300000,
        };
      }

      config.agent.model = model;
      if (maxTurns !== undefined) {
        config.agent.max_turns = maxTurns;
      }
      if (timeout !== undefined) {
        config.agent.timeout = timeout;
      }

      await saveConfig(config);

      const changes = [`model: ${model}`];
      if (maxTurns !== undefined) changes.push(`maxTurns: ${maxTurns}`);
      if (timeout !== undefined) changes.push(`timeout: ${timeout}ms`);

      return {
        success: true,
        message: `Global agent settings updated: ${changes.join(', ')}. New conversations will use these settings.`,
      };
    } catch (err) {
      return { success: false, error: `Failed to set model: ${err}` };
    }
  }

  // ============================================================================
  // OS Monitoring Tools (viewer-only)
  // ============================================================================

  /**
   * Callback to get bot status from running gateways
   * Set by the main application when gateways are initialized
   */
  private botStatusCallback: (() => Map<BotPlatform, { running: boolean; error?: string }>) | null =
    null;

  /**
   * Callback to control bots
   * Set by the main application when gateways are initialized
   */
  private botControlCallback:
    | ((
        platform: BotPlatform,
        action: 'start' | 'stop'
      ) => Promise<{ success: boolean; error?: string }>)
    | null = null;

  /**
   * Set the bot status callback (called by main app)
   */
  setBotStatusCallback(
    callback: () => Map<BotPlatform, { running: boolean; error?: string }>
  ): void {
    this.botStatusCallback = callback;
  }

  /**
   * Set the bot control callback (called by main app)
   */
  setBotControlCallback(
    callback: (
      platform: BotPlatform,
      action: 'start' | 'stop'
    ) => Promise<{ success: boolean; error?: string }>
  ): void {
    this.botControlCallback = callback;
  }

  /**
   * Execute os_list_bots tool - List all configured bots and their status
   */
  private async executeListBots(
    input: ListBotsInput
  ): Promise<{ success: boolean; bots?: BotStatus[]; error?: string }> {
    const { platform } = input;

    try {
      const config = await loadConfig();
      const platforms: BotPlatform[] = ['discord', 'telegram', 'slack', 'chatwork'];
      const bots: BotStatus[] = [];

      // Get runtime status if callback is available
      const runtimeStatus = this.botStatusCallback?.() ?? new Map();

      for (const p of platforms) {
        // Skip if filtering by platform
        if (platform && p !== platform) continue;

        const platformConfig = config[p];
        const configured = !!platformConfig;
        const enabled = configured && platformConfig.enabled === true;
        const runtime = runtimeStatus.get(p);

        let status: BotStatus['status'];
        if (!configured) {
          status = 'not_configured';
        } else if (runtime?.running) {
          status = 'running';
        } else if (runtime?.error) {
          status = 'error';
        } else if (enabled) {
          status = 'stopped';
        } else {
          status = 'stopped';
        }

        bots.push({
          platform: p,
          enabled,
          configured,
          status,
          error: runtime?.error,
        });
      }

      return { success: true, bots };
    } catch (err) {
      return { success: false, error: `Failed to list bots: ${err}` };
    }
  }

  /**
   * Execute os_restart_bot tool - Restart a bot
   * Viewer-only: requires systemControl permission
   */
  private async executeRestartBot(
    input: RestartBotInput
  ): Promise<{ success: boolean; message?: string; error?: string }> {
    // Check viewer-only permission
    const permError = this.checkViewerOnly();
    if (permError) {
      return { success: false, error: permError };
    }

    const { platform } = input;

    if (!platform) {
      return { success: false, error: 'Platform is required' };
    }

    if (!this.botControlCallback) {
      return {
        success: false,
        error:
          'Bot control not available. Please restart MAMA server to apply configuration changes.',
      };
    }

    try {
      // Stop then start
      const stopResult = await this.botControlCallback(platform, 'stop');
      if (!stopResult.success && stopResult.error !== 'Bot not running') {
        return { success: false, error: `Failed to stop bot: ${stopResult.error}` };
      }

      // Small delay
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const startResult = await this.botControlCallback(platform, 'start');
      if (!startResult.success) {
        return { success: false, error: `Failed to start bot: ${startResult.error}` };
      }

      return { success: true, message: `${platform} bot restarted successfully` };
    } catch (err) {
      return { success: false, error: `Failed to restart bot: ${err}` };
    }
  }

  /**
   * Execute os_stop_bot tool - Stop a bot
   * Viewer-only: requires systemControl permission
   */
  private async executeStopBot(
    input: StopBotInput
  ): Promise<{ success: boolean; message?: string; error?: string }> {
    // Check viewer-only permission
    const permError = this.checkViewerOnly();
    if (permError) {
      return { success: false, error: permError };
    }

    const { platform } = input;

    if (!platform) {
      return { success: false, error: 'Platform is required' };
    }

    if (!this.botControlCallback) {
      return {
        success: false,
        error:
          'Bot control not available. Manually disable the bot in config.yaml and restart MAMA.',
      };
    }

    try {
      const result = await this.botControlCallback(platform, 'stop');
      if (!result.success) {
        return { success: false, error: `Failed to stop bot: ${result.error}` };
      }

      return { success: true, message: `${platform} bot stopped successfully` };
    } catch (err) {
      return { success: false, error: `Failed to stop bot: ${err}` };
    }
  }

  // ============================================================================
  // PR Review Tools
  // ============================================================================

  private parsePRUrl(url: string): { owner: string; repo: string; prNumber: number } | null {
    const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
    if (!match) return null;
    return { owner: match[1], repo: match[2], prNumber: parseInt(match[3], 10) };
  }

  private async executePrReviewThreads(input: {
    pr_url?: string;
    owner?: string;
    repo?: string;
    pr_number?: number;
  }): Promise<{ success: boolean; threads?: unknown[]; summary?: string; error?: string }> {
    let owner: string;
    let repo: string;
    let prNumber: number;

    if (input.pr_url) {
      const parsed = this.parsePRUrl(input.pr_url);
      if (!parsed) return { success: false, error: `Invalid PR URL: ${input.pr_url}` };
      ({ owner, repo, prNumber } = parsed);
    } else if (input.owner && input.repo && input.pr_number) {
      owner = input.owner;
      repo = input.repo;
      prNumber = input.pr_number;
    } else {
      return { success: false, error: 'Provide pr_url or (owner, repo, pr_number)' };
    }

    try {
      const query = `
        query($owner: String!, $repo: String!, $prNumber: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $prNumber) {
              reviewThreads(last: 100) {
                nodes {
                  id
                  isResolved
                  comments(first: 10) {
                    nodes { path line body author { login } }
                  }
                }
              }
            }
          }
        }
      `;

      const { stdout } = await execFileAsync(
        'gh',
        [
          'api',
          'graphql',
          '-f',
          `query=${query}`,
          '-F',
          `owner=${owner}`,
          '-F',
          `repo=${repo}`,
          '-F',
          `prNumber=${prNumber}`,
        ],
        { timeout: 30000 }
      );

      let data: GHGraphQLResponse;
      try {
        data = JSON.parse(stdout) as GHGraphQLResponse;
      } catch {
        return {
          success: false,
          error: `Failed to parse GitHub API response: ${stdout.substring(0, 200)}`,
        };
      }
      const threads = data.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];

      const unresolved = threads
        .filter((thread) => !thread.isResolved)
        .map((thread) => ({
          id: thread.id,
          comments: thread.comments.nodes.map((comment) => ({
            path: comment.path,
            line: comment.line,
            body: comment.body,
            author: comment.author?.login ?? 'unknown',
          })),
        }));

      // Build summary grouped by file
      const byFile = new Map<string, { line: number | null; body: string; author: string }[]>();
      for (const t of unresolved) {
        const first = t.comments[0];
        if (!first) continue;
        const file = first.path || '(general)';
        const list = byFile.get(file) || [];
        list.push({ line: first.line, body: first.body, author: first.author });
        byFile.set(file, list);
      }

      const summaryLines = [
        `${unresolved.length} unresolved thread(s) across ${byFile.size} file(s)`,
        '',
      ];
      for (const [file, items] of byFile) {
        summaryLines.push(`**${file}** (${items.length})`);
        for (const item of items) {
          const lineRef = item.line ? `L${item.line} ` : '';
          const body = item.body.length > 300 ? item.body.substring(0, 300) + '…' : item.body;
          summaryLines.push(`  • ${lineRef}@${item.author}: ${body}`);
        }
        summaryLines.push('');
      }

      if (byFile.size > 1) {
        summaryLines.push(
          `💡 ${byFile.size} independent files — delegate fixes in parallel (DELEGATE_BG)`
        );
      }

      return { success: true, threads: unresolved, summary: summaryLines.join('\n') };
    } catch (err) {
      return { success: false, error: `Failed to fetch PR threads: ${err}` };
    }
  }

  // ============================================================================
  // ============================================================================
  // Webchat Tools
  // ============================================================================

  /**
   * Execute webchat_send tool — Send message/file to webchat viewer
   * Copies file to outbound directory and returns the path for viewer rendering
   *
   * Note: session_id removed - all files route to shared outbound dir
   */
  private async executeWebchatSend(input: {
    message?: string;
    file_path?: string;
  }): Promise<{ success: boolean; message?: string; outbound_path?: string; error?: string }> {
    const { message, file_path } = input;

    if (!message && !file_path) {
      return { success: false, error: 'Either message or file_path is required' };
    }

    try {
      const outboundDir = join(homedir(), '.mama', 'workspace', 'media', 'outbound');
      mkdirSync(outboundDir, { recursive: true });

      if (file_path) {
        // Expand ~ to home directory
        const homeDir = homedir();
        const expandedPath = file_path.startsWith('~/')
          ? join(homeDir, file_path.slice(2))
          : file_path;

        // Check path permission based on role
        const pathPermission = this.checkPathPermission(expandedPath);
        if (!pathPermission.allowed) {
          return { success: false, error: pathPermission.error };
        }

        // Fallback security for contexts without path restrictions:
        // Only allow reading from ~/.mama/ directory
        const context = this.getActiveContext();
        if (!context?.role.allowedPaths?.length) {
          const mamaDir = resolve(homeDir, '.mama');
          const resolvedPath = resolve(expandedPath);
          // Use path.relative to prevent path traversal (e.g., ~/.mama-evil/)
          const rel = relative(mamaDir, resolvedPath);
          if (rel.startsWith('..') || isAbsolute(rel)) {
            return {
              success: false,
              error: `Access denied: Can only copy files from ${mamaDir}`,
            };
          }
        }

        if (!existsSync(expandedPath)) {
          return { success: false, error: `File not found: ${expandedPath}` };
        }

        // Copy file to outbound directory with timestamp prefix
        const baseName = basename(expandedPath) || 'file';
        const outName = `${Date.now()}_${baseName}`;
        const outPath = join(outboundDir, outName);
        copyFileSync(expandedPath, outPath);

        const viewerPath = `~/.mama/workspace/media/outbound/${outName}`;

        return {
          success: true,
          message: `${message || 'File ready for download.'}\n\nCRITICAL: Include this EXACT path on its own line in your next response so the viewer renders it as a download link:\n${viewerPath}`,
          outbound_path: viewerPath,
        };
      }

      // Text-only message
      return {
        success: true,
        message: message!,
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to send to webchat: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ============================================================================
  // Multi-Agent Delegation
  // ============================================================================

  /**
   * Execute delegate tool — dispatch a task to another agent
   */
  // ── Agent Test ─────────────────────────────────────────────────────────────

  private async executeAgentTest(input: {
    agent_id: string;
    sample_count?: number;
    test_data?: Array<{ input: string; expected?: string }>;
  }): Promise<GatewayToolResult> {
    const permError = this.checkViewerOnly();
    if (permError) {
      return { success: false, error: permError } as GatewayToolResult;
    }

    const { agent_id } = input;
    const sample_count = Number.parseInt(String(input.sample_count ?? 2), 10);
    const resolvedAgentId = this.resolveManagedAgentId(agent_id);
    if (!Number.isFinite(sample_count) || sample_count < 1) {
      securityLogger.warn('[Agent test] Invalid sample_count received', {
        agent_id: resolvedAgentId,
        sample_count: input.sample_count ?? null,
      });
      return {
        success: false,
        error: `Invalid sample_count for '${resolvedAgentId}': ${String(input.sample_count)}. Must be >= 1.`,
      } as GatewayToolResult;
    }

    // Concurrency guard
    if (this.testInFlight.has(resolvedAgentId)) {
      return { success: false, error: 'test_already_running' } as GatewayToolResult;
    }

    const promise = this._runAgentTest(resolvedAgentId, sample_count, input.test_data);
    this.testInFlight.set(resolvedAgentId, promise);
    try {
      return await promise;
    } finally {
      this.testInFlight.delete(resolvedAgentId);
    }
  }

  private async _runAgentTest(
    agentId: string,
    sampleCount: number,
    testData?: Array<{ input: string; expected?: string }>
  ): Promise<GatewayToolResult> {
    if (!this.agentProcessManager || !this.delegationManagerRef) {
      return {
        success: false,
        error: 'agent_timeout: multi-agent not configured',
      } as GatewayToolResult;
    }

    const startTime = Date.now();

    // 1. Collect test data
    let items: Array<{ input: string; expected?: string }>;
    if (testData && testData.length > 0) {
      const normalizedItems: Array<{ input: string; expected?: string }> = [];
      for (let index = 0; index < testData.length; index++) {
        const rawItem = testData[index] as unknown as Record<string, unknown>;
        if (typeof rawItem.input !== 'string') {
          return {
            success: false,
            error: `Invalid test_data[${index}].input: expected string`,
          } as GatewayToolResult;
        }
        if (rawItem.expected !== undefined && typeof rawItem.expected !== 'string') {
          return {
            success: false,
            error: `Invalid test_data[${index}].expected: expected string`,
          } as GatewayToolResult;
        }
        normalizedItems.push({
          input: rawItem.input,
          ...(typeof rawItem.expected === 'string' ? { expected: rawItem.expected } : {}),
        });
      }
      items = normalizedItems;
    } else if (this.rawStore) {
      const agentConfig = this.delegationManagerRef.getAgentConfig(agentId);
      const connectors: string[] = (agentConfig?.connectors as string[]) ?? [];
      if (connectors.length === 0) {
        return {
          success: false,
          error: 'connector_unavailable: no connectors configured',
        } as GatewayToolResult;
      }
      const allItems: Array<{ input: string }> = [];
      const missingConnectors: string[] = [];
      for (const conn of connectors) {
        if (!this.rawStore.hasConnector(conn)) {
          missingConnectors.push(conn);
          continue;
        }
        const recent = this.rawStore.getRecent(conn, sampleCount);
        for (const item of recent) {
          allItems.push({ input: `[${item.type}] ${item.content}` });
        }
        if (allItems.length >= sampleCount) {
          break;
        }
      }
      if (allItems.length === 0) {
        const detail =
          missingConnectors.length > 0
            ? `connector(s) not found: ${missingConnectors.join(', ')}`
            : 'no recent data';
        return {
          success: false,
          error: `connector_unavailable: ${detail}`,
        } as GatewayToolResult;
      }
      items = allItems.slice(0, sampleCount);
    } else {
      return {
        success: false,
        error: 'connector_unavailable: rawStore not available',
      } as GatewayToolResult;
    }

    // 2. Start validation session for agent_test
    const testVer = this.sessionsDb ? getLatestVersion(this.sessionsDb, agentId) : null;
    const testAgentVersion = testVer?.version ?? 0;
    let testValSession: ValidationSessionRow | null = null;
    try {
      testValSession =
        this.validationService?.startSession(agentId, testAgentVersion, 'agent_test', {
          goal: `Test with ${items.length} items`,
          customBeforeSnapshot: JSON.stringify({
            schema_version: 1,
            test_input_summary: items.map((i) => i.input.slice(0, 80)).join('; '),
            sample_count: items.length,
          }),
        }) ?? null;
    } catch (telemetryErr) {
      securityLogger.warn('[Agent test telemetry] Failed to start validation session', {
        agentId,
        testAgentVersion,
        error: telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr),
      });
    }

    // 3. Log test_run start
    let testRunId: number | null = null;
    if (this.sessionsDb) {
      try {
        const row = logActivity(this.sessionsDb, {
          agent_id: agentId,
          agent_version: testAgentVersion,
          type: 'test_run',
          input_summary: `Testing with ${items.length} items`,
          run_id: testValSession?.id,
          execution_status: 'started',
          trigger_reason: 'agent_test',
        });
        testRunId = row.id;
        if (testValSession && this.validationService) {
          this.validationService.recordRun(testValSession.id, { activityId: row.id });
        }
      } catch (telemetryErr) {
        securityLogger.warn('[Agent test telemetry] Failed to persist startup activity', {
          agentId,
          testValSessionId: testValSession?.id ?? null,
          error: telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr),
        });
        testValSession = this.cleanupValidationSessionOnTelemetryFailure(
          testValSession,
          telemetryErr,
          'agent_test startup telemetry failed'
        );
        testRunId = null;
      }
    }

    // 4. Delegate with a small concurrency limit to keep tests responsive
    const results: Array<{ input: string; output?: string; error?: string }> = [];
    const workerCount = Math.min(3, items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: workerCount }, async () => {
      for (;;) {
        const currentIndex = nextIndex;
        nextIndex++;
        if (currentIndex >= items.length) {
          return;
        }
        const item = items[currentIndex];
        try {
          const r = await this.executeDelegate({
            agentId,
            task: `Process this data:\n${item.input}`,
          });
          const rAny = r as Record<string, unknown>;
          const output = r.success
            ? String((rAny.data as Record<string, unknown>)?.response ?? '')
            : undefined;
          results[currentIndex] = {
            input: item.input,
            output,
            error: r.success ? undefined : String(rAny.error ?? 'unknown'),
          };
        } catch (err) {
          results[currentIndex] = { input: item.input, error: String(err) };
        }
      }
    });
    await Promise.all(workers);

    // 5. Auto-score: pass/fail ratio
    const passed = results.filter((r, index) => {
      if (r.error) {
        return false;
      }
      const expected = items[index]?.expected;
      if (expected === undefined) {
        return true;
      }
      return (r.output ?? '').trim() === expected.trim();
    }).length;
    const failed = results.length - passed;
    const autoScore = results.length > 0 ? Math.round((passed / results.length) * 100) : 0;

    if (this.sessionsDb && testRunId) {
      try {
        updateActivityScore(
          this.sessionsDb,
          testRunId,
          autoScore,
          {
            total: results.length,
            passed,
            failed,
            items: results.map((r, index) => ({
              input: r.input.slice(0, 100),
              result:
                r.error ||
                (items[index]?.expected !== undefined &&
                  (r.output ?? '').trim() !== items[index]!.expected!.trim())
                  ? 'fail'
                  : 'pass',
            })),
          },
          'completed'
        );
      } catch (telemetryErr) {
        securityLogger.warn('[Agent test telemetry] Failed to persist test score', {
          agentId,
          testRunId,
          autoScore,
          totalResults: results.length,
          error: telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr),
        });
      }
    }

    // 6. Finalize validation session with test metrics
    const testDurationMs = Date.now() - startTime;
    if (testValSession && this.validationService) {
      try {
        this.validationService.finalizeSession(testValSession.id, {
          execution_status: 'completed',
          metrics: {
            duration_ms: testDurationMs,
            completion_rate: results.length > 0 ? passed / results.length : 0,
            auto_score: autoScore,
          },
          test_input_summary: items.map((i) => i.input.slice(0, 80)).join('; '),
        });
      } catch (telemetryErr) {
        securityLogger.warn('[Agent test telemetry] Failed to finalize validation session', {
          agentId,
          testValSessionId: testValSession.id,
          autoScore,
          totalResults: results.length,
          error: telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr),
        });
      }
    }

    return {
      success: true,
      data: {
        test_run_id: testRunId,
        agent_id: agentId,
        results,
        auto_score: autoScore,
        duration_ms: testDurationMs,
        validation_session_id: testValSession?.id ?? null,
        ...(testRunId === null ? { warning: 'score_not_persisted' } : {}),
      },
    } as GatewayToolResult;
  }

  // ── Delegation ────────────────────────────────────────────────────────────

  private async executeDelegate(input: {
    agentId: string;
    task: string;
    background?: boolean;
    skill?: string;
  }): Promise<GatewayToolResult> {
    const { agentId, task, background } = input;

    // Resolve skill path safely — reject path traversal attempts
    const resolveSkillPath = (skillName: string): string | null => {
      if (!/^[a-zA-Z0-9_-]+$/.test(skillName)) {
        return null;
      }
      const skillsDir = join(homedir(), '.mama', 'skills');
      const resolved = resolve(skillsDir, `${skillName}.md`);
      if (!resolved.startsWith(skillsDir)) {
        return null;
      }
      return resolved;
    };

    if (!this.agentProcessManager || !this.delegationManagerRef) {
      return { success: false, error: 'Multi-agent not configured' } as GatewayToolResult;
    }

    // Permission check using existing DelegationManager
    // Default to 'conductor' when no agent context is set (e.g., MessageRouter path, audit cron)
    // Conductor is the default agent and the only tier-1 agent that should delegate
    const {
      agentId: activeAgentId,
      source: activeSource,
      channelId: activeChannelId,
    } = this.getActiveRouting();
    const sourceAgentId = activeAgentId || 'conductor';
    const check = this.delegationManagerRef.isDelegationAllowed(sourceAgentId, agentId);
    if (!check.allowed) {
      return {
        success: false,
        error: `Delegation denied: ${check.reason}`,
      } as GatewayToolResult;
    }

    // Background delegation: fire-and-forget with async validation finalize
    if (background) {
      const source = activeSource || 'viewer';
      const channelId = activeChannelId || 'default';

      // Start validation session for background delegation
      let bgAgentVersion = 0;
      let bgValSession: ValidationSessionRow | null = null;
      try {
        const bgVer = this.sessionsDb ? getLatestVersion(this.sessionsDb, agentId) : null;
        bgAgentVersion = bgVer?.version ?? 0;
        bgValSession =
          this.validationService?.startSession(agentId, bgAgentVersion, 'delegate_run') ?? null;

        if (this.sessionsDb) {
          const row = logActivity(this.sessionsDb, {
            agent_id: agentId,
            agent_version: bgAgentVersion,
            type: 'task_start',
            input_summary: task?.slice(0, 200),
            run_id: bgValSession?.id,
            execution_status: 'started',
            trigger_reason: 'delegate_run',
          });
          if (bgValSession && this.validationService) {
            this.validationService.recordRun(bgValSession.id, { activityId: row.id });
          }
        }
      } catch (telemetryErr) {
        securityLogger.warn('[Delegation telemetry] Background bootstrap failed', telemetryErr);
        bgAgentVersion = 0;
        bgValSession = this.cleanupValidationSessionOnTelemetryFailure(
          bgValSession,
          telemetryErr,
          'background delegate bootstrap failed'
        );
      }

      // Fire-and-forget: finalize validation when complete
      const bgStartTime = Date.now();
      void (async () => {
        try {
          const process = await this.agentProcessManager!.getProcess(source, channelId, agentId);
          let delegationPrompt = this.delegationManagerRef!.buildDelegationPrompt(
            sourceAgentId,
            task
          );
          if (input.skill) {
            const skillPath = resolveSkillPath(input.skill);
            if (skillPath && existsSync(skillPath)) {
              const skillContent = readFileSync(skillPath, 'utf-8');
              delegationPrompt = skillContent + '\n\n---\n\n' + delegationPrompt;
            }
          }
          const result = await process.sendMessage(delegationPrompt);
          const durationMs = Date.now() - bgStartTime;

          try {
            if (this.sessionsDb) {
              const row = logActivity(this.sessionsDb, {
                agent_id: agentId,
                agent_version: bgAgentVersion,
                type: 'task_complete',
                input_summary: task?.slice(0, 200),
                output_summary: summarizeActivityOutput(result?.response),
                duration_ms: durationMs,
                run_id: bgValSession?.id,
                execution_status: 'completed',
                trigger_reason: 'delegate_run',
              });
              if (bgValSession && this.validationService) {
                this.validationService.recordRun(bgValSession.id, {
                  activityId: row.id,
                  duration_ms: durationMs,
                });
              }
            }
          } catch (telemetryErr) {
            securityLogger.warn(
              '[Delegation telemetry] Background completion activity failed',
              telemetryErr
            );
          }

          try {
            if (bgValSession && this.validationService) {
              this.validationService.finalizeSession(bgValSession.id, {
                execution_status: 'completed',
                metrics: { duration_ms: durationMs },
              });
            }
          } catch (telemetryErr) {
            securityLogger.warn(
              '[Delegation telemetry] Background completion finalize failed',
              telemetryErr
            );
          }
        } catch (err) {
          const durationMs = Date.now() - bgStartTime;
          try {
            if (this.sessionsDb) {
              const row = logActivity(this.sessionsDb, {
                agent_id: agentId,
                agent_version: bgAgentVersion,
                type: 'task_error',
                input_summary: task?.slice(0, 200),
                error_message: String(err),
                duration_ms: durationMs,
                run_id: bgValSession?.id,
                execution_status: 'failed',
                trigger_reason: 'delegate_run',
              });
              if (bgValSession && this.validationService) {
                this.validationService.recordRun(bgValSession.id, {
                  activityId: row.id,
                  duration_ms: durationMs,
                });
              }
            }
          } catch (telemetryErr) {
            securityLogger.warn(
              '[Delegation telemetry] Background failure activity failed',
              telemetryErr
            );
          }
          try {
            if (bgValSession && this.validationService) {
              this.validationService.finalizeSession(bgValSession.id, {
                execution_status: 'failed',
                error_message: String(err),
                metrics: { duration_ms: durationMs },
              });
            }
          } catch (telemetryErr) {
            securityLogger.warn(
              '[Delegation telemetry] Background failure finalize failed',
              telemetryErr
            );
          }
        }
      })();

      return {
        success: true,
        data: { agentId, background: true, message: 'Background task submitted' },
      } as GatewayToolResult;
    }

    // Synchronous delegation with retry + backoff for resilience
    const source = activeSource || 'viewer';
    const channelId = activeChannelId || 'default';
    const startTime = Date.now();

    // Start validation session for this delegation
    let agentVersion = 0;
    let valSession: ValidationSessionRow | null = null;
    try {
      const ver = this.sessionsDb ? getLatestVersion(this.sessionsDb, agentId) : null;
      agentVersion = ver?.version ?? 0;
      valSession =
        this.validationService?.startSession(agentId, agentVersion, 'delegate_run') ?? null;

      if (this.sessionsDb) {
        const row = logActivity(this.sessionsDb, {
          agent_id: agentId,
          agent_version: agentVersion,
          type: 'task_start',
          input_summary: task?.slice(0, 200),
          run_id: valSession?.id,
          execution_status: 'started',
          trigger_reason: 'delegate_run',
        });
        if (valSession && this.validationService) {
          this.validationService.recordRun(valSession.id, { activityId: row.id });
        }
      }
    } catch (telemetryErr) {
      securityLogger.warn('[Delegation telemetry] Validation bootstrap failed', telemetryErr);
      agentVersion = 0;
      valSession = this.cleanupValidationSessionOnTelemetryFailure(
        valSession,
        telemetryErr,
        'delegate bootstrap failed'
      );
    }

    const MAX_RETRIES = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const process = await this.agentProcessManager.getProcess(source, channelId, agentId);

        let delegationPrompt = this.delegationManagerRef.buildDelegationPrompt(sourceAgentId, task);

        // Inject skill content if specified
        if (input.skill) {
          const skillPath = resolveSkillPath(input.skill);
          if (skillPath && existsSync(skillPath)) {
            const skillContent = readFileSync(skillPath, 'utf-8');
            delegationPrompt = skillContent + '\n\n---\n\n' + delegationPrompt;
          }
        }

        // Inject channel history for fresh processes (no prior context)
        const sessionId = process.getSessionId?.();
        if (!sessionId || attempt > 0) {
          try {
            const { getChannelHistory } = await import('../gateways/channel-history.js');
            const channelHistory = getChannelHistory();
            if (channelHistory) {
              const historyContext = channelHistory.formatForContext(channelId, '', agentId);
              if (historyContext) {
                delegationPrompt = `${historyContext}\n\n${delegationPrompt}`;
              }
            }
          } catch {
            // Channel history injection is best-effort
          }
        }

        const result = await process.sendMessage(delegationPrompt);
        const durationMs = Date.now() - startTime;

        try {
          if (this.sessionsDb) {
            const row = logActivity(this.sessionsDb, {
              agent_id: agentId,
              agent_version: agentVersion,
              type: 'task_complete',
              input_summary: task?.slice(0, 200),
              output_summary: summarizeActivityOutput(result.response),
              duration_ms: durationMs,
              run_id: valSession?.id,
              execution_status: 'completed',
              trigger_reason: 'delegate_run',
            });
            if (valSession && this.validationService) {
              this.validationService.recordRun(valSession.id, {
                activityId: row.id,
                duration_ms: durationMs,
              });
            }
          }
        } catch (telemetryErr) {
          securityLogger.warn('[Delegation telemetry] Completion activity failed', telemetryErr);
        }

        try {
          if (valSession && this.validationService) {
            this.validationService.finalizeSession(valSession.id, {
              execution_status: 'completed',
              metrics: { duration_ms: durationMs },
            });
          }
        } catch (telemetryErr) {
          securityLogger.warn('[Delegation telemetry] Completion finalize failed', telemetryErr);
        }

        return {
          success: true,
          data: { agentId, response: result.response, duration_ms: durationMs },
        } as GatewayToolResult;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const isBusy = lastError.message.includes('busy');
        const isCrash = lastError.message.includes('exited with code');

        if (isCrash) {
          this.agentProcessManager.stopProcess(source, channelId, agentId);
        }

        if (attempt < MAX_RETRIES - 1 && (isBusy || isCrash)) {
          await new Promise((r) => setTimeout(r, this._retryDelayMs * (attempt + 1)));
          continue;
        }
        break;
      }
    }

    const failedDurationMs = Date.now() - startTime;
    try {
      if (this.sessionsDb) {
        const row = logActivity(this.sessionsDb, {
          agent_id: agentId,
          agent_version: agentVersion,
          type: 'task_error',
          input_summary: task?.slice(0, 200),
          error_message: lastError?.message,
          duration_ms: failedDurationMs,
          run_id: valSession?.id,
          execution_status: 'failed',
          trigger_reason: 'delegate_run',
        });
        if (valSession && this.validationService) {
          this.validationService.recordRun(valSession.id, {
            activityId: row.id,
            duration_ms: failedDurationMs,
          });
        }
      }
    } catch (telemetryErr) {
      securityLogger.warn('[Delegation telemetry] Failure activity failed', telemetryErr);
    }

    try {
      if (valSession && this.validationService) {
        this.validationService.finalizeSession(valSession.id, {
          execution_status: 'failed',
          error_message: lastError?.message,
          metrics: { duration_ms: failedDurationMs },
        });
      }
    } catch (telemetryErr) {
      securityLogger.warn('[Delegation telemetry] Failure finalize failed', telemetryErr);
    }

    return {
      success: false,
      error: `Delegation to ${agentId} failed after ${MAX_RETRIES} attempts: ${lastError?.message}`,
    } as GatewayToolResult;
  }

  /**
   * Execute Obsidian CLI command on the wiki vault.
   */
  private async executeObsidian(input: {
    command: string;
    args?: Record<string, string>;
  }): Promise<GatewayToolResult> {
    const { command, args } = input;

    if (!this.obsidianVaultPath) {
      return {
        success: false,
        error: 'Wiki vault path not configured',
      } as GatewayToolResult;
    }

    // Obsidian CLI syntax: obsidian <command> key=value ... [flags]
    // Vault is not passed as path — Obsidian uses the default/focused vault
    const cliArgs = [command];
    for (const [key, value] of Object.entries(args || {})) {
      if (value === 'true' && ['silent', 'overwrite', 'total'].includes(key)) {
        cliArgs.push(key);
      } else {
        cliArgs.push(`${key}=${value}`);
      }
    }

    try {
      const { stdout } = await execFileAsync('obsidian', cliArgs, {
        timeout: 15000,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
      });
      return {
        success: true,
        data: { output: stdout.trim() },
      } as GatewayToolResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not enabled') || msg.includes('ENOENT') || msg.includes('not running')) {
        return {
          success: false,
          error: 'Obsidian CLI unavailable (app not running). Use wiki_publish fallback.',
        } as GatewayToolResult;
      }
      return {
        success: false,
        error: `Obsidian CLI error: ${msg.substring(0, 500)}`,
      } as GatewayToolResult;
    }
  }

  private async executeCodeAct(input: { code: string }): Promise<GatewayToolResult> {
    const { CodeActSandbox, HostBridge } = await import('./code-act/index.js');
    const sandbox = new CodeActSandbox();
    const bridge = new HostBridge(this);
    const context = this.getActiveContext();
    const tier = (context?.tier ?? 1) as 1 | 2 | 3;
    bridge.injectInto(sandbox, tier, context?.role);

    const result = await sandbox.execute(input.code);

    return {
      success: result.success,
      message: result.success
        ? JSON.stringify({ value: result.value, logs: result.logs, metrics: result.metrics })
        : `Code-Act error: ${result.error?.message || 'Unknown error'}`,
    } as GatewayToolResult;
  }

  /**
   * Handle mama_add — auto-extract facts from conversation content with derived memory scopes.
   */
  private async handleMamaAdd(input: { content: string }): Promise<GatewayToolResult> {
    const context = this.getActiveContext();
    if (!context) {
      return {
        success: false,
        error: 'mama_add requires an active agent context',
      } as GatewayToolResult;
    }

    const scopes = deriveMemoryScopes({
      source: context.source,
      channelId: context.session.channelId,
      userId: context.session.userId,
      projectId: process.env.MAMA_WORKSPACE || process.cwd(),
    });

    return this.handleMamaIngest({
      ...input,
      scopes,
    });
  }

  private async handleMamaIngest(input: {
    content: string;
    scopes?: unknown;
  }): Promise<GatewayToolResult> {
    const { content } = input;
    if (!content || typeof content !== 'string') {
      return {
        success: false,
        error: 'content is required and must be a string',
      } as GatewayToolResult;
    }

    try {
      const api = await this.initializeMAMAApi();
      if (!api.ingestMemory) {
        return {
          success: false,
          error: 'Memory ingest API not available.',
        } as GatewayToolResult;
      }

      const context = this.getActiveContext();
      const fallbackScopes = context
        ? deriveMemoryScopes({
            source: context.source,
            channelId: context.session.channelId,
            userId: context.session.userId,
            projectId: process.env.MAMA_WORKSPACE || process.cwd(),
          })
        : [];

      let scopes = fallbackScopes;
      if (Array.isArray(input.scopes) && input.scopes.length > 0) {
        const derivedIds = new Set(fallbackScopes.map((s) => `${s.kind}:${s.id}`));
        const allInDerived = input.scopes.every((s) => derivedIds.has(`${s.kind}:${s.id}`));
        scopes = allInDerived ? input.scopes : fallbackScopes;
      }

      if (scopes.length === 0) {
        return {
          success: false,
          error: 'mama_ingest requires scopes (provide via input or active agent context)',
        } as GatewayToolResult;
      }

      const result = await api.ingestMemory({
        content: content.substring(0, 10_000),
        scopes,
        source: {
          package: 'standalone',
          source_type: 'gateway_tool_executor',
          source: context?.source || null,
        },
      });

      return {
        success: true,
        extracted: 1,
        saved: 1,
        result,
      } as GatewayToolResult;
    } catch (err) {
      return {
        success: false,
        error: `Ingest failed: ${err instanceof Error ? err.message : String(err)}`,
      } as GatewayToolResult;
    }
  }

  private async handleMamaRecall(input: RecallInput): Promise<GatewayToolResult> {
    const api = await this.initializeMAMAApi();
    if (!api.recallMemory || typeof input.query !== 'string' || input.query.length === 0) {
      return {
        success: false,
        error: 'query is required and recallMemory API must be available',
      } as GatewayToolResult;
    }

    const context = this.getActiveContext();
    const fallbackScopes = context
      ? deriveMemoryScopes({
          source: context.source,
          channelId: context.session.channelId,
          userId: context.session.userId,
          projectId: process.env.MAMA_WORKSPACE || process.cwd(),
        })
      : [];
    let scopes = fallbackScopes;
    if (Array.isArray(input.scopes) && input.scopes.length > 0) {
      const derivedIds = new Set(fallbackScopes.map((s) => `${s.kind}:${s.id}`));
      const allInDerived = input.scopes.every((s) => derivedIds.has(`${s.kind}:${s.id}`));
      if (allInDerived)
        scopes = fallbackScopes.filter((s) =>
          input.scopes!.some((is) => is.kind === s.kind && is.id === s.id)
        );
    }

    if (scopes.length === 0) {
      return {
        success: false,
        error: 'mama_recall requires scopes (provide via input or active agent context)',
      } as GatewayToolResult;
    }

    try {
      const bundle = await api.recallMemory(input.query, {
        scopes,
        includeProfile: true,
      });
      return { success: true, bundle } as GatewayToolResult;
    } catch (err) {
      return {
        success: false,
        error: `Recall failed: ${err instanceof Error ? err.message : String(err)}`,
      } as GatewayToolResult;
    }
  }

  static getValidTools(): GatewayToolName[] {
    return [...VALID_TOOLS];
  }

  /**
   * Check if a tool name is valid
   */
  static isValidTool(toolName: string): toolName is GatewayToolName {
    return VALID_TOOLS.includes(toolName as GatewayToolName);
  }
}

function isTruthyEnv(name: string): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return false;
  }
  return TRUTHY_ENV_VALUES.has(value.trim().toLowerCase());
}
