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

      return new Promise((resolve, reject) => {
        try {
          // SECURITY: Bind to localhost only to prevent remote access
          const host = process.env.MAMA_API_HOST || '127.0.0.1';
          server = app.listen(port, host, () => {
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
              reject(new Error(`Failed to bind to port ${port}`));
            }
          });
          server.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
              console.error(
                `Port ${port} is already in use. Try: lsof -i :${port} | awk 'NR>1 {print $2}' | xargs kill`
              );
            }
            reject(err);
          });
        } catch (error) {
          reject(error);
        }
      });
    },
    async stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        if (!server) {
          resolve();
          return;
        }
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
