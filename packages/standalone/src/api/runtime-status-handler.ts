/**
 * Authoritative runtime status route.
 *
 * Operational clients used to assemble "what is running" from stale config,
 * which could name a backend or model the daemon was not using. This route is
 * the single answer: a snapshot supplied by the running daemon and serialized
 * verbatim.
 *
 * The handler owns no state and reads no config, PID or credential. Everything
 * it reports comes from the injected supplier, so the route can never invent a
 * value the runtime did not produce.
 */

import { Router } from 'express';
import { requireAuth } from './auth-middleware.js';

export type RuntimeBackend = 'claude' | 'codex' | 'cline';

export type RuntimeConnectorState = 'connected' | 'disconnected' | 'unknown';

export interface RuntimeConnectorStatus {
  name: string;
  enabled: boolean;
  state: RuntimeConnectorState;
}

export interface RuntimeStatusSnapshot {
  running: boolean;
  version: string;
  backend: RuntimeBackend;
  model: string;
  startedAt: number;
  /**
   * Nullable on purpose: the daemon boots with `healthService: HealthScoreService | null`
   * (api-server-init.ts). When there is no health service the answer is "unavailable",
   * never a fabricated score.
   */
  health: { score: number; status: string } | null;
  connectors: RuntimeConnectorStatus[];
}

export interface RuntimeStatusRouterOptions {
  getRuntimeStatus: () => RuntimeStatusSnapshot | Promise<RuntimeStatusSnapshot>;
}

/**
 * Serialize exactly the snapshot contract - no passthrough of extra supplier
 * fields, so a future supplier change cannot silently widen the wire format.
 */
function serializeSnapshot(snapshot: RuntimeStatusSnapshot): RuntimeStatusSnapshot {
  return {
    running: snapshot.running,
    version: snapshot.version,
    backend: snapshot.backend,
    model: snapshot.model,
    startedAt: snapshot.startedAt,
    health: snapshot.health
      ? { score: snapshot.health.score, status: snapshot.health.status }
      : null,
    connectors: (snapshot.connectors ?? []).map((connector) => ({
      name: connector.name,
      enabled: connector.enabled,
      state: connector.state,
    })),
  };
}

export function createRuntimeStatusRouter(options: RuntimeStatusRouterOptions): Router {
  const router = Router();

  router.get('/status', requireAuth, async (_req, res) => {
    try {
      res.json(serializeSnapshot(await options.getRuntimeStatus()));
    } catch (error) {
      console.error('[API] /api/runtime/status error:', error);
      res.status(503).json({
        error: true,
        code: 'runtime_status_unavailable',
        message: 'Runtime status is unavailable.',
      });
    }
  });

  return router;
}
