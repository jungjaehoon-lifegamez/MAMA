/**
 * Discord Gateway for MAMA Standalone
 *
 * Provides Discord bot integration for receiving and responding to messages.
 * Supports both DM and channel mentions with configurable filtering.
 */

import { Client, GatewayIntentBits, Partials, Message, Events, ChannelType } from 'discord.js';
import { MessageRouter } from './message-router.js';
import { splitForDiscord } from './message-splitter.js';
import { getMemoryLogger } from '../memory/memory-logger.js';
import { getChannelHistory, type HistoryEntry } from './channel-history.js';
import type {
  Gateway,
  GatewayEvent,
  GatewayEventHandler,
  NormalizedMessage,
  DiscordGatewayConfig,
  DiscordGuildConfig,
  DiscordChannelConfig,
  MessageAttachment,
  ContentBlock,
} from './types.js';

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
}

/**
 * Discord Gateway class
 *
 * Connects to Discord via bot token and routes messages
 * to the MessageRouter for processing.
 */
export class DiscordGateway implements Gateway {
  readonly source = 'discord' as const;

  private client: Client;
  private token: string;
  private messageRouter: MessageRouter;
  private config: DiscordGatewayConfig;
  private eventHandlers: GatewayEventHandler[] = [];
  private connected = false;

  // Message editing throttle state
  private lastEditTime = 0;
  private pendingEdit: string | null = null;
  private editTimer: NodeJS.Timeout | null = null;

  constructor(options: DiscordGatewayOptions) {
    this.token = options.token;
    this.messageRouter = options.messageRouter;
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
      ],
      partials: [Partials.Channel], // Required for DM support
    });

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
      this.emitEvent({
        type: 'connected',
        source: 'discord',
        timestamp: new Date(),
        data: { username: client.user.tag },
      });
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
    // Ignore bot messages
    if (message.author.bot) return;

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

    // Download attachments first (needed for both history and processing)
    const attachments: MessageAttachment[] = [];
    for (const [, attachment] of message.attachments) {
      if (attachment.contentType?.startsWith('image/')) {
        try {
          const localPath = await this.downloadAttachment(attachment.url, attachment.name);
          attachments.push({
            type: 'image',
            url: attachment.url,
            localPath,
            filename: attachment.name,
            contentType: attachment.contentType,
            size: attachment.size,
          });
        } catch (err) {
          console.error(`[Discord] Failed to download attachment: ${err}`);
        }
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

    // Remove mentions from message content
    const cleanContent = this.cleanMessageContent(message.content);

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

    if (!cleanContent.trim() && effectiveAttachments.length === 0) {
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

    // Build message history context for Claude (OpenClaw style)
    const historyContext = channelHistory.formatForContext(message.channel.id, message.id);
    if (historyContext) {
      console.log(
        `[Discord] Built historyContext (${historyContext.length} chars):`,
        historyContext.substring(0, 200)
      );
    } else {
      console.log(`[Discord] No historyContext - empty history`);
    }

    // Convert attachments to content blocks (OpenClaw-style)
    const contentBlocks: ContentBlock[] = await this.buildContentBlocks(effectiveAttachments);

    // Normalize message for router - ALL messages go to Claude
    const normalizedMessage: NormalizedMessage = {
      source: 'discord',
      channelId: message.channel.id,
      userId: message.author.id,
      text: cleanContent,
      contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
      metadata: {
        guildId: message.guild?.id,
        username: message.author.username,
        messageId: message.id,
        historyContext,
        attachments: effectiveAttachments.length > 0 ? effectiveAttachments : undefined,
      },
    };

    try {
      let response: string;
      let duration: number;

      const routerResult = await this.messageRouter.process(normalizedMessage);
      response = routerResult.response;
      duration = routerResult.duration;

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

      channelHistory.clearAttachments(message.channel.id);
      console.log(
        `[Discord] Cleared attachments after reply, kept text for conversation context: ${message.channel.id}`
      );
    } finally {
      clearInterval(typingInterval);
    }
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
  private cleanMessageContent(content: string): string {
    // Remove user mentions
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
   * Send response to Discord (handling length limits)
   */
  private async sendResponse(originalMessage: Message, response: string): Promise<void> {
    const chunks = splitForDiscord(response);

    const memoryLogger = getMemoryLogger();
    memoryLogger.logMessage('Discord', 'MAMA', response, true);

    for (let i = 0; i < chunks.length; i++) {
      let sentMessage: Message | undefined;

      if (i === 0) {
        sentMessage = await originalMessage.reply(chunks[i]);
      } else {
        if ('send' in originalMessage.channel) {
          sentMessage = await (
            originalMessage.channel as { send: (content: string) => Promise<Message> }
          ).send(chunks[i]);
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
   * Emit event to registered handlers
   */
  private emitEvent(event: GatewayEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.error('Error in gateway event handler:', error);
      }
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

  /**
   * Check if gateway is connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Register event handler
   */
  onEvent(handler: GatewayEventHandler): void {
    this.eventHandlers.push(handler);
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
      if (attachment.type === 'image' && attachment.localPath) {
        try {
          const fs = await import('fs/promises');
          let imageBuffer = await fs.readFile(attachment.localPath);
          const originalSize = imageBuffer.length;
          let wasCompressed = false;

          // Compress image if needed (Claude limit: ~5MB base64)
          // Higher quality for text recognition
          const MAX_RAW_SIZE = 5 * 1024 * 1024; // 5MB raw = ~6.7MB base64 (compressed JPEG is smaller)
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
            // Convert common types
            if (mediaType.startsWith('image/')) {
              mediaType = 'image/png'; // Default fallback
            } else {
              console.warn(`[Discord] Unsupported media type: ${mediaType}, skipping`);
              continue;
            }
          }

          contentBlocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: base64Data,
            },
          });

          console.log(
            `[Discord] Built content block for image: ${attachment.filename} (${base64Data.length} chars base64)`
          );
        } catch (err) {
          console.error(`[Discord] Failed to build content block: ${err}`);
        }
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
}
