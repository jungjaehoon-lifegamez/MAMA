/**
 * API module exports
 *
 * Provides HTTP API for cron job management and heartbeat functionality.
 */

import express, { type Express, type Router } from 'express';
import { createCronRouter, InMemoryLogStore, type ExecutionLogStore } from './cron-handler.js';
import {
  createHeartbeatRouter,
  InMemoryHeartbeatTracker,
  type HeartbeatTracker,
} from './heartbeat-handler.js';
import { errorHandler, notFoundHandler } from './error-handler.js';
import { CronScheduler } from '../scheduler/index.js';

// Re-export types
export * from './types.js';
export type { ExecutionLogStore } from './cron-handler.js';
export { InMemoryLogStore, ScheduleStoreAdapter } from './cron-handler.js';
export type { HeartbeatTracker } from './heartbeat-handler.js';
export { InMemoryHeartbeatTracker, DEFAULT_HEARTBEAT_PROMPT } from './heartbeat-handler.js';
export { asyncHandler, validateRequired, ApiError } from './error-handler.js';

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
}

/**
 * API server instance
 */
export interface ApiServer {
  /** Express app instance */
  app: Express;
  /** HTTP server instance */
  server: ReturnType<(typeof import('express'))['application']['listen']> | null;
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
  } = options;

  const app = express();

  // Middleware
  app.use(express.json());

  // Set Content-Type header for API responses only
  app.use('/api', (_req, res, next) => {
    res.setHeader('Content-Type', 'application/json');
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

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  // Note: Error handlers are mounted in start() to allow adding custom routes first

  let server: ReturnType<typeof app.listen> | null = null;
  let actualPort = port;
  let errorHandlersMounted = false;

  return {
    app,
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
          try {
            server = app.listen(attemptPort, host, () => {
              if (settled) return;
              settled = true;
              const addr = server?.address();
              if (addr && typeof addr === 'object') {
                actualPort = addr.port;
                console.log(`API server listening on http://${host}:${actualPort}`);
                if (host === '0.0.0.0') {
                  console.warn('⚠️  WARNING: API server exposed to all interfaces!');
                  console.warn('   Set MAMA_API_HOST=127.0.0.1 for local-only access');
                }
                resolve();
              } else {
                reject(new Error(`Failed to bind to port ${attemptPort}`));
              }
            });
            server.on('error', (err: NodeJS.ErrnoException) => {
              if (settled) return;
              settled = true;
              reject(err);
            });
          } catch (error) {
            if (!settled) {
              settled = true;
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
      return new Promise((resolve, reject) => {
        if (!server) {
          resolve();
          return;
        }
        // Force-close all open connections so server.close() resolves immediately
        server.closeAllConnections();
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            server = null;
            resolve();
          }
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
