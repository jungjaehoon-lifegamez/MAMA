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

/** Default timeout for agent responses (5 minutes) */
const AGENT_TIMEOUT_MS = 5 * 60 * 1000;

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

  /** Whether multi-bot mode is initialized */
  private multiBotInitialized = false;

  constructor(config: MultiAgentConfig, processOptions: Partial<PersistentProcessOptions> = {}) {
    this.config = config;
    this.orchestrator = new MultiAgentOrchestrator(config);
    this.processManager = new AgentProcessManager(config, processOptions);
    this.sharedContext = getSharedContextManager();
    this.multiBotManager = new MultiBotManager(config);
    this.messageQueue = new AgentMessageQueue();

    // Periodic cleanup of expired queued messages (F7)
    setInterval(() => {
      this.messageQueue.clearExpired();
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
          cleanContent
        );

        if (response) {
          await this.sendAgentResponses(message, [response]);
          this.orchestrator.recordAgentResponse(agentId, message.channel.id, response.messageId);
        }
      } catch (err) {
        console.error(`[MultiAgent] Mention handler error:`, err);
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
      this.processManager.setBotUserIdMap(botUserIdMap);
      this.processManager.setMentionDelegation(true);
      console.log(`[MultiAgent] Mention delegation enabled with ${botUserIdMap.size} bot IDs`);
    }
  }

  /**
   * Set bot's own user ID (call when Discord connects)
   */
  setBotUserId(userId: string): void {
    this.multiBotManager.setMainBotUserId(userId);
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
  async handleMessage(
    message: Message,
    cleanContent: string,
    historyContext?: string
  ): Promise<MultiAgentResponse | null> {
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
        this.processAgentResponse(agentId, context, cleanContent, historyContext)
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
  ): Promise<AgentResponse | null> {
    const agent = this.orchestrator.getAgent(agentId);
    if (!agent) {
      console.error(`[MultiAgent] Unknown agent: ${agentId}`);
      return null;
    }

    // Strip trigger prefix from message if present
    const cleanMessage = this.orchestrator.stripTriggerPrefix(userMessage, agentId);

    // Build context for this agent (excluding its own previous messages)
    const agentContext = this.sharedContext.buildContextForAgent(context.channelId, agentId, 5);

    // Build full prompt with context
    let fullPrompt = cleanMessage;
    if (historyContext) {
      fullPrompt = `${historyContext}\n\n${cleanMessage}`;
    }
    if (agentContext) {
      fullPrompt = `${agentContext}\n\n${fullPrompt}`;
    }

    console.log(`[MultiAgent] Processing agent ${agentId}, prompt length: ${fullPrompt.length}`);

    try {
      // Get or create process for this agent in this channel
      const process = await this.processManager.getProcess('discord', context.channelId, agentId);

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
        } else {
          // Use main bot - need to get channel reference
          // Note: We can't reply without original message, so just log
          console.warn(
            `[MultiAgent] Cannot send queued message for ${agentId} without agent bot (no original message)`
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
      }
    }

    return agentIds;
  }

  /**
   * Stop all agent processes and bots
   */
  async stopAll(): Promise<void> {
    this.processManager.stopAll();
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
