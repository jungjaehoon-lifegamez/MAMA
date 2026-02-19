/**
 * Multi-Agent Discord Integration
 *
 * Extends the Discord gateway with multi-agent support.
 * Enables multiple AI personas to interact in Discord channels.
 */

import type { Message } from 'discord.js';
import type {
  MultiAgentConfig,
  MessageContext,
  AgentPersonaConfig,
  MultiAgentRuntimeOptions,
} from './types.js';
import { MultiBotManager } from './multi-bot-manager.js';
import type { PersistentProcessOptions } from '../agent/persistent-cli-process.js';
import type { AgentRuntimeProcess } from './runtime-process.js';
import { splitForDiscord } from '../gateways/message-splitter.js';
import type { QueuedMessage } from './agent-message-queue.js';
import { validateDelegationFormat, isDelegationAttempt } from './delegation-format-validator.js';
import { getChannelHistory } from '../gateways/channel-history.js';
import { PromptEnhancer } from '../agent/prompt-enhancer.js';
import type { RuleContext } from '../agent/yaml-frontmatter.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';
import {
  MultiAgentHandlerBase,
  AGENT_TIMEOUT_MS,
  type AgentResponse,
  type MultiAgentResponse,
} from './multi-agent-base.js';

export type { AgentResponse, MultiAgentResponse } from './multi-agent-base.js';

const execFileAsync = promisify(execFile);
const { DebugLogger } = debugLogger as {
  DebugLogger: new (context?: string) => {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};
const logger = new DebugLogger('MultiAgentDiscord');

/** Delay before showing progress message (ms) -- fast requests never show it */
const PROGRESS_DELAY_MS = 5_000;

/** Minimum interval between progress message edits (ms) -- Discord rate limit safety */
const PROGRESS_EDIT_INTERVAL_MS = 3_000;

/** Phase emoji progression */
const _PHASE_EMOJIS = ['👀', '🔍', '💻', '🔧', '📝', '✅'] as const;

/** Max characters allowed for dynamic context blocks to avoid prompt bloat */
const MAX_DYNAMIC_CONTEXT_CHARS = 4000;

/** Map tool names to phase emojis */
function toolToPhaseEmoji(toolName: string): (typeof _PHASE_EMOJIS)[number] | null {
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
export class MultiAgentDiscordHandler extends MultiAgentHandlerBase {
  private multiBotManager: MultiBotManager;
  private promptEnhancer: PromptEnhancer;

  /** Discord client reference for main bot channel sends */
  private discordClient: { channels: { fetch: (id: string) => Promise<unknown> } } | null = null;

  /** Tracks which agent:channel combos have received history injection (new session only) */
  private historyInjected = new Set<string>();

  /** Cleanup interval handle for periodic tasks */
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  /** Cleanup interval period (1 minute) */
  private static readonly CLEANUP_INTERVAL_MS = 60_000;

  constructor(
    config: MultiAgentConfig,
    processOptions: Partial<PersistentProcessOptions> = {},
    runtimeOptions: MultiAgentRuntimeOptions = {}
  ) {
    super(config, processOptions, runtimeOptions);
    this.multiBotManager = new MultiBotManager(config);
    this.promptEnhancer = new PromptEnhancer();

    // Periodic cleanup of expired queued messages and mention dedup entries
    this.cleanupInterval = setInterval(() => {
      this.messageQueue.clearExpired();
      this.cleanupProcessedMentions();
    }, MultiAgentDiscordHandler.CLEANUP_INTERVAL_MS);

    // Setup idle event listeners for all agents (F7)
    this.setupIdleListeners();
  }

  protected getPlatformName(): 'discord' | 'slack' {
    return 'discord';
  }

  formatBold(text: string): string {
    return `**${text}**`;
  }

  protected async sendChannelNotification(channelId: string, message: string): Promise<void> {
    try {
      if (this.discordClient) {
        const channel = await this.discordClient.channels.fetch(channelId);
        if (channel && 'send' in (channel as Record<string, unknown>)) {
          await (channel as { send: (opts: { content: string }) => Promise<unknown> }).send({
            content: message,
          });
        }
      }
    } catch (err) {
      console.error(`[MultiAgent] Failed to send channel notification:`, err);
    }
  }

  /**
   * Extract agent IDs from <@USER_ID> mentions AND DELEGATE::{agent_id}:: patterns
   * in message content. Both syntaxes route to the same delegation flow.
   */
  extractMentionedAgentIds(content: string): string[] {
    const agentIds: string[] = [];

    // 1. Discord native mentions: <@USER_ID> or <@!USER_ID>
    const mentionPattern = /<@!?(\d+)>/g;
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

    // 2. DELEGATE::{agent_id}:: and DELEGATE_BG::{agent_id}:: syntax
    const delegatePattern = /DELEGATE(?:_BG)?::([\w-]+)::/g;
    while ((match = delegatePattern.exec(content)) !== null) {
      const targetAgentId = match[1];
      // Only add if it's a known agent and not already in the list
      if (this.orchestrator.getAgent(targetAgentId) && !agentIds.includes(targetAgentId)) {
        agentIds.push(targetAgentId);
      }
    }

    return agentIds;
  }

  protected async platformCleanup(): Promise<void> {
    // Clear cleanup interval to prevent memory leaks
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    await this.multiBotManager.stopAll();
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
        const maxDepth = this.getEffectiveMaxMentionDepth();

        if (chainState.blocked) {
          logger.info(
            `[MultiAgent] Mention chain blocked in channel ${message.channel.id}, ignoring`
          );
          return;
        }
        if (chainState.length >= maxDepth) {
          logger.info(
            `[MultiAgent] Mention chain depth ${chainState.length} >= max ${maxDepth}, ignoring`
          );
          return;
        }
      }

      logger.info(
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
      const mentionDescription = cleanContent.substring(0, 200);
      let mentionResponse: AgentResponse | null = null;
      try {
        this.systemReminder.notify({
          type: 'delegation-started',
          taskId: '',
          description: mentionDescription,
          agentId,
          requestedBy: senderAgentId ?? message.author.tag,
          channelId: message.channel.id,
          timestamp: Date.now(),
        });

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
          this.systemReminder.notify({
            type: 'delegation-completed',
            taskId: '',
            description: mentionDescription,
            agentId,
            requestedBy: senderAgentId ?? message.author.tag,
            channelId: message.channel.id,
            duration: mentionResponse.duration,
            timestamp: Date.now(),
          });

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
        // Only add checkmark if agent responded (null = busy/queued)
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
      logger.info(`[MultiAgent] Multi-bot mode active for: ${connectedAgents.join(', ')}`);
    }

    // Pass bot ID map to process manager for mention-based delegation prompts
    if (this.config.mention_delegation) {
      const botUserIdMap = this.multiBotManager.getBotUserIdMap();

      // Include LEAD (default agent) which uses the main bot token
      // Without this, @Conductor in other agents' personas won't resolve to <@userId>
      const defaultAgentId = this.config.default_agent;
      if (defaultAgentId && !botUserIdMap.has(defaultAgentId)) {
        const mainBotUserId = this.multiBotManager.getMainBotUserId();
        if (mainBotUserId) {
          botUserIdMap.set(defaultAgentId, mainBotUserId);
        }
      }

      this.processManager.setBotUserIdMap(botUserIdMap);
      this.processManager.setMentionDelegation(true);
      logger.info(`[MultiAgent] Mention delegation enabled with ${botUserIdMap.size} bot IDs`);
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
  }

  /**
   * Set main bot token (to avoid duplicate logins in MultiBotManager)
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
    this.multiBotManager.updateConfig(config);
  }

  /**
   * Handle a Discord message with multi-agent logic
   *
   * @returns Object with selected agents and their responses, or null if no agents respond
   */
  async handleMessage(message: Message, cleanContent: string): Promise<MultiAgentResponse | null> {
    // Intercept !stop command before any agent routing
    if (cleanContent.startsWith('!stop')) {
      await this.handleStopCommand(message, cleanContent);
      return null;
    }

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

    logger.info(
      `[MultiAgent] Selection result: agents=${selection.selectedAgents.join(',')}, reason=${selection.reason}, blocked=${selection.blocked}`
    );

    if (selection.blocked) {
      logger.info(`[MultiAgent] Blocked: ${selection.blockReason}`);
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

    return {
      selectedAgents: selection.selectedAgents,
      reason: selection.reason,
      responses,
    };
  }

  private async handleStopCommand(message: Message, cleanContent: string): Promise<void> {
    const channelId = message.channel.id;
    const args = cleanContent.slice('!stop'.length).trim();

    if (args) {
      const agentId = args;
      const agent = this.orchestrator.getAgent(agentId);
      if (!agent) {
        await message.reply({ content: `⏹️ Unknown agent: \`${agentId}\`` });
        return;
      }

      const hasActive = this.processManager.hasActiveProcess('discord', channelId, agentId);
      if (hasActive) {
        this.processManager.stopProcess('discord', channelId, agentId);
        this.orchestrator.resetChain(channelId);
        const displayName = agent.display_name || agentId;
        await message.reply({ content: `⏹️ Stopped ${displayName}` });
      } else {
        await message.reply({ content: `⏹️ No running agents to stop` });
      }
    } else {
      const activeAgents = this.processManager.getActiveAgentsInChannel('discord', channelId);

      if (activeAgents.length > 0) {
        this.processManager.stopChannelProcesses('discord', channelId);
        this.orchestrator.resetChain(channelId);
        await message.reply({ content: `⏹️ Stopped all agents in this channel` });
      } else {
        await message.reply({ content: `⏹️ No running agents to stop` });
      }
    }

    logger.info(`[MultiAgent] !stop command: channel=${channelId}, target=${args || 'all'}`);
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
    //   DevBot/Reviewer are sub-agent-like -- they get tasks via delegation, not channel history.
    //   Only LEAD needs channel context to understand the conversation flow.
    let fullPrompt = cleanMessage;

    // Inject channel history for all agents on new sessions only.
    // - Keeps human messages + this agent's own messages, excludes other bots.
    // - Only on first message per session (subsequent messages are in session memory).
    const sessionKey = `${agentId}:${context.channelId}`;
    if (!this.historyInjected.has(sessionKey)) {
      const channelHistory = getChannelHistory();
      const displayName = agent.display_name || agentId;
      const historyContext = channelHistory.formatForContext(
        context.channelId,
        context.messageId,
        displayName // keep human + this agent's own messages, exclude other bots
      );
      if (historyContext) {
        fullPrompt = `${historyContext}\n\n${fullPrompt}`;
      }
      this.historyInjected.add(sessionKey);
    }

    if (agentContext) {
      fullPrompt = `${agentContext}\n\n${fullPrompt}`;
    }

    // Inject agent availability status, active work, and channel context (Phase 2 + 3)
    const agentStatus = this.buildAgentStatusSection(agentId);
    const workSection = this.workTracker.buildWorkSection(agentId);
    const channelInfo = `## Current Channel\nPlatform: Discord\nchannel_id: ${context.channelId}\nUse **discord_send** to send messages/files to this channel.`;
    const dynamicContextRaw = [agentStatus, workSection, channelInfo].filter(Boolean).join('\n');
    const dynamicContext =
      dynamicContextRaw.length > MAX_DYNAMIC_CONTEXT_CHARS
        ? `${dynamicContextRaw.slice(0, MAX_DYNAMIC_CONTEXT_CHARS)}\n...`
        : dynamicContextRaw;
    if (dynamicContext) {
      fullPrompt = `${dynamicContext}\n\n${fullPrompt}`;
    }

    // Enhance prompt with keyword detection (ultrawork/search/analyze modes)
    const workspacePath = globalThis.process.env.MAMA_WORKSPACE || '';
    const ruleContext: RuleContext = {
      agentId,
      tier: agent.tier,
      channelId: context.channelId,
    };
    const enhanced = this.promptEnhancer.enhance(cleanMessage, workspacePath, ruleContext);
    if (enhanced.skillContent) {
      fullPrompt = `<system-reminder>\n${enhanced.skillContent}\n</system-reminder>\n\n${fullPrompt}`;
      logger.info(
        `[SkillMatch] Injecting skill into Discord agent ${agentId}: ${enhanced.skillContent.length} chars`
      );
    }
    if (enhanced.keywordInstructions) {
      fullPrompt = `${enhanced.keywordInstructions}\n\n${fullPrompt}`;
      logger.info(
        `[PromptEnhancer] Keyword detected for agent ${agentId}: ${enhanced.keywordInstructions.length} chars injected`
      );
    }
    if (enhanced.rulesContent) {
      fullPrompt = `## Project Rules\n${enhanced.rulesContent}\n\n${fullPrompt}`;
      logger.info(
        `[PromptEnhancer] Rules injected for agent ${agentId}: ${enhanced.rulesContent.length} chars`
      );
    }

    logger.info(`[MultiAgent] Processing agent ${agentId}, prompt length: ${fullPrompt.length}`);

    // Track work start (completed in finally block)
    this.workTracker.startWork(agentId, context.channelId, cleanMessage);

    let agentProcess: AgentRuntimeProcess | null = null;

    try {
      // Get or create process for this agent in this channel
      agentProcess = await this.processManager.getProcess('discord', context.channelId, agentId);

      // Build onToolUse callback for emoji progression (accumulate, don't replace)
      const addedEmojis = new Set<string>();
      const hasOwnBot = this.multiBotManager.hasAgentBot(agentId);

      // Progress tracking state
      let _toolCount = 0;
      const startTime = Date.now();
      let progressMessage: Message | null = null;
      let progressDelayHandle: ReturnType<typeof setTimeout> | null = null;
      let lastEditTime = 0;
      let pendingEditHandle: ReturnType<typeof setTimeout> | null = null;

      /** Build progress message content (elapsed time only -- no tool/code details exposed) */
      const buildProgressContent = (): string => {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        return `⏳ Working... (${elapsed}s)`;
      };

      /** Send or edit the progress message (debounced to 1 edit per 3s) */
      const updateProgressMessage = (): void => {
        if (!discordMessage) return;

        const now = Date.now();
        const timeSinceLastEdit = now - lastEditTime;

        if (progressMessage) {
          // Already have a message -- debounce edits
          if (timeSinceLastEdit >= PROGRESS_EDIT_INTERVAL_MS) {
            lastEditTime = now;
            progressMessage.edit(buildProgressContent()).catch(() => {
              /* ignore -- message may be deleted */
            });
          } else if (!pendingEditHandle) {
            // Schedule a deferred edit
            const delay = PROGRESS_EDIT_INTERVAL_MS - timeSinceLastEdit;
            pendingEditHandle = setTimeout(() => {
              pendingEditHandle = null;
              if (progressMessage) {
                lastEditTime = Date.now();
                progressMessage.edit(buildProgressContent()).catch(() => {
                  /* ignore */
                });
              }
            }, delay);
          }
        }
      };

      /** Start the delayed progress message (fires after PROGRESS_DELAY_MS of first tool use) */
      const scheduleProgressStart = (): void => {
        if (progressDelayHandle || progressMessage || !discordMessage) return;
        progressDelayHandle = setTimeout(async () => {
          progressDelayHandle = null;
          if (!discordMessage) return;
          try {
            const content = buildProgressContent();
            if (hasOwnBot) {
              progressMessage = await this.multiBotManager.sendAsAgent(
                agentId,
                discordMessage.channel.id,
                content
              );
            } else if ('send' in discordMessage.channel) {
              progressMessage = await (
                discordMessage.channel as { send: (c: string) => Promise<Message> }
              ).send(content);
            }
            lastEditTime = Date.now();
          } catch {
            /* ignore -- channel may be unavailable */
          }
        }, PROGRESS_DELAY_MS);
      };

      /** Clean up all progress tracking resources */
      const cleanupProgress = async (): Promise<void> => {
        if (progressDelayHandle) {
          clearTimeout(progressDelayHandle);
          progressDelayHandle = null;
        }
        if (pendingEditHandle) {
          clearTimeout(pendingEditHandle);
          pendingEditHandle = null;
        }
        if (progressMessage) {
          try {
            await progressMessage.delete();
          } catch {
            /* ignore -- message may already be deleted */
          }
          progressMessage = null;
        }
      };

      const onToolUse = discordMessage
        ? (name: string) => {
            // Existing emoji reaction behavior
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

            // Progress message tracking
            _toolCount++;
            scheduleProgressStart();
            updateProgressMessage();
          }
        : undefined;

      // Send message and get response (with timeout, properly cleaned up)
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let result;
      try {
        result = await Promise.race([
          agentProcess.sendMessage(fullPrompt, onToolUse ? { onToolUse } : undefined),
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () =>
                reject(new Error(`Agent ${agentId} timed out after ${AGENT_TIMEOUT_MS / 1000}s`)),
              AGENT_TIMEOUT_MS
            );
          }),
        ]);
      } finally {
        await cleanupProgress();
      }
      if (timeoutHandle) clearTimeout(timeoutHandle);

      // Execute text-based gateway tool calls (```tool_call blocks in response)
      // Claude CLI handles built-in tools (Read, Bash, Glob) internally via native tool_use.
      // Gateway tools (discord_send, mama_*) are requested via text-based tool_call blocks.
      // discord_send is routed through the agent's own bot (not the main LEAD bot).
      // Check for workflow plan BEFORE executing tool calls (priority)
      const workflowStart = Date.now();
      const workflowResult = await this.tryExecuteWorkflow(
        result.response,
        context.channelId,
        'discord',
        (event) => {
          if (!this.discordClient) {
            return;
          }
          let msg = '';
          const modelTag = event.agentModel ? ` [${event.agentModel}]` : '';
          const progress =
            event.totalSteps && event.completedSteps !== undefined
              ? ` [${event.completedSteps}/${event.totalSteps}]`
              : '';
          if (event.type === 'step-started') {
            msg = `  ${event.agentDisplayName}${modelTag}${progress} 시작...`;
          } else if (event.type === 'step-completed') {
            const sec = event.duration_ms ? Math.round(event.duration_ms / 1000) : 0;
            const pct =
              event.totalSteps && event.completedSteps !== undefined
                ? ` (${Math.round((event.completedSteps / event.totalSteps) * 100)}%)`
                : '';
            msg = `${event.agentDisplayName}${modelTag} (${sec}s)${pct} 완료`;
          } else if (event.type === 'step-failed') {
            msg = `${event.agentDisplayName}${modelTag}${progress} ❌ 실패: ${event.error?.substring(0, 100)}`;
          }
          if (msg) {
            this.sendChannelNotification(context.channelId, msg).catch(() => {});
          }
        }
      );

      if (workflowResult) {
        if (workflowResult.failed) {
          this.logger.warn(
            `[MultiAgentDiscord] Workflow failed: ${workflowResult.failed}, sending feedback to conductor`
          );
          const feedback = `[SYSTEM] Your workflow_plan failed to execute.\nReason: ${workflowResult.failed}\nPlease adjust and retry, or respond without a workflow_plan.`;
          const retryResult = await agentProcess!.sendMessage(feedback);
          const cleanedRetry = await this.executeAgentToolCalls(agentId, retryResult.response);
          const formattedResponse = this.formatAgentResponse(agent, cleanedRetry);
          return {
            agentId,
            agent,
            content: formattedResponse,
            rawContent: cleanedRetry,
            duration: Date.now() - workflowStart + (result.duration_ms ?? 0),
          };
        }

        const display = workflowResult.directMessage
          ? `${workflowResult.directMessage}\n\n${workflowResult.result}`
          : workflowResult.result;
        const formattedResponse = this.formatAgentResponse(agent, display);
        const totalDuration = Date.now() - workflowStart + (result.duration_ms ?? 0);
        return {
          agentId,
          agent,
          content: formattedResponse,
          rawContent: display,
          duration: totalDuration,
        };
      }

      // Check for council plan (after workflow, before tool calls)
      const councilResult = await this.tryExecuteCouncil(
        result.response,
        context.channelId,
        'discord',
        (event) => {
          if (!this.discordClient) return;
          let msg = '';
          if (event.type === 'council-round-started') {
            msg = `🗣️ ${event.agentDisplayName} Round ${event.round} 시작...`;
          } else if (event.type === 'council-round-completed') {
            const sec = event.duration_ms ? Math.round(event.duration_ms / 1000) : 0;
            msg = `🗣️ ${event.agentDisplayName} Round ${event.round} (${sec}s) 완료`;
          } else if (event.type === 'council-round-failed') {
            msg = `🗣️ ${event.agentDisplayName} Round ${event.round} ❌ 실패: ${event.error?.substring(0, 100)}`;
          }
          if (msg) {
            this.sendChannelNotification(context.channelId, msg).catch(() => {});
          }
        }
      );

      if (councilResult) {
        const display = councilResult.directMessage
          ? `${councilResult.directMessage}\n\n${councilResult.result}`
          : councilResult.result;
        const formattedResponse = this.formatAgentResponse(agent, display);
        return {
          agentId,
          agent,
          content: formattedResponse,
          rawContent: display,
          duration: Date.now() - workflowStart + (result.duration_ms ?? 0),
        };
      }

      // Strip any workflow/council plan JSON that wasn't executed
      let responseForProcessing = result.response;
      if (this.workflowEngine?.isEnabled()) {
        responseForProcessing = this.workflowEngine.extractNonPlanContent(responseForProcessing);
      }
      if (this.councilEngine) {
        responseForProcessing = this.councilEngine.extractNonPlanContent(responseForProcessing);
      }

      const cleanedResponse = await this.executeAgentToolCalls(agentId, responseForProcessing);

      // Detect API error responses — skip mention resolution and delegation to prevent error loops
      const isErrorResponse = /API Error:\s*\d{3}\b/.test(cleanedResponse);
      const resolvedResponse = isErrorResponse
        ? cleanedResponse
        : this.resolveResponseMentions(cleanedResponse);

      const bgDelegations = isErrorResponse
        ? []
        : this.delegationManager.parseAllDelegations(agentId, resolvedResponse);
      if (bgDelegations.length > 0 && bgDelegations[0].background) {
        let submittedCount = 0;
        const submittedAgents: string[] = [];
        for (const delegation of bgDelegations) {
          if (!delegation.background) {
            continue;
          }
          const check = this.delegationManager.isDelegationAllowed(
            delegation.fromAgentId,
            delegation.toAgentId
          );
          if (check.allowed) {
            this.backgroundTaskManager.submit({
              description: delegation.task.substring(0, 200),
              prompt: delegation.task,
              agentId: delegation.toAgentId,
              requestedBy: agentId,
              channelId: context.channelId,
              source: 'discord',
            });
            submittedCount++;
            submittedAgents.push(delegation.toAgentId);
            logger.info(
              `[MultiAgent] Background delegation: ${agentId} -> ${delegation.toAgentId} (async)`
            );
          } else {
            console.warn(
              `[MultiAgent] Delegation denied: ${agentId} -> ${delegation.toAgentId}: ${check.reason}`
            );
          }
        }

        if (submittedCount > 0) {
          const displayResponse =
            bgDelegations[0].originalContent ||
            `🔄 ${submittedCount} background task(s) submitted to **${[...new Set(submittedAgents)].join(', ')}**`;
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
        logger.info(`[MultiAgent] Agent ${agentId} busy, enqueuing message`);

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

        // Trigger immediate drain if process is idle or reaped
        this.tryDrainNow(agentId, 'discord', context.channelId).catch(() => {});

        if (discordMessage) {
          try {
            await discordMessage.react('⏳');
          } catch {
            /* ignore */
          }
        }
      }

      return null;
    } finally {
      if (agentProcess) {
        this.processManager.releaseProcess(agentId, agentProcess);
      }
      this.workTracker.completeWork(agentId, context.channelId);
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

    // Extract mentioned agent IDs from Discord mentions
    const mentionedAgentIds = isBot ? undefined : this.extractMentionedAgentIds(message.content);

    return {
      channelId: message.channel.id,
      userId: message.author.id,
      content: cleanContent,
      isBot,
      senderAgentId,
      mentionedAgentIds: mentionedAgentIds?.length ? mentionedAgentIds : undefined,
      messageId: message.id,
      timestamp: message.createdTimestamp,
    };
  }

  /**
   * Send queued response to Discord (F7: message queue drain callback)
   */
  protected async sendQueuedResponse(
    agentId: string,
    message: QueuedMessage,
    response: string
  ): Promise<void> {
    const agent = this.orchestrator.getAgent(agentId);
    if (!agent) {
      console.error(`[MultiAgent] Unknown agent in queue: ${agentId}`);
      return;
    }

    // Execute gateway tool calls from response
    const cleanedResponse = await this.executeAgentToolCalls(agentId, response);

    // Parse and submit DELEGATE_BG commands
    const delegations = this.delegationManager.parseAllDelegations(agentId, cleanedResponse);
    let displayResponse = cleanedResponse;
    const hasBackground = delegations.some((delegation) => delegation.background);
    if (delegations.length > 0 && hasBackground) {
      let submittedCount = 0;
      for (const delegation of delegations) {
        if (!delegation.background) {
          continue;
        }
        const check = this.delegationManager.isDelegationAllowed(
          delegation.fromAgentId,
          delegation.toAgentId
        );
        if (check.allowed) {
          this.backgroundTaskManager.submit({
            description: delegation.task.substring(0, 200),
            prompt: delegation.task,
            agentId: delegation.toAgentId,
            requestedBy: agentId,
            channelId: message.channelId,
            source: 'discord',
          });
          submittedCount++;
          logger.info(
            `[MultiAgent] Background delegation (queued): ${agentId} -> ${delegation.toAgentId} (async)`
          );
        } else {
          console.warn(
            `[MultiAgent] Delegation denied (queued): ${agentId} -> ${delegation.toAgentId}: ${check.reason}`
          );
        }
      }
      if (submittedCount > 0) {
        displayResponse =
          delegations[0].originalContent || `🔄 ${submittedCount} background task(s) delegated`;
      }
    }

    // Handle synchronous DELEGATE:: delegations via message queue
    const syncDelegations = delegations.filter((d) => !d.background);
    for (const delegation of syncDelegations) {
      const check = this.delegationManager.isDelegationAllowed(
        delegation.fromAgentId,
        delegation.toAgentId
      );
      if (check.allowed) {
        this.messageQueue.enqueue(delegation.toAgentId, {
          prompt: delegation.task,
          channelId: message.channelId,
          source: 'discord',
          enqueuedAt: Date.now(),
          context: { channelId: message.channelId, userId: 'delegation' },
        });
        logger.info(
          `[MultiAgent] Sync delegation (queued path): ${agentId} -> ${delegation.toAgentId}`
        );
        this.tryDrainNow(delegation.toAgentId, 'discord', message.channelId).catch(() => {});
      } else {
        console.warn(
          `[MultiAgent] Sync delegation denied (queued): ${agentId} -> ${delegation.toAgentId}: ${check.reason}`
        );
      }
    }

    // Format response with agent prefix
    const formattedResponse = this.formatAgentResponse(agent, displayResponse);

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

    // Mark original Discord message as completed
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
        /* ignore -- message may have been deleted */
      }
    }

    logger.info(`[MultiAgent] Queued message delivered for ${agentId} in ${message.channelId}`);
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

    // Post-send: Auto-review trigger for default agent (Armed Conductor) self-implementations
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
   * Detect if the default agent (Conductor) performed direct code edits.
   * Checks for Claude CLI tool-use markers that indicate Edit/Write operations.
   */
  private detectSelfImplementation(rawContent: string): boolean {
    // Claude CLI responses contain tool use results -- look for Edit/Write indicators
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
   * Check git diff size after Conductor self-implementation.
   * If diff exceeds thresholds, auto-trigger Reviewer for quality gate.
   *
   * Thresholds (PAIR mode auto-escalation):
   * - >3 files changed -> auto-mention Reviewer
   * - >200 lines changed -> auto-mention Reviewer
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
        logger.info(
          `[AutoReview] Conductor self-implementation exceeded thresholds: ${filesChanged} files, ${totalLines} lines -> auto-triggering Reviewer`
        );

        // Find reviewer agent using shared helper
        const reviewerEntry = this.findReviewerAgent();
        const reviewerAgentId = reviewerEntry?.[0];

        if (reviewerAgentId && this.multiBotManager.hasAgentBot(reviewerAgentId)) {
          const reviewMsg = `⬆️ **Auto-Review Triggered** -- ${defaultAgentId} self-implemented but diff exceeded thresholds (${filesChanged} files, ${totalLines} lines). Requesting @Reviewer auto-review.`;
          await this.multiBotManager.sendAsAgent(reviewerAgentId, channelId, reviewMsg);
        }
      } else {
        logger.info(
          `[AutoReview] Conductor self-implementation within thresholds: ${filesChanged} files, ${totalLines} lines -- no auto-review needed`
        );
      }
    } catch {
      // Git not available or not in a repo -- skip silently
    }
  }

  /**
   * Get multi-bot manager
   */
  getMultiBotManager(): MultiBotManager {
    return this.multiBotManager;
  }

  /**
   * Get status of all agent bots
   */
  getBotStatus(): Record<string, { connected: boolean; username?: string }> {
    return this.multiBotManager.getStatus();
  }

  /**
   * After sending agent responses, check for mentions to other agents and route them.
   * Discord equivalent of Slack's routeResponseMentions -- necessary because Discord
   * bots don't receive their own messages as events.
   */
  async routeResponseMentions(originalMessage: Message, responses: AgentResponse[]): Promise<void> {
    for (const response of responses) {
      const senderAgent = this.orchestrator.getAgent(response.agentId);

      // Filter out self-mentions only. All agents can route to any other agent
      // including LEAD -- the receiving LLM agent can reason about whether to
      // respond with new information or acknowledge without repeating.
      const mentionedAgentIds = this.extractMentionedAgentIds(response.rawContent).filter(
        (id) => id !== response.agentId // no self-mention
      );
      if (mentionedAgentIds.length === 0) continue;
      if (senderAgent?.can_delegate && isDelegationAttempt(response.rawContent)) {
        const validation = validateDelegationFormat(response.rawContent);
        if (!validation.valid) {
          console.warn(
            `[Delegation] BLOCKED ${response.agentId} -- missing: ${validation.missingSections.join(', ')}`
          );

          // Post warning to channel so the agent sees the feedback
          try {
            const warningMsg =
              `⚠️ **Delegation blocked** -- missing sections: ${validation.missingSections.join(', ')}\n` +
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

          continue; // Skip routing -- do not forward to target agents
        }
      }

      logger.info(
        `[MultiAgent] Auto-routing mentions from ${response.agentId}: -> ${mentionedAgentIds.join(', ')}`
      );

      // Route to all mentioned agents in parallel
      await Promise.all(
        mentionedAgentIds.map((targetAgentId) =>
          this.handleDelegatedMention(targetAgentId, originalMessage, response)
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
    sourceResponse: AgentResponse
  ): Promise<void> {
    // Dedup: prevent double processing
    const dedupKey = `${targetAgentId}:${sourceResponse.messageId || originalMessage.id}`;
    if (this.processedMentions.has(dedupKey)) return;
    this.processedMentions.set(dedupKey, Date.now());

    // Chain depth check
    const chainState = this.orchestrator.getChainState(originalMessage.channel.id);
    const maxDepth = this.config.max_mention_depth ?? 3;
    if (chainState.blocked || chainState.length >= maxDepth) {
      logger.info(`[MultiAgent] Delegation chain blocked/maxed in ${originalMessage.channel.id}`);
      return;
    }

    // Delegation rule validation (Phase 4)
    if (this.config.delegation_rules) {
      const rule = this.config.delegation_rules.find(
        (r) => r.from === sourceResponse.agentId && r.to.includes(targetAgentId)
      );
      if (!rule) {
        logger.info(
          `[MultiAgent] Delegation blocked by rule: ${sourceResponse.agentId} → ${targetAgentId}`
        );
        return;
      }
    }

    logger.info(`[MultiAgent] Delegated mention: ${sourceResponse.agentId} -> ${targetAgentId}`);

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

    const truncatedDescription = sourceResponse.rawContent
      .replace(/<@!?\d+>/g, '')
      .replace(/DELEGATE(?:_BG)?::[\w-]+::/g, '')
      .trim()
      .substring(0, 200);

    this.systemReminder.notify({
      type: 'delegation-started',
      taskId: '',
      description: truncatedDescription,
      agentId: targetAgentId,
      requestedBy: sourceResponse.agentId,
      channelId,
      timestamp: Date.now(),
    });

    const delegationContent = sourceResponse.rawContent
      .replace(/<@!?\d+>/g, '')
      .replace(/DELEGATE(?:_BG)?::[\w-]+::/g, '')
      .trim();

    try {
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
        undefined // Don't pass discordMessage -- emojis handled here via delegation messageId
      );

      if (response) {
        this.systemReminder.notify({
          type: 'delegation-completed',
          taskId: '',
          description: truncatedDescription,
          agentId: targetAgentId,
          requestedBy: sourceResponse.agentId,
          channelId,
          duration: response.duration,
          timestamp: Date.now(),
        });

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
      const isBusy = err instanceof Error && err.message.includes('Process is busy');
      if (isBusy) {
        logger.info(
          `[MultiAgent] ${targetAgentId} busy, enqueuing delegation from ${sourceResponse.agentId}`
        );
        this.messageQueue.enqueue(targetAgentId, {
          prompt: delegationContent,
          channelId,
          source: 'discord',
          enqueuedAt: Date.now(),
          context: { channelId, userId: originalMessage.author.id },
        });
        this.tryDrainNow(targetAgentId, 'discord', channelId).catch(() => {});
      } else {
        console.error(`[MultiAgent] Delegated mention error (${targetAgentId}):`, err);
      }
    } finally {
      // Add checkmark on the delegation message (source agent's response)
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
   * Execute text-based tool calls, routing discord_send through the agent's own bot.
   * Non-discord tools fall through to the base executeTextToolCalls.
   */
  private async executeAgentToolCalls(agentId: string, responseText: string): Promise<string> {
    const toolCalls = this.parseToolCallsFromText(responseText);
    if (toolCalls.length === 0) return responseText;

    const hasOwnBot = this.multiBotManager.hasAgentBot(agentId);

    for (const toolCall of toolCalls) {
      try {
        if (toolCall.name === 'discord_send' && hasOwnBot) {
          if (typeof toolCall.input !== 'object' || toolCall.input === null) {
            console.warn(`[MultiAgent] Tool ${toolCall.name}: invalid input (not an object)`);
            continue;
          }
          const input = toolCall.input as Record<string, unknown>;
          const channelId = typeof input.channel_id === 'string' ? input.channel_id : undefined;
          const filePath =
            typeof input.file_path === 'string'
              ? input.file_path
              : typeof input.image_path === 'string'
                ? input.image_path
                : undefined;
          const message = typeof input.message === 'string' ? input.message : undefined;

          if (!channelId || (!filePath && !message)) {
            console.warn(`[MultiAgent] Tool ${toolCall.name}: missing channel_id or payload`);
            continue;
          }

          if (channelId && filePath) {
            await this.multiBotManager.sendFileAsAgent(agentId, channelId, filePath, message);
          } else if (channelId && message) {
            await this.multiBotManager.sendAsAgent(agentId, channelId, message);
          }
          logger.info(`[MultiAgent] discord_send routed through agent bot: ${agentId}`);
        } else if (this.gatewayToolExecutor) {
          const result = await this.gatewayToolExecutor.execute(
            toolCall.name,
            toolCall.input as Record<string, unknown>
          );
          logger.info(
            `[MultiAgent] Tool ${toolCall.name} succeeded:`,
            JSON.stringify(result).substring(0, 200)
          );
        }
      } catch (error) {
        console.error(
          `[MultiAgent] Tool ${toolCall.name} failed:`,
          error instanceof Error ? error.message : error
        );
      }
    }

    return this.removeToolCallBlocks(responseText);
  }

  /**
   * Resolve @Name mentions in LLM response text to <@userId> Discord format.
   * LLMs generate plain text like "@LEAD", "@Conductor", "@DevBot" which won't
   * trigger Discord mentions or routeResponseMentions detection.
   */
  private resolveResponseMentions(text: string): string {
    if (!this.config.mention_delegation) return text;

    // Collect agent IDs already handled by DELEGATE:: / DELEGATE_BG:: patterns
    // to avoid duplicate delegation via mention resolution
    const delegatedAgentIds = new Set<string>();
    const delegateRegex = /DELEGATE(?:_BG)?::(\w+)::/g;
    let dm;
    while ((dm = delegateRegex.exec(text)) !== null) {
      delegatedAgentIds.add(dm[1].toLowerCase());
    }

    const botUserIdMap = this.multiBotManager.getBotUserIdMap();
    const mainBotUserId = this.multiBotManager.getMainBotUserId();
    const defaultAgentId = this.config.default_agent;

    // Build pattern -> <@userId> lookup
    const patterns = new Map<string, { mention: string; agentId: string }>();
    for (const [agentId, agentConfig] of Object.entries(this.config.agents)) {
      let userId = botUserIdMap.get(agentId);
      if (!userId && agentId === defaultAgentId && mainBotUserId) {
        userId = mainBotUserId;
      }
      if (!userId) continue;

      const mention = `<@${userId}>`;
      if (agentConfig.name) patterns.set(agentConfig.name.toLowerCase(), { mention, agentId });
      if (agentConfig.display_name)
        patterns.set(agentConfig.display_name.toLowerCase(), { mention, agentId });
      patterns.set(agentId.toLowerCase(), { mention, agentId });
    }
    // Also match "LEAD" for the default agent
    if (defaultAgentId && mainBotUserId) {
      patterns.set('lead', { mention: `<@${mainBotUserId}>`, agentId: defaultAgentId });
    }

    let resolved = text;
    for (const [pattern, { mention, agentId }] of patterns) {
      // Skip mention resolution for agents already in DELEGATE:: patterns
      if (delegatedAgentIds.has(agentId.toLowerCase())) continue;

      // Match @pattern but NOT already-resolved <@pattern
      const regex = new RegExp(`(?<!<)@${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      resolved = resolved.replace(regex, mention);
    }

    return resolved;
  }

  private getEffectiveMaxMentionDepth(): number {
    return this.config.max_mention_depth ?? 3;
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
}
