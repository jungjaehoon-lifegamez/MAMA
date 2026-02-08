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
import { getChannelHistory } from '../gateways/channel-history.js';
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

  constructor(config: MultiAgentConfig, processOptions: Partial<PersistentProcessOptions> = {}) {
    this.config = config;
    this.orchestrator = new MultiAgentOrchestrator(config);
    this.processManager = new AgentProcessManager(config, processOptions);
    this.sharedContext = getSharedContextManager();
    this.multiBotManager = new MultiBotManager(config);
    this.messageQueue = new AgentMessageQueue();
    this.prReviewPoller = new PRReviewPoller();

    // Periodic cleanup of expired queued messages and mention dedup entries
    this.cleanupInterval = setInterval(() => {
      this.messageQueue.clearExpired();
      this.cleanupProcessedMentions();
    }, 60_000);

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
      try {
        const response = await this.processAgentResponse(
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

        if (response) {
          await this.sendAgentResponses(message, [response]);
          this.orchestrator.recordAgentResponse(agentId, message.channel.id, response.messageId);

          // Route delegation mentions from this agent's response
          if (this.isMentionDelegationEnabled()) {
            await this.routeResponseMentions(message, [response]);
          }
        }
      } catch (err) {
        console.error(`[MultiAgent] Mention handler error:`, err);
      } finally {
        // Add ✅ to complete the emoji progression
        try {
          await message.react('✅');
        } catch {
          /* ignore */
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
      const reviewerEntry = Object.entries(this.config.agents).find(
        ([aid, cfg]) =>
          aid.toLowerCase().includes('review') || cfg.name?.toLowerCase().includes('review')
      );
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
    this.discordClient = client;
    if (this.prReviewPoller.hasMessageSender()) return;

    this.prReviewPoller.setMessageSender(async (channelId: string, text: string) => {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !('send' in (channel as Record<string, unknown>))) return;

      await (channel as { send: (opts: { content: string }) => Promise<Message> }).send({
        content: text,
      });

      // Store texts per channel to prevent cross-channel contamination
      if (!this.batchData.has(channelId)) {
        this.batchData.set(channelId, []);
      }
      this.batchData.get(channelId)!.push(text.replace(/<@!?\d+>/g, '').trim());
    });

    // After all chunks sent, send LEAD mention FROM Reviewer bot
    // with PR data included so LEAD doesn't pick up stale channel history.
    this.prReviewPoller.setOnBatchComplete(async (channelId: string) => {
      const texts = this.batchData.get(channelId) || [];
      if (texts.length === 0) return;
      this.batchData.delete(channelId); // Clean up after processing

      // Reset chain so LEAD can delegate freely
      this.orchestrator.resetChain(channelId);

      const leadUserId = this.multiBotManager.getMainBotUserId();
      if (!leadUserId) return;

      const reviewerEntry = Object.entries(this.config.agents).find(
        ([aid, cfg]) =>
          aid.toLowerCase().includes('review') || cfg.name?.toLowerCase().includes('review')
      );
      const reviewerAgentId = reviewerEntry?.[0];
      if (!reviewerAgentId) return;

      // Include PR data summary in LEAD mention (Discord 2000 char limit per message)
      const prSummary = texts.join('\n').slice(0, 2000);
      const mentionPrefix = `<@${leadUserId}> PR 리뷰 코멘트를 분석하고 우선순위별로 정리하여 위임하세요.\n\n`;
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

      // Resolve @Name mentions in LLM response to <@userId> format
      const resolvedResponse = this.resolveResponseMentions(result.response);

      // Format response with agent prefix
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

      // Enqueue busy responses (F7: message queue)
      if (errMsg.includes('busy')) {
        console.log(`[MultiAgent] Agent ${agentId} busy, enqueuing message`);

        const queuedMessage: QueuedMessage = {
          prompt: fullPrompt,
          channelId: context.channelId,
          threadTs: context.messageId,
          source: 'discord',
          enqueuedAt: Date.now(),
          context,
        };

        this.messageQueue.enqueue(agentId, queuedMessage);
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

    return sentMessages;
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

  /**
   * Check if mention-based delegation is enabled
   */
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

      // Auto commit+push when Reviewer APPROVE reaches LEAD
      const defaultAgentId = this.config.default_agent;
      const isReviewerApproveToLead =
        this.isReviewerAgent(response.agentId) &&
        mentionedAgentIds.includes(defaultAgentId || '') &&
        /\bapprove\b/i.test(response.rawContent);

      let autoCommitResult: string | null = null;
      if (isReviewerApproveToLead) {
        autoCommitResult = await this.autoCommitAndPush(originalMessage.channel.id);
        if (autoCommitResult) {
          // Post commit result to channel
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

      // Inject commit context when Reviewer APPROVE reaches LEAD
      const defaultAgentId = this.config.default_agent;
      if (targetAgentId === defaultAgentId && /\bapprove\b/i.test(delegationContent)) {
        if (autoCommitResult && autoCommitResult.startsWith('✅')) {
          // Auto commit+push succeeded — inform LEAD, no manual commit needed
          delegationContent +=
            '\n\n✅ [SYSTEM] Auto Commit+Push 완료. 커밋은 이미 처리됨.\n' +
            `결과: ${autoCommitResult}\n` +
            '**커밋/푸시 불필요. 리뷰 결과를 요약하라.**';
        } else {
          // Auto commit+push failed or not attempted — LEAD should commit manually
          const allowAutoPush = process.env.MAMA_ALLOW_AUTO_PUSH === 'true';
          const pushInstruction = allowAutoPush
            ? '4. `git push`\n'
            : '4. `git push` (MAMA_ALLOW_AUTO_PUSH=true 필요)\n';

          delegationContent +=
            '\n\n⚠️ [SYSTEM] Reviewer APPROVED. Auto commit 실패. Phase 3 즉시 실행:\n' +
            '1. `git status` 로 변경 파일 확인\n' +
            '2. `git add {변경된 파일들}` (git add . 금지)\n' +
            '3. `git commit -m "fix: {변경 내용 요약}"`\n' +
            pushInstruction +
            '**칭찬/요약 전에 커밋부터 실행하라. 커밋 없이 응답하면 실패.**';
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
                  content: `👀 **PR Review Poller 시작** — ${key}\n60초 간격으로 새 리뷰 코멘트를 감지합니다.`,
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
   * Auto commit+push when Reviewer APPROVE is detected.
   * Finds the repo from active PR polling sessions, runs git operations.
   * Returns a status message or null if no repo found.
   */
  private async autoCommitAndPush(channelId: string): Promise<string | null> {
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
      // 1. git status
      const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: repoPath,
        timeout: 10000,
      });

      if (!statusOut.trim()) {
        console.log(`[AutoCommit] No changes to commit in ${repoPath}`);
        return `📭 커밋할 변경사항이 없습니다. (${session.repo})`;
      }

      // 2. Get changed files from porcelain format (XY PATH or XY ORIG -> PATH)
      const changedFiles = statusOut
        .trim()
        .split('\n')
        .map((line) => {
          // Porcelain v1: first 2 chars = status, then space, then path
          // For renames: "R  old -> new" — use the new path
          const path = line.slice(3);
          if (path.includes(' -> ')) {
            return path.split(' -> ').pop()?.trim() || '';
          }
          return path.trim();
        })
        .filter(Boolean);

      // 3. git add (specific files, not git add .)
      await execFileAsync('git', ['add', ...changedFiles], {
        cwd: repoPath,
        timeout: 15000,
      });

      // 4. git commit
      const commitMsg = `fix: address PR review comments (${session.owner}/${session.repo}#${session.prNumber})`;
      await execFileAsync('git', ['commit', '-m', commitMsg], { cwd: repoPath, timeout: 15000 });

      const shortStatus =
        changedFiles.length <= 5
          ? changedFiles.join(', ')
          : `${changedFiles.slice(0, 5).join(', ')} +${changedFiles.length - 5} more`;

      // 5. git push - only if explicitly allowed
      const allowAutoPush = process.env.MAMA_ALLOW_AUTO_PUSH === 'true';
      if (allowAutoPush) {
        const { stdout: pushOut, stderr: pushErr } = await execFileAsync('git', ['push'], {
          cwd: repoPath,
          timeout: 30000,
        });

        const result =
          `✅ **Auto Commit+Push 완료**\n` +
          `📁 ${changedFiles.length}개 파일: ${shortStatus}\n` +
          `💬 \`${commitMsg}\`\n` +
          `${pushOut || pushErr || '(pushed)'}`;

        console.log(`[AutoCommit] Success: ${changedFiles.length} files committed and pushed`);
        return result;
      } else {
        const result =
          `✅ **Auto Commit 완료** (Push는 수동)\n` +
          `📁 ${changedFiles.length}개 파일: ${shortStatus}\n` +
          `💬 \`${commitMsg}\`\n` +
          `⚠️ MAMA_ALLOW_AUTO_PUSH=true 필요 (자동 push 비활성화)`;

        console.log(`[AutoCommit] Commit complete, but auto-push disabled`);
        return result;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[AutoCommit] Failed:`, err);
      return `❌ **Auto Commit+Push 실패**: ${errMsg.substring(0, 200)}`;
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
