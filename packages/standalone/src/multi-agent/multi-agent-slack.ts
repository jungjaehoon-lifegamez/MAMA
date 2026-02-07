/**
 * Multi-Agent Slack Integration
 *
 * Extends the Slack gateway with multi-agent support.
 * Mirrors MultiAgentDiscordHandler but uses Slack-specific APIs.
 *
 * Reused platform-agnostic components:
 * - MultiAgentOrchestrator: agent selection, chain tracking
 * - AgentProcessManager: getProcess('slack', channelId, agentId)
 * - SharedContextManager: channelId-based context
 */

import type { WebClient } from '@slack/web-api';
import type { MultiAgentConfig, MessageContext, AgentPersonaConfig } from './types.js';
import { MultiAgentOrchestrator } from './orchestrator.js';
import { AgentProcessManager } from './agent-process-manager.js';
import { getSharedContextManager, type SharedContextManager } from './shared-context.js';
import { SlackMultiBotManager, type SlackMentionEvent } from './slack-multi-bot-manager.js';
import type { PersistentProcessOptions } from '../agent/persistent-cli-process.js';
import { splitForSlack } from '../gateways/message-splitter.js';
import { AgentMessageQueue, type QueuedMessage } from './agent-message-queue.js';
import { PRReviewPoller } from './pr-review-poller.js';

/** Default timeout for agent responses (15 minutes - longer than Discord due to Slack's slower Socket Mode relay and complex thread routing) */
const AGENT_TIMEOUT_MS = 15 * 60 * 1000;

/** Heartbeat interval for status polling (60 seconds) */
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

/** Status emoji for each process state */
const STATE_EMOJI: Record<string, string> = {
  busy: '🔄',
  idle: '💤',
  starting: '⏳',
  dead: '💀',
};

/**
 * Multi-Agent Slack Handler
 *
 * Integrates with the Slack gateway to provide multi-agent support.
 */
export class MultiAgentSlackHandler {
  private config: MultiAgentConfig;
  private orchestrator: MultiAgentOrchestrator;
  private processManager: AgentProcessManager;
  private sharedContext: SharedContextManager;
  private multiBotManager: SlackMultiBotManager;
  private messageQueue: AgentMessageQueue;
  private prReviewPoller: PRReviewPoller;
  private logger = console;

  /** Main Slack WebClient for posting system messages (heartbeat) */
  private mainWebClient: WebClient | null = null;

  /** Active channel for heartbeat reporting */
  private heartbeatChannelId: string | null = null;

  /** Heartbeat polling interval handle */
  private heartbeatInterval?: ReturnType<typeof setInterval>;

  /** Whether multi-bot mode is initialized */
  private multiBotInitialized = false;

  /** Dedup map for bot→agent mentions with timestamps (prevents double processing + memory leak) */
  private processedMentions = new Map<string, number>();

  /** TTL for processed mention entries (5 minutes) */
  private static readonly MENTION_TTL_MS = 5 * 60 * 1000;

  /** Interval handle for periodic cleanup */
  private mentionCleanupInterval?: ReturnType<typeof setInterval>;

  constructor(config: MultiAgentConfig, processOptions: Partial<PersistentProcessOptions> = {}) {
    this.config = config;
    this.orchestrator = new MultiAgentOrchestrator(config);
    this.processManager = new AgentProcessManager(config, processOptions);
    this.sharedContext = getSharedContextManager();
    this.multiBotManager = new SlackMultiBotManager(config);
    this.messageQueue = new AgentMessageQueue();
    this.prReviewPoller = new PRReviewPoller();

    // Start periodic cleanup of processed mentions (every 60 seconds)
    this.mentionCleanupInterval = setInterval(() => {
      this.cleanupProcessedMentions();
      this.messageQueue.clearExpired();
    }, 60_000);

    // Setup idle event listeners for all agents (F7: message queue drain)
    this.setupIdleListeners();
  }

  /**
   * Setup idle event listeners for agent processes (F7)
   */
  private setupIdleListeners(): void {
    // Listen to process creation events from AgentProcessManager
    this.processManager.on('process-created', ({ agentId, process }) => {
      process.on('idle', async () => {
        await this.messageQueue.drain(agentId, process, async (aid, message, response) => {
          await this.sendQueuedResponse(aid, message, response);
        });
      });
    });
  }

  /**
   * Initialize multi-bot support (call after Slack connects)
   */
  async initializeMultiBots(): Promise<void> {
    if (this.multiBotInitialized) return;

    // Register mention callback so agent bots forward mentions to handler
    this.multiBotManager.onMention(async (agentId, event, _webClient) => {
      const cleanContent = event.text.replace(/<@[UW]\w+>/g, '').trim();
      if (!cleanContent) return;

      // Determine if sender is an agent bot
      const isFromAgent = !!event.bot_id;
      const senderAgentId = isFromAgent
        ? (this.multiBotManager.isFromAgentBot(event.bot_id!) ?? undefined)
        : undefined;

      // Chain depth check for mention_delegation
      if (isFromAgent && senderAgentId && senderAgentId !== 'main') {
        const chainState = this.orchestrator.getChainState(event.channel);
        const maxDepth = this.config.max_mention_depth ?? 3;

        if (chainState.blocked) {
          this.logger.log(
            `[MultiAgentSlack] Mention chain blocked in channel ${event.channel}, ignoring`
          );
          return;
        }
        if (chainState.length >= maxDepth) {
          this.logger.log(
            `[MultiAgentSlack] Mention chain depth ${chainState.length} >= max ${maxDepth}, ignoring`
          );
          return;
        }
      }

      this.logger.log(
        `[MultiAgentSlack] Mention-triggered: agent=${agentId}, from=${senderAgentId ?? event.user}, content="${cleanContent.substring(0, 50)}"`
      );

      // Extract mentioned agent IDs from the original content
      const mentionedAgentIds = this.extractMentionedAgentIds(event.text);

      // Force this specific agent to respond
      try {
        const response = await this.processAgentResponse(
          agentId,
          {
            channelId: event.channel,
            userId: event.user,
            content: cleanContent,
            isBot: isFromAgent,
            senderAgentId: senderAgentId && senderAgentId !== 'main' ? senderAgentId : undefined,
            mentionedAgentIds,
            messageId: event.ts,
            timestamp: parseFloat(event.ts) * 1000,
          },
          cleanContent
        );

        if (response) {
          const threadTs = event.thread_ts || event.ts;
          await this.sendAgentResponses(event.channel, threadTs, [response]);
          this.orchestrator.recordAgentResponse(agentId, event.channel, response.messageId);
        }
      } catch (err) {
        this.logger.error(`[MultiAgentSlack] Mention handler error:`, err);
      }
    });

    await this.multiBotManager.initialize();
    this.multiBotInitialized = true;

    const connectedAgents = this.multiBotManager.getConnectedAgents();
    if (connectedAgents.length > 0) {
      this.logger.log(`[MultiAgentSlack] Multi-bot mode active for: ${connectedAgents.join(', ')}`);
    }

    // Pass bot ID map to process manager for mention-based delegation prompts
    if (this.config.mention_delegation) {
      const botUserIdMap = this.multiBotManager.getBotUserIdMap();
      this.processManager.setBotUserIdMap(botUserIdMap);
      this.processManager.setMentionDelegation(true);
      this.logger.log(
        `[MultiAgentSlack] Mention delegation enabled with ${botUserIdMap.size} bot IDs`
      );

      // PR Review Poller: reviewer bot sends messages mentioning @developer
      const developerUserId = botUserIdMap.get('developer');
      if (developerUserId) {
        this.prReviewPoller.setTargetAgentUserId(developerUserId);
      }

      // Use reviewer bot's WebClient to send PR review messages
      // (avoids self-mention issue when main bot = Sisyphus)
      const reviewerClient = this.multiBotManager.getAgentWebClient('reviewer');
      if (reviewerClient) {
        this.prReviewPoller.setMessageSender(async (channelId: string, text: string) => {
          await reviewerClient.chat.postMessage({ channel: channelId, text });
        });
        this.logger.log('[MultiAgentSlack] PR Poller will send messages via reviewer bot');
      }
    }
  }

  /**
   * Set main Slack WebClient (for heartbeat status messages)
   */
  setMainWebClient(client: WebClient): void {
    this.mainWebClient = client;

    // Wire PRReviewPoller to send messages via this WebClient
    this.prReviewPoller.setMessageSender(async (channelId: string, text: string) => {
      await client.chat.postMessage({ channel: channelId, text });
    });
  }

  /**
   * Set main bot's user ID (call when Slack connects via auth.test)
   */
  setBotUserId(userId: string): void {
    this.multiBotManager.setMainBotUserId(userId);
  }

  /**
   * Set main bot's bot ID
   */
  setMainBotId(botId: string): void {
    this.multiBotManager.setMainBotId(botId);
  }

  /**
   * Set main bot token (to avoid duplicate connections)
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
   * Check if mention-based delegation is enabled
   */
  isMentionDelegationEnabled(): boolean {
    return this.config.mention_delegation === true;
  }

  /**
   * Update configuration (for hot reload)
   */
  updateConfig(config: MultiAgentConfig): void {
    this.config = config;
    this.orchestrator.updateConfig(config);
    this.processManager.updateConfig(config);
  }

  /**
   * Handle PR review polling commands from human messages.
   * Returns true if the message was a PR command (consumed), false otherwise.
   *
   * Start: message contains a GitHub PR URL (auto-detect)
   * Stop: message contains "pr 중지", "pr stop", "폴링 중지", "stop polling"
   */
  async handlePRCommand(channelId: string, content: string): Promise<boolean> {
    if (!this.mainWebClient) return false;

    const contentLower = content.toLowerCase();

    // Stop commands
    const stopPatterns = ['pr 중지', 'pr stop', '폴링 중지', 'stop polling', 'pr 종료', 'stop pr'];
    if (stopPatterns.some((p) => contentLower.includes(p))) {
      const sessions = this.prReviewPoller.getActiveSessions();
      if (sessions.length === 0) {
        await this.mainWebClient.chat.postMessage({
          channel: channelId,
          text: '📭 활성 PR 폴링이 없습니다.',
        });
      } else {
        this.prReviewPoller.stopAll();
        await this.mainWebClient.chat.postMessage({
          channel: channelId,
          text: `⏹️ PR 리뷰 폴링 중지: ${sessions.join(', ')}`,
        });
      }
      return true;
    }

    // Start: detect PR URL in message
    const prUrls = PRReviewPoller.extractPRUrls(content);
    if (prUrls.length > 0) {
      for (const prUrl of prUrls) {
        const started = await this.prReviewPoller.startPolling(prUrl, channelId);
        if (started) {
          const parsed = this.prReviewPoller.parsePRUrl(prUrl);
          const key = parsed ? `${parsed.owner}/${parsed.repo}#${parsed.prNumber}` : prUrl;
          await this.mainWebClient.chat.postMessage({
            channel: channelId,
            text: `👀 *PR Review Poller 시작* — ${key}\n60초 간격으로 새 리뷰 코멘트를 감지합니다. 중지하려면 "PR 중지"라고 입력하세요.`,
          });
        }
      }
      return true;
    }

    return false;
  }

  /**
   * Handle a Slack message with multi-agent logic
   *
   * @returns Object with selected agents and their responses, or null if no agents respond
   */
  async handleMessage(
    event: SlackMentionEvent,
    cleanContent: string,
    historyContext?: string
  ): Promise<SlackMultiAgentResponse | null> {
    // Build message context (extract mentioned agents from original text)
    const context = this.buildMessageContext(event, cleanContent);
    context.mentionedAgentIds = this.extractMentionedAgentIds(event.text);

    // Record human message to shared context
    if (!context.isBot) {
      this.sharedContext.recordHumanMessage(context.channelId, event.user, cleanContent, event.ts);
    }

    // Select responding agents
    const selection = this.orchestrator.selectRespondingAgents(context);

    this.logger.log(
      `[MultiAgentSlack] Selection result: agents=${selection.selectedAgents.join(',')}, reason=${selection.reason}, blocked=${selection.blocked}`
    );

    if (selection.blocked) {
      this.logger.log(`[MultiAgentSlack] Blocked: ${selection.blockReason}`);
      return null;
    }

    if (selection.selectedAgents.length === 0) {
      return null;
    }

    // Process all selected agents in parallel
    const results = await Promise.allSettled(
      selection.selectedAgents.map((agentId) =>
        this.processAgentResponse(agentId, context, cleanContent, historyContext)
      )
    );

    const responses: SlackAgentResponse[] = [];
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
        this.logger.error(`[MultiAgentSlack] Error processing agent ${agentId}:`, result.reason);
      }
    }

    if (responses.length === 0) {
      return null;
    }

    return {
      selectedAgents: selection.selectedAgents,
      reason: selection.reason,
      responses,
    };
  }

  /**
   * Process a single agent's response
   */
  private async processAgentResponse(
    agentId: string,
    context: MessageContext,
    userMessage: string,
    historyContext?: string
  ): Promise<SlackAgentResponse | null> {
    const agent = this.orchestrator.getAgent(agentId);
    if (!agent) {
      this.logger.error(`[MultiAgentSlack] Unknown agent: ${agentId}`);
      return null;
    }

    // Strip trigger prefix from message if present
    const cleanMessage = this.orchestrator.stripTriggerPrefix(userMessage, agentId);

    // Build context for this agent
    const agentContext = this.sharedContext.buildContextForAgent(context.channelId, agentId, 5);

    // Build full prompt with context
    let fullPrompt = cleanMessage;
    if (historyContext) {
      fullPrompt = `${historyContext}\n\n${cleanMessage}`;
    }
    if (agentContext) {
      fullPrompt = `${agentContext}\n\n${fullPrompt}`;
    }

    this.logger.log(
      `[MultiAgentSlack] Processing agent ${agentId}, prompt length: ${fullPrompt.length}`
    );

    try {
      // Get or create process for this agent in this channel
      const process = await this.processManager.getProcess('slack', context.channelId, agentId);

      // Send message and get response (with timeout, properly cleaned up)
      let timeoutHandle: ReturnType<typeof setTimeout>;
      const result = await Promise.race([
        process.sendMessage(fullPrompt),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(`Agent ${agentId} timed out after ${AGENT_TIMEOUT_MS / 1000}s`)),
            AGENT_TIMEOUT_MS
          );
        }),
      ]);
      clearTimeout(timeoutHandle!);

      // Format response with agent prefix
      const formattedResponse = this.formatAgentResponse(agent, result.response);

      return {
        agentId,
        agent,
        content: formattedResponse,
        rawContent: result.response,
        duration: result.duration_ms,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[MultiAgentSlack] Failed to get response from ${agentId}:`, error);

      // Enqueue busy responses (F7: message queue)
      if (errMsg.includes('busy')) {
        this.logger.log(`[MultiAgentSlack] Agent ${agentId} busy, enqueuing message`);

        const queuedMessage: QueuedMessage = {
          prompt: fullPrompt,
          channelId: context.channelId,
          threadTs: context.messageId,
          source: 'slack',
          enqueuedAt: Date.now(),
          context,
        };

        this.messageQueue.enqueue(agentId, queuedMessage);
        return null;
      }
      return null;
    }
  }

  /**
   * Build message context from Slack event
   */
  private buildMessageContext(event: SlackMentionEvent, cleanContent: string): MessageContext {
    const isBot = !!event.bot_id;
    let senderAgentId: string | undefined;

    if (isBot && event.bot_id) {
      const agentBotId = this.multiBotManager.isFromAgentBot(event.bot_id);
      if (agentBotId && agentBotId !== 'main') {
        senderAgentId = agentBotId;
      }
    }

    return {
      channelId: event.channel,
      userId: event.user,
      content: cleanContent,
      isBot,
      senderAgentId,
      messageId: event.ts,
      timestamp: parseFloat(event.ts) * 1000,
    };
  }

  /**
   * Format agent response with display name prefix
   */
  private formatAgentResponse(agent: AgentPersonaConfig, response: string): string {
    const prefix = `*${agent.display_name}*:`;
    if (response.startsWith(prefix) || response.startsWith(`*${agent.display_name}*: `)) {
      return response;
    }
    return `${prefix} ${response}`;
  }

  /**
   * Send formatted responses to Slack (handles message splitting)
   * Uses agent's dedicated bot if available, otherwise main WebClient
   */
  async sendAgentResponses(
    channelId: string,
    threadTs: string,
    responses: SlackAgentResponse[],
    mainWebClient?: WebClient
  ): Promise<string[]> {
    const sentMessageTs: string[] = [];

    for (const response of responses) {
      try {
        const chunks = splitForSlack(response.content);
        const hasOwnBot = this.multiBotManager.hasAgentBot(response.agentId);

        for (let i = 0; i < chunks.length; i++) {
          let messageTs: string | null = null;

          if (hasOwnBot) {
            // Use agent's dedicated bot
            messageTs = await this.multiBotManager.replyAsAgent(
              response.agentId,
              channelId,
              threadTs,
              chunks[i]
            );
          } else if (mainWebClient) {
            // Use main bot — broadcast first chunk to channel
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const msgParams: any = {
              channel: channelId,
              text: chunks[i],
              thread_ts: threadTs,
            };
            if (i === 0) {
              msgParams.reply_broadcast = true;
            }
            const result = await mainWebClient.chat.postMessage(msgParams);
            messageTs = result.ts as string;
          }

          if (messageTs) {
            sentMessageTs.push(messageTs);
            if (i === 0) {
              response.messageId = messageTs;
            }
          }
        }
      } catch (err) {
        this.logger.error(
          `[MultiAgentSlack] Failed to send response for agent ${response.agentId}:`,
          err
        );
      }
    }

    return sentMessageTs;
  }

  /**
   * Send queued response to Slack (F7: message queue drain callback)
   */
  private async sendQueuedResponse(
    agentId: string,
    message: QueuedMessage,
    response: string
  ): Promise<void> {
    const agent = this.orchestrator.getAgent(agentId);
    if (!agent) {
      this.logger.error(`[MultiAgentSlack] Unknown agent in queue: ${agentId}`);
      return;
    }

    // Format response with agent prefix
    const formattedResponse = this.formatAgentResponse(agent, response);

    const agentResponse: SlackAgentResponse = {
      agentId,
      agent,
      content: formattedResponse,
      rawContent: response,
    };

    // Send to channel
    await this.sendAgentResponses(
      message.channelId,
      message.threadTs || '',
      [agentResponse],
      undefined // No mainWebClient - use agent bot
    );

    // Record to shared context
    this.sharedContext.recordAgentMessage(
      message.channelId,
      agent,
      response,
      agentResponse.messageId || ''
    );

    this.logger.log(
      `[MultiAgentSlack] Queued message delivered for ${agentId} in ${message.channelId}`
    );
  }

  /**
   * Handle bot→agent mention delegation (called by gateway for main bot messages).
   * Bridges the gap where Slack's app_mention event doesn't fire for bot-posted messages.
   */
  async handleBotToAgentMention(
    targetAgentId: string,
    event: SlackMentionEvent,
    mainWebClient: WebClient
  ): Promise<void> {
    // Dedup: prevent double processing if both gateway and SlackMultiBotManager fire
    const dedupKey = `${targetAgentId}:${event.ts}`;
    if (this.processedMentions.has(dedupKey)) return;
    this.processedMentions.set(dedupKey, Date.now());

    const cleanContent = event.text.replace(/<@[UW]\w+>/g, '').trim();
    if (!cleanContent) return;

    // Determine sender agent
    const senderBotResult = event.bot_id ? this.multiBotManager.isFromAgentBot(event.bot_id) : null;
    const senderAgentId =
      senderBotResult === 'main'
        ? (this.multiBotManager.getMainBotAgentId() ?? undefined)
        : (senderBotResult ?? undefined);

    // Chain depth check
    const chainState = this.orchestrator.getChainState(event.channel);
    const maxDepth = this.config.max_mention_depth ?? 3;
    if (chainState.blocked || chainState.length >= maxDepth) {
      this.logger.log(
        `[MultiAgentSlack] Bot→Agent mention chain blocked/maxed in ${event.channel}`
      );
      return;
    }

    this.logger.log(
      `[MultiAgentSlack] Bot→Agent mention: ${senderAgentId ?? 'main'} → ${targetAgentId}, content="${cleanContent.substring(0, 50)}"`
    );

    // Add eyes reaction
    try {
      await mainWebClient.reactions.add({
        channel: event.channel,
        timestamp: event.ts,
        name: 'eyes',
      });
    } catch {
      /* ignore reaction errors */
    }

    try {
      const response = await this.processAgentResponse(
        targetAgentId,
        {
          channelId: event.channel,
          userId: event.user,
          content: cleanContent,
          isBot: true,
          senderAgentId,
          mentionedAgentIds: [targetAgentId],
          messageId: event.ts,
          timestamp: parseFloat(event.ts) * 1000,
        },
        cleanContent
      );

      if (response) {
        const threadTs = event.thread_ts || event.ts;
        await this.sendAgentResponses(event.channel, threadTs, [response], mainWebClient);
        this.orchestrator.recordAgentResponse(targetAgentId, event.channel, response.messageId);

        // Recursively route mentions in this agent's response.
        // Necessary because Slack doesn't deliver a bot's own messages back to itself.
        await this.routeResponseMentions(event.channel, threadTs, [response], mainWebClient);
      }

      // Replace eyes with checkmark
      try {
        await mainWebClient.reactions.remove({
          channel: event.channel,
          timestamp: event.ts,
          name: 'eyes',
        });
        await mainWebClient.reactions.add({
          channel: event.channel,
          timestamp: event.ts,
          name: 'white_check_mark',
        });
      } catch {
        /* ignore reaction errors */
      }
    } catch (err) {
      this.logger.error(`[MultiAgentSlack] Bot→Agent mention error:`, err);
    }
  }

  /**
   * After sending agent responses, check for mentions to other agents and route them.
   * Necessary because Slack Socket Mode doesn't deliver a bot's own messages back to itself,
   * so the gateway's message listener never fires for responses sent by any bot.
   */
  async routeResponseMentions(
    channelId: string,
    threadTs: string,
    responses: SlackAgentResponse[],
    mainWebClient: WebClient
  ): Promise<void> {
    for (const response of responses) {
      // Filter out self-mentions to prevent routing an agent's response back to itself
      const mentionedAgentIds = this.extractMentionedAgentIds(response.rawContent).filter(
        (id) => id !== response.agentId
      );
      if (mentionedAgentIds.length === 0) continue;

      this.logger.log(
        `[MultiAgentSlack] Auto-routing mentions from ${response.agentId}: → ${mentionedAgentIds.join(', ')}`
      );

      // Route to all mentioned agents in parallel (not sequential)
      await Promise.all(
        mentionedAgentIds.map((targetAgentId) => {
          const syntheticEvent: SlackMentionEvent = {
            type: 'message',
            channel: channelId,
            user: '',
            text: response.rawContent,
            ts: response.messageId || threadTs,
            thread_ts: threadTs,
            bot_id: 'auto-route',
          };
          return this.handleBotToAgentMention(targetAgentId, syntheticEvent, mainWebClient);
        })
      );
    }
  }

  /**
   * Extract agent IDs from <@U...> mentions in message content
   */
  extractMentionedAgentIds(content: string): string[] {
    const mentionPattern = /<@([UW]\w+)>/g;
    const agentIds: string[] = [];
    let match;

    while ((match = mentionPattern.exec(content)) !== null) {
      const userId = match[1];
      const agentId = this.multiBotManager.resolveAgentIdFromUserId(userId);
      if (agentId) {
        // Resolve 'main' to the actual agent ID (e.g., 'sisyphus')
        const resolvedId =
          agentId === 'main' ? (this.multiBotManager.getMainBotAgentId() ?? agentId) : agentId;
        agentIds.push(resolvedId);
      }
    }

    return agentIds;
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
  getMultiBotManager(): SlackMultiBotManager {
    return this.multiBotManager;
  }

  /**
   * Start heartbeat polling for a channel.
   * Only reports when at least 1 agent is busy. Silent when all idle.
   */
  startHeartbeat(channelId: string): void {
    // Already running for this channel
    if (this.heartbeatInterval && this.heartbeatChannelId === channelId) return;

    // Stop existing heartbeat if switching channels
    this.stopHeartbeat();

    this.heartbeatChannelId = channelId;
    this.heartbeatInterval = setInterval(() => {
      this.pollAndReport().catch((err) => {
        this.logger.error('[Heartbeat] Poll error:', err);
      });
    }, HEARTBEAT_INTERVAL_MS);

    this.logger.log(
      `[Heartbeat] Started for channel ${channelId} (${HEARTBEAT_INTERVAL_MS / 1000}s interval)`
    );
  }

  /**
   * Stop heartbeat polling
   */
  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
      this.heartbeatChannelId = null;
    }
  }

  /**
   * Poll agent states and report to Slack if any are busy
   */
  private async pollAndReport(): Promise<void> {
    if (!this.mainWebClient || !this.heartbeatChannelId) return;

    const agentStates = this.processManager.getAgentStates();
    const prSessions = this.prReviewPoller.getActiveSessions();

    // Check if any agent is busy or PR polling is active
    let hasBusy = false;
    for (const state of agentStates.values()) {
      if (state === 'busy' || state === 'starting') {
        hasBusy = true;
        break;
      }
    }

    // Silent when no agents are busy AND no PR polling active
    if (!hasBusy && prSessions.length === 0) return;

    // Build status line
    const agentConfigs = this.config.agents;
    const parts: string[] = [];

    for (const [agentId, agentConfig] of Object.entries(agentConfigs)) {
      if (agentConfig.enabled === false) continue;
      const state = agentStates.get(agentId) ?? 'idle';
      const emoji = STATE_EMOJI[state] ?? '❓';
      const queueSize = this.messageQueue.getQueueSize(agentId);
      let entry = `${emoji} ${agentConfig.display_name}: ${state}`;
      if (queueSize > 0) {
        entry += ` (📬 ${queueSize} queued)`;
      }
      parts.push(entry);
    }

    let statusLine = `⏱️ *Agent Status* | ${parts.join(' | ')}`;

    // Append PR polling info
    if (prSessions.length > 0) {
      statusLine += ` | 👀 PR: ${prSessions.join(', ')}`;
    }

    try {
      await this.mainWebClient.chat.postMessage({
        channel: this.heartbeatChannelId,
        text: statusLine,
      });
    } catch (err) {
      this.logger.error('[Heartbeat] Failed to post status:', err);
    }
  }

  /**
   * Stop all agent processes and bots
   */
  async stopAll(): Promise<void> {
    this.stopHeartbeat();
    this.prReviewPoller.stopAll();
    if (this.mentionCleanupInterval) {
      clearInterval(this.mentionCleanupInterval);
      this.mentionCleanupInterval = undefined;
    }
    this.processManager.stopAll();
    await this.multiBotManager.stopAll();
  }

  /**
   * Get PR review poller for direct access
   */
  getPRReviewPoller(): PRReviewPoller {
    return this.prReviewPoller;
  }

  /**
   * Clean up old processed mention entries based on TTL
   * Called periodically by setInterval in constructor
   */
  private cleanupProcessedMentions(): void {
    const now = Date.now();
    for (const [key, ts] of this.processedMentions) {
      if (now - ts > MultiAgentSlackHandler.MENTION_TTL_MS) {
        this.processedMentions.delete(key);
      }
    }
  }

  /**
   * Get chain state for a channel
   */
  getChainState(channelId: string) {
    return this.orchestrator.getChainState(channelId);
  }

  /**
   * Get status of all agent bots
   */
  getBotStatus(): Record<string, { connected: boolean; botName?: string }> {
    return this.multiBotManager.getStatus();
  }
}

/**
 * Response from a single agent (Slack)
 */
export interface SlackAgentResponse {
  agentId: string;
  agent: AgentPersonaConfig;
  content: string;
  rawContent: string;
  duration?: number;
  messageId?: string;
}

/**
 * Multi-agent response result (Slack)
 */
export interface SlackMultiAgentResponse {
  selectedAgents: string[];
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
  responses: SlackAgentResponse[];
}
