/**
 * API server start and WebSocket upgrade handler.
 *
 * Extracted from cli/commands/start.ts (Task 12 Part A).
 * Waits for port availability, starts the API server, sets up
 * the WebSocket upgrade handler (setup-ws local + /ws proxy to
 * embedding port), and enforces auth on non-localhost connections.
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';

import type { ApiServer } from '../../api/index.js';
import {
  isAuthenticated,
  isLocalRequest,
  isTrustedCloudflareAccessRequest,
  getSecurityLogContext,
} from '../../api/auth-middleware.js';
import { recordSecurityEvent } from '../../security/security-monitor.js';
import { createSetupWebSocketHandler } from '../../setup/setup-websocket.js';
import { API_PORT, EMBEDDING_PORT, waitForPortAvailable } from './utilities.js';

import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';

const { DebugLogger } = debugLogger as unknown as {
  DebugLogger: new (context?: string) => {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};
const startLogger = new DebugLogger('server-start');

/** Anything that can be stopped during shutdown. */
export type Stoppable = { stop: () => Promise<void> | void };

export interface StartServerParams {
  apiServer: ApiServer;
  gateways: Stoppable[];
}

/**
 * Wait for the API port, start the server, set up WebSocket
 * upgrade handling, and push the server into the gateways array.
 */
export async function startServer(params: StartServerParams): Promise<void> {
  const { apiServer, gateways } = params;

  // Wait for API port to become available (previous daemon may still be shutting down).
  // DO NOT kill processes on this port — that causes restart loops when Watchdog spawns
  // a new daemon while the old one is still releasing the port. Port cleanup is the
  // responsibility of `mama stop`, not daemon startup.
  const apiPortAvailable = await waitForPortAvailable(API_PORT, 20000);
  if (!apiPortAvailable) {
    console.error(
      `[API] Port ${API_PORT} still in use after 20s. Previous daemon may still be shutting down. ` +
        `Exiting — ${process.env.MAMA_DAEMON ? 'Watchdog will retry automatically.' : 'Run "mama stop" first, then retry.'}`
    );
    process.exit(1);
  }

  await apiServer.start();
  console.log(`API server started: http://localhost:${apiServer.port}`);

  if (apiServer.server) {
    // Setup WebSocket - use noServer mode to avoid conflict
    const setupWss = new WebSocketServer({ noServer: true });
    createSetupWebSocketHandler(setupWss);
    console.log('✓ Setup WebSocket handler ready for /setup-ws');

    // Handle ALL WebSocket upgrades manually
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apiServer.server.on('upgrade', (request: any, socket: any, head: any) => {
      let url: URL;
      try {
        url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
      } catch (error) {
        startLogger.warn('[SECURITY] Malformed WebSocket upgrade URL rejected', {
          rawUrl: request.url || null,
          error: error instanceof Error ? error.message : String(error),
        });
        socket.destroy();
        return;
      }

      // WebSocket auth: require token for non-localhost connections.
      // Browsers cannot set Authorization headers on WebSocket upgrades,
      // so we allow query-string token auth for this path only.
      const adminToken = process.env.MAMA_AUTH_TOKEN || process.env.MAMA_SERVER_TOKEN;
      const context = getSecurityLogContext(request);
      const isTrustedLocalUpgrade = isLocalRequest(request) && !context.viaTunnel;
      const isTrustedCloudflareUpgrade = isTrustedCloudflareAccessRequest(request);
      if (
        adminToken &&
        !isAuthenticated(request, { allowQueryToken: true }) &&
        !isTrustedCloudflareUpgrade
      ) {
        const details = { hasQueryToken: url.searchParams.has('token') };
        startLogger.warn('[SECURITY] Unauthorized WebSocket upgrade blocked', {
          ...context,
          ...details,
          path: url.pathname,
        });
        recordSecurityEvent({
          type: 'unauthorized_websocket_upgrade',
          severity: 'warn',
          message: 'Unauthorized WebSocket upgrade blocked',
          ...context,
          path: url.pathname,
          details,
        });
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      if (!adminToken && !isTrustedLocalUpgrade && !isTrustedCloudflareUpgrade) {
        const details = { hasQueryToken: url.searchParams.has('token') };
        startLogger.warn(
          '[SECURITY] Blocking non-localhost WebSocket upgrade without auth token configured',
          {
            ...context,
            ...details,
            path: url.pathname,
          }
        );
        recordSecurityEvent({
          type: 'unprotected_websocket_upgrade',
          severity: 'critical',
          message: 'Non-localhost WebSocket upgrade blocked without auth token configured',
          ...context,
          path: url.pathname,
          details,
        });
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      if (url.pathname === '/setup-ws') {
        // Handle setup WebSocket locally
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setupWss.handleUpgrade(request, socket, head, (ws: any) => {
          setupWss.emit('connection', ws, request);
        });
      } else if (url.pathname === '/ws') {
        // Proxy chat WebSocket to embedding server
        const options = {
          hostname: '127.0.0.1',
          port: EMBEDDING_PORT,
          path: request.url,
          method: 'GET',
          headers: {
            ...request.headers,
            host: `127.0.0.1:${EMBEDDING_PORT}`,
          },
        };

        const proxyReq = http.request(options);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        proxyReq.on('upgrade', (proxyRes: any, proxySocket: any, _proxyHead: any) => {
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\n` +
              `Upgrade: websocket\r\n` +
              `Connection: Upgrade\r\n` +
              `Sec-WebSocket-Accept: ${proxyRes.headers['sec-websocket-accept']}\r\n` +
              `\r\n`
          );
          proxySocket.pipe(socket);
          socket.pipe(proxySocket);
        });
        proxyReq.on('error', (err: Error) => {
          console.error('[WS Proxy] Error:', err.message);
          socket.destroy();
        });
        proxyReq.end();
      } else {
        // Unknown WebSocket path - close connection
        socket.destroy();
      }
    });
    console.log(
      `✓ WebSocket upgrade handler registered (/ws → ${EMBEDDING_PORT}, /setup-ws local)`
    );
  }

  gateways.push(apiServer);
}
