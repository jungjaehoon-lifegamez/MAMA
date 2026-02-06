/**
 * Slack Multi-Bot Manager
 *
 * Manages multiple Slack bot clients for multi-agent system.
 * Each agent with slack_bot_token + slack_app_token gets its own SocketModeClient.
 *
 * Mirrors MultiBotManager (Discord) but uses Slack-specific APIs:
 * - SocketModeClient for real-time events
 * - WebClient for API calls (chat.postMessage, auth.test)
 * - bot_id based identification (instead of Discord's author.id)
 */

import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import type { MultiAgentConfig, AgentPersonaConfig } from './types.js';
import { createSafeLogger, maskBotId, maskUserId } from '../utils/log-sanitizer.js';
import { SlackRateLimiter } from '../utils/slack-rate-limiter.js';

/**
 * Slack bot instance for an agent
 */
interface SlackAgentBot {
  agentId: string;
  socketClient: SocketModeClient;
  webClient: WebClient;
  botToken: string;
  appToken: string;
  connected: boolean;
  userId?: string;
  botId?: string;
  botName?: string;
}

/**
 * Slack mention event structure
 */
export interface SlackMentionEvent {
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
 * Slack Multi-Bot Manager
 *
 * Creates and manages multiple Slack bot clients,
 * one for each agent with dedicated slack_bot_token + slack_app_token.
 */
export class SlackMultiBotManager {
  private config: MultiAgentConfig;
  private bots: Map<string, SlackAgentBot> = new Map();
  private mainBotUserId: string | null = null;
  private mainBotId: string | null = null;
  private mainBotToken: string | null = null;
  private mainBotAgentId: string | null = null;

  /** Callback for when an agent bot receives a mention */
  private onMentionCallback:
    | ((agentId: string, event: SlackMentionEvent, webClient: WebClient) => void)
    | null = null;

  /** Safe logger that sanitizes sensitive information */
  private logger = createSafeLogger('SlackMultiBotManager');

  /** Rate limiter for Slack API calls */
  private rateLimiter = new SlackRateLimiter({
    maxRequestsPerMinute: 50,
    minIntervalMs: 1000,
    maxQueueSize: 100,
    enableRetry: true,
    maxRetries: 3,
  });

  constructor(config: MultiAgentConfig) {
    this.config = config;
  }

  /**
   * Set main bot user ID (from SlackGateway auth.test)
   */
  setMainBotUserId(userId: string): void {
    this.mainBotUserId = userId;
  }

  /**
   * Set main bot ID (from SlackGateway auth.test)
   */
  setMainBotId(botId: string): void {
    this.mainBotId = botId;
  }

  /**
   * Set main bot token (to avoid duplicate connections)
   */
  setMainBotToken(token: string): void {
    this.mainBotToken = token;
  }

  /**
   * Register callback for when an agent bot receives a mention
   */
  onMention(
    callback: (agentId: string, event: SlackMentionEvent, webClient: WebClient) => void
  ): void {
    this.onMentionCallback = callback;
  }

  /**
   * Initialize all agent bots
   */
  async initialize(): Promise<void> {
    const agentsWithTokens = Object.entries(this.config.agents).filter(
      ([, config]) => config.slack_bot_token && config.slack_app_token && config.enabled !== false
    );

    this.logger.log(`Initializing ${agentsWithTokens.length} agent bots...`);

    for (const [agentId, agentConfig] of agentsWithTokens) {
      // Skip if agent uses the same token as main bot
      if (this.mainBotToken && agentConfig.slack_bot_token === this.mainBotToken) {
        this.mainBotAgentId = agentId;
        this.logger.log(`Agent ${agentId} uses main bot token - skipping (mapped as main agent)`);
        continue;
      }

      try {
        await this.createAgentBot(agentId, agentConfig);
      } catch (error) {
        this.logger.error(`Failed to create bot for ${agentId}:`, error);
      }
    }
  }

  /**
   * Create a Slack bot for an agent
   */
  private async createAgentBot(
    agentId: string,
    agentConfig: Omit<AgentPersonaConfig, 'id'>
  ): Promise<void> {
    if (!agentConfig.slack_bot_token || !agentConfig.slack_app_token) return;

    const socketClient = new SocketModeClient({
      appToken: agentConfig.slack_app_token,
      serverPingTimeout: 30000,
      clientPingTimeout: 30000,
    });

    const webClient = new WebClient(agentConfig.slack_bot_token);

    const bot: SlackAgentBot = {
      agentId,
      socketClient,
      webClient,
      botToken: agentConfig.slack_bot_token,
      appToken: agentConfig.slack_app_token,
      connected: false,
    };

    // Get bot identity via auth.test (with rate limiting)
    try {
      const authResult = await this.rateLimiter.queueRequest(() => webClient.auth.test());
      bot.userId = authResult.user_id as string;
      bot.botId = authResult.bot_id as string;
      bot.botName = authResult.user as string;
      this.logger.log(
        `Agent ${agentId} identified as ${bot.botName} (userId=${maskUserId(bot.userId || '')}, botId=${maskBotId(bot.botId || '')})`
      );
    } catch (error) {
      this.logger.error(`auth.test failed for ${agentId}:`, error);
      return;
    }

    // Listen for app_mention events
    socketClient.on('app_mention', async ({ event, ack }) => {
      try {
        await ack();
        const mentionEvent = event as SlackMentionEvent;

        // Allow agent bot messages through for mention-based delegation
        if (mentionEvent.bot_id) {
          const senderAgentId = this.isFromAgentBot(mentionEvent.bot_id);
          // Ignore non-agent bots and the main bot
          if (!senderAgentId || senderAgentId === 'main') return;
          // Ignore own messages (self-mention prevention)
          if (mentionEvent.bot_id === bot.botId) return;
        }

        // Forward to callback
        if (this.onMentionCallback) {
          this.logger.log(
            `Agent ${agentId} mentioned by ${mentionEvent.user ? maskUserId(mentionEvent.user) : maskBotId(mentionEvent.bot_id || '')}`
          );

          // Add eyes reaction to acknowledge receipt
          try {
            await bot.webClient.reactions.add({
              channel: mentionEvent.channel,
              timestamp: mentionEvent.ts,
              name: 'eyes',
            });
          } catch {
            /* ignore reaction errors */
          }

          await this.onMentionCallback(agentId, mentionEvent, bot.webClient);

          // Replace eyes with checkmark on completion
          try {
            await bot.webClient.reactions.remove({
              channel: mentionEvent.channel,
              timestamp: mentionEvent.ts,
              name: 'eyes',
            });
            await bot.webClient.reactions.add({
              channel: mentionEvent.channel,
              timestamp: mentionEvent.ts,
              name: 'white_check_mark',
            });
          } catch {
            /* ignore reaction errors */
          }
        }
      } catch (error) {
        this.logger.error(`app_mention error for ${agentId}:`, error);
      }
    });

    // Listen for channel messages (catches bot-to-bot mentions that app_mention misses)
    socketClient.on('message', async ({ event, ack }) => {
      try {
        await ack();
        const msgEvent = event as SlackMentionEvent;

        // Only process bot messages that mention this agent
        if (!msgEvent.bot_id) return; // Human messages handled by app_mention
        if (msgEvent.bot_id === bot.botId) return; // Ignore own messages

        // Check if this agent is mentioned in the message
        if (!bot.userId || !msgEvent.text?.includes(`<@${bot.userId}>`)) return;

        // Verify sender is one of our agent bots
        const senderAgentId = this.isFromAgentBot(msgEvent.bot_id);
        if (!senderAgentId || senderAgentId === 'main') return;

        // Forward to callback (same as app_mention handler)
        if (this.onMentionCallback) {
          this.logger.log(
            `Agent ${agentId} mentioned by bot ${maskBotId(msgEvent.bot_id)} (via message event)`
          );

          try {
            await bot.webClient.reactions.add({
              channel: msgEvent.channel,
              timestamp: msgEvent.ts,
              name: 'eyes',
            });
          } catch {
            /* ignore reaction errors */
          }

          await this.onMentionCallback(agentId, msgEvent, bot.webClient);

          try {
            await bot.webClient.reactions.remove({
              channel: msgEvent.channel,
              timestamp: msgEvent.ts,
              name: 'eyes',
            });
            await bot.webClient.reactions.add({
              channel: msgEvent.channel,
              timestamp: msgEvent.ts,
              name: 'white_check_mark',
            });
          } catch {
            /* ignore reaction errors */
          }
        }
      } catch (error) {
        this.logger.error(`message event error for ${agentId}:`, error);
      }
    });

    // Connection events
    socketClient.on('connected', () => {
      bot.connected = true;
      this.logger.log(`Agent ${agentId} bot connected`);
    });

    socketClient.on('disconnected', () => {
      bot.connected = false;
      this.logger.warn(`Agent ${agentId} bot disconnected`);
    });

    // Start socket mode connection
    await socketClient.start();
    this.bots.set(agentId, bot);
  }

  /**
   * Check if a bot_id belongs to one of our agent bots
   */
  isFromAgentBot(botId: string): string | null {
    for (const [agentId, bot] of this.bots) {
      if (bot.botId === botId) {
        return agentId;
      }
    }

    // Check main bot
    if (this.mainBotId && botId === this.mainBotId) {
      return 'main';
    }

    return null;
  }

  /**
   * Check if an agent has its own bot
   */
  hasAgentBot(agentId: string): boolean {
    const bot = this.bots.get(agentId);
    return bot?.connected ?? false;
  }

  /**
   * Get agent bot
   */
  getAgentBot(agentId: string): SlackAgentBot | undefined {
    return this.bots.get(agentId);
  }

  /**
   * Send a message as a specific agent's bot
   */
  async sendAsAgent(
    agentId: string,
    channelId: string,
    content: string,
    threadTs?: string
  ): Promise<string | null> {
    const bot = this.bots.get(agentId);
    if (!bot?.connected) {
      this.logger.warn(`No connected bot for agent ${agentId}`);
      return null;
    }

    try {
      // Use rate limiter for API calls
      const result = threadTs
        ? await this.rateLimiter.queueRequest(() =>
            bot.webClient.chat.postMessage({
              channel: channelId,
              text: content,
              thread_ts: threadTs,
              reply_broadcast: true,
            })
          )
        : await this.rateLimiter.queueRequest(() =>
            bot.webClient.chat.postMessage({
              channel: channelId,
              text: content,
            })
          );
      this.logger.log(`Agent ${agentId} sent message to ${channelId}`);
      return result.ts as string;
    } catch (error) {
      this.logger.error(`Failed to send as ${agentId}:`, error);
      return null;
    }
  }

  /**
   * Reply to a message as a specific agent's bot (always in thread)
   */
  async replyAsAgent(
    agentId: string,
    channelId: string,
    threadTs: string,
    content: string
  ): Promise<string | null> {
    return this.sendAsAgent(agentId, channelId, content, threadTs);
  }

  /**
   * Get all connected agent IDs
   */
  getConnectedAgents(): string[] {
    return Array.from(this.bots.entries())
      .filter(([, bot]) => bot.connected)
      .map(([agentId]) => agentId);
  }

  /**
   * Get a map of agentId → Slack userId for all connected bots
   */
  getBotUserIdMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [agentId, bot] of this.bots) {
      if (bot.connected && bot.userId) {
        map.set(agentId, bot.userId);
      }
    }
    // Include main bot agent (skipped during init because it shares the main token)
    if (this.mainBotAgentId && this.mainBotUserId) {
      map.set(this.mainBotAgentId, this.mainBotUserId);
    }
    return map;
  }

  /**
   * Resolve an agent ID from a Slack user ID (reverse lookup)
   */
  resolveAgentIdFromUserId(userId: string): string | null {
    for (const [agentId, bot] of this.bots) {
      if (bot.userId === userId) {
        return agentId;
      }
    }
    // Check main bot — return actual agent ID if known
    if (this.mainBotUserId && userId === this.mainBotUserId) {
      return this.mainBotAgentId ?? 'main';
    }
    return null;
  }

  /**
   * Get the agent ID that maps to the main bot
   */
  getMainBotAgentId(): string | null {
    return this.mainBotAgentId;
  }

  /**
   * Stop a specific agent's bot
   */
  async stopAgentBot(agentId: string): Promise<void> {
    const bot = this.bots.get(agentId);
    if (bot) {
      // Remove all event listeners before disconnecting to prevent memory leaks
      bot.socketClient.removeAllListeners();
      await bot.socketClient.disconnect();
      this.bots.delete(agentId);
      this.logger.log(`Stopped bot for agent ${agentId}`);
    }
  }

  /**
   * Stop all agent bots
   */
  async stopAll(): Promise<void> {
    this.logger.log(`Stopping ${this.bots.size} agent bots...`);
    for (const [agentId, bot] of this.bots) {
      try {
        // Remove all event listeners before disconnecting to prevent memory leaks
        bot.socketClient.removeAllListeners();
        await bot.socketClient.disconnect();
        this.logger.log(`Stopped bot for ${agentId}`);
      } catch (error) {
        this.logger.error(`Error stopping bot for ${agentId}:`, error);
      }
    }
    this.bots.clear();
  }

  /**
   * Get status of all bots
   */
  getStatus(): Record<string, { connected: boolean; botName?: string }> {
    const status: Record<string, { connected: boolean; botName?: string }> = {};
    for (const [agentId, bot] of this.bots) {
      status[agentId] = {
        connected: bot.connected,
        botName: bot.botName,
      };
    }
    return status;
  }
}
