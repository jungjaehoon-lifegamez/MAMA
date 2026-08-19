/**
 * API Server initialisation.
 *
 * Extracted from start.ts (Task 11 Part A).
 * Creates the SkillRegistry, memoryDb wrapper, AgentEventBus,
 * and the API server itself.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';

import { createApiServer } from '../../api/index.js';
import type { ApiServer, RuntimeConnectorStatus, RuntimeStatusSnapshot } from '../../api/index.js';
import { visibleConnectorNames } from '../../connectors/private-connector-policy.js';
import { createPersistentReportStore } from '../../api/report-persistence.js';
import type { AgentSituationAdapter } from '../../api/agent-situation-handler.js';
import { liveBoundaryChannels } from '../../evidence/read.js';
import {
  createContextCompileService,
  type ContextCompileService,
} from '../../agent/context-compile-service.js';
import { SkillRegistry } from '../../skills/skill-registry.js';
import type { AgentLoop } from '../../agent/index.js';
import type { CronScheduler } from '../../scheduler/index.js';
import type { HealthScoreService } from '../../observability/health-score.js';
import type { HealthCheckService } from '../../observability/health-check.js';
import type { RawStore } from '../../connectors/framework/raw-store.js';
import type { ConnectorConfigLoadResult } from '../../connectors/config-loader.js';
import type { PrivateConnectorPolicy } from '../../connectors/private-connector-policy.js';
import type { SQLiteDatabase } from '../../sqlite.js';
import type { MAMAConfig } from '../config/types.js';
import { resolvePackageVersion } from '../../package-version.js';
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
  connectorConfigLoadResult: ConnectorConfigLoadResult;
  privateConnectorPolicy: PrivateConnectorPolicy;
  agentLoop: AgentLoop;
  envelopeMetadata?: RuntimeEnvelopeBootstrap['metadata'];
  envelopeAuthority?: RuntimeEnvelopeBootstrap['envelopeAuthority'];
  contextCompileService?: ContextCompileService;
  /** mama-core getAdapter() — used to create the memoryDb shim */
  getAdapter: () => AgentSituationAdapter & {
    exec: (sql: string) => void;
  };
}

export interface InitApiServerResult {
  apiServer: ApiServer;
  eventBus: import('../../multi-agent/agent-event-bus.js').AgentEventBus;
  skillRegistry: SkillRegistry;
}

/**
 * Project the connectors the runtime actually booted with.
 *
 * Only CONFIGURED connectors are listed (so an unconfigured install honestly
 * shows an empty list), filtered through the private-connector visibility
 * policy. `state` reports registration truth, not a guess: a connector the
 * daemon registered is `connected`, one that is switched off is
 * `disconnected`, and one that is enabled in config but absent from the boot
 * registry is `unknown` rather than being claimed as healthy.
 */
export function projectRuntimeConnectors(
  connectorConfigLoadResult: ConnectorConfigLoadResult,
  enabledConnectors: readonly string[]
): RuntimeConnectorStatus[] {
  const configuredNames = Object.keys(connectorConfigLoadResult.config);
  const registered = new Set(enabledConnectors);
  return visibleConnectorNames(configuredNames)
    .filter((name) => configuredNames.includes(name))
    .map((name) => {
      const enabled =
        (connectorConfigLoadResult.config as Record<string, { enabled?: boolean } | undefined>)[
          name
        ]?.enabled ?? false;
      const state: RuntimeConnectorStatus['state'] = registered.has(name)
        ? 'connected'
        : enabled
          ? 'unknown'
          : 'disconnected';
      return { name, enabled, state };
    });
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
    connectorConfigLoadResult,
    privateConnectorPolicy,
    agentLoop,
    getAdapter,
    envelopeMetadata,
    envelopeAuthority,
    contextCompileService: suppliedContextCompileService,
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
  const contextCompileService =
    suppliedContextCompileService ??
    createContextCompileService({
      memoryAdapter: mamaCoreAdapter,
      channelGrant: liveBoundaryChannels,
    });
  // --- Authoritative runtime snapshot ---------------------------------
  // Built from what this boot already resolved. It deliberately does NOT read
  // agents.ts or any stored model registry: the Viewer must show the backend
  // and model this process is running, not a catalog default.
  const daemonStartedAt = Math.round(Date.now() - process.uptime() * 1000);
  const packageVersion = resolvePackageVersion();
  const getRuntimeStatus = (): RuntimeStatusSnapshot => {
    let health: RuntimeStatusSnapshot['health'] = null;
    if (healthService) {
      try {
        const report = healthService.compute();
        health = { score: report.score, status: report.status };
      } catch (error) {
        console.warn('[start] runtime health unavailable:', error);
        health = null;
      }
    }
    return {
      running: true,
      version: packageVersion,
      backend: config.agent.backend,
      model: config.agent.model,
      startedAt: daemonStartedAt,
      health,
      connectors: projectRuntimeConnectors(connectorConfigLoadResult, enabledConnectors),
    };
  };

  const apiServer = createApiServer({
    scheduler,
    port: API_PORT,
    getRuntimeStatus,
    // Daemon runtime is the ONLY place the persistent store is wired; the
    // in-memory default keeps test call sites off the real ~/.mama.
    reportStore: createPersistentReportStore({
      filePath: join(homedir(), '.mama', 'report-slots.json'),
    }),
    db,
    memoryDb: memoryDb as unknown as SQLiteDatabase,
    memoryAdapter: mamaCoreAdapter,
    skillRegistry,
    wikiPath: wikiApiPath,
    healthService: healthService ?? undefined,
    healthCheckService,
    rawStore,
    enabledConnectors,
    eventBus,
    envelope: envelopeMetadata,
    envelopeAuthority,
    contextCompileService,
    connectorConfigLoadResult,
    privateConnectorPolicy,
    onHeartbeat: async (prompt) => {
      try {
        const result = await agentLoop.run(prompt);
        // Capture agent's text response and use it as the briefing slot,
        // through the same single write path the report_publish tool uses.
        const { createReportPublisher } = await import('../../api/report-handler.js');
        const agentText = result?.response || '';
        if (agentText.length > 50 && apiServer.reportStore) {
          // Wrap agent's analysis in styled HTML
          const briefingHtml = `<div style="font-family:Nunito,sans-serif;font-size:13px;color:#1A1A1A;line-height:1.6">${agentText.replace(/\n/g, '<br>').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')}</div>`;
          const publish = createReportPublisher(apiServer.reportStore, apiServer.reportSseClients);
          publish({ briefing: briefingHtml });
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
