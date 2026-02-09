/**
 * Multi-Bot Manager
 *
 * Manages multiple Discord bot clients for multi-agent system.
 * Each agent with a dedicated bot_token gets its own Discord client.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  TextChannel,
  ActivityType,
  type Message,
} from 'discord.js';
import type { MultiAgentConfig, AgentPersonaConfig } from './types.js';

/**
 * Bot instance for an agent
 */
interface AgentBot {
  agentId: string;
  client: Client;
  token: string;
  connected: boolean;
  userId?: string;
  username?: string;
}

/**
 * Multi-Bot Manager
 *
 * Creates and manages multiple Discord bot clients,
 * one for each agent with a dedicated bot_token.
 */
export class MultiBotManager {
  private config: MultiAgentConfig;
  private bots: Map<string, AgentBot> = new Map();
  private mainBotUserId: string | null = null;
  private mainBotToken: string | null = null;

  /** Callback for when an agent bot receives a mention */
  private onMentionCallback: ((agentId: string, message: Message) => void | Promise<void>) | null =
    null;

  constructor(config: MultiAgentConfig) {
    this.config = config;
  }

  /**
   * Set main bot user ID (from DiscordGateway)
   */
  setMainBotUserId(userId: string): void {
    this.mainBotUserId = userId;
  }

  /**
   * Set main bot token (to avoid duplicate logins)
   */
  setMainBotToken(token: string): void {
    this.mainBotToken = token;
  }

  /**
   * Register callback for when an agent bot receives a mention
   */
  onMention(callback: (agentId: string, message: Message) => void | Promise<void>): void {
    this.onMentionCallback = callback;
  }

  /**
   * Initialize all agent bots
   */
  async initialize(): Promise<void> {
    const agentsWithTokens = Object.entries(this.config.agents).filter(
      ([, config]) => config.bot_token && config.enabled !== false
    );

    console.log(`[MultiBotManager] Initializing ${agentsWithTokens.length} agent bots...`);

    // Get main bot token to avoid duplicate login
    const mainToken = this.mainBotToken;

    for (const [agentId, agentConfig] of agentsWithTokens) {
      // Skip if agent uses the same token as main bot (avoid duplicate login)
      if (mainToken && agentConfig.bot_token === mainToken) {
        console.log(
          `[MultiBotManager] Agent ${agentId} uses main bot token - skipping (will use main bot)`
        );
        continue;
      }

      try {
        await this.createAgentBot(agentId, agentConfig);
      } catch (error) {
        console.error(`[MultiBotManager] Failed to create bot for ${agentId}:`, error);
      }
    }
  }

  /**
   * Create a Discord client for an agent
   */
  private async createAgentBot(
    agentId: string,
    agentConfig: Omit<AgentPersonaConfig, 'id'>
  ): Promise<void> {
    if (!agentConfig.bot_token) return;

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMembers,
      ],
      partials: [Partials.Channel],
    });

    const bot: AgentBot = {
      agentId,
      client,
      token: agentConfig.bot_token,
      connected: false,
    };

    // Set up ready handler
    client.once('ready', (c) => {
      bot.connected = true;
      bot.userId = c.user.id;
      bot.username = c.user.tag;
      // Set online presence explicitly
      c.user.setPresence({
        status: 'online',
        activities: [{ name: agentConfig.name || agentId, type: ActivityType.Watching }],
      });
      console.log(
        `[MultiBotManager] Agent ${agentId} bot logged in as ${c.user.tag} (guilds: ${c.guilds.cache.size})`
      );
    });

    // Listen for messages mentioning this agent bot
    client.on('messageCreate', (msg) => {
      if (msg.author.bot) {
        const senderAgentId = this.isFromAgentBot(msg);
        if (!senderAgentId) return;
        if (msg.author.id === bot.userId) return;
      }
      if (!bot.userId || !msg.mentions.has(bot.userId)) return;
      if (this.onMentionCallback) {
        console.log(`[MultiBotManager] Agent ${agentId} mentioned by ${msg.author.tag}`);
        Promise.resolve(this.onMentionCallback(agentId, msg)).catch((err) => {
          console.error(
            `[MultiBotManager] onMention callback failed for ${agentId}:`,
            err instanceof Error ? err.message : err
          );
        });
      }
    });

    // Set up error handler
    client.on('error', (error) => {
      bot.connected = false;
      console.error(`[MultiBotManager] Agent ${agentId} bot error:`, error);
    });

    // Set up disconnect handlers
    client.on('shardDisconnect', () => {
      bot.connected = false;
      console.log(`[MultiBotManager] Agent ${agentId} bot disconnected`);
    });

    // Login and wait for ready event (ensures userId is available)
    await client.login(agentConfig.bot_token);
    this.bots.set(agentId, bot);

    // Wait for ready with timeout (5s) — ensures getBotUserIdMap() has all IDs
    if (!bot.connected) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => resolve(), 5000);
        const check = () => {
          if (bot.connected) {
            clearTimeout(timeout);
            resolve();
          }
        };
        client.once('ready', () => {
          check();
        });
        check(); // In case ready already fired
      });
    }
  }

  /**
   * Get main bot user ID
   */
  getMainBotUserId(): string | null {
    return this.mainBotUserId;
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
  getAgentBot(agentId: string): AgentBot | undefined {
    return this.bots.get(agentId);
  }

  /**
   * React to a message as a specific agent's bot
   */
  async reactAsAgent(
    agentId: string,
    channelId: string,
    messageId: string,
    emoji: string
  ): Promise<boolean> {
    const bot = this.bots.get(agentId);
    if (!bot?.connected) return false;

    try {
      const channel = await bot.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return false;

      const msg = await (channel as TextChannel).messages.fetch(messageId);
      await msg.react(emoji);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send a message as a specific agent's bot
   */
  async sendAsAgent(agentId: string, channelId: string, content: string): Promise<Message | null> {
    const bot = this.bots.get(agentId);
    if (!bot?.connected) {
      console.warn(`[MultiBotManager] No connected bot for agent ${agentId}`);
      return null;
    }

    try {
      const channel = await bot.client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) {
        console.error(`[MultiBotManager] Channel ${channelId} not found or not text channel`);
        return null;
      }

      const message = await (channel as TextChannel).send(content);
      console.log(`[MultiBotManager] Agent ${agentId} sent message to ${channelId}`);
      return message;
    } catch (error) {
      console.error(`[MultiBotManager] Failed to send as ${agentId}:`, error);
      return null;
    }
  }

  /**
   * Reply to a message as a specific agent's bot
   */
  async replyAsAgent(
    agentId: string,
    originalMessage: Message,
    content: string
  ): Promise<Message | null> {
    const bot = this.bots.get(agentId);
    if (!bot?.connected) {
      // Fall back to main bot reply (avoid infinite loop with sendAsAgent)
      console.warn(`[MultiBotManager] No connected bot for agent ${agentId}, using main bot reply`);
      try {
        return await originalMessage.reply({ content });
      } catch (err) {
        console.error(`[MultiBotManager] Failed to reply with main bot:`, err);
        return null;
      }
    }

    try {
      // We can't directly reply from a different bot, so we send a new message
      // mentioning the user instead
      const channel = await bot.client.channels.fetch(originalMessage.channel.id);
      if (!channel || !('send' in channel)) {
        console.error(`[MultiBotManager] Channel not found`);
        return null;
      }

      const message = await (channel as TextChannel).send({
        content,
        // Reference the original message if possible
        reply: { messageReference: originalMessage.id, failIfNotExists: false },
      });

      console.log(`[MultiBotManager] Agent ${agentId} replied in ${originalMessage.channel.id}`);
      return message;
    } catch (error) {
      // If reply fails (e.g., different guild), just send normally
      console.warn(`[MultiBotManager] Reply failed, sending normally:`, error);
      return this.sendAsAgent(agentId, originalMessage.channel.id, content);
    }
  }

  /**
   * Check if a message is from one of our agent bots
   */
  isFromAgentBot(message: Message): string | null {
    for (const [agentId, bot] of this.bots) {
      if (message.author.id === bot.userId) {
        return agentId;
      }
    }

    // Also check main bot
    if (this.mainBotUserId && message.author.id === this.mainBotUserId) {
      return 'main';
    }

    return null;
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
   * Stop a specific agent's bot
   */
  async stopAgentBot(agentId: string): Promise<void> {
    const bot = this.bots.get(agentId);
    if (bot) {
      await bot.client.destroy();
      this.bots.delete(agentId);
      console.log(`[MultiBotManager] Stopped bot for agent ${agentId}`);
    }
  }

  /**
   * Stop all agent bots
   */
  async stopAll(): Promise<void> {
    console.log(`[MultiBotManager] Stopping ${this.bots.size} agent bots...`);
    for (const [agentId, bot] of this.bots) {
      try {
        await bot.client.destroy();
        console.log(`[MultiBotManager] Stopped bot for ${agentId}`);
      } catch (error) {
        console.error(`[MultiBotManager] Error stopping bot for ${agentId}:`, error);
      }
    }
    this.bots.clear();
  }

  /**
   * Update configuration
   */
  async updateConfig(config: MultiAgentConfig): Promise<void> {
    this.config = config;

    // Stop bots for agents that no longer have tokens
    for (const agentId of this.bots.keys()) {
      const agentConfig = config.agents[agentId];
      if (!agentConfig?.bot_token) {
        await this.stopAgentBot(agentId);
      }
    }

    // Start new bots for agents with new tokens
    for (const [agentId, agentConfig] of Object.entries(config.agents)) {
      if (agentConfig.bot_token && agentConfig.enabled !== false && !this.bots.has(agentId)) {
        // Skip if agent uses the same token as main bot (avoid duplicate login)
        if (this.mainBotToken && agentConfig.bot_token === this.mainBotToken) {
          console.log(`[MultiBotManager] Agent ${agentId} uses main bot token - skipping`);
          continue;
        }
        await this.createAgentBot(agentId, agentConfig);
      }
    }
  }

  /**
   * Get a map of agentId → Discord userId for all connected bots
   */
  getBotUserIdMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [agentId, bot] of this.bots) {
      if (bot.connected && bot.userId) {
        map.set(agentId, bot.userId);
      }
    }
    return map;
  }

  /**
   * Resolve an agent ID from a Discord user ID (reverse lookup)
   */
  resolveAgentIdFromUserId(userId: string): string | null {
    for (const [agentId, bot] of this.bots) {
      if (bot.userId === userId) {
        return agentId;
      }
    }
    // Check main bot
    if (this.mainBotUserId && userId === this.mainBotUserId) {
      return 'main';
    }
    return null;
  }

  /**
   * Get status of all bots
   */
  getStatus(): Record<string, { connected: boolean; username?: string }> {
    const status: Record<string, { connected: boolean; username?: string }> = {};
    for (const [agentId, bot] of this.bots) {
      status[agentId] = {
        connected: bot.connected,
        username: bot.username,
      };
    }
    return status;
  }
}
