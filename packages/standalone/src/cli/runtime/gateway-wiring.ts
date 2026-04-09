/**
 * Gateway cross-wiring for MAMA OS runtime.
 *
 * Extracted from cli/commands/start.ts to keep the orchestrator thin.
 * All logic and function signatures are unchanged.
 *
 * Responsibilities:
 *   1. Gateway registry for memory save confirmations (messageRouter.setGatewayRegistry)
 *   2. Health check gateway wiring (healthCheckService.addGateway for each active gateway)
 *   3. Security alert sender wiring (parseSecurityAlertTargets → healthCheckService.securityAlertSender)
 *   4. CronResultRouter — routes cron results to Discord/Slack/Telegram gateways
 *   5. Graph handler runtime wiring — populates graphHandlerOptions with:
 *      - getAgentStates(), getSwarmTasks(), getRecentDelegations()
 *      - applyMultiAgentConfig(), restartMultiAgentAgent(), stopMultiAgentAgent()
 *      - delegation count and agent states wired into healthCheckService
 *   6. Plugin gateway loader — PluginLoader for additional gateways (e.g. Chatwork)
 */

import type { EventEmitter } from 'node:events';

import type { MAMAConfig } from '../config/types.js';
import type { AgentLoop } from '../../agent/index.js';
import {
  DiscordGateway,
  SlackGateway,
  TelegramGateway,
  MessageRouter,
  PluginLoader,
} from '../../gateways/index.js';
import type { HealthCheckService } from '../../observability/health-check.js';
import { formatSecurityAlert, setSecurityAlertSender } from '../../security/security-monitor.js';
import { CronResultRouter } from '../../scheduler/index.js';
import type { GraphHandlerOptions, DelegationHistoryEntry } from '../../api/graph-api-types.js';
import type { SQLiteDatabase } from '../../sqlite.js';
import { parseSecurityAlertTargets } from './utilities.js';

import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';

const { DebugLogger } = debugLogger as unknown as {
  DebugLogger: new (context?: string) => {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};
const wiringLogger = new DebugLogger('gateway-wiring');

/**
 * Result returned by wireGateways.
 */
export interface GatewayWiringResult {
  pluginLoader: PluginLoader;
}

/**
 * Wire gateways into the various subsystems after gateway initialization.
 *
 * Populates graphHandlerOptions in place (mutable object, matching current pattern).
 */
export async function wireGateways(params: {
  config: MAMAConfig;
  messageRouter: MessageRouter;
  healthCheckService: HealthCheckService;
  graphHandlerOptions: GraphHandlerOptions;
  db: SQLiteDatabase;
  discordGateway: DiscordGateway | null;
  slackGateway: SlackGateway | null;
  telegramGateway: TelegramGateway | null;
  gateways: Array<{ stop: () => Promise<void> }>;
  agentLoop: AgentLoop;
  cronEmitter: EventEmitter;
}): Promise<GatewayWiringResult> {
  const {
    config,
    messageRouter,
    healthCheckService,
    graphHandlerOptions,
    db,
    discordGateway,
    slackGateway,
    telegramGateway,
    gateways,
    agentLoop,
    cronEmitter,
  } = params;

  // Wire gateway registry for memory save confirmations
  messageRouter.setGatewayRegistry({
    async sendMessage(source: string, channelId: string, text: string) {
      if (source === 'telegram' && telegramGateway) {
        await telegramGateway.sendMessage(channelId, text);
      } else if (source === 'discord' && discordGateway) {
        await discordGateway.sendMessage(channelId, text);
      } else if (source === 'slack' && slackGateway) {
        await slackGateway.sendMessage(channelId, text);
      }
    },
  });

  // Wire gateways into health check service
  if (discordGateway) {
    healthCheckService.addGateway('discord', discordGateway);
  }
  if (slackGateway) {
    healthCheckService.addGateway('slack', slackGateway);
  }
  if (telegramGateway) {
    healthCheckService.addGateway('telegram', telegramGateway);
  }

  const securityAlertTargets = parseSecurityAlertTargets(config).filter((target) => {
    if (target.gateway === 'discord') return !!discordGateway;
    if (target.gateway === 'telegram') return !!telegramGateway;
    return !!slackGateway;
  });
  if (securityAlertTargets.length > 0) {
    setSecurityAlertSender(async (event) => {
      const message = formatSecurityAlert(event);
      const results = await Promise.allSettled(
        securityAlertTargets.map(async (target) => {
          if (target.gateway === 'discord' && discordGateway) {
            await discordGateway.sendMessage(target.channelId, message);
            return;
          }
          if (target.gateway === 'telegram' && telegramGateway) {
            await telegramGateway.sendMessage(target.channelId, message);
            return;
          }
          if (target.gateway === 'slack' && slackGateway) {
            await slackGateway.sendMessage(target.channelId, message);
          }
        })
      );

      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          const target = securityAlertTargets[index];
          wiringLogger.warn('[SECURITY] Failed to deliver security alert to target', {
            gateway: target?.gateway || 'unknown',
            channelId: target?.channelId || 'unknown',
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      });
    });
  } else {
    setSecurityAlertSender(null);
    wiringLogger.warn(
      '[SECURITY] No active security alert target configured. Set MAMA_SECURITY_ALERT_CHANNELS or configure an active Discord/Slack default channel.'
    );
  }

  // Wire cron results directly to gateways (bypasses OS agent entirely)
  // Instantiated for side effects: subscribes to cronEmitter events
  new CronResultRouter({
    emitter: cronEmitter,
    gateways: {
      discord: discordGateway ?? undefined,
      slack: slackGateway ?? undefined,
      telegram: telegramGateway ?? undefined,
    },
  });

  // Populate graph handler options with runtime dependencies (F4)
  if (discordGateway || slackGateway) {
    const discordHandler = discordGateway?.getMultiAgentHandler();
    const slackHandler = slackGateway?.getMultiAgentHandler();
    const multiAgentHandler = discordHandler || slackHandler;

    if (multiAgentHandler) {
      // getAgentStates: merge real-time process states from ALL gateways
      graphHandlerOptions.getAgentStates = () => {
        try {
          const merged = new Map<string, string>();
          const priority: Record<string, number> = {
            busy: 3,
            starting: 2,
            idle: 1,
            online: 0,
            dead: -1,
          };

          // Collect from Discord
          if (discordHandler) {
            for (const [id, state] of discordHandler.getProcessManager().getAgentStates()) {
              const existing = merged.get(id);
              if (!existing || (priority[state] ?? 0) > (priority[existing] ?? 0)) {
                merged.set(id, state);
              }
            }
          }
          // Collect from Slack
          if (slackHandler) {
            for (const [id, state] of slackHandler.getProcessManager().getAgentStates()) {
              const existing = merged.get(id);
              if (!existing || (priority[state] ?? 0) > (priority[existing] ?? 0)) {
                merged.set(id, state);
              }
            }
          }

          return merged;
        } catch (err) {
          console.error('[GraphAPI] Failed to get agent states:', err);
          return new Map();
        }
      };

      // Share getAgentStates with health check service
      healthCheckService.setGetAgentStates(graphHandlerOptions.getAgentStates);

      // getSwarmTasks: recent delegations from swarm-db
      graphHandlerOptions.getSwarmTasks = (limit = 20) => {
        try {
          // Query swarm_tasks table directly from mama-sessions.db
          const stmt = db.prepare(`
            SELECT
              id, description, category, wave, status,
              claimed_by, claimed_at, completed_at, result
            FROM swarm_tasks
            WHERE status IN ('completed', 'claimed')
            ORDER BY completed_at DESC, claimed_at DESC
            LIMIT ?
          `);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return stmt.all(limit) as Array<any>;
        } catch (err) {
          console.error('[GraphAPI] Failed to fetch swarm tasks:', err);
          return [];
        }
      };

      // getRecentDelegations: in-memory delegation history from DelegationManager
      graphHandlerOptions.getRecentDelegations = (limit = 20): DelegationHistoryEntry[] => {
        try {
          const delegationManager = multiAgentHandler.getDelegationManager();
          if (!delegationManager) {
            const logger = new DebugLogger('GraphAPI');
            logger.warn('[GraphAPI] DelegationManager not available');
            return [];
          }
          return delegationManager.getRecentDelegations(limit);
        } catch (err) {
          const logger = new DebugLogger('GraphAPI');
          logger.error('[GraphAPI] Failed to fetch recent delegations:', err);
          throw new Error(
            `Failed to fetch recent delegations: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      };

      // Wire delegation chain count into health check
      healthCheckService.setGetActiveDelegationCount(() => {
        try {
          const dm = multiAgentHandler.getDelegationManager();
          return dm ? dm.getActiveDelegationCount() : 0;
        } catch {
          return 0;
        }
      });

      // Apply updated multi-agent config at runtime without full daemon restart.
      graphHandlerOptions.applyMultiAgentConfig = async (rawConfig: Record<string, unknown>) => {
        // Type assertion to MultiAgentConfig (rawConfig comes from validated YAML)
        const nextConfig =
          rawConfig as unknown as import('../../cli/config/types.js').MultiAgentConfig;
        if (discordGateway) {
          await discordGateway.setMultiAgentConfig(nextConfig);
        }
        if (slackGateway) {
          await slackGateway.setMultiAgentConfig(nextConfig);
        }
      };

      // Restart a single agent runtime (rolling restart) after per-agent config updates.
      graphHandlerOptions.restartMultiAgentAgent = async (agentId: string) => {
        const discordHandler = discordGateway?.getMultiAgentHandler();
        const slackHandler = slackGateway?.getMultiAgentHandler();
        discordHandler?.getProcessManager().reloadPersona(agentId);
        slackHandler?.getProcessManager().reloadPersona(agentId);
      };

      // Stop a single agent's processes without restart.
      graphHandlerOptions.stopMultiAgentAgent = async (agentId: string) => {
        const discordHandler = discordGateway?.getMultiAgentHandler();
        const slackHandler = slackGateway?.getMultiAgentHandler();
        discordHandler?.getProcessManager().stopAgentProcesses(agentId);
        slackHandler?.getProcessManager().stopAgentProcesses(agentId);
      };
    }
  }

  // Initialize gateway plugin loader (for additional gateways like Chatwork)
  const pluginLoader = new PluginLoader({
    gatewayConfigs: {
      // Pass gateway configs from main config
      ...(config.chatwork
        ? {
            'chatwork-gateway': {
              enabled: config.chatwork.enabled,
              apiToken: config.chatwork.api_token,
              roomIds: config.chatwork.room_ids,
              pollInterval: config.chatwork.poll_interval,
              mentionRequired: config.chatwork.mention_required,
            },
          }
        : {}),
    },
    agentLoop: {
      run: async (prompt: string) => {
        const result = await agentLoop.run(prompt);
        return { response: result.response };
      },
      runWithContent: async (content) => {
        // Cast to match the expected type (both use same structure)
        console.log(`[AgentLoop] runWithContent called with ${content.length} blocks`);
        const result = await agentLoop.runWithContent(
          content as Parameters<typeof agentLoop.runWithContent>[0]
        );
        return { response: result.response };
      },
    },
  });

  // Discover and load gateway plugins
  try {
    const discoveredPlugins = await pluginLoader.discover();
    if (discoveredPlugins.length > 0) {
      console.log(`Plugins discovered: ${discoveredPlugins.map((p) => p.name).join(', ')}`);
      const pluginGateways = await pluginLoader.loadAll();
      for (const gateway of pluginGateways) {
        try {
          await gateway.start();
          gateways.push(gateway);
          console.log(`✓ Plugin gateway connected: ${gateway.source}`);
        } catch (error) {
          console.error(`Plugin gateway failed (${gateway.source}):`, error);
        }
      }
    }
  } catch (error) {
    console.warn('Plugin loading warning:', error);
  }

  return { pluginLoader };
}
