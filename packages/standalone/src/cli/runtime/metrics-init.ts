/**
 * MAMA OS metrics and health service initialization.
 *
 * Extracted from cli/commands/start.ts to keep the orchestrator thin.
 * All logic and function signatures are unchanged.
 */

import { homedir } from 'node:os';

import type { MAMAConfig } from '../config/types.js';
import { expandPath } from '../config/config-manager.js';
import { getSessionPool } from '../../agent/session-pool.js';
import { MetricsStore } from '../../observability/metrics-store.js';
import { MetricsCleanup } from '../../observability/metrics-cleanup.js';
import { HealthScoreService } from '../../observability/health-score.js';
import { HealthCheckService } from '../../observability/health-check.js';
import type { SQLiteDatabase } from '../../sqlite.js';

import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';

const { DebugLogger } = debugLogger as unknown as {
  DebugLogger: new (context?: string) => {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};
const metricsLogger = new DebugLogger('start');

export interface MetricsInitResult {
  metricsStore: MetricsStore | null;
  metricsCleanup: MetricsCleanup | null;
  healthService: HealthScoreService | null;
  healthCheckService: HealthCheckService;
  metricsInterval: ReturnType<typeof setInterval> | null;
}

/**
 * Initialize metrics store, health score, and health check services.
 *
 * @param config   Loaded MAMA configuration
 * @param db       Sessions SQLite database (used by HealthCheckService for token usage queries)
 * @param embeddingPort  Port the embedding server listens on
 */
export async function initMetrics(
  config: MAMAConfig,
  db: SQLiteDatabase,
  embeddingPort: number
): Promise<MetricsInitResult> {
  // Initialize metrics store (respects config.metrics.enabled)
  const metricsEnabled = config.metrics?.enabled !== false;
  let metricsStore: MetricsStore | null = null;
  let metricsCleanup: MetricsCleanup | null = null;
  let healthService: HealthScoreService | null = null;
  let metricsInterval: ReturnType<typeof setInterval> | null = null;

  if (metricsEnabled) {
    const metricsDbPath = expandPath(config.database.path).replace(
      'mama-memory.db',
      'mama-metrics.db'
    );
    metricsStore = MetricsStore.getInstance(metricsDbPath);
    metricsCleanup = new MetricsCleanup(metricsStore, {
      retentionMs: (config.metrics?.retention_days ?? 7) * 24 * 60 * 60 * 1000,
    });
    metricsCleanup.start();
    healthService = new HealthScoreService(metricsStore);
    console.log('✓ Metrics store initialized');

    // Periodic metrics summary log (every 5 minutes)
    const METRICS_LOG_INTERVAL = 5 * 60 * 1000;
    metricsInterval = setInterval(() => {
      try {
        const count = metricsStore!.countSince(Date.now() - METRICS_LOG_INTERVAL);
        const health = healthService!.compute();
        metricsLogger.info(
          `[Metrics] ${count} recorded (5m), health: ${health.score}/100 (${health.status})`
        );
      } catch {
        /* ignore */
      }
    }, METRICS_LOG_INTERVAL);
  } else {
    console.log('ℹ Metrics disabled via config');
  }

  // Initialize connection-based health check service (always active, regardless of metrics config)
  const healthCheckDbPath = expandPath(config.database.path);
  const healthCheckService = new HealthCheckService({
    embeddingPort,
    db,
    sessionPool: getSessionPool(),
    metricsCleanup: metricsCleanup ?? undefined,
    healthScoreService: healthService ?? undefined,
    dbPath: healthCheckDbPath,
    watchdogPidPath: `${homedir()}/.mama/watchdog.pid`,
  });

  // Wire token budget check (daily usage vs config limit)
  const tokenBudgetConfig = config.token_budget;
  if (tokenBudgetConfig && tokenBudgetConfig.daily_limit > 0) {
    const alertThreshold = tokenBudgetConfig.alert_threshold ?? 0.9;
    healthCheckService.setGetTokenUsage(() => {
      try {
        const result = db
          .prepare(
            `
          SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens
          FROM token_usage
          WHERE created_at >= ?
        `
          )
          .get(Date.now() - 86_400_000) as { total_tokens: number };
        return { used: result.total_tokens, limit: tokenBudgetConfig.daily_limit, alertThreshold };
      } catch {
        return null;
      }
    });
  }

  return {
    metricsStore,
    metricsCleanup,
    healthService,
    healthCheckService,
    metricsInterval,
  };
}
