/**
 * Graceful shutdown handler for MAMA OS.
 *
 * Extracted from cli/commands/start.ts (Task 12 Part B).
 * Contains the ordered teardown logic, signal handlers,
 * uncaught error handlers, keep-alive interval, and force
 * exit timer.
 */

import http from 'node:http';

import type { AgentLoop } from '../../agent/index.js';
import type { SessionStore } from '../../gateways/session-store.js';
import type { Stoppable } from './server-start.js';
import type { PluginLoader } from '../../gateways/plugin-loader.js';
import type { MetricsStore } from '../../observability/metrics-store.js';
import type { CronScheduler, CronWorker, TokenKeepAlive } from '../../scheduler/index.js';
import type { HeartbeatScheduler } from '../../scheduler/heartbeat.js';
import type { SQLiteDatabase } from '../../sqlite.js';
import { stopAgentLoops } from '../../cli/shutdown-utils.js';
import { getSessionPool } from '../../agent/session-pool.js';
import {
  EMBEDDING_PORT,
  getEmbeddingServer,
  setEmbeddingServer,
  getEmbeddingShutdownToken,
  waitForPortAvailable,
} from './utilities.js';

import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';

const { DebugLogger } = debugLogger as unknown as {
  DebugLogger: new (context?: string) => {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};
const shutdownLogger = new DebugLogger('shutdown');

export interface ShutdownDeps {
  // Intervals
  metricsInterval: ReturnType<typeof setInterval> | null;
  healthWarningInterval: ReturnType<typeof setInterval> | null;

  // Schedulers
  scheduler: CronScheduler;
  cronWorker: CronWorker;
  heartbeatScheduler: HeartbeatScheduler;
  tokenKeepAlive: TokenKeepAlive;

  // Gateways
  gateways: Stoppable[];
  pluginLoader: PluginLoader;

  // Agent loops
  agentLoop: AgentLoop;
  memoryAgentLoop: AgentLoop | null;

  // Session/DB
  sessionStore: SessionStore;
  db: SQLiteDatabase;

  // Metrics
  metricsStore: MetricsStore | null;
  metricsCleanup: { stop: () => void } | null;
}

// ── Debug helpers ───────────────────────────────────────────────────────────

function getBlockingHandleNames(): string[] {
  const processWithHandles = process as NodeJS.Process & {
    _getActiveHandles?: () => unknown[];
  };
  const getActiveHandles = processWithHandles._getActiveHandles;
  if (typeof getActiveHandles !== 'function') {
    return ['unknown'];
  }
  const handles = getActiveHandles.call(processWithHandles);
  const ignoredHandles = new Set(['WriteStream', 'ReadStream', 'TTY', 'TTYWrap']);
  return (
    handles
      ?.map((handle) => (handle as { constructor?: { name?: string } }).constructor?.name)
      .filter((name): name is string => typeof name === 'string' && !ignoredHandles.has(name)) ?? []
  );
}

function getActiveRequestNames(): string[] {
  const processWithRequests = process as NodeJS.Process & {
    _getActiveRequests?: () => unknown[];
  };
  const getActiveRequests = processWithRequests._getActiveRequests;
  if (typeof getActiveRequests !== 'function') {
    return ['unknown'];
  }
  const requests = getActiveRequests.call(processWithRequests);
  return (
    requests
      ?.map((request) => (request as { constructor?: { name?: string } }).constructor?.name)
      .filter((name): name is string => typeof name === 'string') ?? []
  );
}

/**
 * Install graceful shutdown handlers and keep-alive interval.
 *
 * Registers SIGINT, SIGTERM, SIGHUP, uncaughtException, and
 * unhandledRejection handlers, plus the keep-alive setInterval
 * that keeps the Node.js event loop active.
 */
export function installShutdownHandlers(deps: ShutdownDeps): void {
  let shuttingDown = false;
  let keepAliveInterval: ReturnType<typeof setInterval> | null = null;

  const shutdown = async () => {
    if (shuttingDown) return; // Prevent double shutdown
    shuttingDown = true;
    console.log('\n\n🛑 Shutting down MAMA...');

    // Clear periodic intervals
    if (deps.metricsInterval) {
      clearInterval(deps.metricsInterval);
    }
    if (deps.healthWarningInterval) {
      clearInterval(deps.healthWarningInterval);
    }
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
    }

    // Force exit after 5 seconds if graceful shutdown hangs
    // exit(0) = intentional stop; systemd Restart=on-failure should NOT restart
    const forceExitTimer = setTimeout(() => {
      const blockingHandles = getBlockingHandleNames();
      const activeRequests = getActiveRequestNames();
      if (blockingHandles.length === 0 && activeRequests.length === 0) {
        return;
      }
      console.error('[MAMA] Graceful shutdown timed out, forcing exit');
      process.kill(process.pid, 'SIGKILL');
    }, 5000);
    forceExitTimer.unref();

    try {
      // Stop schedulers and cron worker first
      deps.scheduler.shutdown();
      await deps.cronWorker.stop();
      deps.heartbeatScheduler.stop();
      deps.tokenKeepAlive.stop();

      // Close embedding server (port 3849) - drain connections first
      if (getEmbeddingServer()) {
        await new Promise<void>((resolve) => {
          const shutdownReq = http.request(
            {
              hostname: '127.0.0.1',
              port: EMBEDDING_PORT,
              path: '/shutdown',
              method: 'POST',
              timeout: 2000,
              headers: {
                'X-Shutdown-Token':
                  getEmbeddingShutdownToken() || process.env.MAMA_SHUTDOWN_TOKEN || '',
              },
            },
            async (response) => {
              const statusCode = response.statusCode ?? 0;
              const released = await waitForPortAvailable(EMBEDDING_PORT, 5000);
              if (statusCode >= 200 && statusCode < 300 && released) {
                resolve();
                return;
              }

              shutdownLogger.warn(
                `[EmbeddingServer] Shutdown endpoint did not fully stop server (status=${statusCode}, released=${released})`
              );
              const srv = getEmbeddingServer();
              if (srv) {
                srv.close(() => resolve());
                return;
              }
              resolve();
            }
          );
          shutdownReq.on('error', () => resolve());
          shutdownReq.on('timeout', () => {
            shutdownReq.destroy();
            resolve();
          });
          shutdownReq.end();
        });
        setEmbeddingServer(null);
      }

      // Stop all gateways with per-gateway 2s timeout
      const withTimeout = (p: Promise<void>, ms: number) =>
        Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]);
      await Promise.allSettled(
        deps.gateways.map((g) => withTimeout(Promise.resolve(g.stop()), 2000))
      );

      // Stop plugin gateways
      await withTimeout(
        deps.pluginLoader.stopAll().catch(() => {}),
        1000
      );

      // Stop agent loop
      await stopAgentLoops([deps.agentLoop, deps.memoryAgentLoop]);

      // Release all CLI sessions
      getSessionPool().dispose();

      // Close session database
      deps.sessionStore.close();

      // Stop metrics cleanup
      deps.metricsCleanup?.stop();

      deps.metricsStore?.close();

      deps.db.close();

      const { deletePid } = await import('../utils/pid-manager.js');
      await deletePid();
      const blockingHandles = getBlockingHandleNames();
      const activeRequests = getActiveRequestNames();
      if (blockingHandles.length === 0 && activeRequests.length === 0) {
        clearTimeout(forceExitTimer);
      } else if (
        blockingHandles.length === 0 &&
        activeRequests.length > 0 &&
        activeRequests.every((name) => name === 'FSReqPromise')
      ) {
        process.kill(process.pid, 'SIGKILL');
      }
    } catch (error) {
      // Best effort cleanup
      console.warn('[MAMA] Cleanup error during shutdown:', error);
    }

    process.exitCode = 0;
    return;
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Ignore SIGHUP (sent when terminal closes) - daemon should keep running
  process.on('SIGHUP', () => {
    console.log('[MAMA] Received SIGHUP - ignoring (daemon mode)');
  });

  // Handle uncaught errors to prevent crashes
  process.on('uncaughtException', (error) => {
    console.error('[MAMA] Uncaught exception:', error);
    // Don't exit - try to keep running
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[MAMA] Unhandled rejection:', reason);
    // Don't exit - try to keep running
  });

  console.log('MAMA agent is waiting...\n');

  // Keep process alive using setInterval
  // This ensures the Node.js event loop stays active
  keepAliveInterval = setInterval(() => {
    // Heartbeat - keeps the process running
  }, 30000); // Every 30 seconds
}
