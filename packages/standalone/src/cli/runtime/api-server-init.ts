/**
 * API Server initialisation.
 *
 * Extracted from start.ts (Task 11 Part A).
 * Creates the SkillRegistry, memoryDb wrapper, AgentEventBus,
 * and the API server itself.
 */

import { join } from 'node:path';

import { createApiServer } from '../../api/index.js';
import type { ApiServer } from '../../api/index.js';
import { SkillRegistry } from '../../skills/skill-registry.js';
import type { AgentLoop } from '../../agent/index.js';
import type { CronScheduler } from '../../scheduler/index.js';
import type { HealthScoreService } from '../../observability/health-score.js';
import type { HealthCheckService } from '../../observability/health-check.js';
import type { RawStore } from '../../connectors/framework/raw-store.js';
import type { SQLiteDatabase } from '../../sqlite.js';
import type { MAMAConfig } from '../config/types.js';
import type { RuntimeEnvelopeBootstrap } from './envelope-bootstrap.js';
import { API_PORT } from './utilities.js';

// Re-export SkillRegistry for consumers that need the same instance
export { SkillRegistry };

export interface InitApiServerParams {
  config: MAMAConfig;
  scheduler: CronScheduler;
  db: SQLiteDatabase;
  healthService: HealthScoreService | null;
  healthCheckService: HealthCheckService;
  rawStore: RawStore | undefined;
  enabledConnectors: string[];
  agentLoop: AgentLoop;
  envelopeMetadata?: RuntimeEnvelopeBootstrap['metadata'];
  /** mama-core getAdapter() — used to create the memoryDb shim */
  getAdapter: () => {
    prepare: (sql: string) => unknown;
    exec: (sql: string) => void;
  };
}

export interface InitApiServerResult {
  apiServer: ApiServer;
  eventBus: import('../../multi-agent/agent-event-bus.js').AgentEventBus;
  skillRegistry: SkillRegistry;
}

export async function initApiServer(params: InitApiServerParams): Promise<InitApiServerResult> {
  const {
    config,
    scheduler,
    db,
    healthService,
    healthCheckService,
    rawStore,
    enabledConnectors,
    agentLoop,
    getAdapter,
    envelopeMetadata,
  } = params;

  // ── SkillRegistry + MCP config migration ──────────────────────────────
  const skillRegistry = new SkillRegistry();
  skillRegistry
    .migrateExistingMcpConfigs()
    .catch((err: unknown) => console.warn('[start] MCP config migration warning:', err));

  // ── memoryDb wrapper (adapter → SQLiteDatabase shim) ──────────────────
  const mamaCoreAdapter = getAdapter();
  const memoryDb = {
    prepare: (sql: string) => mamaCoreAdapter.prepare(sql),
    exec: (sql: string) => mamaCoreAdapter.exec(sql),
    close: () => {},
    pragma: () => undefined,
    transaction: () => {
      throw new Error('Not supported on memoryDb wrapper');
    },
    get open() {
      return true;
    },
    driver: 'better-sqlite3' as const,
  };

  // ── Wiki path ─────────────────────────────────────────────────────────
  const wikiApiPath = (
    config.wiki as { enabled?: boolean; vaultPath?: string; wikiDir?: string } | undefined
  )?.enabled
    ? join(
        (config.wiki as { vaultPath: string }).vaultPath,
        (config.wiki as { wikiDir?: string }).wikiDir || 'wiki'
      )
    : undefined;

  // ── AgentEventBus ─────────────────────────────────────────────────────
  const { AgentEventBus } = await import('../../multi-agent/agent-event-bus.js');
  const eventBus = new AgentEventBus();

  // ── createApiServer() ─────────────────────────────────────────────────
  const apiServer = createApiServer({
    scheduler,
    port: API_PORT,
    db,
    memoryDb: memoryDb as unknown as SQLiteDatabase,
    skillRegistry,
    wikiPath: wikiApiPath,
    healthService: healthService ?? undefined,
    healthCheckService,
    rawStore,
    enabledConnectors,
    eventBus,
    envelope: envelopeMetadata,
    onHeartbeat: async (prompt) => {
      try {
        const result = await agentLoop.run(prompt);
        // Capture agent's text response and use it as the briefing slot
        const { broadcastReportUpdate: broadcast } = await import('../../api/report-handler.js');
        const agentText = result?.response || '';
        if (agentText.length > 50 && apiServer.reportStore) {
          // Wrap agent's analysis in styled HTML
          const briefingHtml = `<div style="font-family:Nunito,sans-serif;font-size:13px;color:#1A1A1A;line-height:1.6">${agentText.replace(/\n/g, '<br>').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')}</div>`;
          apiServer.reportStore.update('briefing', briefingHtml, 0);
          broadcast(apiServer.reportSseClients, {
            slots: apiServer.reportStore.getAllSorted(),
          });
          console.log(`[Report] Agent briefing published (${agentText.length} chars)`);
        }
        return { success: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
    enableAutoKillPort: config.enable_auto_kill_port,
  });

  return { apiServer, eventBus, skillRegistry };
}
