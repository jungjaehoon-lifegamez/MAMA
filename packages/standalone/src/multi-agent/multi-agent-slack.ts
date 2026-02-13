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
import type { MultiAgentConfig, MessageContext, MultiAgentRuntimeOptions } from './types.js';
import { SlackMultiBotManager, type SlackMentionEvent } from './slack-multi-bot-manager.js';
import type { PersistentProcessOptions } from '../agent/persistent-cli-process.js';
import { splitForSlack } from '../gateways/message-splitter.js';
import type { QueuedMessage } from './agent-message-queue.js';
import { PRReviewPoller } from './pr-review-poller.js';
import { validateDelegationFormat, isDelegationAttempt } from './delegation-format-validator.js';
import { createSafeLogger } from '../utils/log-sanitizer.js';
import {
  MultiAgentHandlerBase,
  AGENT_TIMEOUT_MS,
  type AgentResponse,
  type MultiAgentResponse,
} from './multi-agent-base.js';

export type { AgentResponse, MultiAgentResponse } from './multi-agent-base.js';

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
export class MultiAgentSlackHandler extends MultiAgentHandlerBase {
  private multiBotManager: SlackMultiBotManager;
  protected logger = createSafeLogger('MultiAgentSlack');

  /** Main Slack WebClient for posting system messages (heartbeat) */
  private mainWebClient: WebClient | null = null;

  /** Active channel for heartbeat reporting */
  private heartbeatChannelId: string | null = null;

  /** Heartbeat polling interval handle */
  private heartbeatInterval?: ReturnType<typeof setInterval>;

  /** PR poller summaries by channel for LEAD wake-up context. */
  private prPollerSummaries = new Map<string, string[]>();

  /** Interval handle for periodic cleanup */
  private mentionCleanupInterval?: ReturnType<typeof setInterval>;

  constructor(
    config: MultiAgentConfig,
    processOptions: Partial<PersistentProcessOptions> = {},
    runtimeOptions: MultiAgentRuntimeOptions = {}
  ) {
    super(config, processOptions, runtimeOptions);
    this.multiBotManager = new SlackMultiBotManager(config);

    // Start periodic cleanup of processed mentions (every 60 seconds)
    this.mentionCleanupInterval = setInterval(() => {
      this.cleanupProcessedMentions();
      this.messageQueue.clearExpired();
    }, 60_000);

    // Setup idle event listeners for all agents (F7: message queue drain)
    this.setupIdleListeners();
  }

  protected getPlatformName(): 'discord' | 'slack' {
    return 'slack';
  }

  formatBold(text: string): string {
    return `*${text}*`;
  }

  protected async sendChannelNotification(channelId: string, message: string): Promise<void> {
    try {
      if (this.mainWebClient) {
        await this.mainWebClient.chat.postMessage({ channel: channelId, text: message });
      }
    } catch (err) {
      console.error(`[MultiAgentSlack] Failed to send channel notification:`, err);
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

  protected async platformCleanup(): Promise<void> {
    this.stopHeartbeat();
    if (this.mentionCleanupInterval) {
      clearInterval(this.mentionCleanupInterval);
      this.mentionCleanupInterval = undefined;
    }
    await this.multiBotManager.stopAll();
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
      const mentionDescription = cleanContent.substring(0, 200);
      try {
        this.systemReminder.notify({
          type: 'delegation-started',
          taskId: '',
          description: mentionDescription,
          agentId,
          requestedBy: senderAgentId ?? event.user,
          channelId: event.channel,
          timestamp: Date.now(),
        });

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
          this.systemReminder.notify({
            type: 'delegation-completed',
            taskId: '',
            description: mentionDescription,
            agentId,
            requestedBy: senderAgentId ?? event.user,
            channelId: event.channel,
            duration: response.duration,
            timestamp: Date.now(),
          });

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

      // PR Review Poller: wake up LEAD with compact summaries from new review items.
      const orchestratorId = this.config.default_agent || 'sisyphus';
      const orchestratorUserId = botUserIdMap.get(orchestratorId);
      if (orchestratorUserId) {
        this.prReviewPoller.setTargetAgentUserId(orchestratorUserId);
      }

      // Keep review summaries compact and actionable at wake-up.
      this.prReviewPoller.setMessageSender(async () => {});
      this.prReviewPoller.setOnBatchItem(async (channelId: string, summary: string) => {
        const compact = this.compactPrReviewBatchSummary(summary);
        if (!compact) {
          return;
        }
        const bucket = this.prPollerSummaries.get(channelId) ?? [];
        bucket.push(compact);
        this.prPollerSummaries.set(channelId, [...new Set(bucket)].slice(-12));
      });
      this.prReviewPoller.setOnBatchComplete(async (channelId: string) => {
        const items = this.prPollerSummaries.get(channelId) ?? [];
        const count = items.length;
        if (count === 0) return;
        this.prPollerSummaries.delete(channelId);

        const sessions = this.prReviewPoller.getSessionDetails();
        const session = sessions.find((s) => s.channelId === channelId);
        if (!session) return;

        const prLabel = `${session.owner}/${session.repo}#${session.prNumber}`;
        const summaryLines = items
          .map((item: string, idx: number) => `- ${idx + 1}. ${item}`)
          .join('\n');
        const promptSummary = `\n${summaryLines}`;

        if (this.mainWebClient) {
          await this.mainWebClient.chat.postMessage({
            channel: channelId,
            text: `📊 PR ${prLabel} — ${count} new review item(s)\n\n${promptSummary}`,
          });
        }

        this.orchestrator.resetChain(channelId);
        const defaultAgentId = this.config.default_agent || 'sisyphus';

        this.messageQueue.enqueue(defaultAgentId, {
          prompt:
            `📊 PR Review follow-up (${count} new item(s))\n` +
            `Target: ${prLabel}\n` +
            `Workspace: \`${session.workspaceDir}\`\n` +
            `Items:\n${promptSummary}`,
          channelId,
          source: 'slack',
          enqueuedAt: Date.now(),
          context: { channelId, userId: 'pr-poller' },
        });
        this.logger.info(`[MultiAgentSlack] PR Poller -> LEAD wake-up (${count} items)`);
        this.tryDrainNow(defaultAgentId, 'slack', channelId).catch(() => {});
      });
      this.logger.log('[MultiAgentSlack] PR Poller summaries now feed LEAD wake-up');
    }
  }

  /**
   * Keep PR poller summaries short and remove duplicates.
   */
  private compactPrReviewBatchSummary(summary: string): string {
    const compact = summary.replace(/[\r\n]+/g, ' ').trim();
    const max = 230;
    if (!compact) return '';
    return compact.length > max ? `${compact.slice(0, max)}…` : compact;
  }

  /**
   * Set main Slack WebClient (for heartbeat status messages)
   */
  setMainWebClient(client: WebClient): void {
    this.mainWebClient = client;

    this.systemReminder.registerCallback(async (channelId, message) => {
      const chunks = splitForSlack(message);
      for (const chunk of chunks) {
        await client.chat.postMessage({ channel: channelId, text: chunk });
      }
    }, 'slack');

    // Only set PR poller sender if not already configured (e.g., by reviewer bot)
    if (!this.prReviewPoller.hasMessageSender?.()) {
      this.prReviewPoller.setMessageSender(async (channelId: string, text: string) => {
        await client.chat.postMessage({ channel: channelId, text });
      });
    }
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
   * Stop: message contains "pr stop", "stop polling"
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
          text: '📭 No active PR polling sessions.',
        });
      } else {
        this.prReviewPoller.stopAll();
        await this.mainWebClient.chat.postMessage({
          channel: channelId,
          text: `⏹️ PR review polling stopped: ${sessions.join(', ')}`,
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
            text: `👀 *PR Review Poller started* -- ${key}\nPolling for new review comments every 60 seconds. Type "PR stop" to stop.`,
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
    cleanContent: string
  ): Promise<MultiAgentResponse | null> {
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
        this.processAgentResponse(agentId, context, cleanContent)
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
    userMessage: string
  ): Promise<AgentResponse | null> {
    const agent = this.orchestrator.getAgent(agentId);
    if (!agent) {
      this.logger.error(`[MultiAgentSlack] Unknown agent: ${agentId}`);
      return null;
    }

    // Strip trigger prefix from message if present
    const cleanMessage = this.orchestrator.stripTriggerPrefix(userMessage, agentId);

    // Build context for this agent
    const agentContext = this.sharedContext.buildContextForAgent(context.channelId, agentId, 5);

    // Build full prompt with context.
    // NOTE: Do NOT inject historyContext into persistent processes -- the CLI process
    // already retains conversation memory across turns. Injecting historyContext causes
    // duplicate messages in Claude's context, making old messages appear "just conversed"
    // and creating cross-agent context confusion.
    // Only inject agentContext (other agents' messages) for inter-agent awareness.
    let fullPrompt = cleanMessage;
    if (agentContext) {
      fullPrompt = `${agentContext}\n\n${fullPrompt}`;
    }

    // Inject agent availability status and active work (Phase 2 + 3)
    const agentStatus = this.buildAgentStatusSection(agentId);
    const workSection = this.workTracker.buildWorkSection(agentId);
    const dynamicContext = [agentStatus, workSection].filter(Boolean).join('\n');
    if (dynamicContext) {
      fullPrompt = `${dynamicContext}\n\n${fullPrompt}`;
    }

    this.logger.log(
      `[MultiAgentSlack] Processing agent ${agentId}, prompt length: ${fullPrompt.length}`
    );

    // Track work start (completed in finally block)
    this.workTracker.startWork(agentId, context.channelId, cleanMessage);

    try {
      // Get or create process for this agent in this channel
      const process = await this.processManager.getProcess('slack', context.channelId, agentId);

      // Send message and get response (with timeout, properly cleaned up)
      let timeoutHandle: ReturnType<typeof setTimeout>;
      let result;
      try {
        result = await Promise.race([
          process.sendMessage(fullPrompt),
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () =>
                reject(new Error(`Agent ${agentId} timed out after ${AGENT_TIMEOUT_MS / 1000}s`)),
              AGENT_TIMEOUT_MS
            );
          }),
        ]);
      } finally {
        clearTimeout(timeoutHandle!);
      }

      // Execute text-based gateway tool calls (```tool_call blocks in response)
      const cleanedResponse = await this.executeTextToolCalls(result.response);

      const bgDelegation = this.delegationManager.parseDelegation(agentId, cleanedResponse);
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
            source: 'slack',
          });
          this.logger.log(
            `[MultiAgentSlack] Background delegation: ${agentId} -> ${bgDelegation.toAgentId} (async)`
          );

          const displayResponse =
            bgDelegation.originalContent ||
            `🔄 Background task submitted to *${toAgent?.display_name ?? bgDelegation.toAgentId}*`;
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

      // Format response with agent prefix
      const formattedResponse = this.formatAgentResponse(agent, cleanedResponse);

      return {
        agentId,
        agent,
        content: formattedResponse,
        rawContent: cleanedResponse,
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

        // Trigger immediate drain if process is idle or reaped
        this.tryDrainNow(agentId, 'slack', context.channelId).catch(() => {});

        return null;
      }
      return null;
    } finally {
      this.workTracker.completeWork(agentId, context.channelId);
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
   * Send formatted responses to Slack (handles message splitting)
   * Uses agent's dedicated bot if available, otherwise main WebClient
   */
  async sendAgentResponses(
    channelId: string,
    threadTs: string | undefined,
    responses: AgentResponse[],
    mainWebClient?: WebClient
  ): Promise<string[]> {
    const sentMessageTs: string[] = [];

    for (const response of responses) {
      try {
        const chunks = splitForSlack(response.content);
        const hasOwnBot = this.multiBotManager.hasAgentBot(response.agentId);

        for (let i = 0; i < chunks.length; i++) {
          let messageTs: string | null = null;

          if (hasOwnBot && threadTs) {
            // Use agent's dedicated bot (requires threadTs for reply)
            messageTs = await this.multiBotManager.replyAsAgent(
              response.agentId,
              channelId,
              threadTs,
              chunks[i]
            );
          } else if (hasOwnBot && !threadTs) {
            // Use agent's dedicated bot for top-level message
            messageTs = await this.multiBotManager.sendAsAgent(
              response.agentId,
              channelId,
              chunks[i]
            );
          } else if (mainWebClient) {
            // Use main bot -- broadcast first chunk to channel
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const msgParams: any = {
              channel: channelId,
              text: chunks[i],
              ...(threadTs && { thread_ts: threadTs }),
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
  protected async sendQueuedResponse(
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

    const agentResponse: AgentResponse = {
      agentId,
      agent,
      content: formattedResponse,
      rawContent: response,
    };

    // Send to channel (pass mainWebClient as fallback for agents without dedicated bots)
    await this.sendAgentResponses(
      message.channelId,
      message.threadTs,
      [agentResponse],
      this.mainWebClient ?? undefined
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
   * Handle bot->agent mention delegation (called by gateway for main bot messages).
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
        `[MultiAgentSlack] Bot->Agent mention chain blocked/maxed in ${event.channel}`
      );
      return;
    }

    this.logger.log(
      `[MultiAgentSlack] Bot->Agent mention: ${senderAgentId ?? 'main'} -> ${targetAgentId}, content="${cleanContent.substring(0, 50)}"`
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

    const botMentionDescription = cleanContent.substring(0, 200);

    this.systemReminder.notify({
      type: 'delegation-started',
      taskId: '',
      description: botMentionDescription,
      agentId: targetAgentId,
      requestedBy: senderAgentId ?? 'main',
      channelId: event.channel,
      timestamp: Date.now(),
    });

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
        this.systemReminder.notify({
          type: 'delegation-completed',
          taskId: '',
          description: botMentionDescription,
          agentId: targetAgentId,
          requestedBy: senderAgentId ?? 'main',
          channelId: event.channel,
          duration: response.duration,
          timestamp: Date.now(),
        });

        const threadTs = event.thread_ts || event.ts;
        await this.sendAgentResponses(event.channel, threadTs, [response], mainWebClient);
        this.orchestrator.recordAgentResponse(targetAgentId, event.channel, response.messageId);

        // Recursively route mentions in this agent's response.
        // Necessary because Slack doesn't deliver a bot's own messages back to itself.
        await this.routeResponseMentions(event.channel, threadTs, [response], mainWebClient);
      }
    } catch (err) {
      this.logger.error(`[MultiAgentSlack] Bot->Agent mention error:`, err);
    } finally {
      // Replace eyes with checkmark regardless of success/failure
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
    responses: AgentResponse[],
    mainWebClient: WebClient
  ): Promise<void> {
    for (const response of responses) {
      // Filter out self-mentions to prevent routing an agent's response back to itself
      const mentionedAgentIds = this.extractMentionedAgentIds(response.rawContent).filter(
        (id) => id !== response.agentId
      );
      if (mentionedAgentIds.length === 0) continue;

      // Hard gate: block malformed delegations from can_delegate agents
      const senderAgent = this.orchestrator.getAgent(response.agentId);
      if (senderAgent?.can_delegate && isDelegationAttempt(response.rawContent)) {
        const validation = validateDelegationFormat(response.rawContent);
        if (!validation.valid) {
          this.logger.warn(
            `[Delegation] BLOCKED ${response.agentId} -- missing: ${validation.missingSections.join(', ')}`
          );

          // Post warning to channel so the agent sees the feedback
          try {
            const warningMsg =
              `⚠️ *Delegation blocked* -- missing sections: ${validation.missingSections.join(', ')}\n` +
              `Re-send with all 6 sections: TASK, EXPECTED OUTCOME, MUST DO, MUST NOT DO, REQUIRED TOOLS, CONTEXT`;
            const hasOwnBot = this.multiBotManager.hasAgentBot(response.agentId);
            if (hasOwnBot) {
              await this.multiBotManager.replyAsAgent(
                response.agentId,
                channelId,
                threadTs,
                warningMsg
              );
            } else {
              await mainWebClient.chat.postMessage({
                channel: channelId,
                text: warningMsg,
                thread_ts: threadTs,
              });
            }
          } catch {
            /* ignore warning post errors */
          }

          continue; // Skip routing -- do not forward to target agents
        }
      }

      this.logger.log(
        `[MultiAgentSlack] Auto-routing mentions from ${response.agentId}: -> ${mentionedAgentIds.join(', ')}`
      );

      // Route to all mentioned agents in parallel (not sequential)
      await Promise.all(
        mentionedAgentIds.map((targetAgentId) => {
          const syntheticEvent: SlackMentionEvent = {
            type: 'message',
            channel: channelId,
            user: '',
            text: response.rawContent,
            ts: `${response.messageId || threadTs}-${response.agentId}`,
            thread_ts: threadTs,
            bot_id: 'auto-route',
          };
          return this.handleBotToAgentMention(targetAgentId, syntheticEvent, mainWebClient);
        })
      );
    }
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
   * Get status of all agent bots
   */
  getBotStatus(): Record<string, { connected: boolean; botName?: string }> {
    return this.multiBotManager.getStatus();
  }
}
