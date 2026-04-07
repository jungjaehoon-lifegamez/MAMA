/**
 * Connector API router for /api/connectors endpoints.
 * Provides status, event stream, and manual poll trigger for the Control Tower UI.
 */

import { Router } from 'express';
import { asyncHandler } from './error-handler.js';
import type { ConnectorEventLog } from './connector-event-log.js';
import type { ConnectorRegistry } from '../connectors/framework/connector-registry.js';
import type { PollingScheduler } from '../connectors/framework/polling-scheduler.js';
import type { ChannelConfig } from '../connectors/framework/types.js';
import { AVAILABLE_CONNECTORS } from '../connectors/index.js';

export interface ConnectorHandlerDeps {
  registry: ConnectorRegistry | null;
  scheduler: PollingScheduler | null;
  eventLog: ConnectorEventLog;
  channelConfigs: Record<string, Record<string, ChannelConfig>>;
  /** Callback to trigger a full pollAll cycle */
  triggerPoll?: () => Promise<void>;
}

export function createConnectorRouter(deps: ConnectorHandlerDeps): Router {
  const router = Router();

  // GET /api/connectors/status — health + last poll for all connectors
  router.get(
    '/status',
    asyncHandler(async (_req, res) => {
      const { registry, scheduler } = deps;
      const connectors: Array<{
        name: string;
        enabled: boolean;
        healthy: boolean;
        lastPollTime: string | null;
        lastPollCount: number;
        channelCount: number;
      }> = [];

      const healthMap = registry ? await registry.healthCheckAll() : {};
      const activeNames = registry ? [...registry.getActive().keys()] : [];

      for (const name of AVAILABLE_CONNECTORS) {
        const isActive = activeNames.includes(name);
        const health = healthMap[name];
        const lastPoll = scheduler?.getLastPollTime(name);
        const channels = deps.channelConfigs[name] ?? {};
        connectors.push({
          name,
          enabled: isActive,
          healthy: health?.healthy ?? false,
          lastPollTime: lastPoll?.toISOString() ?? null,
          lastPollCount: health?.lastPollCount ?? 0,
          channelCount: Object.keys(channels).length,
        });
      }

      res.json({ connectors });
    })
  );

  // GET /api/connectors/events — recent extraction events
  router.get('/events', (_req, res) => {
    const limitParam = Array.isArray(_req.query.limit) ? _req.query.limit[0] : _req.query.limit;
    const limit = Math.min(Number(limitParam) || 50, 200);
    res.json({
      events: deps.eventLog.getRecent(limit),
      stats: deps.eventLog.getStats(),
    });
  });

  // POST /api/connectors/:name/poll — trigger manual poll (fire-and-forget)
  router.post(
    '/:name/poll',
    asyncHandler(async (req, res) => {
      const name = req.params.name as string;
      if (!deps.registry?.get(name)) {
        res.status(404).json({ error: `Connector "${name}" not found or not active` });
        return;
      }
      if (deps.triggerPoll) {
        deps.triggerPoll().catch((err) => console.error(`[connector] manual poll error:`, err));
      }
      res.json({ success: true, message: `Poll triggered for ${name}` });
    })
  );

  // POST /api/connectors/:name/toggle — enable/disable a connector
  router.post(
    '/:name/toggle',
    asyncHandler(async (req, res) => {
      const name = req.params.name as string;
      const { enabled } = req.body as { enabled?: boolean };

      if (!(AVAILABLE_CONNECTORS as readonly string[]).includes(name)) {
        res.status(404).json({ error: `Unknown connector: ${name}` });
        return;
      }

      // Read and update connectors.json
      const { existsSync, readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');

      const configPath = join(homedir(), '.mama', 'connectors.json');
      const dir = join(homedir(), '.mama');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      let config: Record<string, unknown> = {};
      if (existsSync(configPath)) {
        try {
          config = JSON.parse(readFileSync(configPath, 'utf-8'));
        } catch {
          config = {};
        }
      }

      if (!config[name]) {
        config[name] = {
          enabled: enabled ?? true,
          pollIntervalMinutes: 60,
          channels: {},
          auth: { type: 'none' },
        };
      } else {
        (config[name] as Record<string, unknown>).enabled = enabled ?? true;
      }

      writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      res.json({
        success: true,
        message: `Connector "${name}" ${enabled ? 'enabled' : 'disabled'}. Restart MAMA OS to apply.`,
      });
    })
  );

  return router;
}
