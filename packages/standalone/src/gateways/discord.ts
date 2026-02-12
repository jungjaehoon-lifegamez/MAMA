/**
 * Discord Gateway for MAMA Standalone
 *
 * Provides Discord bot integration for receiving and responding to messages.
 * Supports both DM and channel mentions with configurable filtering.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  Message,
  Events,
  ChannelType,
  AttachmentBuilder,
} from 'discord.js';
import { existsSync } from 'node:fs';
import { splitForDiscord } from './message-splitter.js';
import { getMemoryLogger } from '../memory/memory-logger.js';
import { getChannelHistory, type HistoryEntry } from './channel-history.js';
import { BaseGateway } from './base-gateway.js';
import type {
  NormalizedMessage,
  DiscordGatewayConfig,
  DiscordGuildConfig,
  DiscordChannelConfig,
  MessageAttachment,
  ContentBlock,
} from './types.js';
import type { MessageRouter } from './message-router.js';
import type { MultiAgentConfig } from '../cli/config/types.js';
import { MultiAgentDiscordHandler } from '../multi-agent/multi-agent-discord.js';

/**
 * Discord Gateway options
 */
export interface DiscordGatewayOptions {
  /** Discord bot token */
  token: string;
  /** Message router for processing messages */
  messageRouter: MessageRouter;
  /** Gateway configuration */
  config?: Partial<DiscordGatewayConfig>;
  /** Multi-agent configuration (optional) */
  multiAgentConfig?: MultiAgentConfig;
}

/**
 * Discord Gateway class
 *
 * Connects to Discord via bot token and routes messages
 * to the MessageRouter for processing.
 */
export class DiscordGateway extends BaseGateway {
  readonly source = 'discord' as const;

  private client: Client;
  private token: string;
  private config: DiscordGatewayConfig;

  // Message editing throttle state
  private lastEditTime = 0;
  private pendingEdit: string | null = null;
  private editTimer: NodeJS.Timeout | null = null;

  // Multi-agent support
  private multiAgentHandler: MultiAgentDiscordHandler | null = null;

  protected get mentionPattern(): RegExp | null {
    return null; // Discord uses custom cleanMessageContent with multiple patterns
  }

  constructor(options: DiscordGatewayOptions) {
    super({ messageRouter: options.messageRouter });
    this.token = options.token;
    this.config = {
      enabled: true,
      token: options.token,
      guilds: options.config?.guilds || {},
    };

    // Create Discord client with required intents
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Channel], // Required for DM support
    });

    // Initialize multi-agent handler if configured
    if (options.multiAgentConfig?.enabled) {
      this.multiAgentHandler = new MultiAgentDiscordHandler(options.multiAgentConfig, {
        dangerouslySkipPermissions: options.multiAgentConfig.dangerouslySkipPermissions ?? false,
      });
      console.log('[Discord] Multi-agent mode enabled');
    }

    this.setupEventListeners();
  }

  /**
   * Set up Discord client event listeners
   */
  private setupEventListeners(): void {
    // Ready event
    this.client.once(Events.ClientReady, (client) => {
      console.log(`Discord bot logged in as ${client.user.tag}`);
      this.connected = true;

      // Set bot user ID and token for multi-agent handler, then initialize multi-bots
      if (this.multiAgentHandler) {
        this.multiAgentHandler.setBotUserId(client.user.id);
        this.multiAgentHandler.setMainBotToken(this.token);
        this.multiAgentHandler.setDiscordClient(client);
        // Initialize agent-specific bots (async, don't block)
        this.multiAgentHandler.initializeMultiBots().catch((err) => {
          console.error('[Discord] Failed to initialize multi-bots:', err);
          // Reset handler on failure to prevent isEnabled() returning true with broken state
          this.multiAgentHandler = null;
        });
      }

      this.emitEvent({
        type: 'connected',
        source: 'discord',
        timestamp: new Date(),
        data: { username: client.user.tag },
      });

      // Backfill channel names for existing sessions
      this.backfillChannelNames();
    });

    // Message event
    this.client.on(Events.MessageCreate, async (message) => {
      try {
        await this.handleMessage(message);
      } catch (error) {
        console.error('Error handling Discord message:', error);
        this.emitEvent({
          type: 'error',
          source: 'discord',
          timestamp: new Date(),
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    });

    // Disconnect event
    this.client.on(Events.ShardDisconnect, () => {
      this.connected = false;
      this.emitEvent({
        type: 'disconnected',
        source: 'discord',
        timestamp: new Date(),
      });
    });

    // Error event
    this.client.on(Events.Error, (error) => {
      console.error('Discord client error:', error);
      this.emitEvent({
        type: 'error',
        source: 'discord',
        timestamp: new Date(),
        error,
      });
    });
  }

  /**
   * Handle incoming Discord message
   */
  private async handleMessage(message: Message): Promise<void> {
    // 1. Classify - handle bot messages
    const classification = await this.classifyMessage(message);
    if (!classification) return; // bot message, already handled or ignored

    const isDM = message.channel.type === ChannelType.DM;
    const isMentioned = message.mentions.has(this.client.user!);

    // Debug logging
    console.log(
      `[Discord] Message received: "${message.content.substring(0, 50)}..." from ${message.author.tag}`
    );
    console.log(
      `[Discord] isDM: ${isDM}, isMentioned: ${isMentioned}, channelId: ${message.channel.id}`
    );

    // Log incoming message
    const memoryLogger = getMemoryLogger();
    memoryLogger.logMessage('Discord', message.author.tag, message.content, false);

    const cleanContent = this.cleanMessageContent(message.content);

    // 2. Collect attachments + history
    const attachmentInfo = await this.collectAttachments(message, cleanContent);

    // Check if we should respond to this message
    if (!this.shouldRespond(message, isDM, isMentioned)) {
      console.log('[Discord] Skipping - shouldRespond returned false');
      return;
    }

    // Emit message received event
    this.emitEvent({
      type: 'message_received',
      source: 'discord',
      timestamp: new Date(),
      data: {
        channelId: message.channel.id,
        userId: message.author.id,
        isDM,
        isMentioned,
      },
    });

    if (!cleanContent.trim() && attachmentInfo.effectiveAttachments.length === 0) {
      return; // Don't process empty messages without attachments
    }

    // Start typing indicator
    const typingInterval = setInterval(() => {
      if ('sendTyping' in message.channel) {
        (message.channel as { sendTyping: () => Promise<void> }).sendTyping().catch(() => {});
      }
    }, 5000);
    if ('sendTyping' in message.channel) {
      await (message.channel as { sendTyping: () => Promise<void> }).sendTyping();
    }

    // Add eyes emoji to indicate processing
    try {
      await message.react('👀');
    } catch (err) {
      console.warn(
        '[Discord] Failed to add reaction emoji:',
        err instanceof Error ? err.message : err
      );
    }

    // Build message history context for Claude (OpenClaw style)
    const channelHistory = getChannelHistory();
    const historyContext = channelHistory.formatForContext(message.channel.id, message.id);
    if (historyContext) {
      console.log(
        `[Discord] Built historyContext (${historyContext.length} chars):`,
        historyContext.substring(0, 200)
      );
    } else {
      console.log(`[Discord] No historyContext - empty history`);
    }

    // Get channel name for session display
    const channelName = this.getChannelDisplayName(message);

    // Normalize message for router - ALL messages go to Claude
    const normalizedMessage: NormalizedMessage = {
      source: 'discord',
      channelId: message.channel.id,
      channelName,
      userId: message.author.id,
      text: cleanContent,
      contentBlocks:
        attachmentInfo.contentBlocks.length > 0 ? attachmentInfo.contentBlocks : undefined,
      metadata: {
        guildId: message.guild?.id,
        username: message.author.username,
        messageId: message.id,
        historyContext,
        attachments:
          attachmentInfo.effectiveAttachments.length > 0
            ? attachmentInfo.effectiveAttachments
            : undefined,
      },
    };

    // 3. Dispatch to agent
    let processingSuccess = false;
    try {
      await this.dispatchToAgent(message, cleanContent, normalizedMessage, attachmentInfo);
      processingSuccess = true;
    } catch (error) {
      console.error('[Discord] Message processing failed:', error);
      processingSuccess = false;
      throw error;
    } finally {
      clearInterval(typingInterval);
      // Add conditional reaction based on processing success
      try {
        await message.react(processingSuccess ? '✅' : '❌');
      } catch {
        /* ignore reaction errors */
      }
    }
  }

  /**
   * Classify message type and handle multi-agent bot messages.
   * Returns null if the message was fully handled (bot-to-bot routing)
   * or should be ignored, or classification info for further processing.
   */
  private async classifyMessage(message: Message): Promise<{
    handled: boolean;
    isBot: boolean;
  } | null> {
    // Multi-agent mode: detect messages from our agent bots
    if (message.author.bot && this.multiAgentHandler) {
      const agentBotId = this.multiAgentHandler.getMultiBotManager().isFromAgentBot(message);
      if (agentBotId && agentBotId !== 'main') {
        // This is from one of our agent bots - record to shared context
        const agentId =
          this.multiAgentHandler.getOrchestrator().extractAgentIdFromMessage(message.content) ||
          agentBotId;
        const agent = this.multiAgentHandler.getOrchestrator().getAgent(agentId);
        if (agent) {
          this.multiAgentHandler
            .getSharedContext()
            .recordAgentMessage(message.channel.id, agent, message.content, message.id);
        }

        if (this.multiAgentHandler.isMentionDelegationEnabled()) {
          if (this.client.user && message.mentions.has(this.client.user)) {
            // Main bot (LEAD) isn't in MultiBotManager — route via delegation chain
            const senderAgent = this.multiAgentHandler.getOrchestrator().getAgent(agentBotId);
            if (senderAgent) {
              await this.multiAgentHandler.routeResponseMentions(message, [
                {
                  agentId: agentBotId,
                  agent: senderAgent,
                  content: message.content,
                  rawContent: message.content,
                  duration: 0,
                },
              ]);
            }
          }
          return null;
        }

        // Fallback: pass to multi-agent handler for cross-agent conversation
        const cleanContent = this.cleanMessageContent(message.content);
        const multiAgentResult = await this.multiAgentHandler.handleMessage(message, cleanContent);
        if (multiAgentResult && multiAgentResult.responses.length > 0) {
          await this.multiAgentHandler.sendAgentResponses(message, multiAgentResult.responses);
          console.log(
            `[Discord] Agent-to-agent: ${agentBotId} → ${multiAgentResult.selectedAgents.join(', ')}`
          );
        }
        return null;
      }
      // Message from main bot - record to shared context
      if (agentBotId === 'main' || message.author.id === this.client.user?.id) {
        const agentId = this.multiAgentHandler
          .getOrchestrator()
          .extractAgentIdFromMessage(message.content);
        if (agentId) {
          const agent = this.multiAgentHandler.getOrchestrator().getAgent(agentId);
          if (agent) {
            this.multiAgentHandler
              .getSharedContext()
              .recordAgentMessage(message.channel.id, agent, message.content, message.id);
          }
          // When mention_delegation is enabled, routeResponseMentions already handles
          // delegation from LEAD's responses — skip to avoid duplicate processing
          if (!this.multiAgentHandler.isMentionDelegationEnabled()) {
            const cleanContent = this.cleanMessageContent(message.content);
            const multiAgentResult = await this.multiAgentHandler.handleMessage(
              message,
              cleanContent
            );
            if (multiAgentResult && multiAgentResult.responses.length > 0) {
              await this.multiAgentHandler.sendAgentResponses(message, multiAgentResult.responses);
              console.log(
                `[Discord] Agent-to-agent (main): ${agentId} → ${multiAgentResult.selectedAgents.join(', ')}`
              );
            }
          }
        }
        return null;
      }
    }

    // Ignore other bot messages (not part of our multi-agent system)
    if (message.author.bot) return null;

    return { handled: false, isBot: false };
  }

  /**
   * Collect attachments from message, record to history, and resolve effective attachments.
   */
  private async collectAttachments(
    message: Message,
    cleanContent: string
  ): Promise<{
    attachments: MessageAttachment[];
    effectiveAttachments: MessageAttachment[];
    contentBlocks: ContentBlock[];
  }> {
    // Download all attachments (images, documents, etc.)
    const attachments: MessageAttachment[] = [];
    for (const [, attachment] of message.attachments) {
      try {
        const localPath = await this.downloadAttachment(attachment.url, attachment.name);
        const isImage = attachment.contentType?.startsWith('image/');
        attachments.push({
          type: isImage ? 'image' : 'file',
          url: attachment.url,
          localPath,
          filename: attachment.name,
          contentType: attachment.contentType || 'application/octet-stream',
          size: attachment.size,
        });
        console.log(
          `[Discord] Downloaded ${isImage ? 'image' : 'file'}: ${attachment.name} -> ${localPath}`
        );
      } catch (err) {
        console.error(`[Discord] Failed to download attachment: ${err}`);
      }
    }

    // Record to channel history (always, for context)
    const channelHistory = getChannelHistory();
    const historyEntry: HistoryEntry = {
      messageId: message.id,
      sender: message.author.username,
      userId: message.author.id,
      body: this.cleanMessageContent(message.content),
      timestamp: Date.now(),
      attachments: attachments.length > 0 ? attachments : undefined,
      isBot: false,
    };
    channelHistory.record(message.channel.id, historyEntry);
    console.log(
      `[Discord] Recorded to history: ${message.channel.id} (${channelHistory.getHistory(message.channel.id).length} entries)`
    );

    // Get attachments from history if current message has none
    // Only reuse attachments if message contains action keywords (번역, 분석, translate, etc.)
    let effectiveAttachments = attachments;
    if (attachments.length === 0) {
      const lowerContent = cleanContent.toLowerCase();

      const isMetaQuestion =
        lowerContent.includes('품질') ||
        lowerContent.includes('어때') ||
        lowerContent.includes('어떤가') ||
        lowerContent.includes('어떻') ||
        lowerContent.includes('결과') ||
        lowerContent.includes('quality') ||
        lowerContent.includes('how') ||
        lowerContent.includes('result') ||
        lowerContent.includes('어떠') ||
        lowerContent.match(/어때[?？]/) ||
        lowerContent.match(/어떤가[?？]/);

      const hasActionKeyword =
        lowerContent.includes('번역') ||
        lowerContent.includes('translate') ||
        lowerContent.includes('분석') ||
        lowerContent.includes('analyze') ||
        lowerContent.includes('읽어') ||
        lowerContent.includes('read') ||
        lowerContent.includes('뭐라') ||
        lowerContent.includes('무슨말');

      if (hasActionKeyword && !isMetaQuestion) {
        const historyAttachments = channelHistory.getRecentAttachments(
          message.channel.id,
          message.author.id
        );
        if (historyAttachments.length > 0) {
          effectiveAttachments = historyAttachments;
          console.log(
            `[Discord] Using ${historyAttachments.length} attachments from history (action keyword detected)`
          );
        }
      } else if (hasActionKeyword && isMetaQuestion) {
        console.log(
          `[Discord] Action keyword found but meta question detected - NOT reusing attachments`
        );
      }
    }

    // Convert attachments to content blocks (OpenClaw-style)
    const contentBlocks: ContentBlock[] = await this.buildContentBlocks(effectiveAttachments);

    return { attachments, effectiveAttachments, contentBlocks };
  }

  /**
   * Dispatch message to multi-agent or single-agent processing.
   */
  private async dispatchToAgent(
    message: Message,
    cleanContent: string,
    normalizedMessage: NormalizedMessage,
    _attachmentInfo: { effectiveAttachments: MessageAttachment[] }
  ): Promise<void> {
    const channelHistory = getChannelHistory();

    // Pre-analyze images before routing (multi-agent handler only gets text)
    let enrichedContent = cleanContent;
    if (normalizedMessage.contentBlocks?.some((b) => b.type === 'image')) {
      const { getImageAnalyzer } = await import('./image-analyzer.js');
      const analysisText = await getImageAnalyzer().processContentBlocks(
        normalizedMessage.contentBlocks
      );
      if (analysisText) {
        enrichedContent = `${cleanContent}\n\n${analysisText}`;
      }
    }

    // Check if multi-agent mode should handle this message
    if (this.multiAgentHandler?.isEnabled()) {
      const multiAgentResult = await this.multiAgentHandler.handleMessage(message, enrichedContent);

      if (multiAgentResult && multiAgentResult.responses.length > 0) {
        // Multi-agent handled the message
        const sentMessages = await this.multiAgentHandler.sendAgentResponses(
          message,
          multiAgentResult.responses
        );

        // Record bot responses to history with correct agent attribution.
        // sentMessages is a flat array of chunks; track offset per response.
        let msgIndex = 0;
        for (const agentResp of multiAgentResult.responses) {
          const chunkCount = splitForDiscord(agentResp.content).length;
          for (let c = 0; c < chunkCount && msgIndex < sentMessages.length; c++) {
            const sentMsg = sentMessages[msgIndex++];
            channelHistory.record(message.channel.id, {
              messageId: sentMsg.id,
              sender: agentResp.agent.display_name || this.client.user?.username || 'MAMA',
              userId: agentResp.agentId || this.client.user?.id || '',
              body: sentMsg.content,
              timestamp: Date.now(),
              isBot: true,
            });
          }
        }

        this.emitEvent({
          type: 'message_sent',
          source: 'discord',
          timestamp: new Date(),
          data: {
            channelId: message.channel.id,
            responseLength: multiAgentResult.responses.reduce(
              (sum, r) => sum + r.content.length,
              0
            ),
            multiAgent: true,
            agents: multiAgentResult.selectedAgents,
          },
        });

        // Route delegation mentions from agent responses
        if (this.multiAgentHandler.isMentionDelegationEnabled()) {
          await this.multiAgentHandler.routeResponseMentions(message, multiAgentResult.responses);
        }

        console.log(
          `[Discord] Multi-agent responded: ${multiAgentResult.selectedAgents.join(', ')}`
        );
      }
      // Multi-agent mode owns routing — never fall through to message-router.
      // If null, the message was either queued (busy), blocked, or had no match.
      // Falling through would create duplicate responses from a second CLI process.
      return;
    }

    // Regular single-agent processing
    // Pass enriched content (images already analyzed above) to avoid double analysis
    if (enrichedContent !== cleanContent) {
      normalizedMessage.text = enrichedContent;
      normalizedMessage.contentBlocks = undefined;
    }
    const routerResult = await this.messageRouter.process(normalizedMessage);
    const response = routerResult.response;
    const duration = routerResult.duration;

    await this.sendResponse(message, response);

    this.emitEvent({
      type: 'message_sent',
      source: 'discord',
      timestamp: new Date(),
      data: {
        channelId: message.channel.id,
        responseLength: response.length,
        duration,
      },
    });

    // Keep attachments in history for reference in subsequent turns
    // (localPath allows "that image" references to work)
    console.log(`[Discord] Kept attachments for future reference: ${message.channel.id}`);
  }

  /**
   * Check if bot should respond to this message
   */
  private shouldRespond(message: Message, isDM: boolean, isMentioned: boolean): boolean {
    // Always respond to DMs
    if (isDM) return true;

    // For guild messages, check configuration
    const guildId = message.guild?.id;
    const channelId = message.channel.id;

    console.log(`[Discord] shouldRespond check - guildId: ${guildId}, channelId: ${channelId}`);
    console.log(`[Discord] guilds config:`, JSON.stringify(this.config.guilds, null, 2));

    if (!guildId) return false;

    // Get guild config (or wildcard config)
    const guildConfig = this.config.guilds?.[guildId] || this.config.guilds?.['*'];
    console.log(`[Discord] guildConfig:`, JSON.stringify(guildConfig, null, 2));

    if (!guildConfig) {
      // No config for this guild, only respond to mentions
      return isMentioned;
    }

    // Get channel config
    const channelConfig = guildConfig.channels?.[channelId];

    if (channelConfig) {
      // Channel-specific config
      if (channelConfig.requireMention === false) {
        return true; // No mention required for this channel
      }
      return isMentioned;
    }

    // Use guild default
    if (guildConfig.requireMention === false) {
      return true;
    }

    return isMentioned;
  }

  /**
   * Clean message content (remove mentions)
   */
  protected override cleanMessageContent(content: string): string {
    return content
      .replace(/<@!?\d+>/g, '')
      .replace(/<@&\d+>/g, '') // Role mentions
      .trim();
  }

  /**
   * Edit message with 150ms throttle to respect Discord rate limits
   */
  async editMessageThrottled(message: Message, content: string): Promise<void> {
    this.pendingEdit = content;

    const now = Date.now();
    const timeSinceLastEdit = now - this.lastEditTime;

    if (timeSinceLastEdit >= 150) {
      await this.flushEdit(message);
    } else if (!this.editTimer) {
      const delay = 150 - timeSinceLastEdit;
      this.editTimer = setTimeout(() => this.flushEdit(message), delay);
    }
  }

  /**
   * Flush pending edit to Discord
   */
  private async flushEdit(message: Message): Promise<void> {
    if (!this.pendingEdit) return;
    await message.edit(this.pendingEdit);
    this.lastEditTime = Date.now();
    this.pendingEdit = null;
    this.editTimer = null;
  }

  /**
   * Send response to Discord (handling length limits and file attachments)
   */
  private async sendResponse(originalMessage: Message, response: string): Promise<void> {
    const memoryLogger = getMemoryLogger();
    memoryLogger.logMessage('Discord', 'MAMA', response, true);

    // Extract file paths from response (outbound files to send)
    const filePathPattern =
      /(?:파일 위치|파일 경로|File|Path|saved at|저장됨):\s*\**([/~][^\s\n*]+)/gi;
    const outboundPattern = /\/home\/[^/]+\/\.mama\/workspace\/media\/outbound\/[^\s\n*]+/g;

    const filePaths: string[] = [];
    let match;

    // Helper to clean markdown/punctuation from file paths
    const cleanPath = (p: string) =>
      p.replace(/[*`[\]()]+$/g, '').replace(/^~/, process.env.HOME || '');

    // Find explicit file location markers
    while ((match = filePathPattern.exec(response)) !== null) {
      const filePath = cleanPath(match[1]);
      if (existsSync(filePath)) {
        filePaths.push(filePath);
        console.log(`[Discord] Found file via marker: ${filePath}`);
      }
    }

    // Find outbound media files
    while ((match = outboundPattern.exec(response)) !== null) {
      const filePath = cleanPath(match[0]);
      if (existsSync(filePath) && !filePaths.includes(filePath)) {
        filePaths.push(filePath);
        console.log(`[Discord] Found outbound file: ${filePath}`);
      }
    }

    // Build attachments
    const attachments = filePaths.map((fp) => new AttachmentBuilder(fp));

    if (attachments.length > 0) {
      console.log(`[Discord] Attaching ${attachments.length} file(s): ${filePaths.join(', ')}`);
    }

    const chunks = splitForDiscord(response);

    for (let i = 0; i < chunks.length; i++) {
      let sentMessage: Message | undefined;

      // Attach files to the first message only
      const messageOptions =
        i === 0 && attachments.length > 0
          ? { content: chunks[i], files: attachments }
          : { content: chunks[i] };

      if (i === 0) {
        sentMessage = await originalMessage.reply(messageOptions);
      } else {
        if ('send' in originalMessage.channel) {
          sentMessage = await (
            originalMessage.channel as {
              send: (options: { content: string; files?: AttachmentBuilder[] }) => Promise<Message>;
            }
          ).send(messageOptions);
        }
      }

      if (sentMessage && this.client.user) {
        const history = getChannelHistory();
        history.record(originalMessage.channel.id, {
          messageId: sentMessage.id,
          sender: this.client.user.username,
          userId: this.client.user.id,
          body: chunks[i],
          timestamp: Date.now(),
          isBot: true,
        });
      }
    }
  }

  /**
   * Get human-readable channel name for session display
   */
  private getChannelDisplayName(message: Message): string {
    const channel = message.channel;

    // DM channel
    if (channel.isDMBased()) {
      const recipient = message.author.username;
      return `DM with ${recipient}`;
    }

    // Guild channel - try to get the name
    if ('name' in channel && channel.name) {
      const guildName = message.guild?.name;
      return guildName ? `#${channel.name} (${guildName})` : `#${channel.name}`;
    }

    // Fallback to channel ID
    return `Channel ${channel.id}`;
  }

  /**
   * Backfill channel names for existing sessions when Discord connects
   * This updates sessions created before the channel_name feature was added
   */
  private backfillChannelNames(): void {
    try {
      // Get all Discord sessions
      const sessions = this.messageRouter.listSessions('discord');
      let updated = 0;

      for (const session of sessions) {
        // Skip if already has a channel name
        if (session.channelName) continue;

        // Try to find the channel in the client cache
        const channel = this.client.channels.cache.get(session.channelId);
        if (!channel) continue;

        let channelName: string;

        // DM channel
        if (channel.isDMBased()) {
          channelName = 'DM';
        } else if ('name' in channel && channel.name) {
          // Guild channel
          const guild =
            'guild' in channel ? (channel as { guild?: { name: string } }).guild : undefined;
          channelName = guild ? `#${channel.name} (${guild.name})` : `#${channel.name}`;
        } else {
          continue; // Can't determine name
        }

        // Update session with channel name
        if (this.messageRouter.updateChannelName('discord', session.channelId, channelName)) {
          updated++;
        }
      }

      if (updated > 0) {
        console.log(`[Discord] Backfilled ${updated} channel names`);
      }
    } catch (error) {
      console.error('[Discord] Failed to backfill channel names:', error);
    }
  }

  // ============================================================================
  // Gateway Interface Implementation
  // ============================================================================

  /**
   * Start the Discord gateway
   */
  async start(): Promise<void> {
    if (this.connected) {
      console.log('Discord gateway already connected');
      return;
    }

    await this.client.login(this.token);
  }

  /**
   * Stop the Discord gateway
   */
  async stop(): Promise<void> {
    // Stop multi-agent processes (don't let failure block shutdown)
    if (this.multiAgentHandler) {
      try {
        await this.multiAgentHandler.stopAll();
      } catch (err) {
        console.error('[Discord] Error stopping multi-agent handler:', err);
        // Continue with shutdown anyway
      }
    }

    if (!this.connected) {
      return;
    }

    await this.client.destroy();
    this.connected = false;

    this.emitEvent({
      type: 'disconnected',
      source: 'discord',
      timestamp: new Date(),
    });
  }

  // ============================================================================
  // Configuration
  // ============================================================================

  /**
   * Update gateway configuration
   */
  setConfig(config: Partial<DiscordGatewayConfig>): void {
    if (config.guilds) {
      this.config.guilds = { ...this.config.guilds, ...config.guilds };
    }
    if (config.enabled !== undefined) {
      this.config.enabled = config.enabled;
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): DiscordGatewayConfig {
    return { ...this.config };
  }

  /**
   * Add guild configuration
   */
  addGuildConfig(guildId: string, config: DiscordGuildConfig): void {
    this.config.guilds = this.config.guilds || {};
    this.config.guilds[guildId] = config;
  }

  /**
   * Add channel configuration
   */
  addChannelConfig(guildId: string, channelId: string, config: DiscordChannelConfig): void {
    this.config.guilds = this.config.guilds || {};
    if (!this.config.guilds[guildId]) {
      this.config.guilds[guildId] = { channels: {} };
    }
    this.config.guilds[guildId].channels = this.config.guilds[guildId].channels || {};
    this.config.guilds[guildId].channels[channelId] = config;
  }

  /**
   * Send a message to a specific channel
   */
  async sendMessage(channelId: string, content: string): Promise<void> {
    if (!this.connected) {
      throw new Error('Discord gateway not connected');
    }

    const channel = await this.client.channels.fetch(channelId);
    if (!channel) {
      throw new Error(`Channel not found: ${channelId}`);
    }

    if (!('send' in channel)) {
      throw new Error(`Channel ${channelId} is not a text channel`);
    }

    const chunks = splitForDiscord(content);
    for (const chunk of chunks) {
      await (channel as { send: (content: string) => Promise<unknown> }).send(chunk);
    }
  }

  /**
   * Download attachment to local file
   */
  private async downloadAttachment(url: string, filename: string): Promise<string> {
    const fs = await import('fs/promises');
    const path = await import('path');

    // Create media directory
    const mediaDir = path.join(process.env.HOME || '', '.mama', 'workspace', 'media', 'inbound');
    await fs.mkdir(mediaDir, { recursive: true });

    // Generate unique filename
    const timestamp = Date.now();
    const localPath = path.join(
      mediaDir,
      `${timestamp}-${filename.replace(/[^a-zA-Z0-9.-]/g, '_')}`
    );

    // Download file
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(localPath, buffer);

    console.log(`[Discord] Downloaded attachment: ${localPath} (${buffer.length} bytes)`);
    return localPath;
  }

  private async compressImage(buffer: Buffer, maxSizeBytes: number): Promise<Buffer> {
    try {
      const sharp = (await import('sharp')).default;

      let compressed = await sharp(buffer)
        .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();

      if (compressed.length > maxSizeBytes) {
        compressed = await sharp(buffer)
          .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 75 })
          .toBuffer();
      }

      if (compressed.length > maxSizeBytes) {
        compressed = await sharp(buffer)
          .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 70 })
          .toBuffer();
      }

      return compressed;
    } catch (err) {
      console.warn(`[Discord] sharp not available, cannot compress: ${err}`);
      return buffer;
    }
  }

  /**
   * Build content blocks from attachments (OpenClaw-style)
   * Converts images to base64-encoded content blocks for Claude
   */
  private async buildContentBlocks(attachments: MessageAttachment[]): Promise<ContentBlock[]> {
    const contentBlocks: ContentBlock[] = [];

    // Supported Claude image types
    const SUPPORTED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

    for (const attachment of attachments) {
      if (!attachment.localPath) continue;

      try {
        if (attachment.type === 'image') {
          // Handle images: add path info + base64 content
          const fs = await import('fs/promises');
          let imageBuffer = await fs.readFile(attachment.localPath);
          const originalSize = imageBuffer.length;
          let wasCompressed = false;

          // Compress image if needed (Claude limit: ~5MB base64)
          const MAX_RAW_SIZE = 5 * 1024 * 1024;
          if (imageBuffer.length > MAX_RAW_SIZE) {
            console.log(
              `[Discord] Image too large (${(originalSize / 1024 / 1024).toFixed(2)}MB), compressing...`
            );
            const compressed = await this.compressImage(imageBuffer, MAX_RAW_SIZE);
            imageBuffer = Buffer.from(compressed);
            wasCompressed = true;
            console.log(
              `[Discord] Compressed to ${(imageBuffer.length / 1024 / 1024).toFixed(2)}MB`
            );
          }

          const base64Data = imageBuffer.toString('base64');
          let mediaType = wasCompressed ? 'image/jpeg' : attachment.contentType || 'image/png';

          // Normalize media type to Claude-supported format
          if (!SUPPORTED_MEDIA_TYPES.includes(mediaType)) {
            if (mediaType.startsWith('image/')) {
              mediaType = 'image/png';
            } else {
              console.warn(`[Discord] Unsupported media type: ${mediaType}, skipping`);
              continue;
            }
          }

          // Add image path info as text block
          contentBlocks.push({
            type: 'text',
            text: `[Image: ${attachment.filename}, saved at: ${attachment.localPath}]`,
          });

          contentBlocks.push({
            type: 'image',
            localPath: attachment.localPath, // For formatHistoryAsPrompt()
            source: {
              type: 'base64',
              media_type: mediaType,
              data: base64Data,
            },
          });

          console.log(
            `[Discord] Built content block for image: ${attachment.filename} at ${attachment.localPath}`
          );
        } else {
          // Handle files: add path info only (Claude can read files via tools)
          contentBlocks.push({
            type: 'text',
            text: `[File: ${attachment.filename}, type: ${attachment.contentType}, saved at: ${attachment.localPath}]`,
          });

          console.log(
            `[Discord] Added file reference: ${attachment.filename} at ${attachment.localPath}`
          );
        }
      } catch (err) {
        console.error(`[Discord] Failed to build content block: ${err}`);
      }
    }

    return contentBlocks;
  }

  /**
   * Send a file (image, document, etc.) to a specific channel
   */
  async sendFile(channelId: string, filePath: string, caption?: string): Promise<void> {
    if (!this.connected) {
      throw new Error('Discord gateway not connected');
    }

    const channel = await this.client.channels.fetch(channelId);
    if (!channel) {
      throw new Error(`Channel not found: ${channelId}`);
    }

    if (!('send' in channel)) {
      throw new Error(`Channel ${channelId} is not a text channel`);
    }

    const sendFn = (
      channel as { send: (options: { content?: string; files: string[] }) => Promise<unknown> }
    ).send.bind(channel);
    await sendFn({
      content: caption,
      files: [filePath],
    });
  }

  /**
   * Send an image file to a specific channel (alias for sendFile)
   * @deprecated Use sendFile instead
   */
  async sendImage(channelId: string, imagePath: string, caption?: string): Promise<void> {
    return this.sendFile(channelId, imagePath, caption);
  }

  /**
   * Get the multi-agent handler (if enabled)
   */
  getMultiAgentHandler(): MultiAgentDiscordHandler | null {
    return this.multiAgentHandler;
  }

  /**
   * Update multi-agent configuration
   */
  async setMultiAgentConfig(config: MultiAgentConfig): Promise<void> {
    if (config.enabled) {
      if (this.multiAgentHandler) {
        this.multiAgentHandler.updateConfig(config);
      } else {
        this.multiAgentHandler = new MultiAgentDiscordHandler(config, {
          dangerouslySkipPermissions: config.dangerouslySkipPermissions ?? false,
        });
        if (this.client.user) {
          this.multiAgentHandler.setBotUserId(this.client.user.id);
          this.multiAgentHandler.setMainBotToken(this.token);
          await this.multiAgentHandler.initializeMultiBots();
        }
      }
      console.log('[Discord] Multi-agent mode enabled/updated');
    } else {
      if (this.multiAgentHandler) {
        await this.multiAgentHandler.stopAll();
        this.multiAgentHandler = null;
      }
      console.log('[Discord] Multi-agent mode disabled');
    }
  }
}
