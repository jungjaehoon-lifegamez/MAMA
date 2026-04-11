/**
 * mama start command — thin orchestrator.
 *
 * This file contains two functions:
 *   - startCommand()   — CLI entry point (config load, foreground/daemon decision)
 *   - runAgentLoop()   — linear orchestrator that calls all init functions in order
 *
 * All heavy lifting is delegated to modules in ../runtime/.
 */

import {
  loadConfig,
  initConfig,
  configExists,
  expandPath,
  provisionDefaults,
} from '../config/config-manager.js';
import { writePid, isDaemonRunning } from '../utils/pid-manager.js';
import { killProcessesOnPorts, killAllMamaDaemons, killAllMamaWatchdogs } from './stop.js';
import { OAuthManager } from '../../auth/index.js';
import { GatewayToolExecutor } from '../../agent/gateway-tool-executor.js';
import { SessionStore, MessageRouter, initChannelHistory } from '../../gateways/index.js';
import { createGraphHandler } from '../../api/graph-api.js';
import type { GraphHandlerOptions } from '../../api/graph-api-types.js';
import Database from '../../sqlite.js';
import { existsSync, readFileSync } from 'node:fs';
import { UICommandQueue } from '../../api/ui-command-handler.js';
import { initAgentTables, getLatestVersion, createAgentVersion } from '../../db/agent-store.js';
import { initValidationTables } from '../../validation/store.js';

import {
  API_PORT,
  EMBEDDING_PORT,
  openBrowser,
  isOnboardingComplete,
  shouldAutoOpenBrowser,
  resolveCodexCommandForStartup,
  hasCodexBackendConfigured,
  startEmbeddingServerIfAvailable,
} from '../runtime/utilities.js';
import { startDaemon } from '../runtime/daemon.js';
import { initMetrics } from '../runtime/metrics-init.js';
import { initMamaCore } from '../runtime/mama-core-init.js';
import { initMainAgentLoop } from '../runtime/agent-loop-init.js';
import { initMemoryAgent } from '../runtime/memory-agent-init.js';
import { initGateways } from '../runtime/gateway-init.js';
import { wireGateways } from '../runtime/gateway-wiring.js';
import { initCronScheduler, initHeartbeat } from '../runtime/scheduler-init.js';
import { initConnectors } from '../runtime/connector-init.js';
import { initApiServer } from '../runtime/api-server-init.js';
import { registerApiRoutes } from '../runtime/api-routes-init.js';
import { startServer } from '../runtime/server-start.js';
import { installShutdownHandlers } from '../runtime/shutdown.js';

/**
 * Options for start command
 */
export interface StartOptions {
  /** Run in foreground (not as daemon) */
  foreground?: boolean;
}

/**
 * Execute start command
 */
export async function startCommand(options: StartOptions = {}): Promise<void> {
  console.log('\n🚀 Starting MAMA Standalone\n');

  // Check if already running
  const runningInfo = await isDaemonRunning();
  if (runningInfo) {
    console.log(`⚠️  MAMA is already running. (PID: ${runningInfo.pid})`);
    console.log('   To stop it: mama stop\n');
    process.exit(1);
  }

  // Clean up ALL stale mama daemon processes (not just port holders).
  // Zombie daemons may stay alive via Slack Socket Mode without holding any port.
  await killAllMamaWatchdogs();
  await killAllMamaDaemons();
  await killProcessesOnPorts([3847, 3849]);

  // Check config exists
  if (!configExists()) {
    console.log('⚠️  Config file not found.');
    console.log('   Initialize first: mama init\n');
    process.exit(1);
  }

  // Load config
  let config;
  try {
    config = await initConfig();
  } catch (error) {
    console.error(
      `Failed to load config: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }

  const backend = config.agent.backend;
  process.env.MAMA_BACKEND = backend;

  if (backend === 'codex-mcp') {
    console.log('✓ Codex-MCP backend (OAuth handled by Codex login)');
  } else {
    console.log('✓ Claude CLI mode (OAuth token not needed)');
  }

  if (options.foreground) {
    // Run in foreground
    console.log('Starting agent loop (foreground)... ✓\n');
    console.log('MAMA is running in foreground.');
    console.log('Press Ctrl+C to stop.\n');

    // Auto-open browser (after a delay for server to start)
    const needsOnboarding = !isOnboardingComplete();
    const targetUrl = needsOnboarding
      ? `http://localhost:${API_PORT}/setup`
      : `http://localhost:${API_PORT}/viewer`;
    if (shouldAutoOpenBrowser()) {
      setTimeout(() => {
        if (needsOnboarding) {
          console.log('🎭 First-time setup - Opening onboarding wizard...\n');
        } else {
          console.log('🌐 Opening MAMA OS...\n');
        }
        openBrowser(targetUrl);
      }, 3000); // Wait for embedding server
    }

    await writePid(process.pid);
    await runAgentLoop(config);
  } else {
    // Run as daemon
    process.stdout.write('Starting agent loop... ');

    try {
      const daemonPid = await startDaemon();
      console.log('✓');
      console.log(`\nMAMA is running in the background.`);
      console.log(`PID: ${daemonPid}\n`);
      console.log('Check status: mama status');
      console.log('Stop: mama stop\n');

      // Auto-open browser after server is ready
      const needsOnboarding = !isOnboardingComplete();
      const targetUrl = needsOnboarding
        ? `http://localhost:${API_PORT}/setup`
        : `http://localhost:${API_PORT}/viewer`;

      // Wait for server to be ready
      if (shouldAutoOpenBrowser()) {
        setTimeout(() => {
          if (needsOnboarding) {
            console.log('🎭 First-time setup - Opening onboarding wizard...\n');
          } else {
            console.log('🌐 Opening MAMA OS...\n');
          }
          openBrowser(targetUrl);
        }, 2000); // Wait 2 seconds for embedding server to start
      }
    } catch (error) {
      console.log('❌');
      console.error(
        `\nFailed to start daemon: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exit(1);
    }
  }
}

/**
 * Run agent loop (for foreground and daemon mode).
 *
 * This is the linear orchestrator — each phase calls one or more
 * init functions and threads their results into the next phase.
 *
 * Phase  1: Foundation (config, db, oauth, metrics)
 * Phase  2: Session + Tool + Agent Loop
 * Phase  3: MAMA Core API
 * Phase  4: Memory Agent + MessageRouter
 * Phase  5: Graph Handler + Embedding
 * Phase  6: Cron Scheduler
 * Phase  7: Gateways
 * Phase  8: Gateway Wiring
 * Phase  9: Heartbeat + Connectors
 * Phase 10: API Server + Routes
 * Phase 11: Server Start + Shutdown
 */
export async function runAgentLoop(
  config: Awaited<ReturnType<typeof loadConfig>>,
  options: { osAgentMode?: boolean } = {}
): Promise<void> {
  // ── Phase 1: Foundation ───────────────────────────────────────────────────

  const startupBackend = config.agent.backend;
  const usesCodexBackend = startupBackend === 'codex-mcp' || hasCodexBackendConfigured(config);

  if (usesCodexBackend) {
    const codexCommand = resolveCodexCommandForStartup();
    process.env.MAMA_CODEX_COMMAND = codexCommand;
    console.log(`✓ Codex CLI backend (command: ${codexCommand})`);
  }

  // Claude CLI is always used (Pi Agent removed for ToS compliance)
  console.log('✓ Claude CLI mode (ToS compliance)');

  // Provision default persona templates and multi-agent config on first start
  try {
    await provisionDefaults();
  } catch (error) {
    console.warn(`[Provision] Warning: ${error instanceof Error ? error.message : String(error)}`);
  }

  const oauthManager = new OAuthManager();

  // Initialize database for session storage
  const dbPath = expandPath(config.database.path).replace('mama-memory.db', 'mama-sessions.db');
  const db = new Database(dbPath);

  // Initialize metrics store, health score service, and health check service
  const { metricsStore, metricsCleanup, healthService, healthCheckService, metricsInterval } =
    await initMetrics(config, db, EMBEDDING_PORT);

  // Ensure swarm_tasks table exists (used by Graph API delegations endpoint)
  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS swarm_tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      priority INTEGER DEFAULT 0,
      wave INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      claimed_by TEXT,
      claimed_at INTEGER,
      completed_at INTEGER,
      result TEXT,
      files_owned TEXT,
      depends_on TEXT,
      retry_count INTEGER DEFAULT 0
    )
  `
  ).run();

  // ── Phase 2: Session + Tool + Agent Loop ──────────────────────────────────

  const sessionStore = new SessionStore(db);

  // Initialize channel history with SQLite persistence (Sprint 3 F5)
  initChannelHistory(db);

  const mamaDbPath = expandPath(config.database.path);
  const toolExecutor = new GatewayToolExecutor({
    mamaDbPath: mamaDbPath,
    sessionStore: sessionStore,
    rolesConfig: config.roles, // Pass roles from config.yaml
  });

  const validBackends = ['claude', 'codex-mcp'] as const;
  const rawBackend = config.agent.backend;
  const isValidBackend = validBackends.includes(rawBackend as (typeof validBackends)[number]);
  const runtimeBackend: 'claude' | 'codex-mcp' = isValidBackend
    ? (rawBackend as 'claude' | 'codex-mcp')
    : 'claude';
  if (rawBackend && !isValidBackend) {
    console.warn(`[Config] Unknown backend "${rawBackend}", falling back to "claude"`);
    process.env.MAMA_BACKEND = 'claude';
  }

  // Initialize main agent loop + client (reasoning state is closure-scoped inside)
  const { agentLoop, agentLoopClient } = initMainAgentLoop(
    config,
    oauthManager,
    db,
    metricsStore,
    runtimeBackend,
    options
  );

  // ── Phase 3: MAMA Core API ────────────────────────────────────────────────

  const { mamaApi, mamaApiClient, connectorExtractionFn } = await initMamaCore(config);

  // getAdapter is still used directly in this file for DB queries after initDB has run
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getAdapter } = require('@jungjaehoon/mama-core/db-manager');

  // ── Phase 4: Memory Agent + MessageRouter ─────────────────────────────────

  const messageRouter = new MessageRouter(sessionStore, agentLoopClient, mamaApiClient, {
    backend: runtimeBackend,
  });

  const { memoryAgentLoop } = await initMemoryAgent(
    oauthManager,
    config,
    mamaApi,
    mamaApiClient,
    messageRouter,
    runtimeBackend
  );

  // ── Phase 5: Graph Handler + Embedding ────────────────────────────────────

  // Create singleton UI command queue for Agent↔Viewer communication
  const uiCommandQueue = new UICommandQueue();

  // Prepare graph handler options (will be populated after gateways init)
  const graphHandlerOptions: GraphHandlerOptions = {
    healthService: healthService ?? undefined,
    healthCheckService,
    auditConversation: (job) => messageRouter.auditConversation(job),
    sessionsDb: db,
    uiCommandQueue,
  };

  // Wire sessionsDb and uiCommandQueue into gateway tool executor
  toolExecutor.setSessionsDb(db);
  toolExecutor.setUICommandQueue(uiCommandQueue);

  // Wire up Code-Act executor for POST /api/code-act endpoint
  // Always register: Dashboard/Wiki agents use code-act via MCP → HTTP proxy
  {
    graphHandlerOptions.executeCodeAct = async (code: string) => {
      const { CodeActSandbox, HostBridge } = await import('../../agent/code-act/index.js');
      const sandbox = new CodeActSandbox();
      const bridge = new HostBridge(toolExecutor);
      const toolCalls: { name: string; input: Record<string, unknown> }[] = [];
      bridge.onToolUse = (toolName, input, result) => {
        if (result !== undefined) {
          toolCalls.push({ name: toolName, input });
        }
      };
      // Set default agent context for /api/code-act calls (Conductor, tier 1)
      // In normal agent loop execution, this is set per-request by the handler
      toolExecutor.setCurrentAgentContext(
        config.multi_agent?.default_agent || 'conductor',
        'api',
        'code-act'
      );
      bridge.injectInto(sandbox, 1);
      const result = await sandbox.execute(code);
      return {
        success: result.success,
        value: result.value,
        logs: result.logs,
        error: result.error?.message,
        metrics: result.metrics,
        toolCalls,
      };
    };

    // Pre-warm Code-Act WASM module for fast first execution
    (async () => {
      try {
        const { CodeActSandbox } = await import('../../agent/code-act/index.js');
        await CodeActSandbox.warmup();
      } catch (err: unknown) {
        console.warn('[CodeAct] WASM warmup failed (non-fatal):', err);
      }
    })();
  }

  const graphHandler = createGraphHandler(graphHandlerOptions);

  // Seed initial agent versions from config (version 1 for new agents)
  // initAgentTables is idempotent (CREATE IF NOT EXISTS) — safe to call before apiServer
  initAgentTables(db);
  initValidationTables(db);
  {
    const agents = config.multi_agent?.agents ?? {};
    for (const [id, cfg] of Object.entries(agents)) {
      if (!getLatestVersion(db, id)) {
        let personaText: string | null = null;
        try {
          const pPath = expandPath(cfg.persona_file);
          if (existsSync(pPath)) personaText = readFileSync(pPath, 'utf-8');
        } catch {
          /* ignore */
        }
        createAgentVersion(db, {
          agent_id: id,
          snapshot: { model: cfg.model, tier: cfg.tier, backend: cfg.backend },
          persona_text: personaText,
          change_note: 'Initial version (migrated from config.yaml)',
        });
      }
    }
    console.log(`✓ Agent versions seeded (${Object.keys(agents).length} agents)`);
  }

  await startEmbeddingServerIfAvailable(messageRouter, sessionStore, graphHandler);

  // ── Phase 6: Cron Scheduler ───────────────────────────────────────────────

  const { scheduler, cronWorker, cronEmitter } = initCronScheduler(config);

  // ── Phase 7: Gateways ────────────────────────────────────────────────────

  const { discordGateway, slackGateway, telegramGateway, gateways } = await initGateways(
    config,
    messageRouter,
    toolExecutor,
    agentLoop,
    runtimeBackend,
    db
  );

  // ── Phase 8: Gateway Wiring ──────────────────────────────────────────────

  const { pluginLoader } = await wireGateways({
    config,
    messageRouter,
    healthCheckService,
    graphHandlerOptions,
    db,
    discordGateway,
    slackGateway,
    telegramGateway,
    gateways,
    agentLoop,
    cronEmitter,
  });

  if (graphHandlerOptions.applyMultiAgentConfig) {
    toolExecutor.setApplyMultiAgentConfig(graphHandlerOptions.applyMultiAgentConfig);
    agentLoop.setApplyMultiAgentConfig(graphHandlerOptions.applyMultiAgentConfig);
  }
  if (graphHandlerOptions.restartMultiAgentAgent) {
    toolExecutor.setRestartMultiAgentAgent(graphHandlerOptions.restartMultiAgentAgent);
    agentLoop.setRestartMultiAgentAgent(graphHandlerOptions.restartMultiAgentAgent);
  }

  // ── Phase 8.5: Delegate tool fallback wiring ─────────────────────────────
  // If no Discord/Slack handler wired the delegate tool, create standalone
  // DelegationManager + AgentProcessManager so delegate() works from any path
  // (Viewer, Telegram, iMessage, Terminal).
  if (!toolExecutor.hasDelegateSupport() && config.multi_agent?.enabled) {
    const { AgentProcessManager } = await import('../../multi-agent/agent-process-manager.js');
    const { DelegationManager } = await import('../../multi-agent/delegation-manager.js');
    const agentConfigs = Object.entries(config.multi_agent.agents || {}).map(([id, cfg]) => ({
      id,
      ...cfg,
    }));
    const pm = new AgentProcessManager(
      config.multi_agent,
      {},
      {
        backend: runtimeBackend,
        model: config.agent.model,
      }
    );
    const dm = new DelegationManager(agentConfigs);
    dm.setSessionsDb(db);
    toolExecutor.setAgentProcessManager(pm);
    toolExecutor.setDelegationManager(dm);

    graphHandlerOptions.applyMultiAgentConfig = async (rawConfig: Record<string, unknown>) => {
      const nextConfig = rawConfig as unknown as import('../config/types.js').MultiAgentConfig;
      pm.updateConfig(nextConfig);
      dm.updateAgents(Object.entries(nextConfig.agents || {}).map(([id, cfg]) => ({ id, ...cfg })));
    };
    graphHandlerOptions.restartMultiAgentAgent = async (agentId: string) => {
      pm.reloadPersona(agentId);
    };
    toolExecutor.setApplyMultiAgentConfig(graphHandlerOptions.applyMultiAgentConfig);
    toolExecutor.setRestartMultiAgentAgent(graphHandlerOptions.restartMultiAgentAgent);
    agentLoop.setApplyMultiAgentConfig(graphHandlerOptions.applyMultiAgentConfig);
    agentLoop.setRestartMultiAgentAgent(graphHandlerOptions.restartMultiAgentAgent);

    // Also wire to the main AgentLoop's internal GatewayToolExecutor
    // (MessageRouter uses agentLoop which has its own executor instance)
    agentLoop.setAgentProcessManager(pm);
    agentLoop.setDelegationManager(dm);
    console.log('[start] ✓ Delegate tool wired (standalone — no Discord/Slack handler)');
  }

  // ── Phase 9: Heartbeat + Connectors ──────────────────────────────────────

  const { heartbeatScheduler, tokenKeepAlive, healthWarningInterval } = initHeartbeat(
    config,
    agentLoop,
    discordGateway,
    scheduler,
    healthCheckService
  );

  const { rawStoreForApi, enabledConnectorNames, connectorSchedulerStop } =
    await initConnectors(connectorExtractionFn);

  // Inject rawStore into tool executor for agent_test connector data access
  if (rawStoreForApi) {
    toolExecutor.setRawStore(rawStoreForApi);
  }

  // Add connector scheduler to graceful shutdown if active
  if (connectorSchedulerStop) {
    gateways.push({ stop: () => Promise.resolve(connectorSchedulerStop()) });
  }

  // ── Phase 10: API Server + Routes ────────────────────────────────────────

  const { apiServer, eventBus } = await initApiServer({
    config,
    scheduler,
    db,
    healthService,
    healthCheckService,
    rawStore: rawStoreForApi,
    enabledConnectors: enabledConnectorNames,
    agentLoop,
    getAdapter,
  });

  await registerApiRoutes({
    config,
    apiServer,
    eventBus,
    oauthManager,
    mamaApi,
    messageRouter,
    agentLoop,
    toolExecutor,
    discordGateway,
    slackGateway,
    graphHandler,
    getAdapter,
    sessionsDb: db,
  });

  // ── Phase 11: Server Start + Shutdown ────────────────────────────────────

  await startServer({ apiServer, gateways });

  installShutdownHandlers({
    metricsInterval,
    healthWarningInterval,
    scheduler,
    cronWorker,
    heartbeatScheduler,
    tokenKeepAlive,
    gateways,
    pluginLoader,
    agentLoop,
    memoryAgentLoop,
    sessionStore,
    db,
    metricsStore,
    metricsCleanup,
  });
}
