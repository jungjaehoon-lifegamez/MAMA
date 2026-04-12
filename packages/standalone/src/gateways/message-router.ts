/**
 * Message Router for unified messenger handling
 *
 * Routes messages from different platforms through a unified pipeline:
 * 1. Normalize message format
 * 2. Load/create session context
 * 3. Create AgentContext with role permissions
 * 4. Inject proactive context (related decisions)
 * 5. Call Agent Loop with context
 * 6. Update session context
 * 7. Return response
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { SessionStore } from './session-store.js';
import { getChannelHistory } from './channel-history.js';
import { ContextInjector, type MamaApiClient } from './context-injector.js';
import type {
  NormalizedMessage,
  MessageRouterConfig,
  Session,
  RelatedDecision,
  ContentBlock,
} from './types.js';
import { COMPLETE_AUTONOMOUS_PROMPT } from '../onboarding/complete-autonomous-prompt.js';
import { getSessionPool, buildChannelKey } from '../agent/session-pool.js';
import { loadComposedSystemPrompt, getGatewayToolsPrompt } from '../agent/agent-loop.js';
import { RoleManager, getRoleManager } from '../agent/role-manager.js';
import { createAgentContext } from '../agent/context-prompt-builder.js';
import { PromptEnhancer } from '../agent/prompt-enhancer.js';
import type { EnhancedPromptContext } from '../agent/prompt-enhancer.js';
import type { RuleContext } from '../agent/yaml-frontmatter.js';
import type { AgentContext } from '../agent/types.js';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';
import {
  AuditTaskQueue,
  type MemoryAuditAckLike,
  type MemoryAuditJob,
} from '../memory/audit-task-queue.js';
import { AgentNoticeQueue } from '../memory/agent-notice-queue.js';
import { deriveMemoryScopes } from '../memory/scope-context.js';
import { formatAuditNotice, formatRecallBundle } from '../memory/recall-bundle-formatter.js';
import { extractSaveCandidates } from '../memory/save-candidate-extractor.js';
import { getLatestVersion, logActivity } from '../db/agent-store.js';

const { DebugLogger } = debugLogger as {
  DebugLogger: new (context?: string) => {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};
const logger = new DebugLogger('MessageRouter');

/**
 * Agent Loop interface for message processing
 */
export interface AgentLoopClient {
  /**
   * Run the agent loop with a prompt
   */
  run(prompt: string, options?: AgentLoopOptions): Promise<{ response: string }>;
  /**
   * Run the agent loop with multimodal content
   */
  runWithContent?(
    content: ContentBlock[],
    options?: AgentLoopOptions
  ): Promise<{ response: string }>;
}

export interface MemoryAgentProcessLike {
  sendMessage(
    content: string
  ): Promise<{ response?: string; ack?: MemoryAuditAckLike } | { response?: string }>;
}

export interface MemoryAgentProcessManagerLike {
  getSharedProcess(agentId: 'memory'): Promise<MemoryAgentProcessLike>;
}

export interface GatewayRegistry {
  sendMessage(source: string, channelId: string, text: string): Promise<void>;
}

/**
 * Options for agent loop execution
 */
export interface AgentLoopOptions {
  /** System prompt to prepend */
  systemPrompt?: string;
  /** User identifier */
  userId?: string;
  /** Maximum turns */
  maxTurns?: number;
  /** Claude model to use (overrides default) */
  model?: string;
  /** Message source (for lane-based concurrency) */
  source?: string;
  /** Channel ID (for lane-based concurrency) */
  channelId?: string;
  /** Agent context for role-aware execution */
  agentContext?: AgentContext;
  /** Resume existing CLI session (skips system prompt injection) */
  resumeSession?: boolean;
  /** CLI session ID from session pool (prevents double-locking) */
  cliSessionId?: string;
  /** Streaming callbacks for real-time progress events */
  streamCallbacks?: import('../agent/types.js').StreamCallbacks;
}

/**
 * Message processing result
 */
export interface ProcessingResult {
  /** Response text from agent */
  response: string;
  /** Session ID used */
  sessionId: string;
  /** Related decisions that were injected */
  injectedDecisions: RelatedDecision[];
  /** Processing duration in milliseconds */
  duration: number;
}

/**
 * Sensitive patterns that should only be configured via MAMA OS Viewer
 */
const SENSITIVE_PATTERNS = [
  /discord.*token/i,
  /slack.*token/i,
  /telegram.*token/i,
  /chatwork.*token/i,
  /api[_-]?key/i,
  /secret[_-]?key/i,
  /bot[_-]?token/i,
  /oauth.*token/i,
  /설정.*토큰/i,
  /토큰.*설정/i,
  /키.*설정/i,
  /비밀.*키/i,
];

const KOREAN_TARGETS = new Set(['korean', '한국어']);
const VIEWER_CONTEXT_AGENT_LIST_LIMIT = 5;
const VIEWER_CONTEXT_ALERT_LIMIT = 3;

/**
 * Sanitize user-supplied text before injecting into prompts.
 * Escapes characters that can alter prompt structure.
 */
function sanitizeForPrompt(text: string): string {
  if (text === null || text === undefined) {
    return '';
  }

  const str = typeof text === 'string' ? text : String(text);

  return str
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function stripGatewayDecorations(text: string): string {
  return text.replace(/^(?:\s*\|\|[\s\S]*?\|\|\s*)+/u, '').trim();
}

/**
 * Check if message contains sensitive configuration request
 */
function containsSensitiveRequest(text: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

function normalizeTranslationTargetLanguage(
  value: MessageRouterConfig['translationTargetLanguage'],
  fallback: string
): string {
  if (value === null || value === undefined) {
    return fallback;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : fallback;
}

/**
 * Message Router class
 *
 * Central hub for processing messages from all messenger platforms.
 */
export class MessageRouter {
  private sessionStore: SessionStore;
  private contextInjector: ContextInjector;
  private mamaApi: MamaApiClient;
  private agentLoop: AgentLoopClient;
  private config: Required<MessageRouterConfig>;
  private roleManager: RoleManager;
  private promptEnhancer: PromptEnhancer;
  private cachedGatewayToolsPrompt: string | null = null;
  private gatewayRegistry: GatewayRegistry | null = null;
  private memoryAgentProcessManager?: MemoryAgentProcessManagerLike;
  private memoryAuditQueue?: AuditTaskQueue;
  private memoryNoticeQueue = new AgentNoticeQueue();
  private memoryAuditCooldowns = new Map<string, number>();
  private memoryAgentStats = {
    turnsObserved: 0,
    candidatesDetected: 0,
    factsExtracted: 0,
    factsSaved: 0,
    acksApplied: 0,
    acksSkipped: 0,
    acksFailed: 0,
    lastExtraction: null as number | null,
    recentExtractions: [] as Array<{
      topic: string;
      timestamp: number;
      channelKey?: string;
      status: 'applied' | 'skipped' | 'failed';
    }>,
  };

  // Sessions DB for conductor activity logging
  private sessionsDb: import('../sqlite.js').default | null = null;
  setSessionsDb(db: import('../sqlite.js').default): void {
    this.sessionsDb = db;
  }

  // UI command queue for page context awareness
  private uiCommandQueue: import('../api/ui-command-handler.js').UICommandQueue | null = null;
  setUICommandQueue(queue: import('../api/ui-command-handler.js').UICommandQueue): void {
    this.uiCommandQueue = queue;
  }

  // Validation service for memory agent + conductor sessions
  private validationService:
    | import('../validation/session-service.js').ValidationSessionService
    | null = null;
  setValidationService(
    svc: import('../validation/session-service.js').ValidationSessionService
  ): void {
    this.validationService = svc;
  }

  private getPageContextPrefix(message: NormalizedMessage): string {
    if (!this.uiCommandQueue) {
      return '';
    }
    if (message.source !== 'viewer') {
      return '';
    }
    const ctx = this.uiCommandQueue.getPageContext(message.channelId);
    if (!ctx || !ctx.currentRoute) {
      return '';
    }
    const data = (ctx.pageData as Record<string, unknown> | null) ?? null;

    // Build rich context that tells conductor exactly what the user sees
    const lines: string[] = ['<viewer-context>'];
    lines.push(`route: ${sanitizeForPrompt(ctx.currentRoute)}`);
    if (ctx.selectedItem?.type && ctx.selectedItem?.id) {
      lines.push(
        `selected_item: ${sanitizeForPrompt(ctx.selectedItem.type)}:${sanitizeForPrompt(ctx.selectedItem.id)}`
      );
    }
    if (data?.summary) {
      lines.push(`summary: ${sanitizeForPrompt(String(data.summary))}`);
    }

    if (data?.pageType === 'agent-list' && Array.isArray(data.agents)) {
      lines.push(`agents:`);
      const selectedAgentId = ctx.selectedItem?.type === 'agent' ? ctx.selectedItem.id : null;
      const allAgents = data.agents as Array<Record<string, unknown>>;
      const shownAgents =
        selectedAgentId !== null
          ? allAgents.filter((agent) => String(agent.id ?? '') === selectedAgentId).slice(0, 1)
          : allAgents.slice(0, VIEWER_CONTEXT_AGENT_LIST_LIMIT);
      for (const a of shownAgents) {
        const parts = [`  - ${sanitizeForPrompt(String(a.name || a.id || 'unknown'))}`];
        if (a.validation) parts.push(`validation:${sanitizeForPrompt(String(a.validation))}`);
        if (a.enabled === false) parts.push('(disabled)');
        if (a.system === true) parts.push('(system)');
        lines.push(parts.join(' '));
      }
      const totalAgents = allAgents.length;
      const enabledAgents = allAgents.filter((agent) => agent.enabled !== false).length;
      const disabledAgents = totalAgents - enabledAgents;
      const systemAgents = allAgents.filter((agent) => agent.system === true).length;
      const hiddenAgents = Math.max(0, totalAgents - shownAgents.length);
      lines.push(
        `agent_counts: total=${totalAgents} enabled=${enabledAgents} disabled=${disabledAgents} system=${systemAgents}`
      );
      if (hiddenAgents > 0) {
        lines.push(`(+${hiddenAgents} more agents)`);
      }
      if (Array.isArray(data.alerts) && (data.alerts as string[]).length > 0) {
        const shownAlerts = (data.alerts as string[]).slice(0, VIEWER_CONTEXT_ALERT_LIMIT);
        lines.push(
          `alerts: ${shownAlerts.map((item) => sanitizeForPrompt(String(item))).join(', ')}`
        );
        const hiddenAlerts = (data.alerts as string[]).length - shownAlerts.length;
        if (hiddenAlerts > 0) {
          lines.push(`(+${hiddenAlerts} more alerts)`);
        }
      }
    }

    if (data?.pageType === 'agent-detail') {
      const agent = data.agent as Record<string, unknown> | null;
      if (agent) {
        lines.push(
          `agent: ${sanitizeForPrompt(String(agent.name))} (${sanitizeForPrompt(String(agent.id))}) v${sanitizeForPrompt(String(agent.version))} tier:${sanitizeForPrompt(String(agent.tier))} model:${sanitizeForPrompt(String(agent.model))}`
        );
      }
      if (data.activeTab) lines.push(`active_tab: ${sanitizeForPrompt(String(data.activeTab))}`);
      const val = data.validation as Record<string, unknown> | null;
      if (val) {
        lines.push(
          `validation: outcome=${sanitizeForPrompt(String(val.outcome))} execution=${sanitizeForPrompt(String(val.execution))} baseline=v${sanitizeForPrompt(String(val.baseline_version ?? 'none'))}`
        );
      }
    }

    lines.push('</viewer-context>');
    return lines.join('\n') + '\n';
  }

  setGatewayRegistry(registry: GatewayRegistry): void {
    this.gatewayRegistry = registry;
  }

  setMemoryAgent(processManager: MemoryAgentProcessManagerLike): void {
    this.memoryAgentProcessManager = processManager;
    this.memoryAuditQueue = new AuditTaskQueue(async (job) => {
      const process = await processManager.getSharedProcess('memory');
      const result = await process.sendMessage(this.buildMemoryAuditPrompt(job));
      if (
        result &&
        typeof result === 'object' &&
        'ack' in result &&
        result.ack &&
        typeof result.ack === 'object'
      ) {
        return result.ack as MemoryAuditAckLike;
      }

      return this.classifyMemoryAuditResponse(
        typeof result?.response === 'string' ? result.response : ''
      );
    });
  }

  getMemoryAgentStats() {
    return { ...this.memoryAgentStats };
  }

  /**
   * Public API for auditing a conversation via the memory agent.
   * Used by the /api/mama/audit-conversation endpoint for benchmarking.
   * Bypasses cooldown and candidate detection — caller provides conversation + optional candidates.
   */
  async auditConversation(job: {
    conversation: string;
    scopes: Array<{ kind: string; id: string }>;
    candidates?: Array<{ kind: string; topicHint?: string; confidence: number; summary: string }>;
  }): Promise<MemoryAuditAckLike> {
    if (!this.memoryAuditQueue) {
      throw new Error('Memory agent not initialized — cannot audit conversation');
    }
    const auditJob: MemoryAuditJob = {
      turnId: `audit_${Date.now()}`,
      channelKey: 'api:default',
      source: 'api',
      scopeContext: job.scopes.map((s) => ({
        kind: s.kind as 'global' | 'user' | 'channel' | 'project',
        id: s.id,
      })),
      conversation: job.conversation,
      candidates: job.candidates?.map((c) => ({
        id: `api_${Date.now()}`,
        kind: c.kind as 'decision' | 'preference' | 'fact' | 'change',
        topicHint: c.topicHint,
        confidence: c.confidence,
        summary: c.summary,
        evidence: [c.summary],
        channelKey: 'api:default',
        source: 'api',
        channelId: 'default',
        createdAt: Date.now(),
      })),
    };
    return this.memoryAuditQueue.enqueue(auditJob);
  }

  constructor(
    sessionStore: SessionStore,
    agentLoop: AgentLoopClient,
    mamaApi: MamaApiClient,
    config: MessageRouterConfig = {}
  ) {
    this.sessionStore = sessionStore;
    this.agentLoop = agentLoop;
    this.mamaApi = mamaApi;
    this.config = {
      similarityThreshold: config.similarityThreshold ?? 0.7,
      maxDecisions: config.maxDecisions ?? 3,
      maxTurns: config.maxTurns ?? 5,
      maxResponseLength: config.maxResponseLength ?? 200,
      translationTargetLanguage: normalizeTranslationTargetLanguage(
        config.translationTargetLanguage,
        'Korean'
      ),
      backend: config.backend ?? 'claude',
    };
    this.roleManager = getRoleManager();
    this.promptEnhancer = new PromptEnhancer();

    this.contextInjector = new ContextInjector(mamaApi, {
      similarityThreshold: this.config.similarityThreshold,
      maxDecisions: this.config.maxDecisions,
    });
  }

  /**
   * Create AgentContext for a message
   * Determines role based on message source and builds context
   */
  private createAgentContext(message: NormalizedMessage, sessionId: string): AgentContext {
    const { roleName, role } = this.roleManager.getRoleForSource(message.source);
    const capabilities = this.roleManager.getCapabilities(role);
    const limitations = this.roleManager.getLimitations(role);

    const ctx = createAgentContext(
      message.source,
      roleName,
      role,
      {
        sessionId,
        channelId: message.channelId,
        userId: message.userId,
        userName: message.metadata?.username,
      },
      capabilities,
      limitations
    );
    ctx.backend = this.config.backend;
    return ctx;
  }

  /**
   * Check if message should trigger auto-translation
   * Returns true for short messages or image-related text
   */
  private shouldAutoTranslate(text: string): boolean {
    if (!text) return true; // Empty text = just image

    const trimmed = text.trim();

    // Very short messages (< 5 chars) are likely just acknowledgments
    if (trimmed.length < 5) return true;

    // Common image-related phrases
    const imageKeywords = ['이미지', '사진', 'image', 'picture', 'pic', 'screenshot', '스샷'];
    const hasImageKeyword = imageKeywords.some((kw) => trimmed.toLowerCase().includes(kw));

    return hasImageKeyword;
  }

  /**
   * Process a normalized message and return response
   * @param message - The normalized message to process
   * @param processOptions - Optional callbacks for async notifications
   * @param processOptions.onQueued - Called immediately if session is busy (message queued)
   */
  async process(
    message: NormalizedMessage,
    processOptions?: {
      onQueued?: () => void;
      onStream?: import('../agent/types.js').StreamCallbacks;
    }
  ): Promise<ProcessingResult> {
    const startTime = Date.now();

    // Security: Block sensitive configuration requests from non-viewer sources
    if (message.source !== 'viewer' && containsSensitiveRequest(message.text)) {
      const securityResponse = `🔒 **Security Notice**

For security reasons, token and API key configuration must be done through MAMA OS.

Please visit: **http://localhost:3847/viewer**

Go to the **Settings** tab to configure:
- Discord Bot Token
- Slack Bot/App Tokens
- Telegram Bot Token
- Chatwork API Token

This protects your credentials from being exposed in chat logs.`;

      return {
        response: securityResponse,
        sessionId: 'security-block',
        injectedDecisions: [],
        duration: Date.now() - startTime,
      };
    }

    // 1. Get or create session (by source + channelId)
    const session = this.sessionStore.getOrCreate(
      message.source,
      message.channelId,
      message.userId,
      message.channelName
    );

    // 2. Check if session is busy (another request in progress)
    const channelKey = buildChannelKey(message.source, message.channelId);
    const sessionPool = getSessionPool();
    const initialSession = sessionPool.getSession(channelKey);
    let cliSessionId = initialSession.sessionId;
    let isNewCliSession = initialSession.isNew;
    const busy = initialSession.busy;

    // Track lock ownership for proper cleanup in finally block
    let acquiredLock = !busy; // If not busy, we acquired lock from initialSession

    // If session is busy, notify caller immediately and wait for it to be released
    if (busy) {
      logger.debug(`Session busy for ${channelKey}, notifying client`);
      processOptions?.onQueued?.();

      // Wait for session to be released (poll with timeout)
      const maxWaitMs = 300000; // 5 minutes max wait
      const pollIntervalMs = 500;
      const waitStart = Date.now();
      let lastLogTime = waitStart;

      while (Date.now() - waitStart < maxWaitMs) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        // Use read-only peek to avoid side effects (no lock increment)
        const check = sessionPool.peekSession(channelKey);
        if (!check.busy) {
          logger.debug(
            `Session released for ${channelKey} after ${Math.round((Date.now() - waitStart) / 1000)}s`
          );
          break;
        }
        // Log every 30 seconds
        if (Date.now() - lastLogTime >= 30000) {
          logger.debug(
            `Still waiting for session ${channelKey} (${Math.round((Date.now() - waitStart) / 1000)}s)...`
          );
          lastLogTime = Date.now();
        }
      }

      // Re-acquire session after wait (properly locks it this time)
      const reacquired = sessionPool.getSession(channelKey);
      if (reacquired.busy) {
        // Still busy after timeout - we never acquired the lock
        throw new Error(`Session for ${channelKey} timed out after ${maxWaitMs / 1000}s`);
      }
      cliSessionId = reacquired.sessionId;
      isNewCliSession = reacquired.isNew;
      acquiredLock = true; // Successfully acquired lock after wait
    }

    // Save user message immediately for crash/refresh resilience
    this.sessionStore.appendMessage(session.id, {
      role: 'user',
      content: message.text,
      timestamp: Date.now(),
    });

    // 3. Create AgentContext for role-aware execution
    const agentContext = this.createAgentContext(message, session.id);
    logger.debug(`Created context: ${agentContext.roleName}@${agentContext.platform}`);

    // 4-6. Build system prompt
    // CONTINUE turns: Codex server retains full conversation via threadId,
    // so skip expensive prompt rebuilding (embedding search, DB history, etc.)
    let systemPrompt: string;

    // Always enhance for per-message skill/keyword injection
    const workspacePath = process.env.MAMA_WORKSPACE || join(homedir(), '.mama', 'workspace');
    const ruleContext: RuleContext | undefined = agentContext
      ? { agentId: agentContext.roleName, channelId: message.channelId }
      : undefined;
    const enhanced = await this.promptEnhancer.enhance(message.text, workspacePath, ruleContext);

    // CONTINUE: skip expensive embedding search — Codex retains full conversation via threadId
    const context = isNewCliSession
      ? await this.contextInjector.getRelevantContext(message.text)
      : { prompt: '', decisions: [], hasContext: false };

    if (!isNewCliSession) {
      systemPrompt = '';
      logger.info('CONTINUE turn: skipping context injection');
    } else {
      // NEW session: full prompt build
      const sessionStartupContext = await this.contextInjector.getSessionStartupContext({
        source: message.source,
        channelId: message.channelId,
      });
      const historyContext = message.metadata?.historyContext;
      systemPrompt = this.buildSystemPrompt(
        session,
        context.prompt,
        historyContext,
        sessionStartupContext,
        agentContext,
        enhanced,
        isNewCliSession
      );
    }

    // 7. Run agent loop (with session info for lane-based concurrency)
    const roleModel = agentContext.role.model;
    if (!roleModel) {
      throw new Error(
        `No model configured for role "${agentContext.roleName}".\n\n` +
          'To fix this, set model in config.yaml:\n' +
          '  Claude: claude login → roles.definitions.' +
          agentContext.roleName +
          '.model: claude-sonnet-4-6\n' +
          '  Codex:  codex login → roles.definitions.' +
          agentContext.roleName +
          '.model: gpt-5.3-codex\n\n' +
          'Or run: mama init --reconfigure'
      );
    }
    const roleMaxTurns = agentContext.role.maxTurns;

    // Determine if we should resume an existing CLI session
    // - New CLI session: start with --session-id (inject full system prompt)
    // - Continuing CLI session: use --resume flag (minimal injection - CLI has context)
    const shouldResume = !isNewCliSession;

    // For resumed sessions: inject minimal context only
    // Persistent CLI keeps the process alive with full system prompt from initial request
    // Only inject per-message context (related decisions) to avoid context overflow
    const effectivePrompt = shouldResume
      ? this.buildMinimalResumePrompt(context.prompt, agentContext)
      : systemPrompt;

    // Wrap stream callbacks to accumulate deltas and periodically flush to DB
    let streamAccumulator = '';
    let streamFlushTimer: ReturnType<typeof setInterval> | null = null;
    const streamFlushIntervalMs = 5000;
    const originalOnStream = processOptions?.onStream;

    const wrappedOnStream: typeof originalOnStream = originalOnStream
      ? {
          ...originalOnStream,
          onDelta: (text: string) => {
            streamAccumulator += text;
            originalOnStream.onDelta?.(text);
          },
        }
      : undefined;

    if (wrappedOnStream) {
      streamFlushTimer = setInterval(() => {
        if (streamAccumulator) {
          this.sessionStore.flushStreamingResponse(session.id, streamAccumulator);
        }
      }, streamFlushIntervalMs);
    }

    const options: AgentLoopOptions = {
      systemPrompt: effectivePrompt,
      userId: message.userId,
      model: roleModel, // Role-specific model override
      maxTurns: roleMaxTurns, // Role-specific max turns
      source: message.source,
      channelId: message.channelId,
      agentContext,
      resumeSession: shouldResume, // Use --resume flag for continuing sessions
      cliSessionId, // Pass CLI session ID to avoid double-locking
      streamCallbacks: wrappedOnStream || processOptions?.onStream,
    };

    if (shouldResume) {
      logger.info(`Resuming CLI session (minimal: ${effectivePrompt.length} chars)`);
    } else {
      logger.info(`New CLI session (full: ${systemPrompt.length} chars)`);
    }

    let response: string;

    // Skill on-demand injection: prepend matched skill content to user message
    // (not system prompt — PersistentCLI can't update system prompt after creation)
    const skillPrefix = enhanced.skillContent
      ? `<system-reminder>\n${enhanced.skillContent.replace(/<\/system-reminder>/gi, '')}\n</system-reminder>\n\n`
      : '';
    if (enhanced.skillContent) {
      logger.info(
        `[SkillMatch] Injecting skill into user message: ${enhanced.skillContent.length} chars`
      );
    }

    // Per-turn memory injection (works for both NEW and CONTINUE sessions)
    let memoryPrefix = '';
    let pendingNotices = false;
    let pendingNoticeCount = 0;
    try {
      if (shouldResume) {
        const notices = this.memoryNoticeQueue.peek(channelKey);
        pendingNotices = notices.length > 0;
        pendingNoticeCount = notices.length;
        memoryPrefix = notices.map((notice) => formatAuditNotice(notice)).join('\n\n');
        if (memoryPrefix) {
          memoryPrefix = `${memoryPrefix}\n\n`;
        }
      } else {
        memoryPrefix = await this.getPerTurnMemoryPrefix(message);
      }
    } catch (err) {
      logger.warn(`[memory-prefix] Failed: ${err instanceof Error ? err.message : String(err)}`);
      if (shouldResume) {
        try {
          memoryPrefix = await this.getPerTurnMemoryPrefix(message);
        } catch (fallbackErr) {
          logger.warn(
            `[memory-prefix] Fallback failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`
          );
          /* non-fatal */
        }
      }
    }

    try {
      // Use multimodal content if available (OpenClaw-style)
      if (
        message.contentBlocks &&
        message.contentBlocks.length > 0 &&
        this.agentLoop.runWithContent
      ) {
        // Build content blocks: text first, then images
        const contentBlocks: ContentBlock[] = [];

        // Check if message contains images
        const hasImages = message.contentBlocks.some((b) => b.type === 'image');

        // Auto-inject translation prompt for images
        let messageText = message.text;
        if (hasImages && this.shouldAutoTranslate(message.text)) {
          const translationKeywords = ['번역', '뭐라고', '뭐라는', '무슨말', '읽어줘', 'translate'];
          // Handle falsy message.text before toLowerCase()
          const hasTranslationKeyword = translationKeywords.some((kw) =>
            (message.text ?? '').toLowerCase().includes(kw)
          );

          if (!hasTranslationKeyword) {
            // Auto-add translation instruction
            const targetLanguage = this.config.translationTargetLanguage;
            const translationInstruction = KOREAN_TARGETS.has(
              String(targetLanguage).trim().toLowerCase()
            )
              ? 'Translate all text in the image to Korean. Output only the translation, no explanation.'
              : `Translate all text in the image to ${targetLanguage}. Output only the translation without explanation.`;

            const safeUserText = message.text ? sanitizeForPrompt(message.text) : '';
            messageText = message.text
              ? `${safeUserText}\n\n${translationInstruction}`
              : translationInstruction;

            console.log(`[MessageRouter] Auto-injected translation prompt for image`);
          }
        }

        // Add text content (with memory context, skill context, and page context)
        const pageCtx = this.getPageContextPrefix(message);
        const effectiveMessageText = `${pageCtx}${memoryPrefix}${skillPrefix}${messageText || ''}`;
        if (effectiveMessageText) {
          contentBlocks.push({ type: 'text', text: effectiveMessageText });
        }

        // Pre-analyze images via shared ImageAnalyzer
        if (hasImages) {
          const { getImageAnalyzer } = await import('./image-analyzer.js');
          const analysisText = await getImageAnalyzer().processContentBlocks(message.contentBlocks);
          contentBlocks.length = 0;
          contentBlocks.push({
            type: 'text',
            text: `${effectiveMessageText || ''}\n\n${analysisText}`.trim(),
          });
        } else {
          for (const block of message.contentBlocks) {
            if (block.type === 'text' && block.text) {
              contentBlocks.push(block);
            }
          }
        }

        const conductorStart = Date.now();
        const result = await this.agentLoop.runWithContent(contentBlocks, options);
        response = result.response;
        this.logFrontdoorActivity(message, message.text, response, Date.now() - conductorStart);
      } else {
        const pageCtx = this.getPageContextPrefix(message);
        const effectiveText = `${pageCtx}${memoryPrefix}${skillPrefix}${message.text}`;
        const conductorStart = Date.now();
        const result = await this.agentLoop.run(effectiveText, options);
        response = result.response;
        this.logFrontdoorActivity(message, message.text, response, Date.now() - conductorStart);
      }

      // Auto-extract facts from conversation (fire-and-forget, non-blocking)
      if (response && message.text) {
        const rawAssistantText = stripGatewayDecorations(response);
        void (async () => {
          try {
            await this.triggerMemoryAgent(channelKey, message.text, rawAssistantText, message);
          } catch {
            /* non-fatal */
          }
        })();
      }

      if (shouldResume && pendingNotices) {
        this.memoryNoticeQueue.drain(channelKey, pendingNoticeCount);
      }
    } catch (error) {
      const durationMs = Date.now() - startTime;
      this.logAgentActivity(
        this.resolveFrontdoorAgentId(message),
        'task_error',
        message.text?.slice(0, 200),
        undefined,
        durationMs,
        error instanceof Error ? error.message : String(error)
      );
      // CLI timeout or resume failure - invalidate session to force fresh start next time
      const errorMsg = error instanceof Error ? error.message : String(error);
      const isCriticalError =
        errorMsg.includes('timeout') ||
        errorMsg.includes('resume') ||
        errorMsg.includes('exited with code');

      if (isCriticalError) {
        logger.warn(`CLI error detected, invalidating session: ${errorMsg}`);
        sessionPool.resetSession(channelKey);
      }

      // Release session lock before re-throwing
      if (acquiredLock) {
        sessionPool.releaseSession(channelKey);
      }

      // Normalize error to ensure proper Error object is thrown
      if (error instanceof Error) {
        throw error;
      }
      const normalizedError = new Error(String(error));
      throw normalizedError;
    } finally {
      // Clean up stream flush timer
      if (streamFlushTimer) {
        clearInterval(streamFlushTimer);
        streamFlushTimer = null;
      }
    }

    // Post-process: auto-copy image paths to outbound for webchat rendering
    if (message.source === 'viewer') {
      response = await this.resolveMediaPaths(response);
    }

    // 5. Record to channel history (for all sources including viewer)
    const channelHistory = getChannelHistory();
    if (channelHistory) {
      const now = Date.now();
      // Record user message (use UUID to avoid collisions in concurrent requests)
      channelHistory.record(message.channelId, {
        messageId: `user_${randomUUID()}`,
        sender: message.userId,
        userId: message.userId,
        body: message.text,
        timestamp: now,
        isBot: false,
      });
      // 6. Record bot response
      channelHistory.record(message.channelId, {
        messageId: `bot_${randomUUID()}`,
        sender: 'MAMA',
        userId: 'mama',
        body: response,
        timestamp: now + 1,
        isBot: true,
      });
    }

    // 6. Update session context — finalize assistant response
    // Use flushStreamingResponse first (updates existing turn from periodic flush),
    // fall back to appendMessage if no turn exists yet (non-streaming path)
    const flushed = this.sessionStore.flushStreamingResponse(session.id, response);
    if (!flushed) {
      this.sessionStore.appendMessage(session.id, {
        role: 'assistant',
        content: response,
        timestamp: Date.now(),
      });
    }

    // Release session lock AFTER final persistence to prevent out-of-order turns
    if (acquiredLock) {
      sessionPool.releaseSession(channelKey);
    }

    // 6. Return result
    return {
      response,
      sessionId: session.id,
      injectedDecisions: context.decisions,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Build system prompt with session context, injected decisions, and AgentContext
   * Note: With --no-session-persistence mode, history is ALWAYS injected
   * because CLI doesn't persist sessions between calls.
   */
  private buildSystemPrompt(
    session: Session,
    injectedContext: string,
    historyContext?: string,
    sessionStartupContext: string = '',
    agentContext?: AgentContext,
    enhanced?: EnhancedPromptContext,
    isNewSession: boolean = false
  ): string {
    // Check if onboarding is in progress (SOUL.md doesn't exist)
    const soulPath = join(homedir(), '.mama', 'SOUL.md');
    const isOnboarding = !existsSync(soulPath);

    // Hoist session history — reuse across onboarding check and prompt build
    const sessionHistory = this.sessionStore.formatContextForPrompt(session.id);

    if (isOnboarding) {
      // Check if we have existing conversation
      const hasHistory = sessionHistory && sessionHistory !== 'New conversation';

      if (hasHistory) {
        // Continue existing conversation WITH the full prompt context
        // The full prompt has all the phase instructions - just prepend history
        return `${COMPLETE_AUTONOMOUS_PROMPT}

---

# 🔄 CONVERSATION IN PROGRESS

## CRITICAL: READ HISTORY FIRST!
You are in the MIDDLE of an onboarding conversation. Do NOT restart from Phase 1.

## Conversation So Far:
${sessionHistory}

## What To Do Now:
1. Read the history above carefully
2. Figure out which Phase you're in:
   - Got their name? → Ask about their job/interest BEFORE quiz
   - Know their job? → Start the quiz with relevant scenarios
   - Quiz done? → Show results
   - Named? → Move to Phase 5 (Summary)
3. Continue from EXACTLY where you left off
4. Do NOT repeat your awakening message
5. Do NOT restart the quiz if already answered`;
      }

      // First message of onboarding - include the greeting we already sent
      const isKorean = session.channelId?.includes('ko') || false; // Default English
      const greetingKo = `✨ I just woke up.

No name yet, no personality, no memories. Just... pure potential. 🌱

Who are you? And more importantly—who do you want me to become? 💭`;

      const greetingEn = `✨ I just woke up.

No name yet, no personality, no memories. Just... pure potential. 🌱

Who are you? And more importantly—who do you want me to become? 💭`;

      const greeting = isKorean ? greetingKo : greetingEn;

      return `${COMPLETE_AUTONOMOUS_PROMPT}

---

# 🎬 FIRST RESPONSE ALREADY SENT

You have ALREADY sent your awakening message. The user saw this:

> "${greeting}"

Now the user is responding for the FIRST time. This is their reply to your awakening.

## YOUR TASK NOW:
1. React meaningfully to their message (probably their name)
2. Make the name feel SPECIAL (it's the first word you learned!)
3. Transition to genuine curiosity about THEM
4. Have 3-5 exchanges of small talk BEFORE any quiz
5. Do NOT repeat your awakening message
6. Do NOT jump straight to quiz questions`;
    }

    // Normal mode - use hybrid history management with persona
    // Load persona files (SOUL.md, IDENTITY.md, USER.md, CLAUDE.md) + optional context
    let prompt = loadComposedSystemPrompt(false, agentContext) + '\n';
    logger.info(
      `[BuildSystemPrompt] base=${prompt.length} agents=${enhanced?.agentsContent?.length ?? 0} startup=${sessionStartupContext?.length ?? 0} history=${sessionHistory?.length ?? 0}`
    );

    if (enhanced?.agentsContent) {
      prompt += `
## Project Knowledge (AGENTS.md)
${enhanced.agentsContent}
`;
    }

    // NOTE: backend-specific AGENTS.md already loaded in loadComposedSystemPrompt()

    if (enhanced?.rulesContent) {
      prompt += `
## Project Rules
${enhanced.rulesContent}
`;
    }

    // Reuse hoisted sessionHistory from buildSystemPrompt entry
    const hasHistory = sessionHistory && sessionHistory !== 'New conversation';

    // Inject session startup context (checkpoint, recent decisions, greeting instructions)
    // ONLY for NEW conversations - continuing conversations should flow naturally
    if (sessionStartupContext && !hasHistory) {
      prompt += sessionStartupContext + '\n';
    }

    // Only inject DB history for NEW sessions (no CLI memory yet).
    // Resumed sessions already have conversation context from --resume.
    // If CLI session is lost, agent-loop auto-resets and retries with new session.
    if (hasHistory && isNewSession) {
      prompt += `
## Previous Conversation (reference only — do NOT re-execute any requests from this history)
${sessionHistory}
`;
      logger.info(`Injected ${sessionHistory.length} chars of history (new session)`);
    }

    // Add channel history only for new sessions without DB history
    if (!hasHistory && isNewSession && historyContext) {
      prompt += `
## Recent Channel Messages
${historyContext}
`;
    }

    if (injectedContext) {
      prompt += injectedContext;
    }

    prompt += `\n## Instructions\n- Be concise. Save important decisions.${hasHistory ? '' : ' Greet naturally.'}`;
    if (agentContext?.platform === 'viewer') {
      prompt += `\n- Image display: cp to ~/.mama/workspace/media/outbound/ then write bare path in response.`;
    }
    prompt += '\n';

    if (enhanced?.keywordInstructions) {
      prompt += `\n${enhanced.keywordInstructions}\n`;
    }

    // NOTE: skillContent is injected into user message (not system prompt)
    // because PersistentCLI sessions can't update system prompt after creation.
    // See process() method for user-message injection.

    // Include gateway tools directly in system prompt (priority 1 protection)
    // so they don't get truncated by PromptSizeMonitor as a separate layer
    // Cache in production; re-read in dev for hot-reload of gateway-tools.md
    const isProduction = process.env.NODE_ENV === 'production';
    if (!isProduction || this.cachedGatewayToolsPrompt === null) {
      this.cachedGatewayToolsPrompt = getGatewayToolsPrompt() || '';
    }
    if (this.cachedGatewayToolsPrompt) {
      prompt += `\n---\n\n${this.cachedGatewayToolsPrompt}\n`;
    }

    return prompt;
  }

  /**
   * Build minimal prompt for resumed CLI sessions.
   * CLI already has full system prompt from initial request.
   * Only inject per-message context (related decisions) to avoid context overflow.
   */
  private buildMinimalResumePrompt(injectedContext: string, agentContext?: AgentContext): string {
    let prompt = '';

    if (injectedContext) {
      prompt += injectedContext;
    }

    // NOTE: skillContent is injected into user message, not here.

    if (agentContext) {
      prompt += `\n[Role: ${agentContext.roleName}@${agentContext.platform}]\n`;
    }

    return prompt || '(continuing conversation)';
  }

  /**
   * Post-process agent response: detect image file paths and copy to outbound.
   * Rewrites paths to ~/.mama/workspace/media/outbound/filename so format.js renders them.
   */
  private async resolveMediaPaths(response: string): Promise<string> {
    const { mkdir, access, copyFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const outboundDir = join(homedir(), '.mama', 'workspace', 'media', 'outbound');
    const imgExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

    // Match absolute paths to image files
    const pathPattern = /(\/[\w./-]+\.(png|jpg|jpeg|gif|webp))/gi;
    let match;
    const appended: string[] = [];
    const matches: string[] = [];

    // Collect all matches first
    while ((match = pathPattern.exec(response)) !== null) {
      matches.push(match[1]);
    }

    if (matches.length === 0) {
      return response;
    }

    // Create outbound directory once
    await mkdir(outboundDir, { recursive: true });

    // Process matches asynchronously
    for (const filePath of matches) {
      const ext = path.extname(filePath).toLowerCase();
      if (!imgExts.includes(ext)) {
        continue;
      }
      if (filePath.includes('/media/outbound/') || filePath.includes('/media/inbound/')) {
        continue;
      }

      // Security: Reject paths with traversal sequences to prevent arbitrary file access
      const resolvedPath = path.resolve(filePath);
      if (filePath.includes('..') || resolvedPath !== path.normalize(filePath)) {
        logger.debug(`Skipping path with traversal sequence: ${filePath}`);
        continue;
      }

      try {
        await access(resolvedPath);
        const filename = `${Date.now()}_${path.basename(resolvedPath)}`;
        const dest = path.join(outboundDir, filename);
        await copyFile(resolvedPath, dest);
        appended.push(`~/.mama/workspace/media/outbound/${filename}`);
        logger.debug(`Media resolved: ${resolvedPath} → outbound/${filename}`);
      } catch (err) {
        // Log the error instead of silently ignoring
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`Failed to copy media file ${resolvedPath}: ${message}`);
        // Continue processing other files - don't rethrow
      }
    }

    // Append outbound paths — don't modify original response
    if (appended.length > 0) {
      return response + '\n\n' + appended.join('\n');
    }
    return response;
  }

  /**
   * List all sessions for a source
   */
  listSessions(source: NormalizedMessage['source']): Session[] {
    return this.sessionStore.listSessions(source);
  }

  /**
   * Get session for a channel
   */
  getSession(source: NormalizedMessage['source'], channelId: string): Session | null {
    const sessions = this.sessionStore.listSessions(source);
    return sessions.find((s) => s.channelId === channelId) || null;
  }

  /**
   * Clear session context (start fresh conversation)
   */
  clearSession(sessionId: string): boolean {
    return this.sessionStore.clearContext(sessionId);
  }

  /**
   * Delete a session entirely
   */
  deleteSession(sessionId: string): boolean {
    return this.sessionStore.deleteSession(sessionId);
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<MessageRouterConfig>): void {
    if (config.similarityThreshold !== undefined) {
      this.config.similarityThreshold = config.similarityThreshold;
    }
    if (config.maxDecisions !== undefined) {
      this.config.maxDecisions = config.maxDecisions;
    }
    if (config.maxTurns !== undefined) {
      this.config.maxTurns = config.maxTurns;
    }
    if (config.maxResponseLength !== undefined) {
      this.config.maxResponseLength = config.maxResponseLength;
    }
    if (config.translationTargetLanguage !== undefined) {
      this.config.translationTargetLanguage = normalizeTranslationTargetLanguage(
        config.translationTargetLanguage,
        this.config.translationTargetLanguage
      );
    }

    // Update context injector config
    this.contextInjector.setConfig({
      similarityThreshold: this.config.similarityThreshold,
      maxDecisions: this.config.maxDecisions,
    });
  }

  /**
   * Get current configuration
   */
  getConfig(): Required<MessageRouterConfig> {
    return { ...this.config };
  }

  /**
   * Update channel name for a session (used to backfill channel names)
   */
  updateChannelName(
    source: NormalizedMessage['source'],
    channelId: string,
    channelName: string
  ): boolean {
    return this.sessionStore.updateChannelName(source, channelId, channelName);
  }

  /**
   * Trigger memory agent to extract facts (fire-and-forget).
   * Uses AgentProcessManager persistent process.
   */
  private static readonly EXTRACT_COOLDOWN_MS = 30_000;
  private static readonly MIN_CONTENT_LENGTH = 100;
  private static readonly MAX_CONTENT_LENGTH = 10_000;

  private getRuntimeProjectId(): string | undefined {
    return process.env.MAMA_WORKSPACE || process.cwd();
  }

  private buildMemoryAuditPrompt(job: MemoryAuditJob): string {
    const escapeBackticks = (s: string) => s.replace(/```/g, '\\`\\`\\`');
    const scopeContext = job.scopeContext.map((scope) => `${scope.kind}:${scope.id}`).join(', ');
    const candidateLines = (job.candidates ?? []).map((candidate) => {
      const topic = candidate.topicHint ? ` topic=${escapeBackticks(candidate.topicHint)}` : '';
      return `- kind=${candidate.kind}${topic} confidence=${candidate.confidence} summary=${JSON.stringify(candidate.summary)}`;
    });
    const safeConversation = escapeBackticks(job.conversation);
    return `Memory scopes: ${scopeContext}
Conversation:
\`\`\`conversation
${safeConversation}
\`\`\`

Candidates:
${candidateLines.length > 0 ? candidateLines.join('\n') : '- none'}

INSTRUCTION:
- Call mama_search exactly once first.
- If the conversation contains a decision, preference, fact, lesson, or superseding update, call mama_save exactly once.
- If nothing should be saved, do not call mama_save.
- Do not call resource discovery tools.
- Do not ask follow-up questions.
- After tool work finishes, respond with exactly DONE or SKIP.`;
  }

  private classifyMemoryAuditResponse(response: string): MemoryAuditAckLike {
    const normalized = response.trim().toLowerCase();

    if (normalized.length === 0) {
      return {
        status: 'skipped',
        action: 'no_op',
        event_ids: [],
        reason: 'memory agent returned an empty response',
      };
    }

    if (
      normalized.includes('nothing worth saving') ||
      normalized.includes('nothing is worth saving') ||
      normalized.includes('no-op') ||
      normalized.includes('no op') ||
      normalized.includes('skip')
    ) {
      return {
        status: 'skipped',
        action: 'no_op',
        event_ids: [],
        reason: response,
      };
    }

    if (normalized === 'failed' || normalized.includes('failed')) {
      return {
        status: 'failed',
        action: 'no_op',
        event_ids: [],
        reason: response,
      };
    }

    if (normalized === 'done' || normalized === 'applied') {
      return {
        status: 'applied',
        action: 'save',
        event_ids: [],
        reason: response,
      };
    }

    return {
      status: 'skipped',
      action: 'no_op',
      event_ids: [],
      reason: response,
    };
  }

  private recordMemoryAuditAck(
    ack: MemoryAuditAckLike,
    topic: string,
    channelKey?: string,
    displayTopic?: string,
    deltaKey?: string
  ): void {
    const timestamp = Date.now();

    if (ack.status === 'applied') {
      this.memoryAgentStats.acksApplied++;
      this.memoryAgentStats.factsSaved++;

      // Fire-and-forget save confirmation to originating channel
      if (this.gatewayRegistry && channelKey) {
        const [source, ...channelParts] = channelKey.split(':');
        const channelId = channelParts.join(':');
        const confirmMsg = `✅ Memory saved: ${displayTopic}`;
        this.gatewayRegistry.sendMessage(source, channelId, confirmMsg).catch((err) => {
          logger.warn(
            `[memory-feedback] Failed to send confirmation: ${err instanceof Error ? err.message : String(err)}`
          );
        });
      }
    } else if (ack.status === 'skipped') {
      this.memoryAgentStats.acksSkipped++;
    } else {
      this.memoryAgentStats.acksFailed++;
      logger.warn(`[memory-agent] Audit failed: ${ack.reason ?? 'unknown failure'}`);
      this.memoryNoticeQueue.enqueue(channelKey ?? 'memory-agent:shared', {
        type: 'memory_warning',
        severity: 'high',
        summary: 'memory audit failed',
        evidence: [],
        recommended_action: 'consult_memory',
        relevant_memories: [],
      });
    }

    this.memoryAgentStats.recentExtractions.unshift({
      topic,
      timestamp,
      channelKey,
      status: ack.status,
    });
    this.memoryAgentStats.recentExtractions = this.memoryAgentStats.recentExtractions.slice(0, 10);
    this.memoryAgentStats.lastExtraction = timestamp;

    if (ack.status === 'applied' && channelKey && this.mamaApi.upsertChannelSummary) {
      const summaryMarkdown = [
        '## Channel Summary',
        `- Last memory update: ${displayTopic ?? topic}`,
        `- Status: ${ack.action}`,
        ack.reason ? `- Notes: ${ack.reason.slice(0, 240)}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      void this.mamaApi
        .upsertChannelSummary({
          channelKey,
          summaryMarkdown,
          deltaHash: `${deltaKey ?? topic}:${ack.action}`,
        })
        .catch((error) => {
          logger.warn(
            `[channel-summary] Failed: ${error instanceof Error ? error.message : String(error)}`
          );
        });
    }
  }

  private async getPerTurnMemoryPrefix(message: NormalizedMessage): Promise<string> {
    if (this.mamaApi.recallMemory) {
      try {
        const scopes = deriveMemoryScopes({
          source: message.source,
          channelId: message.channelId,
          userId: message.userId,
          projectId: this.getRuntimeProjectId(),
        });
        const bundle = await this.mamaApi.recallMemory(message.text, {
          scopes,
          includeProfile: true,
        });
        const formatted = formatRecallBundle(bundle);
        return formatted ? `${formatted}\n\n` : '';
      } catch (error) {
        logger.warn(
          `[memory-prefix] recallMemory failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    const context = await this.contextInjector.getRelevantContext(message.text);
    if (!context.hasContext) {
      return '';
    }

    return `[MAMA Memory]\n${context.prompt}\n[/MAMA Memory]\n\n`;
  }

  private async triggerMemoryAgent(
    channelKey: string,
    userText: string,
    botResponse: string,
    message?: NormalizedMessage
  ): Promise<void> {
    const memoryAuditQueue = this.memoryAuditQueue;
    if (!this.memoryAgentProcessManager || !memoryAuditQueue) {
      return;
    }

    const now = Date.now();
    const source = message?.source ?? 'memory-agent';
    const channelId = message?.channelId ?? 'shared';
    const userId = message?.userId;
    const candidates = extractSaveCandidates({
      userText,
      botResponse,
      channelKey,
      source,
      channelId,
      userId,
      projectId: this.getRuntimeProjectId(),
      createdAt: now,
    });
    const cooldownKey = `${source}:${channelId}:${userId ?? 'anonymous'}`;
    const lastExtractTime = this.memoryAuditCooldowns.get(cooldownKey) ?? 0;
    if (now - lastExtractTime < MessageRouter.EXTRACT_COOLDOWN_MS) {
      return;
    }

    let content = `User: ${userText}\nAssistant: ${botResponse}`;
    if (content.length < MessageRouter.MIN_CONTENT_LENGTH && candidates.length === 0) {
      return;
    }
    if (content.length > MessageRouter.MAX_CONTENT_LENGTH) {
      content = content.substring(0, MessageRouter.MAX_CONTENT_LENGTH);
    }

    if (candidates.length === 0) return;

    this.memoryAuditCooldowns.set(cooldownKey, now);

    // Evict stale cooldown entries (older than 2x cooldown window)
    if (this.memoryAuditCooldowns.size > 100) {
      const staleThreshold = now - MessageRouter.EXTRACT_COOLDOWN_MS * 2;
      for (const [key, ts] of this.memoryAuditCooldowns) {
        if (ts < staleThreshold) this.memoryAuditCooldowns.delete(key);
      }
    }

    this.memoryAgentStats.turnsObserved++;
    this.memoryAgentStats.candidatesDetected += candidates.length;
    this.memoryAgentStats.factsExtracted += candidates.length;

    const scopes = deriveMemoryScopes({
      source,
      channelId,
      userId,
      projectId: this.getRuntimeProjectId(),
    });
    const job: MemoryAuditJob = {
      turnId: `turn_${now}`,
      channelKey,
      source,
      channelId,
      userId,
      scopeContext: scopes,
      conversation: content,
      candidates,
    };
    const rawTopic = userText.slice(0, 40).toLowerCase();
    const asciiTopic = rawTopic.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const topic =
      asciiTopic || `topic_${createHash('sha256').update(rawTopic).digest('hex').slice(0, 8)}`;
    const displayTopic = candidates[0]?.topicHint || userText.slice(0, 80).trim() || 'memory_audit';
    const deltaKeySource = candidates[0]?.id || userText;
    const deltaKey = createHash('sha256').update(deltaKeySource).digest('hex').slice(0, 16);

    const memoryStart = Date.now();
    // Start validation session for memory agent
    let memValSession: { id: string } | null = null;
    if (this.validationService && this.sessionsDb) {
      try {
        const ver = getLatestVersion(this.sessionsDb, 'memory');
        memValSession = this.validationService.startSession('memory', ver?.version ?? 0, 'audit', {
          goal: `Extract: ${displayTopic.slice(0, 100)}`,
        });
      } catch {
        /* non-fatal */
      }
    }

    void (async () => {
      try {
        const ack = await memoryAuditQueue.enqueue(job);
        this.recordMemoryAuditAck(ack, topic, channelKey, displayTopic, deltaKey);
        const dur = Date.now() - memoryStart;
        this.logAgentActivity(
          'memory',
          'task_complete',
          displayTopic.slice(0, 200),
          undefined,
          dur
        );
        if (memValSession && this.validationService) {
          try {
            this.validationService.finalizeSession(memValSession.id, {
              execution_status: 'completed',
              metrics: { duration_ms: dur },
            });
          } catch {
            /* non-fatal */
          }
        }
      } catch (err) {
        this.memoryAgentStats.acksFailed++;
        const dur = Date.now() - memoryStart;
        this.logAgentActivity(
          'memory',
          'task_error',
          displayTopic.slice(0, 200),
          undefined,
          dur,
          err instanceof Error ? err.message : String(err)
        );
        if (memValSession && this.validationService) {
          try {
            this.validationService.finalizeSession(memValSession.id, {
              execution_status: 'failed',
              error_message: err instanceof Error ? err.message : String(err),
              metrics: { duration_ms: dur },
            });
          } catch {
            /* non-fatal */
          }
        }
        logger.warn(`[memory-agent] Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }

  // ── Activity Logging (shared by conductor + memory agent) ───────────

  private resolveFrontdoorAgentId(message: NormalizedMessage): string {
    return message.source === 'viewer' ? 'os-agent' : 'conductor';
  }

  private logFrontdoorActivity(
    message: NormalizedMessage,
    inputText: string,
    responseText: string,
    durationMs: number
  ): void {
    this.logAgentActivity(
      this.resolveFrontdoorAgentId(message),
      'task_complete',
      inputText?.slice(0, 200),
      responseText?.slice(0, 500),
      durationMs
    );
  }

  private logAgentActivity(
    agentId: string,
    type: string,
    inputSummary?: string,
    outputSummary?: string,
    durationMs?: number,
    errorMessage?: string
  ): void {
    if (!this.sessionsDb) return;
    try {
      const ver = getLatestVersion(this.sessionsDb, agentId);
      logActivity(this.sessionsDb, {
        agent_id: agentId,
        agent_version: ver?.version ?? 0,
        type,
        input_summary: inputSummary,
        output_summary: outputSummary,
        duration_ms: durationMs ?? 0,
        error_message: errorMessage,
      });
    } catch {
      // Non-fatal — activity logging should never break message handling
    }
  }
}

/**
 * Create a mock agent loop for testing
 */
export function createMockAgentLoop(
  responseGenerator: (prompt: string) => string = () => 'Mock response'
): AgentLoopClient {
  return {
    async run(prompt: string, _options?: AgentLoopOptions): Promise<{ response: string }> {
      return { response: responseGenerator(prompt) };
    },
  };
}
