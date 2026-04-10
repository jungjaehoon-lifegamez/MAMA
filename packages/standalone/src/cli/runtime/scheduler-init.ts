/**
 * Scheduler initialization for MAMA OS.
 *
 * Extracted from cli/commands/start.ts to keep the orchestrator thin.
 * All logic and function signatures are unchanged.
 *
 * Responsibilities:
 *   initCronScheduler:
 *     1. Creates CronWorker + EventEmitter (for gateway routing)
 *     2. Creates CronScheduler and wires executeCallback to CronWorker
 *     3. Loads cron jobs from config.scheduling.jobs
 *
 *   initHeartbeat:
 *     1. Creates HeartbeatScheduler (interval, quiet hours, Discord notify)
 *     2. Wires scheduler + heartbeat into HealthCheckService
 *     3. Starts periodic health-warning interval (every 5 minutes)
 *     4. Creates TokenKeepAlive and starts it
 */

import { EventEmitter } from 'node:events';

import type { MAMAConfig } from '../config/types.js';
import { CronScheduler, CronWorker, TokenKeepAlive } from '../../scheduler/index.js';
import { HeartbeatScheduler } from '../../scheduler/heartbeat.js';
import { DiscordGateway } from '../../gateways/index.js';
import type { AgentLoop } from '../../agent/index.js';
import type { HealthCheckService } from '../../observability/health-check.js';

import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';

const { DebugLogger } = debugLogger as unknown as {
  DebugLogger: new (context?: string) => {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};
const schedulerLogger = new DebugLogger('scheduler-init');

/**
 * Result returned by initCronScheduler.
 */
export interface CronSchedulerResult {
  scheduler: CronScheduler;
  cronWorker: CronWorker;
  cronEmitter: EventEmitter;
}

/**
 * Result returned by initHeartbeat.
 */
export interface HeartbeatResult {
  heartbeatScheduler: HeartbeatScheduler;
  tokenKeepAlive: TokenKeepAlive;
  healthWarningInterval: ReturnType<typeof setInterval> | null;
}

/**
 * Initialize cron scheduler with a dedicated CronWorker and EventEmitter.
 *
 * Creates the scheduler, wires the execute callback to CronWorker,
 * and loads cron jobs from config.scheduling.jobs.
 */
export function initCronScheduler(config: MAMAConfig): CronSchedulerResult {
  // Initialize cron scheduler with dedicated CronWorker (isolated from OS agent)
  const cronEmitter = new EventEmitter();
  const cronWorker = new CronWorker({ emitter: cronEmitter });
  const scheduler = new CronScheduler();
  scheduler.setExecuteCallback(async (prompt, job) => {
    console.log(`[Cron] Executing: ${prompt.substring(0, 50)}...`);
    const result = await cronWorker.execute(prompt, {
      jobId: job.id,
      jobName: job.name,
      channel: job.channel,
    });
    console.log(`[Cron] Completed: ${result.substring(0, 100)}...`);
    return result;
  });

  // Load cron jobs from config.yaml scheduling.jobs
  const schedulingConfig = (config as Record<string, unknown>).scheduling as
    | {
        jobs?: Array<{
          id: string;
          name: string;
          cron: string;
          prompt: string;
          enabled?: boolean;
          channel?: string;
          description?: string;
        }>;
      }
    | undefined;
  if (schedulingConfig?.jobs?.length) {
    let loaded = 0;
    for (const job of schedulingConfig.jobs) {
      try {
        scheduler.addJob({
          id: job.id,
          name: job.name,
          cronExpr: job.cron,
          prompt: job.prompt,
          enabled: job.enabled ?? true,
          channel: job.channel,
        });
        loaded++;
      } catch (err) {
        console.warn(
          `[Cron] Failed to load job "${job.id}": ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    if (loaded > 0) {
      console.log(`✓ Loaded ${loaded} cron job(s) from config`);
    }
  }

  return { scheduler, cronWorker, cronEmitter };
}

/**
 * Initialize heartbeat scheduler, health warning interval, and token keep-alive.
 *
 * Wires the heartbeat and cron scheduler into HealthCheckService,
 * starts a periodic health-warning log every 5 minutes,
 * and starts the OAuth token keep-alive timer.
 */
export function initHeartbeat(
  config: MAMAConfig,
  agentLoop: AgentLoop,
  discordGateway: DiscordGateway | null,
  scheduler: CronScheduler,
  healthCheckService: HealthCheckService
): HeartbeatResult {
  // Initialize heartbeat scheduler
  const heartbeatConfig = config.heartbeat || {};
  const heartbeatScheduler = new HeartbeatScheduler(
    agentLoop,
    {
      interval: heartbeatConfig.interval || 30 * 60 * 1000, // 30 minutes default
      quietStart: heartbeatConfig.quiet_start || 23,
      quietEnd: heartbeatConfig.quiet_end || 8,
      notifyChannelId: heartbeatConfig.notify_channel_id || config.discord?.default_channel_id,
    },
    discordGateway
      ? async (channelId, message) => {
          await discordGateway!.sendMessage(channelId, message);
        }
      : undefined
  );

  if (heartbeatConfig.enabled !== false) {
    heartbeatScheduler.start();
    console.log('✓ Heartbeat scheduler started');
  }

  // Wire scheduler and heartbeat into health check service
  healthCheckService.setCronScheduler(scheduler);
  healthCheckService.setHeartbeat(heartbeatScheduler);

  // Periodic health check warning log (every 5 minutes)
  const healthWarningInterval = setInterval(
    async () => {
      try {
        const report = await healthCheckService.check();
        const criticalFails = report.checks.filter(
          (c) => c.severity === 'critical' && c.status === 'fail'
        );
        if (criticalFails.length > 0) {
          schedulerLogger.warn(
            `[Health] ⚠ ${criticalFails.length} critical issue(s): ${criticalFails.map((c) => c.name).join(', ')}`
          );
        }
      } catch {
        /* ignore */
      }
    },
    5 * 60 * 1000
  );

  // Initialize token keep-alive (prevents OAuth token expiration)
  const tokenKeepAlive = new TokenKeepAlive({
    intervalMs: 6 * 60 * 60 * 1000, // 6 hours
    onRefresh: () => {
      console.log('✓ OAuth token kept alive');
    },
    onError: (error) => {
      console.warn(`⚠️ Token refresh warning: ${error.message}`);
    },
  });
  tokenKeepAlive.start();

  return { heartbeatScheduler, tokenKeepAlive, healthWarningInterval };
}
