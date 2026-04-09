/**
 * Gateway initialization for Discord, Slack, and Telegram.
 *
 * Extracted from cli/commands/start.ts to keep the orchestrator thin.
 * All logic and function signatures are unchanged.
 *
 * Responsibilities:
 *   1. Creates `gateways` array for cleanup tracking
 *   2. Constructs `gatewayMultiAgentConfig` and `gatewayMultiAgentRuntime` objects
 *   3. Initializes Discord gateway (if config.discord enabled):
 *      - Normalizes guild config via normalizeDiscordGuilds()
 *      - Creates DiscordGateway instance
 *      - Creates gatewayInterface object with sendMessage/sendFile/sendImage
 *      - Calls agentLoop.setDiscordGateway(gatewayInterface)
 *      - Wires multi-agent handler's gateway tool executor
 *      - Calls discordGateway.start()
 *   4. Initializes Slack gateway (if config.slack enabled):
 *      - Creates SlackGateway instance
 *      - Creates slackGatewayInterface
 *      - Calls toolExecutor.setSlackGateway(slackGatewayInterface)
 *      - Calls slackGateway.start()
 *   5. Initializes Telegram gateway (if config.telegram enabled):
 *      - Creates TelegramGateway instance
 *      - Wires toolExecutor.setTelegramGateway() and agentLoop.setTelegramGateway()
 *      - Calls telegramGateway.start()
 */

import type { MAMAConfig } from '../config/types.js';
import { AgentLoop } from '../../agent/index.js';
import { GatewayToolExecutor } from '../../agent/gateway-tool-executor.js';
import {
  DiscordGateway,
  SlackGateway,
  TelegramGateway,
  MessageRouter,
} from '../../gateways/index.js';
import { normalizeDiscordGuilds } from './utilities.js';

import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';

const { DebugLogger } = debugLogger as unknown as {
  DebugLogger: new (context?: string) => {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};
const gatewayLogger = new DebugLogger('gateway-init');

/**
 * Result returned by initGateways.
 */
export interface GatewayInitResult {
  discordGateway: DiscordGateway | null;
  slackGateway: SlackGateway | null;
  telegramGateway: TelegramGateway | null;
  gateways: Array<{ stop: () => Promise<void> }>;
}

/**
 * Initialize Discord, Slack, and Telegram gateways.
 *
 * Reads config, creates gateway instances, wires them to the agent loop
 * and tool executor, and starts each enabled gateway.
 */
export async function initGateways(
  config: MAMAConfig,
  messageRouter: MessageRouter,
  toolExecutor: GatewayToolExecutor,
  agentLoop: AgentLoop,
  runtimeBackend: 'claude' | 'codex-mcp'
): Promise<GatewayInitResult> {
  // Track active gateways for cleanup
  const gateways: { stop: () => Promise<void> }[] = [];

  const gatewayMultiAgentConfig = config.multi_agent;
  const gatewayMultiAgentRuntime = {
    backend: runtimeBackend,
    model: config.agent.model,
    effort: config.agent.effort,
    requestTimeout: config.agent.timeout,
    codexCommand: process.env.MAMA_CODEX_COMMAND || process.env.CODEX_COMMAND,
    codexCwd: config.agent.codex_cwd,
    codexSandbox: config.agent.codex_sandbox,
  };

  // Initialize Discord gateway if enabled (before API server for reference)
  let discordGateway: DiscordGateway | null = null;
  if (config.discord?.enabled && config.discord?.token) {
    console.log('Initializing Discord gateway...');
    try {
      const normalizedGuilds = normalizeDiscordGuilds(config.discord.guilds);

      const guildKeys = normalizedGuilds ? Object.keys(normalizedGuilds) : [];
      gatewayLogger.info(
        `Discord config guild keys: ${guildKeys.length ? guildKeys.join(', ') : '(none)'}.`
      );
      gatewayLogger.info(
        `Discord config loaded keys: ${Object.keys(config.discord || {}).join(', ')}`
      );

      discordGateway = new DiscordGateway({
        token: config.discord.token,
        messageRouter,
        defaultChannelId: config.discord.default_channel_id,
        config: normalizedGuilds
          ? {
              guilds: normalizedGuilds,
            }
          : undefined,
        multiAgentConfig: gatewayMultiAgentConfig,
        multiAgentRuntime: gatewayMultiAgentRuntime,
      });

      const gatewayInterface = {
        sendMessage: async (channelId: string, message: string) =>
          discordGateway!.sendMessage(channelId, message),
        sendFile: async (channelId: string, filePath: string, caption?: string) =>
          discordGateway!.sendFile(channelId, filePath, caption),
        sendImage: async (channelId: string, imagePath: string, caption?: string) =>
          discordGateway!.sendFile(channelId, imagePath, caption),
      };

      agentLoop.setDiscordGateway(gatewayInterface);

      // Wire gateway tool executor to multi-agent handler
      const multiAgentDiscord = discordGateway.getMultiAgentHandler();
      if (multiAgentDiscord) {
        toolExecutor.setDiscordGateway(gatewayInterface);
        multiAgentDiscord.setGatewayToolExecutor(toolExecutor);
        console.log('[start] ✓ Gateway tool executor wired to multi-agent handler');
      }

      await discordGateway.start();
      gateways.push(discordGateway);
      console.log('✓ Discord connected');
    } catch (error) {
      console.error(
        `Failed to connect Discord: ${error instanceof Error ? error.message : String(error)}`
      );
      discordGateway = null;
    }
  }

  // Initialize Slack gateway if enabled (native, like Discord)
  let slackGateway: SlackGateway | null = null;
  if (config.slack?.enabled && config.slack?.bot_token && config.slack?.app_token) {
    console.log('Initializing Slack gateway...');
    try {
      slackGateway = new SlackGateway({
        botToken: config.slack.bot_token,
        appToken: config.slack.app_token,
        messageRouter,
        multiAgentConfig: gatewayMultiAgentConfig,
        multiAgentRuntime: gatewayMultiAgentRuntime,
      });

      await slackGateway.start();
      gateways.push(slackGateway);

      // Wire Slack gateway tool executor
      const slackGatewayInterface = {
        sendMessage: async (channelId: string, message: string) =>
          slackGateway!.sendMessage(channelId, message),
        sendFile: async (channelId: string, filePath: string, caption?: string) =>
          slackGateway!.sendFile(channelId, filePath, caption),
        sendImage: async (channelId: string, imagePath: string, caption?: string) =>
          slackGateway!.sendFile(channelId, imagePath, caption),
      };
      toolExecutor.setSlackGateway(slackGatewayInterface);

      const multiAgentSlack = slackGateway.getMultiAgentHandler();
      if (multiAgentSlack) {
        multiAgentSlack.setGatewayToolExecutor(toolExecutor);
        console.log('[start] ✓ Gateway tool executor wired to Slack multi-agent handler');
      }

      console.log('✓ Slack connected');
    } catch (error) {
      console.error(
        `Failed to connect Slack: ${error instanceof Error ? error.message : String(error)}`
      );
      slackGateway = null;
    }
  }

  // Initialize Telegram gateway if enabled
  let telegramGateway: TelegramGateway | null = null;
  if (config.telegram?.enabled && config.telegram?.token) {
    console.log('Initializing Telegram gateway...');
    try {
      telegramGateway = new TelegramGateway({
        token: config.telegram.token,
        messageRouter,
        config: {
          allowedChats: config.telegram.allowed_chats,
        },
      });

      await telegramGateway.start();
      gateways.push(telegramGateway);

      // Wire tool executor
      const telegramGatewayInterface = {
        sendMessage: async (chatId: string, message: string) =>
          telegramGateway!.sendMessage(chatId, message),
        sendFile: async (chatId: string, filePath: string, caption?: string) =>
          telegramGateway!.sendFile(chatId, filePath, caption),
        sendImage: async (chatId: string, imagePath: string, caption?: string) =>
          telegramGateway!.sendImage(chatId, imagePath, caption),
        sendSticker: async (chatId: string | number, emotion: string) =>
          telegramGateway!.sendSticker(chatId, emotion),
      };
      toolExecutor.setTelegramGateway(telegramGatewayInterface);
      agentLoop.setTelegramGateway(telegramGatewayInterface);

      console.log('✓ Telegram connected');
    } catch (error) {
      console.error(
        `Failed to connect Telegram: ${error instanceof Error ? error.message : String(error)}`
      );
      telegramGateway = null;
    }
  }

  return { discordGateway, slackGateway, telegramGateway, gateways };
}
