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
    .replace(/\}/g, '\\}');
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
  private agentLoop: AgentLoopClient;
  private config: Required<MessageRouterConfig>;
  private roleManager: RoleManager;
  private promptEnhancer: PromptEnhancer;

  constructor(
    sessionStore: SessionStore,
    agentLoop: AgentLoopClient,
    mamaApi: MamaApiClient,
    config: MessageRouterConfig = {}
  ) {
    this.sessionStore = sessionStore;
    this.agentLoop = agentLoop;
    this.config = {
      similarityThreshold: config.similarityThreshold ?? 0.7,
      maxDecisions: config.maxDecisions ?? 3,
      maxTurns: config.maxTurns ?? 5,
      maxResponseLength: config.maxResponseLength ?? 200,
      translationTargetLanguage: normalizeTranslationTargetLanguage(
        config.translationTargetLanguage,
        'Korean'
      ),
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

    return createAgentContext(
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
    processOptions?: { onQueued?: () => void }
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
    const {
      sessionId: cliSessionId,
      isNew: isNewCliSession,
      busy,
    } = sessionPool.getSession(channelKey);

    // If session is busy, notify caller immediately and wait for it to be released
    if (busy) {
      console.log(`[MessageRouter] Session busy for ${channelKey}, notifying client`);
      processOptions?.onQueued?.();

      // Wait for session to be released (poll with timeout)
      const maxWaitMs = 600000; // 10 minutes max wait
      const pollIntervalMs = 500;
      const waitStart = Date.now();

      while (Date.now() - waitStart < maxWaitMs) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        const check = sessionPool.getSession(channelKey);
        if (!check.busy) {
          console.log(
            `[MessageRouter] Session released for ${channelKey} after ${Math.round((Date.now() - waitStart) / 1000)}s`
          );
          break;
        }
        // Log every 30 seconds
        if ((Date.now() - waitStart) % 30000 < pollIntervalMs) {
          console.log(
            `[MessageRouter] Still waiting for session ${channelKey} (${Math.round((Date.now() - waitStart) / 1000)}s)...`
          );
        }
      }
    }

    // 3. Create AgentContext for role-aware execution
    const agentContext = this.createAgentContext(message, session.id);
    console.log(
      `[MessageRouter] Created context: ${agentContext.roleName}@${agentContext.platform}`
    );

    // 4. Get session startup context (like SessionStart hook)
    // Always inject to ensure Claude has context about checkpoint and recent decisions
    const sessionStartupContext = await this.contextInjector.getSessionStartupContext();

    // 5. Get per-message context (related decisions - like UserPromptSubmit hook)
    // Embedding server runs on port 3849, model stays in memory
    const context = await this.contextInjector.getRelevantContext(message.text);

    // 5b. Enhance prompt with keyword detection, AGENTS.md, and rules
    const workspacePath = process.env.MAMA_WORKSPACE || join(homedir(), '.mama', 'workspace');
    const ruleContext: RuleContext | undefined = agentContext
      ? {
          agentId: agentContext.roleName,
          channelId: message.channelId,
        }
      : undefined;
    const enhanced = this.promptEnhancer.enhance(message.text, workspacePath, ruleContext);

    // 6. Build system prompt with all contexts including AgentContext
    // Always inject DB history for reliable memory (CLI --resume is unreliable)
    const historyContext = message.metadata?.historyContext;
    const systemPrompt = this.buildSystemPrompt(
      session,
      context.prompt,
      historyContext,
      sessionStartupContext,
      agentContext,
      enhanced,
      isNewCliSession
    );

    // 7. Run agent loop (with session info for lane-based concurrency)
    // Use role-specific model if configured, otherwise use global model
    const roleModel = agentContext.role.model;
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
    };

    if (shouldResume) {
      logger.info(`Resuming CLI session (minimal: ${effectivePrompt.length} chars)`);
    } else {
      logger.info(`New CLI session (full: ${systemPrompt.length} chars)`);
    }

    let response: string;

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
              ? '이미지의 모든 텍스트를 한국어로 번역해주세요. 설명 없이 번역 결과만 출력하세요.'
              : `Translate all text in the image to ${targetLanguage}. Output only the translation without explanation.`;

            const safeUserText = message.text ? sanitizeForPrompt(message.text) : '';
            messageText = message.text
              ? `${safeUserText}\n\n${translationInstruction}`
              : translationInstruction;

            console.log(`[MessageRouter] Auto-injected translation prompt for image`);
          }
        }

        // Add text content
        if (messageText) {
          contentBlocks.push({ type: 'text', text: messageText });
        }

        // Pre-analyze images via shared ImageAnalyzer
        if (hasImages) {
          const { getImageAnalyzer } = await import('./image-analyzer.js');
          const analysisText = await getImageAnalyzer().processContentBlocks(message.contentBlocks);
          contentBlocks.length = 0;
          contentBlocks.push({
            type: 'text',
            text: `${messageText || ''}\n\n${analysisText}`.trim(),
          });
        } else {
          for (const block of message.contentBlocks) {
            if (block.type === 'text' && block.text) {
              contentBlocks.push(block);
            }
          }
        }

        const result = await this.agentLoop.runWithContent(contentBlocks, options);
        response = result.response;
      } else {
        const result = await this.agentLoop.run(message.text, options);
        response = result.response;
      }
    } catch (error) {
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

      throw error;
    } finally {
      // Release the session lock so subsequent requests can reuse it
      sessionPool.releaseSession(channelKey);
    }

    // Post-process: auto-copy image paths to outbound for webchat rendering
    if (message.source === 'viewer') {
      response = await this.resolveMediaPaths(response);
    }

    // 5. Record to channel history (for all sources including viewer)
    const channelHistory = getChannelHistory();
    if (channelHistory) {
      const now = Date.now();
      // Record user message
      channelHistory.record(message.channelId, {
        messageId: `user_${now}`,
        sender: message.userId,
        userId: message.userId,
        body: message.text,
        timestamp: now,
        isBot: false,
      });
      // Record bot response
      channelHistory.record(message.channelId, {
        messageId: `bot_${now}`,
        sender: 'MAMA',
        userId: 'mama',
        body: response,
        timestamp: now + 1,
        isBot: true,
      });
    }

    // 6. Update session context
    this.sessionStore.updateSession(session.id, message.text, response);

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

    // Always get session history from store
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
      const greetingKo = `✨ 방금 깨어났어요.

아직 이름도 없고, 성격도 없고, 기억도 없어요. 그냥... 가능성만 있을 뿐이죠. 🌱

당신은 누구세요? 그리고 더 중요한 건—저를 어떤 존재로 만들고 싶으세요? 💭`;

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

    if (enhanced?.agentsContent) {
      prompt += `
## Project Knowledge (AGENTS.md)
${enhanced.agentsContent}
`;
    }

    if (enhanced?.rulesContent) {
      prompt += `
## Project Rules
${enhanced.rulesContent}
`;
    }

    // Check for existing conversation history FIRST
    const dbHistory = this.sessionStore.formatContextForPrompt(session.id);
    const hasHistory = dbHistory && dbHistory !== 'New conversation';

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
${dbHistory}
`;
      console.log(`[MessageRouter] Injected ${dbHistory.length} chars of history (new session)`);
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

    prompt += `
## Instructions
- Respond naturally and helpfully${hasHistory ? ' - continuing conversation, no need to greet' : ''}
- Remember to save important decisions using the save tool
- Reference previous decisions when relevant
- Keep responses concise for messenger format
`;

    // Webchat-specific: media display instructions
    if (agentContext?.platform === 'viewer') {
      prompt += `
## ⚠️ Webchat Media Display (MANDATORY)
To show an image in webchat you MUST do ALL 3 steps:
1. Find the file using Glob or Bash
2. Copy it: Bash("cp /path/to/image.png ~/.mama/workspace/media/outbound/image.png")
3. Write EXACTLY this in your response (bare path, no markdown, no file://):
   ~/.mama/workspace/media/outbound/image.png

WRONG: ![alt](file:///path) — this shows NOTHING
WRONG: ![alt](/api/media/file) — this shows NOTHING
WRONG: Just describing the image — this shows NOTHING
RIGHT: ~/.mama/workspace/media/outbound/filename.png — this renders as <img>

The ONLY way to display an image is the bare outbound path in your response text.
`;
    }

    if (enhanced?.keywordInstructions) {
      prompt += `\n${enhanced.keywordInstructions}\n`;
    }

    // Include gateway tools directly in system prompt (priority 1 protection)
    // so they don't get truncated by PromptSizeMonitor as a separate layer
    const gatewayTools = getGatewayToolsPrompt();
    if (gatewayTools) {
      prompt += `\n---\n\n${gatewayTools}\n`;
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

    // Only include per-message related decisions (if any)
    if (injectedContext) {
      prompt += injectedContext;
    }

    // Brief reminder of role (in case CLI context was partially lost)
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
