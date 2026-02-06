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

/** Default timeout for agent responses (5 minutes) */
const AGENT_TIMEOUT_MS = 15 * 60 * 1000;

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
  private logger = console;

  /** Whether multi-bot mode is initialized */
  private multiBotInitialized = false;

  constructor(config: MultiAgentConfig, processOptions: Partial<PersistentProcessOptions> = {}) {
    this.config = config;
    this.orchestrator = new MultiAgentOrchestrator(config);
    this.processManager = new AgentProcessManager(config, processOptions);
    this.sharedContext = getSharedContextManager();
    this.multiBotManager = new SlackMultiBotManager(config);
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

      // Return a user-friendly busy message instead of silently failing
      if (errMsg.includes('busy')) {
        return {
          agentId,
          agent,
          content: `*${agent.display_name}*: 이전 요청을 처리 중입니다. 잠시 후 다시 시도해주세요. ⏳`,
          rawContent: '',
          duration: 0,
        };
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
   * Extract agent IDs from <@U...> mentions in message content
   */
  private extractMentionedAgentIds(content: string): string[] {
    const mentionPattern = /<@([UW]\w+)>/g;
    const agentIds: string[] = [];
    let match;

    while ((match = mentionPattern.exec(content)) !== null) {
      const userId = match[1];
      const agentId = this.multiBotManager.resolveAgentIdFromUserId(userId);
      if (agentId && agentId !== 'main') {
        agentIds.push(agentId);
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
   * Stop all agent processes and bots
   */
  async stopAll(): Promise<void> {
    this.processManager.stopAll();
    await this.multiBotManager.stopAll();
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
