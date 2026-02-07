/**
 * Slack Gateway for MAMA Standalone
 *
 * Provides Slack integration using Socket Mode for receiving and responding to messages.
 * Supports both DM and channel mentions with thread context preservation.
 */

import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import { MessageRouter } from './message-router.js';
import { splitForSlack } from './message-splitter.js';
import type {
  Gateway,
  GatewayEvent,
  GatewayEventHandler,
  NormalizedMessage,
  SlackGatewayConfig,
  SlackChannelConfig,
} from './types.js';
import type { MultiAgentConfig } from '../cli/config/types.js';
import { MultiAgentSlackHandler } from '../multi-agent/multi-agent-slack.js';
import { getChannelHistory } from './channel-history.js';
import { createSafeLogger } from '../utils/log-sanitizer.js';

/**
 * Slack message event structure
 */
interface SlackMessageEvent {
  type: string;
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
  channel_type?: string;
}

/**
 * Slack Gateway options
 */
export interface SlackGatewayOptions {
  /** Slack bot token (xoxb-...) */
  botToken: string;
  /** Slack app token for Socket Mode (xapp-...) */
  appToken: string;
  /** Message router for processing messages */
  messageRouter: MessageRouter;
  /** Gateway configuration */
  config?: Partial<SlackGatewayConfig>;
  /** Multi-agent configuration (optional) */
  multiAgentConfig?: MultiAgentConfig;
}

/**
 * Slack Gateway class
 *
 * Connects to Slack via Socket Mode and routes messages
 * to the MessageRouter for processing.
 */
export class SlackGateway implements Gateway {
  readonly source = 'slack' as const;

  private socketClient: SocketModeClient;
  private webClient: WebClient;
  private messageRouter: MessageRouter;
  private config: SlackGatewayConfig;
  private eventHandlers: GatewayEventHandler[] = [];
  private connected = false;

  // Multi-agent support
  private multiAgentHandler: MultiAgentSlackHandler | null = null;
  private botToken: string;

  // Safe logger instance
  private logger = createSafeLogger('SlackGateway');

  constructor(options: SlackGatewayOptions) {
    this.messageRouter = options.messageRouter;
    this.botToken = options.botToken;
    this.config = {
      enabled: true,
      botToken: options.botToken,
      appToken: options.appToken,
      channels: options.config?.channels || {},
    };

    // Create Socket Mode client for real-time events
    this.socketClient = new SocketModeClient({
      appToken: options.appToken,
      serverPingTimeout: 30000,
      clientPingTimeout: 30000,
    });

    // Create Web client for API calls
    this.webClient = new WebClient(options.botToken);

    // Initialize multi-agent handler if configured
    if (options.multiAgentConfig?.enabled) {
      this.multiAgentHandler = new MultiAgentSlackHandler(options.multiAgentConfig, {
        // Headless daemon — no interactive permission prompts possible
        dangerouslySkipPermissions: options.multiAgentConfig.dangerouslySkipPermissions ?? true,
      });
      this.logger.log('Multi-agent mode enabled');
    }

    this.setupEventListeners();
  }

  /**
   * Set up Socket Mode event listeners
   */
  private setupEventListeners(): void {
    // Connection events
    this.socketClient.on('connected', async () => {
      this.logger.log('Gateway connected via Socket Mode');
      this.connected = true;

      // Get bot identity and initialize multi-agent bots
      if (this.multiAgentHandler) {
        try {
          const authResult = await this.webClient.auth.test();
          const userId = authResult.user_id as string;
          const botId = authResult.bot_id as string;
          this.multiAgentHandler.setBotUserId(userId);
          this.multiAgentHandler.setMainBotId(botId);
          this.multiAgentHandler.setMainBotToken(this.botToken);
          this.multiAgentHandler.setMainWebClient(this.webClient);
          // Initialize agent-specific bots (async, don't block)
          this.multiAgentHandler.initializeMultiBots().catch((err) => {
            this.logger.error('Failed to initialize multi-bots:', err);
          });
        } catch (err) {
          this.logger.error('auth.test failed:', err);
        }
      }

      this.emitEvent({
        type: 'connected',
        source: 'slack',
        timestamp: new Date(),
      });
    });

    this.socketClient.on('disconnected', () => {
      this.connected = false;
      this.emitEvent({
        type: 'disconnected',
        source: 'slack',
        timestamp: new Date(),
      });
    });

    // Direct message events
    this.socketClient.on('message', async ({ event, ack }) => {
      try {
        await ack();
        await this.handleMessage(event as SlackMessageEvent, false);
      } catch (error) {
        this.logger.error('Error handling Slack message:', error);
        this.emitEvent({
          type: 'error',
          source: 'slack',
          timestamp: new Date(),
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    });

    // App mention events (when @bot is mentioned in a channel)
    this.socketClient.on('app_mention', async ({ event, ack }) => {
      try {
        await ack();
        await this.handleMessage(event as SlackMessageEvent, true);
      } catch (error) {
        this.logger.error('Error handling Slack mention:', error);
        this.emitEvent({
          type: 'error',
          source: 'slack',
          timestamp: new Date(),
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    });
  }

  /**
   * Handle incoming Slack message
   */
  private async handleMessage(event: SlackMessageEvent, isMention: boolean): Promise<void> {
    // Record ALL messages to channel history (for conversation context)
    const channelHistory = getChannelHistory();
    const senderName = event.bot_id ? (event.bot_id === 'auto-route' ? 'Agent' : 'Bot') : 'User';
    channelHistory.record(event.channel, {
      messageId: event.ts,
      sender: senderName,
      userId: event.user || event.bot_id || '',
      body: event.text || '',
      timestamp: parseFloat(event.ts) * 1000,
      isBot: !!event.bot_id,
    });

    // Multi-agent mode: detect messages from our bots (main or agent)
    if (event.bot_id && this.multiAgentHandler) {
      const multiBotManager = this.multiAgentHandler.getMultiBotManager();
      const agentBotId = multiBotManager.isFromAgentBot(event.bot_id);

      if (agentBotId) {
        // Message from one of our bots (main or agent)

        // Update history entry with agent display name
        const agentForHistory = this.multiAgentHandler
          .getOrchestrator()
          .getAgent(
            agentBotId === 'main' ? (multiBotManager.getMainBotAgentId() ?? agentBotId) : agentBotId
          );
        if (agentForHistory) {
          channelHistory.updateSender(event.channel, event.ts, agentForHistory.display_name);
        }

        // Record to shared context (non-main agent bots)
        if (agentBotId !== 'main') {
          const agent = this.multiAgentHandler.getOrchestrator().getAgent(agentBotId);
          if (agent) {
            this.multiAgentHandler
              .getSharedContext()
              .recordAgentMessage(event.channel, agent, event.text, event.ts);
          }
        }

        // Route bot→agent @mentions directly from the gateway.
        // Slack's app_mention event does NOT fire for bot-posted messages,
        // so the gateway must detect <@AGENT_USER_ID> in bot messages and
        // invoke the target agent's response directly.
        // When mention_delegation is enabled, MultiBotManager's onMention handles
        // agent-to-agent routing directly — skip fallback to avoid dual processing.
        if (this.multiAgentHandler.isMentionDelegationEnabled()) {
          const mentionedAgentIds = this.multiAgentHandler.extractMentionedAgentIds(event.text);
          if (mentionedAgentIds.length > 0) {
            this.logger.log(
              `[Slack] Bot→Agent mention routing: ${agentBotId} → ${mentionedAgentIds.join(', ')}`
            );
            // Route to all mentioned agents in parallel
            await Promise.all(
              mentionedAgentIds.map((targetAgentId) =>
                this.multiAgentHandler!.handleBotToAgentMention(
                  targetAgentId,
                  event,
                  this.webClient
                )
              )
            );
          }
          return;
        }

        // Non-delegation fallback for non-main agent bots
        if (agentBotId !== 'main') {
          const cleanContent = this.cleanMessageContent(event.text);
          const multiAgentResult = await this.multiAgentHandler.handleMessage(event, cleanContent);
          if (multiAgentResult && multiAgentResult.responses.length > 0) {
            const threadTs = event.thread_ts || event.ts;
            await this.multiAgentHandler.sendAgentResponses(
              event.channel,
              threadTs,
              multiAgentResult.responses,
              this.webClient
            );
            this.logger.log(
              `[Slack] Agent-to-agent: ${agentBotId} → ${multiAgentResult.selectedAgents.join(', ')}`
            );
          }
        }
        return;
      }
    }

    // Ignore other bot messages (not part of our multi-agent system)
    if (event.bot_id) return;

    // Check for PR review polling commands (start/stop) — before shouldRespond
    // so "PR 중지" works without requiring bot mention
    if (this.multiAgentHandler?.isEnabled()) {
      const prContent = this.cleanMessageContent(event.text);
      if (prContent.trim()) {
        const handled = await this.multiAgentHandler.handlePRCommand(event.channel, prContent);
        if (handled) return;
      }
    }

    const isDM = event.channel_type === 'im';

    // Check if we should respond to this message
    if (!this.shouldRespond(event, isDM, isMention)) {
      return;
    }

    // Emit message received event
    this.emitEvent({
      type: 'message_received',
      source: 'slack',
      timestamp: new Date(),
      data: {
        channelId: event.channel,
        userId: event.user,
        isDM,
        isMention,
        hasThread: !!event.thread_ts,
      },
    });

    // Remove mentions from message content
    const cleanContent = this.cleanMessageContent(event.text);

    // Check if multi-agent mode should handle this message
    if (this.multiAgentHandler?.isEnabled()) {
      // Acknowledge receipt with emoji reaction
      try {
        await this.webClient.reactions.add({
          channel: event.channel,
          timestamp: event.ts,
          name: 'eyes',
        });
      } catch (err) {
        const errDetail = err instanceof Error ? err.message : String(err);
        this.logger.warn(`[Slack] Failed to add reaction: ${errDetail}`);
      }

      // Build conversation history context (like Discord's channel-history)
      const historyContext = channelHistory.formatForContext(event.channel, event.ts);

      const multiAgentResult = await this.multiAgentHandler.handleMessage(
        event,
        cleanContent,
        historyContext || undefined
      );

      if (multiAgentResult && multiAgentResult.responses.length > 0) {
        // Replace eyes with checkmark on completion
        try {
          await this.webClient.reactions.remove({
            channel: event.channel,
            timestamp: event.ts,
            name: 'eyes',
          });
          await this.webClient.reactions.add({
            channel: event.channel,
            timestamp: event.ts,
            name: 'white_check_mark',
          });
        } catch {
          /* ignore reaction errors */
        }

        const threadTs = event.thread_ts || event.ts;
        await this.multiAgentHandler.sendAgentResponses(
          event.channel,
          threadTs,
          multiAgentResult.responses,
          this.webClient
        );

        // Record agent responses to channel history (after send so messageId is populated)
        for (const resp of multiAgentResult.responses) {
          channelHistory.record(event.channel, {
            messageId: resp.messageId || event.ts,
            sender: resp.agent.display_name,
            userId: resp.agentId,
            body: resp.rawContent.substring(0, 500),
            timestamp: Date.now(),
            isBot: true,
          });
        }

        // Route any @agent mentions in the responses.
        // Slack doesn't deliver a bot's own messages back to itself,
        // so we must route mentions immediately after sending.
        if (this.multiAgentHandler.isMentionDelegationEnabled()) {
          await this.multiAgentHandler.routeResponseMentions(
            event.channel,
            threadTs,
            multiAgentResult.responses,
            this.webClient
          );
        }

        this.emitEvent({
          type: 'message_sent',
          source: 'slack',
          timestamp: new Date(),
          data: {
            channelId: event.channel,
            responseLength: multiAgentResult.responses.reduce(
              (sum, r) => sum + r.content.length,
              0
            ),
            multiAgent: true,
            agents: multiAgentResult.selectedAgents,
          },
        });

        this.logger.log(
          `[Slack] Multi-agent responded: ${multiAgentResult.selectedAgents.join(', ')}`
        );

        // Start heartbeat polling for this channel (reports only when agents are busy)
        this.multiAgentHandler.startHeartbeat(event.channel);

        return; // Multi-agent handled it
      }
      // If multi-agent returns null, fall through to regular processing
    }

    // Normalize message for router
    const normalizedMessage: NormalizedMessage = {
      source: 'slack',
      channelId: event.channel,
      userId: event.user,
      text: cleanContent,
      metadata: {
        threadTs: event.thread_ts || event.ts,
        messageId: event.ts,
      },
    };

    // Process through message router
    const result = await this.messageRouter.process(normalizedMessage);

    // Send response in thread
    await this.sendResponse(event, result.response);

    // Emit message sent event
    this.emitEvent({
      type: 'message_sent',
      source: 'slack',
      timestamp: new Date(),
      data: {
        channelId: event.channel,
        responseLength: result.response.length,
        duration: result.duration,
        threadTs: event.thread_ts || event.ts,
      },
    });
  }

  /**
   * Check if bot should respond to this message
   */
  private shouldRespond(event: SlackMessageEvent, isDM: boolean, isMention: boolean): boolean {
    // Always respond to DMs
    if (isDM) return true;

    // For channel messages, check if mention is required
    const channelConfig = this.config.channels?.[event.channel];

    if (channelConfig) {
      // Channel-specific config
      if (channelConfig.requireMention === false) {
        return true; // No mention required for this channel
      }
      return isMention;
    }

    // Default: require mention for channel messages
    return isMention;
  }

  /**
   * Clean message content (remove mentions)
   */
  private cleanMessageContent(content: string): string {
    // Remove user/bot mentions (<@U12345> or <@W12345>)
    return content
      .replace(/<@[UW]\w+>/g, '')
      .replace(/<@[UW]\w+\|[^>]+>/g, '') // Mentions with display name
      .trim();
  }

  /**
   * Send response to Slack (handling length limits and threading)
   */
  private async sendResponse(originalEvent: SlackMessageEvent, response: string): Promise<void> {
    const threadTs = originalEvent.thread_ts || originalEvent.ts;
    const chunks = splitForSlack(response);

    for (const chunk of chunks) {
      await this.webClient.chat.postMessage({
        channel: originalEvent.channel,
        text: chunk,
        thread_ts: threadTs,
        reply_broadcast: true, // Also show in channel
      });
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
        this.logger.error('Error in gateway event handler:', error);
      }
    }
  }

  // ============================================================================
  // Gateway Interface Implementation
  // ============================================================================

  /**
   * Start the Slack gateway
   */
  async start(): Promise<void> {
    if (this.connected) {
      this.logger.log('Slack gateway already connected');
      return;
    }

    await this.socketClient.start();
  }

  /**
   * Stop the Slack gateway
   */
  async stop(): Promise<void> {
    // Stop multi-agent processes
    if (this.multiAgentHandler) {
      await this.multiAgentHandler.stopAll();
    }

    if (!this.connected) {
      return;
    }

    await this.socketClient.disconnect();
    this.connected = false;

    this.emitEvent({
      type: 'disconnected',
      source: 'slack',
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
  setConfig(config: Partial<SlackGatewayConfig>): void {
    if (config.channels) {
      this.config.channels = { ...this.config.channels, ...config.channels };
    }
    if (config.enabled !== undefined) {
      this.config.enabled = config.enabled;
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): SlackGatewayConfig {
    return { ...this.config };
  }

  /**
   * Add channel configuration
   */
  addChannelConfig(channelId: string, config: SlackChannelConfig): void {
    this.config.channels = this.config.channels || {};
    this.config.channels[channelId] = config;
  }

  // ============================================================================
  // Message Sending API (for discord_send tool compatibility)
  // ============================================================================

  /**
   * Send message to a channel
   */
  async sendMessage(channelId: string, text: string): Promise<void> {
    const chunks = splitForSlack(text);
    for (const chunk of chunks) {
      await this.webClient.chat.postMessage({
        channel: channelId,
        text: chunk,
      });
    }
  }

  /**
   * Send file/document to a channel
   * Supports any file type (documents, images, PDFs, etc.)
   */
  async sendFile(channelId: string, filePath: string, caption?: string): Promise<void> {
    const { createReadStream } = await import('fs');
    const { basename } = await import('path');

    const filename = basename(filePath);

    await this.webClient.filesUploadV2({
      channel_id: channelId,
      file: createReadStream(filePath),
      filename,
      initial_comment: caption,
    });
  }

  /**
   * Send image to a channel (alias for sendFile)
   */
  async sendImage(channelId: string, imagePath: string, caption?: string): Promise<void> {
    return this.sendFile(channelId, imagePath, caption);
  }

  // ============================================================================
  // Multi-Agent Support
  // ============================================================================

  /**
   * Get the multi-agent handler (if enabled)
   */
  getMultiAgentHandler(): MultiAgentSlackHandler | null {
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
        this.multiAgentHandler = new MultiAgentSlackHandler(config, {
          // Headless daemon — no interactive permission prompts possible
          dangerouslySkipPermissions: config.dangerouslySkipPermissions ?? true,
        });
        // If already connected, initialize multi-bots
        if (this.connected) {
          try {
            const authResult = await this.webClient.auth.test();
            this.multiAgentHandler.setBotUserId(authResult.user_id as string);
            this.multiAgentHandler.setMainBotId(authResult.bot_id as string);
            this.multiAgentHandler.setMainBotToken(this.botToken);
            await this.multiAgentHandler.initializeMultiBots();
          } catch (err) {
            this.logger.error('[Slack] Failed to initialize multi-agent:', err);
          }
        }
      }
      this.logger.log('[Slack] Multi-agent mode enabled/updated');
    } else {
      if (this.multiAgentHandler) {
        await this.multiAgentHandler.stopAll();
        this.multiAgentHandler = null;
      }
      this.logger.log('[Slack] Multi-agent mode disabled');
    }
  }
}
