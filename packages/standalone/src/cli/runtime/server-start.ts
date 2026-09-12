/**
 * API server startup.
 *
 * Extracted from cli/commands/start.ts (Task 12 Part A).
 * Waits for port availability and starts the operational API server.
 */

import type { ApiServer } from '../../api/index.js';
import { API_PORT, waitForPortAvailable } from './utilities.js';

/** Anything that can be stopped during shutdown. */
export type Stoppable = { stop: () => Promise<void> | void };

export interface StartServerParams {
  apiServer: ApiServer;
  gateways: Stoppable[];
}

/**
 * Wait for the API port, start the server, and push it into the gateways array.
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

  gateways.push(apiServer);
}
