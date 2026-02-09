/**
 * Multi-Agent Discord Integration
 *
 * Extends the Discord gateway with multi-agent support.
 * Enables multiple AI personas to interact in Discord channels.
 */

import type { Message } from 'discord.js';
import type { MultiAgentConfig, MessageContext, AgentPersonaConfig } from './types.js';
import { MultiAgentOrchestrator } from './orchestrator.js';
import { AgentProcessManager } from './agent-process-manager.js';
import { getSharedContextManager, type SharedContextManager } from './shared-context.js';
import { MultiBotManager } from './multi-bot-manager.js';
import type { PersistentProcessOptions } from '../agent/persistent-cli-process.js';
import { splitForDiscord } from '../gateways/message-splitter.js';
import { AgentMessageQueue, type QueuedMessage } from './agent-message-queue.js';
import { validateDelegationFormat, isDelegationAttempt } from './delegation-format-validator.js';
import { BackgroundTaskManager, type BackgroundTask } from './background-task-manager.js';
import { SystemReminderService } from './system-reminder.js';
import { DelegationManager } from './delegation-manager.js';
import { getChannelHistory } from '../gateways/channel-history.js';
import { PromptEnhancer } from '../agent/prompt-enhancer.js';
import type { RuleContext } from '../agent/yaml-frontmatter.js';
import { PRReviewPoller } from './pr-review-poller.js';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Default timeout for agent responses (15 minutes — must accommodate sub-agent spawns) */
const AGENT_TIMEOUT_MS = 15 * 60 * 1000;

/** Phase emoji progression: 👀 → 🔍/💻 → 🔧 → 📝 → ✅ */
const PHASE_EMOJIS = ['👀', '🔍', '💻', '🔧', '📝', '✅'] as const;

/** Map tool names to phase emojis */
function toolToPhaseEmoji(toolName: string): (typeof PHASE_EMOJIS)[number] | null {
  switch (toolName) {
    case 'Task':
    case 'Read':
    case 'Grep':
    case 'Glob':
    case 'WebFetch':
    case 'WebSearch':
      return '🔍'; // analysis
    case 'Bash':
      return '💻'; // terminal commands
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return '🔧'; // implementation (file mutations only)
    default:
      return null; // no change
  }
}

/**
 * Multi-Agent Discord Handler
 *
 * Integrates with the Discord gateway to provide multi-agent support.
 * Should be instantiated and called from the Discord gateway when
 * multi-agent mode is enabled.
 */
export class MultiAgentDiscordHandler {
  private config: MultiAgentConfig;
  private orchestrator: MultiAgentOrchestrator;
  private processManager: AgentProcessManager;
  private sharedContext: SharedContextManager;
  private multiBotManager: MultiBotManager;
  private messageQueue: AgentMessageQueue;
  private prReviewPoller: PRReviewPoller;
  private promptEnhancer: PromptEnhancer;
  private backgroundTaskManager: BackgroundTaskManager;
  private systemReminder: SystemReminderService;
  private delegationManager: DelegationManager;

  /** Discord client reference for main bot channel sends */
  private discordClient: { channels: { fetch: (id: string) => Promise<unknown> } } | null = null;

  /** Whether multi-bot mode is initialized */
  private multiBotInitialized = false;

  /** Tracks which agent:channel combos have received history injection (new session only) */
  private historyInjected = new Set<string>();

  /** Dedup map for delegation mentions with timestamps (prevents double processing) */
  private processedMentions = new Map<string, number>();

  /** TTL for processed mention entries (5 minutes) */
  private static readonly MENTION_TTL_MS = 5 * 60 * 1000;

  /** Cleanup interval handle for periodic tasks */
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  /** Channel-safe batch data accumulation (prevents cross-channel data contamination) */
  private batchData = new Map<string, string[]>();

  /** Tracks channels where APPROVE+commit was processed (prevents congratulation loops) */
  private approveProcessedChannels = new Map<string, number>();

  /** APPROVE cooldown period — blocks agent-to-agent routing after commit (5 minutes) */
  private static readonly APPROVE_COOLDOWN_MS = 5 * 60 * 1000;

  /** Cleanup interval period (1 minute) */
  private static readonly CLEANUP_INTERVAL_MS = 60_000;

  constructor(config: MultiAgentConfig, processOptions: Partial<PersistentProcessOptions> = {}) {
    this.config = config;
    this.orchestrator = new MultiAgentOrchestrator(config);
    this.processManager = new AgentProcessManager(config, processOptions);
    this.sharedContext = getSharedContextManager();
    this.multiBotManager = new MultiBotManager(config);
    this.messageQueue = new AgentMessageQueue();
    this.prReviewPoller = new PRReviewPoller();
    this.promptEnhancer = new PromptEnhancer();

    const agentConfigs = Object.entries(config.agents).map(([id, cfg]) => ({ id, ...cfg }));
    this.delegationManager = new DelegationManager(agentConfigs);

    this.backgroundTaskManager = new BackgroundTaskManager(
      async (agentId: string, prompt: string): Promise<string> => {
        const process = await this.processManager.getProcess('discord', 'background', agentId);
        const result = await process.sendMessage(prompt);
        return result.response;
      },
      { maxConcurrentPerAgent: 2, maxTotalConcurrent: 5 }
    );

    this.systemReminder = new SystemReminderService({
      batchWindowMs: 2000,
      enableChatNotifications: true,
    });

    this.backgroundTaskManager.on('task-started', ({ task }: { task: BackgroundTask }) => {
      this.systemReminder.notify({
        type: 'task-started',
        taskId: task.id,
        description: task.description,
        agentId: task.agentId,
        requestedBy: task.requestedBy,
        channelId: task.channelId,
        timestamp: Date.now(),
      });
    });

    this.backgroundTaskManager.on('task-completed', ({ task }: { task: BackgroundTask }) => {
      this.systemReminder.notify({
        type: 'task-completed',
        taskId: task.id,
        description: task.description,
        agentId: task.agentId,
        requestedBy: task.requestedBy,
        channelId: task.channelId,
        duration: task.duration,
        timestamp: Date.now(),
      });
    });

    this.backgroundTaskManager.on('task-failed', ({ task }: { task: BackgroundTask }) => {
      this.systemReminder.notify({
        type: 'task-failed',
        taskId: task.id,
        description: task.description,
        agentId: task.agentId,
        requestedBy: task.requestedBy,
        channelId: task.channelId,
        error: task.error,
        timestamp: Date.now(),
      });
    });

    // Periodic cleanup of expired queued messages and mention dedup entries
    this.cleanupInterval = setInterval(() => {
      this.messageQueue.clearExpired();
      this.cleanupProcessedMentions();
      this.cleanupApproveChannels();
    }, MultiAgentDiscordHandler.CLEANUP_INTERVAL_MS);

    // Setup idle event listeners for all agents (F7)
    this.setupIdleListeners();
  }

  /**
   * Setup idle event listeners for agent processes (F7)
   */
  private setupIdleListeners(): void {
    this.processManager.on('process-created', ({ agentId, process }) => {
      process.on('idle', async () => {
        await this.messageQueue.drain(agentId, process, async (aid, message, response) => {
          await this.sendQueuedResponse(aid, message, response);
        });
      });
    });
  }

  /**
   * Initialize multi-bot support (call after Discord connects)
   */
  async initializeMultiBots(): Promise<void> {
    if (this.multiBotInitialized) return;

    // Register mention callback so agent bots forward mentions to handler
    this.multiBotManager.onMention(async (agentId, message) => {
      // Dedup: skip if already processed via routeResponseMentions
      const dedupKey = `${agentId}:${message.id}`;
      if (this.processedMentions.has(dedupKey)) return;
      this.processedMentions.set(dedupKey, Date.now());

      // Block agent-to-agent mentions during post-APPROVE cooldown
      const approveCooldown = this.approveProcessedChannels.get(message.channel.id);
      if (
        message.author.bot &&
        approveCooldown &&
        Date.now() - approveCooldown < MultiAgentDiscordHandler.APPROVE_COOLDOWN_MS
      ) {
        return;
      }

      const cleanContent = message.content.replace(/<@!?\d+>/g, '').trim();
      if (!cleanContent) return;

      // Determine if sender is an agent bot (for mention_delegation chains)
      const isFromAgent = message.author.bot;
      const senderAgentId = isFromAgent
        ? (this.multiBotManager.isFromAgentBot(message) ?? undefined)
        : undefined;

      // Chain depth check for mention_delegation
      if (isFromAgent && senderAgentId && senderAgentId !== 'main') {
        const chainState = this.orchestrator.getChainState(message.channel.id);
        const maxDepth = this.config.max_mention_depth ?? 3;

        if (chainState.blocked) {
          console.log(
            `[MultiAgent] Mention chain blocked in channel ${message.channel.id}, ignoring`
          );
          return;
        }
        if (chainState.length >= maxDepth) {
          console.log(
            `[MultiAgent] Mention chain depth ${chainState.length} >= max ${maxDepth}, ignoring`
          );
          return;
        }
      }

      console.log(
        `[MultiAgent] Mention-triggered: agent=${agentId}, from=${senderAgentId ?? message.author.tag}, content="${cleanContent.substring(0, 50)}"`
      );

      // Extract mentioned agent IDs from the original content
      const mentionedAgentIds = this.extractMentionedAgentIds(message.content);

      // Add eyes emoji to indicate processing
      try {
        await message.react('👀');
      } catch {
        /* ignore */
      }

      // Force this specific agent to respond
      let mentionResponse: AgentResponse | null = null;
      try {
        mentionResponse = await this.processAgentResponse(
          agentId,
          {
            channelId: message.channel.id,
            userId: message.author.id,
            content: cleanContent,
            isBot: isFromAgent,
            senderAgentId: senderAgentId && senderAgentId !== 'main' ? senderAgentId : undefined,
            mentionedAgentIds,
            messageId: message.id,
            timestamp: message.createdTimestamp,
          },
          cleanContent,
          message
        );

        if (mentionResponse) {
          await this.sendAgentResponses(message, [mentionResponse]);
          this.orchestrator.recordAgentResponse(
            agentId,
            message.channel.id,
            mentionResponse.messageId
          );

          // Route delegation mentions from this agent's response
          if (this.isMentionDelegationEnabled()) {
            await this.routeResponseMentions(message, [mentionResponse]);
          }
        }
      } catch (err) {
        console.error(`[MultiAgent] Mention handler error:`, err);
      } finally {
        // Only add ✅ if agent responded (null = busy/queued, ⏳ already added)
        if (mentionResponse) {
          try {
            await message.react('✅');
          } catch {
            /* ignore */
          }
        }
      }
    });

    await this.multiBotManager.initialize();
    this.multiBotInitialized = true;

    const connectedAgents = this.multiBotManager.getConnectedAgents();
    if (connectedAgents.length > 0) {
      console.log(`[MultiAgent] Multi-bot mode active for: ${connectedAgents.join(', ')}`);
    }

    // Pass bot ID map to process manager for mention-based delegation prompts
    if (this.config.mention_delegation) {
      const botUserIdMap = this.multiBotManager.getBotUserIdMap();

      // Include LEAD (default agent) which uses the main bot token
      // Without this, @Sisyphus in other agents' personas won't resolve to <@userId>
      const defaultAgentId = this.config.default_agent;
      if (defaultAgentId && !botUserIdMap.has(defaultAgentId)) {
        const mainBotUserId = this.multiBotManager.getMainBotUserId();
        if (mainBotUserId) {
          botUserIdMap.set(defaultAgentId, mainBotUserId);
        }
      }

      this.processManager.setBotUserIdMap(botUserIdMap);
      this.processManager.setMentionDelegation(true);
      console.log(`[MultiAgent] Mention delegation enabled with ${botUserIdMap.size} bot IDs`);

      // PR Review Poller: target Reviewer for @mention in Discord messages.
      // Reviewer analyzes PR data → summarizes → mentions LEAD with prioritized tasks.
      const reviewerEntry = this.findReviewerAgent();
      const reviewerTargetId = reviewerEntry?.[0];
      const reviewerUserId = reviewerTargetId ? botUserIdMap.get(reviewerTargetId) : undefined;
      if (reviewerUserId) {
        this.prReviewPoller.setTargetAgentUserId(reviewerUserId);
        console.log(`[MultiAgent] PR Poller target: ${reviewerTargetId} (reviewer → LEAD)`);
      } else {
        // Fallback: mention LEAD directly
        const orchestratorId = defaultAgentId || 'sisyphus';
        const orchestratorUserId = botUserIdMap.get(orchestratorId);
        if (orchestratorUserId) {
          this.prReviewPoller.setTargetAgentUserId(orchestratorUserId);
          console.log(`[MultiAgent] PR Poller target: ${orchestratorId} (fallback LEAD)`);
        }
      }
    }
  }

  /**
   * Set bot's own user ID (call when Discord connects)
   * Also wires the PR Review Poller message sender via Discord client.
   */
  setBotUserId(userId: string): void {
    this.multiBotManager.setMainBotUserId(userId);
  }

  /**
   * Set Discord client for PR Review Poller message delivery.
   * Call after Discord client is ready.
   * The sender posts the message to the channel AND injects it into the
   * multi-agent flow so LEAD processes the review comments.
   */
  setDiscordClient(client: { channels: { fetch: (id: string) => Promise<unknown> } }): void {
    // Guard against setting different client when already configured
    if (this.discordClient && this.discordClient !== client) {
      console.warn('[MultiAgent] Attempted to set different Discord client - ignoring');
      return;
    }

    this.discordClient = client;

    this.systemReminder.registerCallback(async (channelId, message) => {
      const ch = await client.channels.fetch(channelId);
      if (ch && 'send' in (ch as Record<string, unknown>)) {
        const chunks = splitForDiscord(message);
        for (const chunk of chunks) {
          await (ch as { send: (opts: { content: string }) => Promise<unknown> }).send({
            content: chunk,
          });
        }
      }
    }, 'discord');

    if (this.prReviewPoller.hasMessageSender()) return;

    this.prReviewPoller.setMessageSender(async (channelId: string, text: string) => {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !('send' in (channel as Record<string, unknown>))) return;

      await (channel as { send: (opts: { content: string }) => Promise<Message> }).send({
        content: text,
      });

      // Store texts per channel to prevent cross-channel contamination
      // Use immutable approach to avoid race conditions
      const currentTexts = this.batchData.get(channelId) || [];
      const cleanText = text.replace(/<@!?\d+>/g, '').trim();
      this.batchData.set(channelId, [...currentTexts, cleanText]);
    });

    // After all chunks sent, send LEAD mention FROM Reviewer bot
    // with PR data included so LEAD doesn't pick up stale channel history.
    this.prReviewPoller.setOnBatchComplete(async (channelId: string) => {
      // Atomically retrieve and clear batch data to prevent race conditions
      const texts = this.batchData.get(channelId) || [];
      if (texts.length === 0) return;

      // Clear immediately to prevent duplicate processing
      this.batchData.delete(channelId);

      // Reset chain so LEAD can delegate freely
      this.orchestrator.resetChain(channelId);

      const leadUserId = this.multiBotManager.getMainBotUserId();
      if (!leadUserId) return;

      const reviewerEntry = this.findReviewerAgent();
      const reviewerAgentId = reviewerEntry?.[0];
      if (!reviewerAgentId) return;

      // Include PR data summary in LEAD mention (Discord 2000 char limit per message)
      const mentionPrefix = `<@${leadUserId}> Please analyze PR review comments and prioritize them for delegation.\n\n`;
      const prSummary = texts.join('\n').slice(0, 2000 - mentionPrefix.length);
      const fullMsg = `${mentionPrefix}${prSummary}`;

      // Split using Discord-aware splitter (2000 char limit)
      const chunks = splitForDiscord(fullMsg);
      for (const chunk of chunks) {
        await this.multiBotManager.sendAsAgent(reviewerAgentId, channelId, chunk);
      }
      console.log(
        `[MultiAgent] PR Poller → LEAD mention sent via ${reviewerAgentId} (${chunks.length} chunks, ${prSummary.length} chars)`
      );
    });
    console.log('[MultiAgent] PR Review Poller message sender configured for Discord');
  }

  /**
   * Set main bot token (to avoid duplicate logins in MultiBotManager)
   */
  setMainBotToken(token: string): void {
    this.multiBotManager.setMainBotToken(token);
  }

  /**
   * Check if multi-agent mode is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Update configuration (for hot reload)
   */
  updateConfig(config: MultiAgentConfig): void {
    this.config = config;
    this.orchestrator.updateConfig(config);
    this.processManager.updateConfig(config);
    this.multiBotManager.updateConfig(config);
  }

  /**
   * Handle a Discord message with multi-agent logic
   *
   * @returns Object with selected agents and their responses, or null if no agents respond
   */
  async handleMessage(message: Message, cleanContent: string): Promise<MultiAgentResponse | null> {
    // Build message context
    const context = this.buildMessageContext(message, cleanContent);

    // Record human message to shared context
    if (!context.isBot) {
      this.sharedContext.recordHumanMessage(
        context.channelId,
        message.author.username,
        cleanContent,
        message.id
      );

      // Auto-detect PR URLs in user messages and start polling
      this.detectAndPollPRUrls(cleanContent, context.channelId, message);
    }

    // Select responding agents
    const selection = this.orchestrator.selectRespondingAgents(context);

    console.log(
      `[MultiAgent] Selection result: agents=${selection.selectedAgents.join(',')}, reason=${selection.reason}, blocked=${selection.blocked}`
    );

    if (selection.blocked) {
      console.log(`[MultiAgent] Blocked: ${selection.blockReason}`);
      return null;
    }

    if (selection.selectedAgents.length === 0) {
      return null;
    }

    // Process all selected agents in parallel
    const results = await Promise.allSettled(
      selection.selectedAgents.map((agentId) =>
        this.processAgentResponse(agentId, context, cleanContent, message)
      )
    );

    const responses: AgentResponse[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const agentId = selection.selectedAgents[i];

      if (result.status === 'fulfilled' && result.value) {
        const response = result.value;
        responses.push(response);

        // Record agent response to orchestrator and shared context
        this.orchestrator.recordAgentResponse(agentId, context.channelId, response.messageId);

        const agent = this.orchestrator.getAgent(agentId);
        if (agent) {
          this.sharedContext.recordAgentMessage(
            context.channelId,
            agent,
            response.content,
            response.messageId
          );
        }
      } else if (result.status === 'rejected') {
        console.error(`[MultiAgent] Error processing agent ${agentId}:`, result.reason);
      }
    }

    if (responses.length === 0) {
      return null;
    }

    // Auto-detect PR URLs in agent responses and start polling
    for (const resp of responses) {
      this.detectAndPollPRUrls(resp.rawContent, context.channelId, message);
    }

    return {
      selectedAgents: selection.selectedAgents,
      reason: selection.reason,
      responses,
    };
  }

  /**
   * Process a single agent's response
   * @param discordMessage - Optional Discord message for emoji progression
   */
  private async processAgentResponse(
    agentId: string,
    context: MessageContext,
    userMessage: string,
    discordMessage?: Message
  ): Promise<AgentResponse | null> {
    const agent = this.orchestrator.getAgent(agentId);
    if (!agent) {
      console.error(`[MultiAgent] Unknown agent: ${agentId}`);
      return null;
    }

    // Strip trigger prefix from message if present
    const cleanMessage = this.orchestrator.stripTriggerPrefix(userMessage, agentId);

    // Build context for this agent.
    // In delegation chains (senderAgentId set), include own messages so the agent
    // can see what it already said and reason about whether to repeat.
    // In normal triggers, exclude own messages to avoid self-reference confusion.
    let agentContext: string;
    if (context.senderAgentId) {
      const messages = this.sharedContext.getRecentMessages(context.channelId, 10);
      if (messages.length > 0) {
        const lines = messages.map((msg) => {
          const isSelf = msg.agentId === agentId;
          const prefix = msg.isHuman ? '👤' : isSelf ? '📌 (you)' : '🤖';
          const content =
            msg.content.length > 600 ? msg.content.slice(0, 600) + '...' : msg.content;
          return `${prefix} **${msg.displayName}**: ${content}`;
        });
        agentContext = `## Delegation Chain Context\n${lines.join('\n')}`;
      } else {
        agentContext = '';
      }
    } else {
      agentContext = this.sharedContext.buildContextForAgent(context.channelId, agentId, 5);
    }

    // Build full prompt with context.
    // - agentContext: other agents' recent messages (inter-agent awareness)
    // - historyContext: human-only channel history (LEAD agent only)
    //   DevBot/Reviewer are sub-agent-like — they get tasks via delegation, not channel history.
    //   Only LEAD needs channel context to understand the conversation flow.
    let fullPrompt = cleanMessage;

    // Inject channel history for the default (LEAD) agent on new sessions only.
    // - Keeps human messages + LEAD's own messages, excludes other bots.
    // - Only on first message per session (subsequent messages are in session memory).
    // - DevBot/Reviewer get tasks via delegation — they don't need channel history.
    const defaultAgentId = this.config.default_agent;
    const sessionKey = `${agentId}:${context.channelId}`;
    if (agentId === defaultAgentId && !this.historyInjected.has(sessionKey)) {
      const channelHistory = getChannelHistory();
      const leadDisplayName = agent.display_name || agentId;
      const historyContext = channelHistory.formatForContext(
        context.channelId,
        context.messageId,
        leadDisplayName // keep human + LEAD's own messages, exclude other bots
      );
      if (historyContext) {
        fullPrompt = `${historyContext}\n\n${fullPrompt}`;
      }
      this.historyInjected.add(sessionKey);
    }

    if (agentContext) {
      fullPrompt = `${agentContext}\n\n${fullPrompt}`;
    }

    // Enhance prompt with keyword detection (ultrawork/search/analyze modes)
    const workspacePath = process.env.MAMA_WORKSPACE || '';
    const ruleContext: RuleContext = {
      agentId,
      tier: agent.tier,
      channelId: context.channelId,
    };
    const enhanced = this.promptEnhancer.enhance(cleanMessage, workspacePath, ruleContext);
    if (enhanced.keywordInstructions) {
      fullPrompt = `${enhanced.keywordInstructions}\n\n${fullPrompt}`;
      console.log(
        `[PromptEnhancer] Keyword detected for agent ${agentId}: ${enhanced.keywordInstructions.length} chars injected`
      );
    }
    if (enhanced.rulesContent) {
      fullPrompt = `## Project Rules\n${enhanced.rulesContent}\n\n${fullPrompt}`;
      console.log(
        `[PromptEnhancer] Rules injected for agent ${agentId}: ${enhanced.rulesContent.length} chars`
      );
    }

    console.log(`[MultiAgent] Processing agent ${agentId}, prompt length: ${fullPrompt.length}`);

    try {
      // Get or create process for this agent in this channel
      const process = await this.processManager.getProcess('discord', context.channelId, agentId);

      // Build onToolUse callback for emoji progression (accumulate, don't replace)
      const addedEmojis = new Set<string>();
      const hasOwnBot = this.multiBotManager.hasAgentBot(agentId);
      const onToolUse = discordMessage
        ? (name: string) => {
            const emoji = toolToPhaseEmoji(name);
            if (emoji && !addedEmojis.has(emoji)) {
              addedEmojis.add(emoji);
              if (hasOwnBot) {
                this.multiBotManager
                  .reactAsAgent(agentId, discordMessage.channel.id, discordMessage.id, emoji)
                  .catch(() => {
                    /* ignore */
                  });
              } else {
                discordMessage.react(emoji).catch(() => {
                  /* ignore */
                });
              }
            }
          }
        : undefined;

      // Send message and get response (with timeout, properly cleaned up)
      let timeoutHandle: ReturnType<typeof setTimeout>;
      const result = await Promise.race([
        process.sendMessage(fullPrompt, onToolUse ? { onToolUse } : undefined),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(`Agent ${agentId} timed out after ${AGENT_TIMEOUT_MS / 1000}s`)),
            AGENT_TIMEOUT_MS
          );
        }),
      ]);
      clearTimeout(timeoutHandle!);

      const resolvedResponse = this.resolveResponseMentions(result.response);

      const bgDelegation = this.delegationManager.parseDelegation(agentId, resolvedResponse);
      if (bgDelegation && bgDelegation.background) {
        const check = this.delegationManager.isDelegationAllowed(
          bgDelegation.fromAgentId,
          bgDelegation.toAgentId
        );
        if (check.allowed) {
          const toAgent = this.orchestrator.getAgent(bgDelegation.toAgentId);
          this.backgroundTaskManager.submit({
            description: bgDelegation.task.substring(0, 200),
            prompt: bgDelegation.task,
            agentId: bgDelegation.toAgentId,
            requestedBy: agentId,
            channelId: context.channelId,
            source: 'discord',
          });
          console.log(
            `[MultiAgent] Background delegation: ${agentId} → ${bgDelegation.toAgentId} (async)`
          );

          const displayResponse =
            bgDelegation.originalContent ||
            `🔄 Background task submitted to **${toAgent?.display_name ?? bgDelegation.toAgentId}**`;
          const formattedResponse = this.formatAgentResponse(agent, displayResponse);
          return {
            agentId,
            agent,
            content: formattedResponse,
            rawContent: displayResponse,
            duration: result.duration_ms,
          };
        }
      }

      const formattedResponse = this.formatAgentResponse(agent, resolvedResponse);
      return {
        agentId,
        agent,
        content: formattedResponse,
        rawContent: resolvedResponse,
        duration: result.duration_ms,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[MultiAgent] Failed to get response from ${agentId}:`, error);

      if (errMsg.includes('busy')) {
        console.log(`[MultiAgent] Agent ${agentId} busy, enqueuing message`);

        const queuedMessage: QueuedMessage = {
          prompt: fullPrompt,
          channelId: context.channelId,
          threadTs: context.messageId,
          source: 'discord',
          enqueuedAt: Date.now(),
          context,
          discordMessageId: discordMessage?.id,
        };

        this.messageQueue.enqueue(agentId, queuedMessage);

        if (discordMessage) {
          try {
            await discordMessage.react('⏳');
          } catch {
            /* ignore */
          }
        }
      }

      return null;
    }
  }

  /**
   * Build message context from Discord message
   */
  private buildMessageContext(message: Message, cleanContent: string): MessageContext {
    const isBot = message.author.bot;
    let senderAgentId: string | undefined;

    if (isBot) {
      // Check if message is from one of our agent bots
      const agentBotId = this.multiBotManager.isFromAgentBot(message);
      if (agentBotId && agentBotId !== 'main') {
        senderAgentId = agentBotId;
      } else {
        // Try to extract agent ID from message display name (main bot)
        const extracted = this.orchestrator.extractAgentIdFromMessage(message.content);
        senderAgentId = extracted ?? undefined;
      }
    }

    return {
      channelId: message.channel.id,
      userId: message.author.id,
      content: cleanContent,
      isBot,
      senderAgentId,
      messageId: message.id,
      timestamp: message.createdTimestamp,
    };
  }

  /**
   * Format agent response with display name prefix
   */
  private formatAgentResponse(agent: AgentPersonaConfig, response: string): string {
    // Check if response already has the agent prefix
    const prefix = `**${agent.display_name}**:`;
    if (response.startsWith(prefix) || response.startsWith(`**${agent.display_name}**: `)) {
      return response;
    }

    return `${prefix} ${response}`;
  }

  /**
   * Send queued response to Discord (F7: message queue drain callback)
   */
  private async sendQueuedResponse(
    agentId: string,
    message: QueuedMessage,
    response: string
  ): Promise<void> {
    const agent = this.orchestrator.getAgent(agentId);
    if (!agent) {
      console.error(`[MultiAgent] Unknown agent in queue: ${agentId}`);
      return;
    }

    // Format response with agent prefix
    const formattedResponse = this.formatAgentResponse(agent, response);

    const chunks = splitForDiscord(formattedResponse);
    const hasOwnBot = this.multiBotManager.hasAgentBot(agentId);

    for (const chunk of chunks) {
      try {
        if (hasOwnBot) {
          // Use agent's dedicated bot - send to channel
          await this.multiBotManager.sendAsAgent(agentId, message.channelId, chunk);
        } else if (this.discordClient) {
          // Use main bot via stored Discord client
          const channel = await this.discordClient.channels.fetch(message.channelId);
          if (channel && 'send' in (channel as Record<string, unknown>)) {
            await (channel as { send: (content: string) => Promise<unknown> }).send(chunk);
          }
        } else {
          console.warn(
            `[MultiAgent] Cannot send queued message for ${agentId}: no agent bot or Discord client`
          );
        }
      } catch (err) {
        console.error(`[MultiAgent] Failed to send queued response for ${agentId}:`, err);
      }
    }

    // Record to shared context
    this.sharedContext.recordAgentMessage(message.channelId, agent, response, '');

    // Mark original Discord message as completed (⏳→✅)
    if (message.discordMessageId && this.discordClient) {
      try {
        const channel = await this.discordClient.channels.fetch(message.channelId);
        if (channel && 'messages' in (channel as Record<string, unknown>)) {
          const originalMsg = await (
            channel as { messages: { fetch: (id: string) => Promise<Message> } }
          ).messages.fetch(message.discordMessageId);
          if (originalMsg) {
            await originalMsg.react('✅');
          }
        }
      } catch {
        /* ignore — message may have been deleted */
      }
    }

    console.log(`[MultiAgent] Queued message delivered for ${agentId} in ${message.channelId}`);
  }

  /**
   * Send formatted response to Discord (handles message splitting)
   * Uses agent's dedicated bot if available, otherwise main bot
   */
  async sendAgentResponses(
    originalMessage: Message,
    responses: AgentResponse[]
  ): Promise<Message[]> {
    const sentMessages: Message[] = [];

    for (const response of responses) {
      try {
        const chunks = splitForDiscord(response.content);
        const hasOwnBot = this.multiBotManager.hasAgentBot(response.agentId);

        for (let i = 0; i < chunks.length; i++) {
          let sentMessage: Message | null = null;

          try {
            if (hasOwnBot) {
              // Use agent's dedicated bot
              if (i === 0) {
                // First chunk: reply to original message
                sentMessage = await this.multiBotManager.replyAsAgent(
                  response.agentId,
                  originalMessage,
                  chunks[i]
                );
              } else {
                // Subsequent chunks: send as new message
                sentMessage = await this.multiBotManager.sendAsAgent(
                  response.agentId,
                  originalMessage.channel.id,
                  chunks[i]
                );
              }
            } else {
              // Use main bot
              if (sentMessages.length === 0 && i === 0) {
                // First message: reply to original
                sentMessage = await originalMessage.reply({ content: chunks[i] });
              } else {
                // Subsequent messages: send as new message
                if ('send' in originalMessage.channel) {
                  sentMessage = await (
                    originalMessage.channel as {
                      send: (content: { content: string }) => Promise<Message>;
                    }
                  ).send({ content: chunks[i] });
                }
              }
            }

            if (sentMessage) {
              sentMessages.push(sentMessage);

              // Update response with message ID (for chain tracking)
              if (i === 0) {
                response.messageId = sentMessage.id;
              }
            }
          } catch (chunkErr) {
            // Per-chunk error handling: don't let one chunk failure drop remaining chunks
            console.error(
              `[MultiAgent] Failed to send chunk ${i + 1}/${chunks.length} for agent ${response.agentId}:`,
              chunkErr
            );
            // Continue with next chunk
          }
        }
      } catch (err) {
        // Per-response error handling: don't let one agent's failure drop other agents' responses
        console.error(`[MultiAgent] Failed to send response for agent ${response.agentId}:`, err);
      }
    }

    // Post-send: Auto-review trigger for default agent (Armed Sisyphus) self-implementations
    const defaultAgentId = this.config.default_agent;
    if (defaultAgentId) {
      const selfImplemented = responses.find(
        (r) => r.agentId === defaultAgentId && this.detectSelfImplementation(r.rawContent)
      );

      if (selfImplemented && sentMessages.length > 0) {
        this.triggerAutoReviewIfNeeded(originalMessage.channel.id, defaultAgentId).catch((err) =>
          console.error('[AutoReview] Failed to check diff size:', err)
        );
      }
    }

    return sentMessages;
  }

  /**
   * Detect if the default agent (Sisyphus) performed direct code edits.
   * Checks for Claude CLI tool-use markers that indicate Edit/Write operations.
   */
  private detectSelfImplementation(rawContent: string): boolean {
    // Claude CLI responses contain tool use results — look for Edit/Write indicators
    const editIndicators = [
      /\bedit\b.*\bapplied\b/i,
      /\bwrote\b.*\bfile\b/i,
      /\bmodified\b.*\bfile/i,
      /\bEdit\b.*\bsuccess/i,
      /\bWrite\b.*\bsuccess/i,
      /파일.*수정/,
      /수정.*완료/,
      /\[SOLO\]/i,
      /\[PAIR\]/i,
    ];
    return editIndicators.some((pattern) => pattern.test(rawContent));
  }

  /**
   * Check git diff size after Sisyphus self-implementation.
   * If diff exceeds thresholds, auto-trigger Reviewer for quality gate.
   *
   * Thresholds (PAIR mode auto-escalation):
   * - >3 files changed → auto-mention Reviewer
   * - >200 lines changed → auto-mention Reviewer
   */
  private async triggerAutoReviewIfNeeded(
    channelId: string,
    defaultAgentId: string
  ): Promise<void> {
    const MAX_FILES = 3;
    const MAX_LINES = 200;

    try {
      // Get diff stats from git
      const { stdout: diffStat } = await execFileAsync('git', ['diff', '--stat', '--cached'], {
        cwd: process.cwd(),
        timeout: 5000,
      });

      // Also check unstaged changes (increased timeout for large repos)
      const { stdout: diffUnstaged } = await execFileAsync('git', ['diff', '--stat'], {
        cwd: process.cwd(),
        timeout: 10000,
      });

      const combinedDiff = diffStat + '\n' + diffUnstaged;
      const fileLines = combinedDiff
        .split('\n')
        .filter((l) => l.includes('|'))
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const filesChanged = fileLines.length;

      // Parse total insertions/deletions from summary line
      const summaryMatch = combinedDiff.match(/(\d+)\s+insertion|(\d+)\s+deletion/g);
      let totalLines = 0;
      if (summaryMatch) {
        for (const m of summaryMatch) {
          const num = m.match(/(\d+)/);
          if (num) {
            totalLines += parseInt(num[1], 10);
          }
        }
      }

      if (filesChanged > MAX_FILES || totalLines > MAX_LINES) {
        console.log(
          `[AutoReview] Sisyphus self-implementation exceeded thresholds: ${filesChanged} files, ${totalLines} lines → auto-triggering Reviewer`
        );

        // Find reviewer agent using shared helper
        const reviewerEntry = this.findReviewerAgent();
        const reviewerAgentId = reviewerEntry?.[0];

        if (reviewerAgentId && this.multiBotManager.hasAgentBot(reviewerAgentId)) {
          const reviewMsg = `⬆️ **Auto-Review Triggered** — ${defaultAgentId} self-implemented but diff exceeded thresholds (${filesChanged} files, ${totalLines} lines). Requesting @Reviewer auto-review.`;
          await this.multiBotManager.sendAsAgent(reviewerAgentId, channelId, reviewMsg);
        }
      } else {
        console.log(
          `[AutoReview] Sisyphus self-implementation within thresholds: ${filesChanged} files, ${totalLines} lines — no auto-review needed`
        );
      }
    } catch {
      // Git not available or not in a repo — skip silently
    }
  }

  /**
   * Get orchestrator for direct access
   */
  getOrchestrator(): MultiAgentOrchestrator {
    return this.orchestrator;
  }

  /**
   * Get process manager for direct access
   */
  getProcessManager(): AgentProcessManager {
    return this.processManager;
  }

  /**
   * Get shared context manager
   */
  getSharedContext(): SharedContextManager {
    return this.sharedContext;
  }

  /**
   * Get multi-bot manager
   */
  getMultiBotManager(): MultiBotManager {
    return this.multiBotManager;
  }

  getBackgroundTaskManager(): BackgroundTaskManager {
    return this.backgroundTaskManager;
  }

  getSystemReminder(): SystemReminderService {
    return this.systemReminder;
  }

  isMentionDelegationEnabled(): boolean {
    return this.config.mention_delegation === true;
  }

  /**
   * Extract agent IDs from <@USER_ID> mentions in message content
   */
  private extractMentionedAgentIds(content: string): string[] {
    const mentionPattern = /<@!?(\d+)>/g;
    const agentIds: string[] = [];
    let match;

    while ((match = mentionPattern.exec(content)) !== null) {
      const userId = match[1];
      const agentId = this.multiBotManager.resolveAgentIdFromUserId(userId);
      if (agentId && agentId !== 'main') {
        agentIds.push(agentId);
      } else if (agentId === 'main' && this.config.default_agent) {
        // Main bot userId maps to the default agent (LEAD)
        agentIds.push(this.config.default_agent);
      }
    }

    return agentIds;
  }

  /**
   * After sending agent responses, check for mentions to other agents and route them.
   * Discord equivalent of Slack's routeResponseMentions — necessary because Discord
   * bots don't receive their own messages as events.
   */
  async routeResponseMentions(originalMessage: Message, responses: AgentResponse[]): Promise<void> {
    // Block all agent-to-agent routing during post-APPROVE cooldown
    const channelApproveTs = this.approveProcessedChannels.get(originalMessage.channel.id);
    if (
      channelApproveTs &&
      Date.now() - channelApproveTs < MultiAgentDiscordHandler.APPROVE_COOLDOWN_MS
    ) {
      return;
    }

    for (const response of responses) {
      const senderAgent = this.orchestrator.getAgent(response.agentId);

      // Filter out self-mentions only. All agents can route to any other agent
      // including LEAD — the receiving LLM agent can reason about whether to
      // respond with new information or acknowledge without repeating.
      const mentionedAgentIds = this.extractMentionedAgentIds(response.rawContent).filter(
        (id) => id !== response.agentId // no self-mention
      );
      if (mentionedAgentIds.length === 0) continue;
      if (senderAgent?.can_delegate && isDelegationAttempt(response.rawContent)) {
        const validation = validateDelegationFormat(response.rawContent);
        if (!validation.valid) {
          console.warn(
            `[Delegation] BLOCKED ${response.agentId} — missing: ${validation.missingSections.join(', ')}`
          );

          // Post warning to channel so the agent sees the feedback
          try {
            const warningMsg =
              `⚠️ **Delegation blocked** — missing sections: ${validation.missingSections.join(', ')}\n` +
              `Re-send with all 6 sections: TASK, EXPECTED OUTCOME, MUST DO, MUST NOT DO, REQUIRED TOOLS, CONTEXT`;
            const hasOwnBot = this.multiBotManager.hasAgentBot(response.agentId);
            if (hasOwnBot) {
              await this.multiBotManager.replyAsAgent(
                response.agentId,
                originalMessage,
                warningMsg
              );
            } else {
              await originalMessage.reply({ content: warningMsg });
            }
          } catch {
            /* ignore warning post errors */
          }

          continue; // Skip routing — do not forward to target agents
        }
      }

      console.log(
        `[MultiAgent] Auto-routing mentions from ${response.agentId}: → ${mentionedAgentIds.join(', ')}`
      );

      const defaultAgentId = this.config.default_agent;
      const isReviewerApproveToLead =
        this.isReviewerAgent(response.agentId) &&
        mentionedAgentIds.includes(defaultAgentId || '') &&
        /\b(APPROVE|approved|approves)\b(?!\w)/i.test(response.rawContent);

      let autoCommitResult: string | null = null;
      if (isReviewerApproveToLead) {
        // Dedup: skip if APPROVE already processed for this channel
        const lastApprove = this.approveProcessedChannels.get(originalMessage.channel.id);
        if (
          lastApprove &&
          Date.now() - lastApprove < MultiAgentDiscordHandler.APPROVE_COOLDOWN_MS
        ) {
          console.log(
            `[MultiAgent] APPROVE already processed for ${originalMessage.channel.id}, skipping`
          );
          continue;
        }

        autoCommitResult = await this.autoCommitAndPush(originalMessage.channel.id);
        if (autoCommitResult) {
          try {
            const chunks = splitForDiscord(autoCommitResult);
            for (const chunk of chunks) {
              if ('send' in originalMessage.channel) {
                await (
                  originalMessage.channel as {
                    send: (opts: { content: string }) => Promise<Message>;
                  }
                ).send({ content: chunk });
              }
            }
          } catch {
            /* ignore send errors */
          }
        }
      }

      // Route to all mentioned agents in parallel
      await Promise.all(
        mentionedAgentIds.map((targetAgentId) =>
          this.handleDelegatedMention(targetAgentId, originalMessage, response, autoCommitResult)
        )
      );

      // Set APPROVE cooldown AFTER routing to LEAD (so LEAD gets the first one)
      if (isReviewerApproveToLead) {
        this.approveProcessedChannels.set(originalMessage.channel.id, Date.now());
      }
    }
  }

  /**
   * Handle a delegated mention: process target agent response and recursively route.
   */
  private async handleDelegatedMention(
    targetAgentId: string,
    originalMessage: Message,
    sourceResponse: AgentResponse,
    autoCommitResult?: string | null
  ): Promise<void> {
    // Dedup: prevent double processing
    const dedupKey = `${targetAgentId}:${sourceResponse.messageId || originalMessage.id}`;
    if (this.processedMentions.has(dedupKey)) return;
    this.processedMentions.set(dedupKey, Date.now());

    // Chain depth check
    const chainState = this.orchestrator.getChainState(originalMessage.channel.id);
    const maxDepth = this.config.max_mention_depth ?? 3;
    if (chainState.blocked || chainState.length >= maxDepth) {
      console.log(`[MultiAgent] Delegation chain blocked/maxed in ${originalMessage.channel.id}`);
      return;
    }

    console.log(`[MultiAgent] Delegated mention: ${sourceResponse.agentId} → ${targetAgentId}`);

    // React on the delegation message (source agent's response), not the user's original message
    const hasOwnBot = this.multiBotManager.hasAgentBot(targetAgentId);
    const delegationMsgId = sourceResponse.messageId || originalMessage.id;
    const channelId = originalMessage.channel.id;
    try {
      if (hasOwnBot) {
        await this.multiBotManager.reactAsAgent(targetAgentId, channelId, delegationMsgId, '👀');
      } else {
        await originalMessage.react('👀');
      }
    } catch {
      /* ignore */
    }

    try {
      let delegationContent = sourceResponse.rawContent.replace(/<@!?\d+>/g, '').trim();

      const defaultAgentId = this.config.default_agent;
      if (
        targetAgentId === defaultAgentId &&
        /\b(APPROVE|approved|approves)\b(?!\w)/i.test(delegationContent)
      ) {
        if (autoCommitResult && autoCommitResult.startsWith('✅')) {
          delegationContent +=
            '\n\n✅ [SYSTEM] Auto Commit completed.\n' +
            `Result: ${autoCommitResult}\n` +
            '**Execute `git push` now. Then summarize review results briefly. Do NOT congratulate agents.**';
        } else if (autoCommitResult) {
          delegationContent +=
            '\n\n⚠️ [SYSTEM] Reviewer APPROVED. Auto commit failed. Execute Phase 3:\n' +
            '1. `git status`\n' +
            '2. `git add {changed files}` (git add . prohibited)\n' +
            '3. `git commit -m "fix: {change summary}"`\n' +
            '4. `git push`\n' +
            '**Execute commit+push first. No praise. No congratulations. Just results.**';
        } else {
          delegationContent +=
            '\n\n⚠️ [SYSTEM] Reviewer APPROVED. Execute Phase 3:\n' +
            '1. `git status` → `git add` → `git commit` → `git push`\n' +
            '**Execute immediately. No praise. Just results.**';
        }
      }

      const response = await this.processAgentResponse(
        targetAgentId,
        {
          channelId,
          userId: originalMessage.author.id,
          content: delegationContent,
          isBot: true,
          senderAgentId: sourceResponse.agentId,
          mentionedAgentIds: [targetAgentId],
          messageId: originalMessage.id,
          timestamp: originalMessage.createdTimestamp,
        },
        delegationContent,
        undefined // Don't pass discordMessage — emojis handled here via delegation messageId
      );

      if (response) {
        await this.sendAgentResponses(originalMessage, [response]);
        this.orchestrator.recordAgentResponse(
          targetAgentId,
          originalMessage.channel.id,
          response.messageId
        );

        // Recursively route mentions in this agent's response
        await this.routeResponseMentions(originalMessage, [response]);
      }
    } catch (err) {
      console.error(`[MultiAgent] Delegated mention error (${targetAgentId}):`, err);
    } finally {
      // Add ✅ on the delegation message (source agent's response)
      try {
        if (hasOwnBot) {
          await this.multiBotManager.reactAsAgent(targetAgentId, channelId, delegationMsgId, '✅');
        } else {
          // Fix: React to the delegation message, not the original user message
          const delegationMsg = await originalMessage.channel.messages.fetch(delegationMsgId);
          await delegationMsg.react('✅');
        }
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Resolve @Name mentions in LLM response text to <@userId> Discord format.
   * LLMs generate plain text like "@LEAD", "@Sisyphus", "@DevBot" which won't
   * trigger Discord mentions or routeResponseMentions detection.
   */
  private resolveResponseMentions(text: string): string {
    if (!this.config.mention_delegation) return text;

    const botUserIdMap = this.multiBotManager.getBotUserIdMap();
    const mainBotUserId = this.multiBotManager.getMainBotUserId();
    const defaultAgentId = this.config.default_agent;

    // Build pattern → <@userId> lookup
    const patterns = new Map<string, string>();
    for (const [agentId, agentConfig] of Object.entries(this.config.agents)) {
      let userId = botUserIdMap.get(agentId);
      if (!userId && agentId === defaultAgentId && mainBotUserId) {
        userId = mainBotUserId;
      }
      if (!userId) continue;

      const mention = `<@${userId}>`;
      if (agentConfig.name) patterns.set(agentConfig.name.toLowerCase(), mention);
      if (agentConfig.display_name) patterns.set(agentConfig.display_name.toLowerCase(), mention);
      patterns.set(agentId.toLowerCase(), mention);
    }
    // Also match "LEAD" for the default agent
    if (defaultAgentId && mainBotUserId) {
      patterns.set('lead', `<@${mainBotUserId}>`);
    }

    let resolved = text;
    for (const [pattern, mention] of patterns) {
      // Match @pattern but NOT already-resolved <@pattern
      const regex = new RegExp(`(?<!<)@${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      resolved = resolved.replace(regex, mention);
    }

    return resolved;
  }

  /**
   * Clean up old processed mention entries based on TTL
   */
  private cleanupProcessedMentions(): void {
    const now = Date.now();
    for (const [key, ts] of this.processedMentions) {
      if (now - ts > MultiAgentDiscordHandler.MENTION_TTL_MS) {
        this.processedMentions.delete(key);
      }
    }
  }

  private cleanupApproveChannels(): void {
    const now = Date.now();
    for (const [channelId, ts] of this.approveProcessedChannels) {
      if (now - ts > MultiAgentDiscordHandler.APPROVE_COOLDOWN_MS) {
        this.approveProcessedChannels.delete(channelId);
      }
    }
  }

  /**
   * Detect PR URLs in text and auto-start polling.
   * Sends a notification to the channel when polling starts.
   */
  private detectAndPollPRUrls(text: string, channelId: string, message: Message): void {
    const prUrls = PRReviewPoller.extractPRUrls(text);
    if (prUrls.length === 0) return;

    for (const prUrl of prUrls) {
      this.prReviewPoller
        .startPolling(prUrl, channelId)
        .then((started) => {
          if (started) {
            const parsed = this.prReviewPoller.parsePRUrl(prUrl);
            const key = parsed ? `${parsed.owner}/${parsed.repo}#${parsed.prNumber}` : prUrl;
            if ('send' in message.channel) {
              (message.channel as { send: (opts: { content: string }) => Promise<unknown> })
                .send({
                  content: `👀 **PR Review Poller Started** — ${key}\nDetecting new review comments every 60 seconds.`,
                })
                .catch((err) => {
                  console.warn(
                    `[MultiAgent] Failed to send PR polling start message to Discord channel ${channelId}:`,
                    err?.message || err
                  );
                });
            }
            console.log(
              `[MultiAgent] PR Poller started for ${key} in Discord channel ${channelId}`
            );
          }
        })
        .catch((err) => {
          console.error(`[MultiAgent] Failed to start PR polling:`, err);
        });
    }
  }

  /**
   * Get PR Review Poller instance
   */
  getPRReviewPoller(): PRReviewPoller {
    return this.prReviewPoller;
  }

  /**
   * Stop all agent processes and bots
   */
  async stopAll(): Promise<void> {
    // Clear cleanup interval to prevent memory leaks
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    this.processManager.stopAll();
    this.prReviewPoller.stopAll();
    await this.multiBotManager.stopAll();
  }

  /**
   * Get chain state for a channel (for debugging)
   */
  getChainState(channelId: string) {
    return this.orchestrator.getChainState(channelId);
  }

  /**
   * Get status of all agent bots
   */
  getBotStatus(): Record<string, { connected: boolean; username?: string }> {
    return this.multiBotManager.getStatus();
  }

  /**
   * Check if an agent ID is the reviewer agent
   */
  private isReviewerAgent(agentId: string): boolean {
    return (
      agentId.toLowerCase().includes('review') ||
      this.config.agents[agentId]?.name?.toLowerCase().includes('review') === true
    );
  }

  /**
   * Find the reviewer agent entry from config
   */
  private findReviewerAgent(): [string, Omit<AgentPersonaConfig, 'id'>] | undefined {
    return Object.entries(this.config.agents).find(
      ([aid, cfg]) =>
        aid.toLowerCase().includes('review') || cfg.name?.toLowerCase().includes('review')
    );
  }

  /**
   * Auto commit+push when Reviewer APPROVE is detected.
   * Finds the repo from active PR polling sessions, runs git operations.
   * Returns a status message or null if no repo found.
   */
  private async autoCommitAndPush(channelId: string): Promise<string | null> {
    // Check if auto-commit is explicitly enabled (disabled by default for safety)
    if (process.env.MAMA_ENABLE_AUTO_COMMIT !== 'true') {
      console.log(
        '[AutoCommit] Auto-commit is disabled by default. Set MAMA_ENABLE_AUTO_COMMIT=true to enable'
      );
      return null;
    }

    // Find active PR session for this channel to get the repo info
    const sessions = this.prReviewPoller.getActiveSessions();
    if (sessions.length === 0) return null;

    // Find session matching this channel
    const pollerSessions = this.prReviewPoller.getSessionDetails();
    const session = pollerSessions.find((s) => s.channelId === channelId);
    if (!session) return null;

    // Find local repo path (check common locations)
    const homedir = process.env.HOME || '/home/deck';
    const possiblePaths = [
      `${homedir}/${session.repo}`,
      `${homedir}/project/${session.repo}`,
      `${homedir}/projects/${session.repo}`,
    ];

    let repoPath: string | null = null;
    for (const p of possiblePaths) {
      try {
        await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: p, timeout: 5000 });
        repoPath = p;
        break;
      } catch {
        // not a git repo at this path
      }
    }

    if (!repoPath) {
      console.log(`[AutoCommit] No local repo found for ${session.repo}`);
      return null;
    }

    console.log(`[AutoCommit] Found repo at ${repoPath}, running commit+push`);

    try {
      // 1. Check current branch - prevent commits to main/master
      const { stdout: branchOut } = await execFileAsync('git', ['branch', '--show-current'], {
        cwd: repoPath,
        timeout: 5000,
      });

      const currentBranch = branchOut.trim();
      const protectedBranches = ['main', 'master', 'develop', 'production', 'staging'];
      if (protectedBranches.includes(currentBranch)) {
        console.log(`[AutoCommit] Refusing to commit to protected branch: ${currentBranch}`);
        return `🚫 Auto-commit blocked: Cannot commit to protected branch '${currentBranch}'. (${session.repo})`;
      }

      // 2. git status
      const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: repoPath,
        timeout: 10000,
      });

      if (!statusOut.trim()) {
        console.log(`[AutoCommit] No changes to commit in ${repoPath}`);
        return `📭 No changes to commit. (${session.repo})`;
      }

      // 2. Get changed files from porcelain format (XY PATH or XY ORIG -> PATH)
      const changedFiles = statusOut
        .trim()
        .split('\n')
        .map((line) => {
          // Porcelain v1: first 2 chars = status, then space, then path
          // For renames: "R  old -> new" — use the new path
          let path = line.substring(2).trimStart();
          if (path.includes(' -> ')) {
            path = path.split(' -> ').pop()?.trim() || '';
          } else {
            path = path.trim();
          }

          // Remove quotes if git added them for paths with spaces
          if (path.startsWith('"') && path.endsWith('"')) {
            path = path.slice(1, -1);
          }

          return path;
        })
        .filter(Boolean);

      // Check for sensitive files
      const sensitivePatterns = [
        /\.env/i,
        /\.pem$/i,
        /\.key$/i,
        /credentials/i,
        /secrets/i,
        /private.*key/i,
        /id_rsa/i,
        /\.p12$/i,
        /\.pfx$/i,
        /password/i,
        /\.aws\//i,
        /\.ssh\//i,
      ];

      const sensitiveFiles = changedFiles.filter((file) =>
        sensitivePatterns.some((pattern) => pattern.test(file))
      );

      if (sensitiveFiles.length > 0) {
        console.log(`[AutoCommit] Blocked: sensitive files detected: ${sensitiveFiles.join(', ')}`);
        return `🔒 Auto-commit blocked: Sensitive files detected:\n${sensitiveFiles.map((f) => `• ${f}`).join('\n')}`;
      }

      // 3. git add (specific files, batched to prevent ARG_MAX issues)
      const BATCH_SIZE = 50;
      for (let i = 0; i < changedFiles.length; i += BATCH_SIZE) {
        const batch = changedFiles.slice(i, i + BATCH_SIZE);
        await execFileAsync('git', ['add', ...batch], {
          cwd: repoPath,
          timeout: 15000,
        });
      }

      // 4. git commit
      const commitMsg = `fix: address PR review comments (${session.owner}/${session.repo}#${session.prNumber})`;
      await execFileAsync('git', ['commit', '-m', commitMsg], { cwd: repoPath, timeout: 15000 });

      const shortStatus =
        changedFiles.length <= 5
          ? changedFiles.join(', ')
          : `${changedFiles.slice(0, 5).join(', ')} +${changedFiles.length - 5} more`;

      // Safety: Only commit, never push. Push is always manual.
      console.log(`[AutoCommit] Committed ${changedFiles.length} files safely (no push)`);
      return (
        `✅ **Auto Commit Completed** (Manual push required)\n` +
        `📁 ${changedFiles.length} files: ${shortStatus}\n` +
        `💬 \`${commitMsg}\`\n` +
        `⚠️ Review changes with \`git diff HEAD~1\` before pushing`
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[AutoCommit] Failed:`, err);
      return `❌ **Auto Commit Failed**: ${errMsg.substring(0, 200)}`;
    }
  }
}

/**
 * Response from a single agent
 */
export interface AgentResponse {
  /** Agent ID */
  agentId: string;
  /** Agent configuration */
  agent: AgentPersonaConfig;
  /** Formatted content (with agent prefix) */
  content: string;
  /** Raw content from Claude */
  rawContent: string;
  /** Response duration in ms */
  duration?: number;
  /** Discord message ID (set after sending) */
  messageId?: string;
}

/**
 * Multi-agent response result
 */
export interface MultiAgentResponse {
  /** Selected agent IDs */
  selectedAgents: string[];
  /** Selection reason */
  reason:
    | 'explicit_trigger'
    | 'keyword_match'
    | 'default_agent'
    | 'free_chat'
    | 'category_match'
    | 'delegation'
    | 'ultrawork'
    | 'mention_chain'
    | 'none';
  /** Individual agent responses */
  responses: AgentResponse[];
}
