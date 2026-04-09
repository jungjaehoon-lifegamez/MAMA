/**
 * API module exports
 *
 * Provides HTTP API for cron job management and heartbeat functionality.
 */

import express, { type Express, type Router } from 'express';
import { createServer, type Server as HttpServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { SQLiteDatabase } from '../sqlite.js';
import { createCronRouter, InMemoryLogStore, type ExecutionLogStore } from './cron-handler.js';
import {
  createHeartbeatRouter,
  InMemoryHeartbeatTracker,
  type HeartbeatTracker,
} from './heartbeat-handler.js';
import { createTokenRouter, initTokenUsageTable } from './token-handler.js';
import { createSkillsRouter } from './skills-handler.js';
import { errorHandler, notFoundHandler } from './error-handler.js';
import { requireAuth } from './auth-middleware.js';
import { CronScheduler } from '../scheduler/index.js';
import { SkillRegistry } from '../skills/skill-registry.js';
import type { SystemHealthReport } from '../observability/health-check.js';
import { createSecurityMiddleware } from '../security/security-monitor.js';
import { createReportRouter, createReportStore } from './report-handler.js';
import { createWikiRouter } from './wiki-handler.js';
import { createIntelligenceRouter } from './intelligence-handler.js';
import { createConnectorFeedRouter } from './connector-feed-handler.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { AVAILABLE_CONNECTORS } from '../connectors/index.js';

// Re-export types
export * from './types.js';
export type { ExecutionLogStore } from './cron-handler.js';
export { InMemoryLogStore, ScheduleStoreAdapter } from './cron-handler.js';
export type { HeartbeatTracker } from './heartbeat-handler.js';
export { InMemoryHeartbeatTracker, DEFAULT_HEARTBEAT_PROMPT } from './heartbeat-handler.js';
export { asyncHandler, validateRequired, ApiError } from './error-handler.js';
export { createTokenRouter, initTokenUsageTable, insertTokenUsage } from './token-handler.js';
export type { TokenUsageRecord } from './token-handler.js';

/**
 * API server options
 */
export interface ApiServerOptions {
  /** Scheduler instance */
  scheduler: CronScheduler;
  /** Port to listen on (default: 3847) */
  port?: number;
  /** Log store for execution logs (default: InMemoryLogStore) */
  logStore?: ExecutionLogStore;
  /** Heartbeat tracker (default: InMemoryHeartbeatTracker) */
  heartbeatTracker?: HeartbeatTracker;
  /** Heartbeat execution callback */
  onHeartbeat?: (prompt: string) => Promise<{ success: boolean; error?: string }>;
  /** Enable automatic process killing on port conflicts (default: false) */
  enableAutoKillPort?: boolean;
  /** Sessions database instance (for token tracking) */
  db?: SQLiteDatabase;
  /** Memory database instance (for intelligence queries — mama-memory.db) */
  memoryDb?: SQLiteDatabase;
  /** Wiki directory path (for wiki API) */
  wikiPath?: string;
  /** Skill registry instance */
  skillRegistry?: SkillRegistry;
  /** Health score service for /api/metrics/health */
  healthService?: { compute(windowMs?: number): unknown };
  /** Connection-based health check service */
  healthCheckService?: {
    check(): Promise<SystemHealthReport>;
  };
  /** RawStore for connector feed queries */
  rawStore?: import('../connectors/framework/raw-store.js').RawStore;
  /** List of enabled connector names */
  enabledConnectors?: string[];
  /** AgentEventBus for notices */
  eventBus?: {
    getRecentNotices(
      limit: number
    ): Array<{ agent: string; action: string; target: string; timestamp: number }>;
  };
}

/**
 * API server instance
 */
export interface ApiServer {
  /** Express app instance */
  app: Express;
  /** HTTP server instance */
  server: HttpServer | null;
  /** Report slots store */
  reportStore: import('./report-handler.js').ReportStore;
  /** SSE clients for report updates */
  reportSseClients: Set<ServerResponse>;
  /** Start the server */
  start(): Promise<void>;
  /** Stop the server */
  stop(): Promise<void>;
  /** Get the port the server is listening on */
  port: number;
}

/**
 * Create and configure the API server
 */
export function createApiServer(options: ApiServerOptions): ApiServer {
  const {
    scheduler,
    port = 3847,
    logStore = new InMemoryLogStore(),
    heartbeatTracker = new InMemoryHeartbeatTracker(),
    onHeartbeat,
    enableAutoKillPort = false,
    db,
    memoryDb,
    skillRegistry,
    healthService,
    healthCheckService,
    rawStore,
    enabledConnectors,
    eventBus,
  } = options;

  const app = express();

  // Security headers
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    // Allow playgrounds to be loaded in iframes (viewer embeds them)
    if (!req.path.startsWith('/playgrounds/')) {
      res.setHeader('X-Frame-Options', 'DENY');
    } else {
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  // Middleware
  app.use(express.json({ limit: '1mb' }));
  app.use(createSecurityMiddleware());

  // CORS: allow only localhost/127.0.0.1 origins
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Global auth gate for ALL /api/* routes
  // When MAMA_AUTH_TOKEN is set, every /api request must carry a valid Bearer token.
  // Without token configured, only localhost is allowed (isAuthenticated handles this).
  app.use('/api', requireAuth);

  // Set Content-Type header for API responses only (exclude media endpoints)
  app.use('/api', (req, res, next) => {
    if (!req.path.startsWith('/media')) {
      res.setHeader('Content-Type', 'application/json');
    }
    next();
  });

  // Mount API routers
  const cronRouter = createCronRouter(scheduler, logStore);
  const heartbeatRouter = createHeartbeatRouter({
    scheduler,
    logStore,
    tracker: heartbeatTracker,
    onHeartbeat,
  });

  app.use('/api/cron', cronRouter);
  app.use('/api/heartbeat', heartbeatRouter);

  // Mount report store (created early so intelligence router can reference it)
  const reportSseClients = new Set<ServerResponse>();
  const reportStore = createReportStore();

  // Mount token router if database is available
  if (db) {
    initTokenUsageTable(db);
    const tokenRouter = createTokenRouter(db);
    app.use('/api/tokens', tokenRouter);

    const intelligenceDb = memoryDb ?? db;
    const intelligenceRouter = createIntelligenceRouter(intelligenceDb, {
      reportStore,
      eventBus,
    });
    app.use('/api/intelligence', intelligenceRouter);
  }

  // Mount skills router if registry is available
  if (skillRegistry) {
    const skillsRouter = createSkillsRouter(skillRegistry);
    app.use('/api/skills', skillsRouter);
  }

  // Mount report router (always available)
  const reportRouter = createReportRouter(reportStore, reportSseClients);
  app.use('/api/report', reportRouter);

  // Mount wiki router if wiki path is configured
  const wikiPath = options.wikiPath;
  if (wikiPath) {
    const wikiRouter = createWikiRouter(wikiPath);
    app.use('/api/wiki', wikiRouter);
  }

  // Connector status endpoint — reads connectors.json + runtime state
  app.get('/api/connectors/status', (_req, res) => {
    const configPath = join(homedir(), '.mama', 'connectors.json');
    let config: Record<
      string,
      {
        enabled?: boolean;
        pollIntervalMinutes?: number;
        channels?: Record<string, unknown>;
        auth?: unknown;
      }
    > = {};
    try {
      if (existsSync(configPath)) {
        config = JSON.parse(readFileSync(configPath, 'utf-8'));
      }
    } catch {
      /* empty */
    }
    const connectors = AVAILABLE_CONNECTORS.map((name) => {
      const cfg = config[name];
      return {
        name,
        enabled: cfg?.enabled ?? false,
        healthy: cfg?.enabled ?? false,
        lastPollTime: null,
        lastPollCount: 0,
        channelCount: cfg?.channels ? Object.keys(cfg.channels).length : 0,
        pollIntervalMinutes: cfg?.pollIntervalMinutes ?? 60,
      };
    });
    res.json({ connectors });
  });

  // Mount connector feed router (activity + per-connector feed)
  if (rawStore && enabledConnectors && enabledConnectors.length > 0) {
    const connectorFeedRouter = createConnectorFeedRouter(rawStore, enabledConnectors);
    app.use('/api/connectors', connectorFeedRouter);
  }

  // Health check endpoint (watchdog)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  // Metrics health endpoint (observability)
  app.get('/api/metrics/health', async (_req, res) => {
    if (healthCheckService) {
      try {
        const report = await healthCheckService.check();
        res.json(report);
      } catch (e) {
        console.error('[API] /api/metrics/health error:', e);
        res.status(500).json({ error: String(e) });
      }
    } else if (healthService) {
      try {
        res.json(healthService.compute());
      } catch (e) {
        console.error('[API] /api/metrics/health error:', e);
        res.status(500).json({ error: String(e) });
      }
    } else {
      res.status(503).json({ error: 'Metrics not available' });
    }
  });

  // Note: Error handlers are mounted in start() to allow adding custom routes first

  let server: HttpServer | null = null;
  let actualPort = port;
  let errorHandlersMounted = false;

  return {
    app,
    reportStore,
    reportSseClients,
    get server() {
      return server;
    },
    get port() {
      return actualPort;
    },
    async start(): Promise<void> {
      // Mount error handlers right before starting
      if (!errorHandlersMounted) {
        app.use(notFoundHandler);
        app.use(errorHandler);
        errorHandlersMounted = true;
      }

      const host = process.env.MAMA_API_HOST || '127.0.0.1';
      const enablePortFallback = process.env.MAMA_API_PORT_FALLBACK === 'true';
      let attemptPort = port; // Mutable copy for fallback attempts

      const tryListen = (): Promise<void> =>
        new Promise((resolve, reject) => {
          let settled = false;
          const candidate = createServer(app);

          const cleanup = () => {
            candidate.removeAllListeners();
            try {
              candidate.close();
            } catch {
              /* already closed */
            }
          };

          try {
            candidate.on('error', (err: NodeJS.ErrnoException) => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(err);
            });
            // exclusive: false → SO_REUSEADDR, allows binding over TIME_WAIT sockets
            candidate.listen({ port: attemptPort, host, exclusive: false }, () => {
              if (settled) return;
              settled = true;
              const addr = candidate.address();
              if (addr && typeof addr === 'object') {
                server = candidate; // Only assign on success
                actualPort = addr.port;
                console.log(`API server listening on http://${host}:${actualPort}`);
                if (host === '0.0.0.0') {
                  console.warn('⚠️  WARNING: API server exposed to all interfaces!');
                  console.warn('   Set MAMA_API_HOST=127.0.0.1 for local-only access');
                }
                resolve();
              } else {
                cleanup();
                reject(new Error(`Failed to bind to port ${attemptPort}`));
              }
            });
          } catch (error) {
            if (!settled) {
              settled = true;
              cleanup();
              reject(error);
            }
          }
        });

      const MAX_RETRIES = 5;
      const RETRY_DELAY_MS = 2000;
      const MAX_PORT_FALLBACK = 10;
      let fallbackCount = 0;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          await tryListen();
          break; // Success
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
          if (err.code === 'EADDRINUSE' && attempt < MAX_RETRIES) {
            console.warn(
              `Port ${attemptPort} in use (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${RETRY_DELAY_MS}ms...`
            );
            if (attempt === 0) {
              // First retry: show what's using the port
              console.error(
                `\n❌ Port ${attemptPort} is already in use.\n\n` +
                  `Options:\n` +
                  `1. Stop the process using port ${attemptPort}\n` +
                  `2. Use a different port: MAMA_API_PORT=<port> mama start\n` +
                  `3. Enable port fallback: MAMA_API_PORT_FALLBACK=true mama start\n` +
                  `4. Enable auto-kill: enableAutoKillPort=true (USE WITH CAUTION)\n`
              );

              // Try to identify the process (informational only)
              let processInfo = '';
              try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { execSync } = require('child_process');
                processInfo = execSync(
                  `lsof -i :${attemptPort} 2>/dev/null | grep LISTEN || echo ""`,
                  {
                    timeout: 2000,
                    encoding: 'utf8',
                  }
                );
                if (processInfo.trim()) {
                  console.error(`Process using port ${attemptPort}:\n${processInfo}`);
                }
              } catch {
                /* ignore - lsof might not be available */
              }

              // Auto-kill process if explicitly enabled (opt-in)
              if (enableAutoKillPort && processInfo.trim()) {
                if (!Number.isInteger(attemptPort)) {
                  throw new Error(`Invalid port number: ${attemptPort}`);
                }
                console.warn(
                  `⚠️  AUTO-KILL ENABLED: Attempting to kill process on port ${attemptPort}`
                );
                try {
                  // eslint-disable-next-line @typescript-eslint/no-require-imports
                  const { execSync } = require('child_process');
                  execSync(`kill -9 $(lsof -ti:${attemptPort})`, { timeout: 3000 });
                  console.log(`✅ Process on port ${attemptPort} killed successfully`);
                  // Continue with current attempt instead of waiting
                  continue;
                } catch (killError) {
                  console.error(`❌ Failed to kill process on port ${attemptPort}:`, killError);
                  // Fall through to normal retry logic
                }
              }
            }
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          } else if (err.code === 'EADDRINUSE') {
            // All retries failed - try fallback port if enabled
            if (enablePortFallback && attemptPort < 65535) {
              fallbackCount++;
              if (fallbackCount > MAX_PORT_FALLBACK) {
                throw new Error(
                  `Failed to find an available port after trying ${MAX_PORT_FALLBACK} fallback ports from ${port}.`
                );
              }
              const fallbackPort = attemptPort + 1;
              console.log(
                `\n🔄 Port ${attemptPort} unavailable after ${MAX_RETRIES + 1} attempts. ` +
                  `Trying fallback port ${fallbackPort}... (${fallbackCount}/${MAX_PORT_FALLBACK})`
              );
              attemptPort = fallbackPort;
              actualPort = fallbackPort;
              attempt = -1; // Reset attempts for new port
            } else {
              throw new Error(
                `Failed to bind to port ${attemptPort} after ${MAX_RETRIES + 1} attempts. ` +
                  `Enable port fallback with MAMA_API_PORT_FALLBACK=true`
              );
            }
          } else {
            throw err;
          }
        }
      }
    },
    async stop(): Promise<void> {
      if (!server) {
        return;
      }
      const s = server;
      server = null;

      // Force-close all connections (idle + active)
      s.closeAllConnections();

      return new Promise<void>((resolve) => {
        const timeoutId = setTimeout(resolve, 2000);
        s.close(() => {
          clearTimeout(timeoutId);
          resolve();
        });
      });
    },
  };
}

/**
 * Create API routers without starting a server
 * Useful for integrating into an existing Express app
 */
export function createApiRouters(options: ApiServerOptions): {
  cronRouter: Router;
  heartbeatRouter: Router;
} {
  const {
    scheduler,
    logStore = new InMemoryLogStore(),
    heartbeatTracker = new InMemoryHeartbeatTracker(),
    onHeartbeat,
  } = options;

  return {
    cronRouter: createCronRouter(scheduler, logStore),
    heartbeatRouter: createHeartbeatRouter({
      scheduler,
      logStore,
      tracker: heartbeatTracker,
      onHeartbeat,
    }),
  };
}
