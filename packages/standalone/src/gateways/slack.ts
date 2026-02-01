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

  constructor(options: SlackGatewayOptions) {
    this.messageRouter = options.messageRouter;
    this.config = {
      enabled: true,
      botToken: options.botToken,
      appToken: options.appToken,
      channels: options.config?.channels || {},
    };

    // Create Socket Mode client for real-time events
    this.socketClient = new SocketModeClient({
      appToken: options.appToken,
    });

    // Create Web client for API calls
    this.webClient = new WebClient(options.botToken);

    this.setupEventListeners();
  }

  /**
   * Set up Socket Mode event listeners
   */
  private setupEventListeners(): void {
    // Connection events
    this.socketClient.on('connected', () => {
      console.log('Slack gateway connected via Socket Mode');
      this.connected = true;
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
        console.error('Error handling Slack message:', error);
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
        console.error('Error handling Slack mention:', error);
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
    // Ignore bot messages
    if (event.bot_id) return;

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

    if (!cleanContent.trim()) {
      return; // Don't process empty messages
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
        thread_ts: threadTs, // Always reply in thread
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
        console.error('Error in gateway event handler:', error);
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
      console.log('Slack gateway already connected');
      return;
    }

    await this.socketClient.start();
  }

  /**
   * Stop the Slack gateway
   */
  async stop(): Promise<void> {
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
}
