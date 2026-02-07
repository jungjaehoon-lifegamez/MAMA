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
import { ContextInjector, type MamaApiClient } from './context-injector.js';
import type { NormalizedMessage, MessageRouterConfig, Session, RelatedDecision } from './types.js';
import { COMPLETE_AUTONOMOUS_PROMPT } from '../onboarding/complete-autonomous-prompt.js';
import { getSessionPool, buildChannelKey } from '../agent/session-pool.js';
import { loadComposedSystemPrompt } from '../agent/agent-loop.js';
import { RoleManager, getRoleManager } from '../agent/role-manager.js';
import { createAgentContext } from '../agent/context-prompt-builder.js';
import type { AgentContext } from '../agent/types.js';

/**
 * Content block for multimodal input
 */
export interface ContentBlock {
  type: 'text' | 'image' | 'document';
  text?: string;
  localPath?: string; // For image path reference
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

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
   */
  async process(message: NormalizedMessage): Promise<ProcessingResult> {
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

    // 2. Check if this is a new CLI session (need to inject history from DB)
    const channelKey = buildChannelKey(message.source, message.channelId);
    const sessionPool = getSessionPool();
    const { sessionId: cliSessionId, isNew: isNewCliSession } = sessionPool.getSession(channelKey);

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

    // 6. Build system prompt with all contexts including AgentContext
    // Always inject DB history for reliable memory (CLI --resume is unreliable)
    const historyContext = message.metadata?.historyContext;
    const systemPrompt = this.buildSystemPrompt(
      session,
      context.prompt,
      historyContext,
      sessionStartupContext,
      agentContext
    );

    // 7. Run agent loop (with session info for lane-based concurrency)
    // Use role-specific model if configured, otherwise use global model
    const roleModel = agentContext.role.model;
    const roleMaxTurns = agentContext.role.maxTurns;

    // Determine if we should resume an existing CLI session
    // - New CLI session: start with --session-id
    // - Continuing CLI session: use --resume flag
    // Note: Always inject system prompt to ensure Gateway Tools and AgentContext
    // are available even if CLI session was lost (daemon restart, timeout, etc.)
    const shouldResume = !isNewCliSession;

    const options: AgentLoopOptions = {
      // Always inject system prompt - ensures Gateway Tools and AgentContext
      // are available even if CLI session was lost
      systemPrompt,
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
      console.log(
        `[MessageRouter] Resuming CLI session (injecting ${systemPrompt.length} chars for safety)`
      );
    } else {
      console.log(
        `[MessageRouter] New CLI session (injecting ${systemPrompt.length} chars of system prompt)`
      );
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

        // Add all content blocks (text info + images + files)
        for (const block of message.contentBlocks) {
          // Include text blocks (contain path info like "[Image: x.jpg, saved at: /path]")
          // Include image blocks with source (base64 data)
          if (block.type === 'text' || (block.type === 'image' && block.source)) {
            contentBlocks.push(block);
          }
        }

        const result = await this.agentLoop.runWithContent(contentBlocks, options);
        response = result.response;
      } else {
        const result = await this.agentLoop.run(message.text, options);
        response = result.response;
      }
    } finally {
      // Release the session lock so subsequent requests can reuse it
      sessionPool.releaseSession(channelKey);
    }

    // 5. Update session context
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
    agentContext?: AgentContext
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
      const isKorean = session.channelId?.includes('ko') || true; // Default Korean for now
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

    // Check for existing conversation history FIRST
    const dbHistory = this.sessionStore.formatContextForPrompt(session.id);
    const hasHistory = dbHistory && dbHistory !== 'New conversation';

    // Inject session startup context (checkpoint, recent decisions, greeting instructions)
    // ONLY for NEW conversations - continuing conversations should flow naturally
    if (sessionStartupContext && !hasHistory) {
      prompt += sessionStartupContext + '\n';
    }

    // Always inject DB history to ensure Claude has conversation context
    // CLI --resume is unreliable, so we can't depend on it for memory
    if (hasHistory) {
      prompt += `
## 🔄 CONVERSATION IN PROGRESS

**IMPORTANT**: You are in the MIDDLE of an ongoing conversation in this channel.
- Do NOT greet or introduce yourself again
- Do NOT summarize what was discussed - just continue naturally
- Respond as if you just heard the user's message, not as if you're resuming from a log
- The conversation below is YOUR conversation with this user - you remember it

---
${dbHistory}
---

`;
      console.log(`[MessageRouter] Injected ${dbHistory.length} chars of history`);
    }

    // Add channel history context only if provided (for multi-user channels)
    if (historyContext) {
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

    return prompt;
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
