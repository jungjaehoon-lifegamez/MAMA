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
  getDefaultMultiAgentConfig,
} from '../config/config-manager.js';
import { writePid, isDaemonRunning } from '../utils/pid-manager.js';
import { killProcessesOnPorts, killAllMamaDaemons, killAllMamaWatchdogs } from './stop.js';
import { OAuthManager } from '../../auth/index.js';
import { GatewayToolExecutor } from '../../agent/gateway-tool-executor.js';
import { createContextCompileService } from '../../agent/context-compile-service.js';
import type {
  AgentContext,
  GatewayToolExecutionContext,
  MAMAApiInterface,
} from '../../agent/types.js';
import { SessionStore, MessageRouter, initChannelHistory } from '../../gateways/index.js';
import { createGraphHandler } from '../../api/graph-api.js';
import type { CodeActExecutionContext, GraphHandlerOptions } from '../../api/graph-api-types.js';
import Database from '../../sqlite.js';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { minimatch } from 'minimatch';
import { UICommandQueue } from '../../api/ui-command-handler.js';
import { initAgentTables, getLatestVersion, createAgentVersion } from '../../db/agent-store.js';
import { initValidationTables } from '../../validation/store.js';
import { ValidationSessionService } from '../../validation/session-service.js';

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
import { buildRuntimeEnvelopeBootstrap } from '../runtime/envelope-bootstrap.js';
import { resolveMessageRouterConfig } from '../runtime/message-router-config.js';
import { resolveReactiveProjectRoot } from '../../envelope/reactive-config.js';
import { deriveMemoryScopes, type MemoryScopeRef } from '../../memory/scope-context.js';
import { DEFAULT_ROLES, type AgentPersonaConfig, type RoleConfig } from '../config/types.js';
import { RoleManager } from '../../agent/role-manager.js';
import { randomUUID } from 'node:crypto';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';
import {
  beginModelRunInAdapter,
  commitModelRunInAdapter,
  failModelRunInAdapter,
} from '@jungjaehoon/mama-core';
import type { DBManagerAdapter as DatabaseAdapter } from '@jungjaehoon/mama-core';

const { DebugLogger } = debugLogger as unknown as {
  DebugLogger: new (context?: string) => {
    warn: (...args: unknown[]) => void;
  };
};
const codeActLogger = new DebugLogger('CodeAct');
type RuntimeBackend = 'claude' | 'codex' | 'codex-mcp';
const TRUTHY_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);
const CODE_ACT_MUTATION_TOOLS = new Set([
  'mama_save',
  'context_compile',
  'mama_update',
  'mama_add',
  'mama_ingest',
  'report_publish',
  'wiki_publish',
  'task_create',
  'task_update',
  'contract_no_update',
]);

function isTruthyEnvValue(value: string | undefined): boolean {
  return value !== undefined && TRUTHY_ENV_VALUES.has(value.trim().toLowerCase());
}

function uniqueToolList(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isWildcardToolList(values: readonly string[] | undefined): boolean {
  return Boolean(values?.includes('*'));
}

function isGlobToolPattern(value: string): boolean {
  return /[*?[{]/.test(value);
}

function toolPatternAllows(pattern: string, toolName: string): boolean {
  return minimatch(toolName, pattern);
}

function intersectAllowedToolPolicies(
  configuredAllowed: string[] | undefined,
  requestedAllowed: string[] | undefined
): string[] | undefined {
  const configured =
    configuredAllowed !== undefined ? uniqueToolList(configuredAllowed) : undefined;
  const requested = requestedAllowed !== undefined ? uniqueToolList(requestedAllowed) : undefined;

  // Treat explicit empty arrays as deny-all so a caller cannot widen a fully
  // restricted policy by sending a wildcard. Only an undefined (truly absent)
  // policy falls back to the other side.
  if (configured === undefined) {
    return requested;
  }
  if (requested === undefined) {
    return configured;
  }
  if (isWildcardToolList(configured)) {
    return requested;
  }
  if (isWildcardToolList(requested)) {
    return configured;
  }

  const narrowed: string[] = [];
  for (const requestedPattern of requested) {
    for (const configuredPattern of configured) {
      if (requestedPattern === configuredPattern) {
        narrowed.push(requestedPattern);
      } else if (
        !isGlobToolPattern(requestedPattern) &&
        toolPatternAllows(configuredPattern, requestedPattern)
      ) {
        narrowed.push(requestedPattern);
      } else if (
        !isGlobToolPattern(configuredPattern) &&
        toolPatternAllows(requestedPattern, configuredPattern)
      ) {
        narrowed.push(configuredPattern);
      }
    }
  }
  return uniqueToolList(narrowed);
}

function mergeBlockedToolPolicies(
  configuredBlocked: string[] | undefined,
  requestedBlocked: string[] | undefined
): string[] | undefined {
  const merged = uniqueToolList([...(configuredBlocked ?? []), ...(requestedBlocked ?? [])]);
  return merged.length > 0 ? merged : undefined;
}

export function deriveCodeActToolPolicy(
  requestContext: CodeActExecutionContext | undefined,
  agentConfig: Omit<AgentPersonaConfig, 'id'> | undefined
): { allowedTools?: string[]; blockedTools?: string[] } {
  const configuredAllowed =
    agentConfig?.gateway_tool_permissions?.allowed ?? agentConfig?.tool_permissions?.allowed;
  const configuredBlocked =
    agentConfig?.gateway_tool_permissions?.blocked ?? agentConfig?.tool_permissions?.blocked;
  const allowedTools = intersectAllowedToolPolicies(
    configuredAllowed,
    requestContext?.allowedTools
  );
  const blockedTools = mergeBlockedToolPolicies(configuredBlocked, requestContext?.blockedTools);
  return { allowedTools, blockedTools };
}

export function resolveCodeActAgentPolicy(
  requestContext: CodeActExecutionContext | undefined,
  agents: Record<string, Omit<AgentPersonaConfig, 'id'>> | undefined,
  defaultAgentId: string
): {
  agentId: string;
  agentConfig?: Omit<AgentPersonaConfig, 'id'>;
  policy?: { allowedTools?: string[]; blockedTools?: string[] };
  error?: string;
} {
  const agentId = requestContext?.agentId || defaultAgentId;
  const agentConfig = agents?.[agentId];
  if (!agentConfig) {
    return { agentId, error: `Unknown Code-Act agent: ${agentId}` };
  }
  if (agentConfig.useCodeAct !== true) {
    return { agentId, error: `Agent is not configured for Code-Act: ${agentId}` };
  }
  const policy = deriveCodeActToolPolicy(requestContext, agentConfig);
  if (!policy.allowedTools || policy.allowedTools.length === 0) {
    // Fail closed: an agent that resolves to no allowed tools must be rejected
    // rather than silently widened to wildcard access.
    return {
      agentId,
      agentConfig,
      policy,
      error: `Agent has no allowed Code-Act tools: ${agentId}`,
    };
  }
  return {
    agentId,
    agentConfig,
    policy,
  };
}

export function resolveCodeActRawConnectors(
  enabledConnectorNames: readonly string[] | undefined
): string[] {
  return [...new Set((enabledConnectorNames ?? []).map((name) => name.trim()).filter(Boolean))];
}

const CODE_ACT_RAW_MEMORY_SCOPE_LIMIT = 500;
const MEMORY_SCOPE_KINDS = new Set(['global', 'user', 'channel', 'project']);

function isMemoryScopeKind(value: unknown): value is MemoryScopeRef['kind'] {
  return typeof value === 'string' && MEMORY_SCOPE_KINDS.has(value);
}

function uniqueMemoryScopes(scopes: readonly MemoryScopeRef[]): MemoryScopeRef[] {
  const seen = new Set<string>();
  const unique: MemoryScopeRef[] = [];
  for (const scope of scopes) {
    const id = scope.id.trim();
    if (!id) {
      continue;
    }
    const key = `${scope.kind}:${id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push({ kind: scope.kind, id });
  }
  return unique;
}

export function resolveCodeActMemoryScopes(
  baseScopes: readonly MemoryScopeRef[],
  adapter?: Pick<DatabaseAdapter, 'prepare'>
): MemoryScopeRef[] {
  const scopes = [...baseScopes];
  if (!adapter) {
    return uniqueMemoryScopes(scopes);
  }

  try {
    const rows = adapter
      .prepare(
        `
          SELECT DISTINCT ms.kind AS kind, ms.external_id AS id
          FROM memory_scopes ms
          JOIN memory_scope_bindings msb ON msb.scope_id = ms.id
          JOIN decisions d ON d.id = msb.memory_id
          WHERE d.topic LIKE 'raw/%'
            AND (d.status = 'active' OR d.status IS NULL)
            AND d.superseded_by IS NULL
          ORDER BY ms.kind, ms.external_id
          LIMIT ?
        `
      )
      .all(CODE_ACT_RAW_MEMORY_SCOPE_LIMIT) as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (!isMemoryScopeKind(row.kind) || typeof row.id !== 'string') {
        continue;
      }
      scopes.push({ kind: row.kind, id: row.id });
    }
  } catch {
    return uniqueMemoryScopes(scopes);
  }

  return uniqueMemoryScopes(scopes);
}

function buildCodeActRole(policy: {
  allowedTools?: string[];
  blockedTools?: string[];
}): RoleConfig {
  // Caller (resolveCodeActAgentPolicy) rejects empty/undefined allowedTools, so
  // here we honor the resolved policy verbatim instead of widening to wildcard.
  return {
    allowedTools: policy.allowedTools ?? [],
    blockedTools: policy.blockedTools,
    allowedPaths: [],
    systemControl: false,
    sensitiveAccess: false,
  };
}

type CodeActModelRunAdapter = Pick<DatabaseAdapter, 'prepare'>;

type CodeActExecutionResultLike = {
  success?: boolean;
  error?: { message?: string } | string;
};

export interface CodeActParentModelRunOptions {
  inputSnapshotRef: string;
  inputRefs: Record<string, unknown>;
}

export function bindCodeActParentModelRun(
  adapter: CodeActModelRunAdapter,
  executionContext: GatewayToolExecutionContext | null,
  options: CodeActParentModelRunOptions
): { executionContext: GatewayToolExecutionContext | null; modelRunId: string | null } {
  if (!executionContext?.envelope) {
    return { executionContext, modelRunId: null };
  }

  const run = beginModelRunInAdapter(adapter, {
    agent_id: executionContext.agentId,
    instance_id: executionContext.envelope.instance_id,
    envelope_hash: executionContext.envelope.envelope_hash,
    input_snapshot_ref: options.inputSnapshotRef,
    input_refs: options.inputRefs,
  });

  return {
    executionContext: {
      ...executionContext,
      modelRunId: run.model_run_id,
    },
    modelRunId: run.model_run_id,
  };
}

function codeActErrorSummary(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function resultErrorSummary(result: CodeActExecutionResultLike): string {
  if (typeof result.error === 'string') {
    return result.error;
  }
  return result.error?.message ?? 'Code-Act execution failed';
}

export function finalizeCodeActParentModelRun(
  adapter: CodeActModelRunAdapter,
  modelRunId: string | null,
  result: CodeActExecutionResultLike
): void {
  if (!modelRunId) {
    return;
  }
  if (result.success === false) {
    failModelRunInAdapter(adapter, modelRunId, resultErrorSummary(result));
    return;
  }
  commitModelRunInAdapter(adapter, modelRunId, 'code-act completed');
}

export function failCodeActParentModelRun(
  adapter: CodeActModelRunAdapter,
  modelRunId: string | null,
  error: unknown
): void {
  if (!modelRunId) {
    return;
  }
  failModelRunInAdapter(adapter, modelRunId, codeActErrorSummary(error));
}

/**
 * Options for start command
 */
export interface StartOptions {
  /** Run in foreground (not as daemon) */
  foreground?: boolean;
}

export function buildSystemAgentProcessDefaults(config: {
  multi_agent?: { dangerouslySkipPermissions?: boolean };
}): { dangerouslySkipPermissions: boolean } {
  return {
    dangerouslySkipPermissions: config.multi_agent?.dangerouslySkipPermissions ?? true,
  };
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

  const validBackends = ['claude', 'codex', 'codex-mcp'] as const;
  const backend = config.agent.backend;
  const isValidBackend = validBackends.includes(backend as RuntimeBackend);
  process.env.MAMA_BACKEND = isValidBackend ? backend : 'claude';

  if (backend === 'codex' || backend === 'codex-mcp') {
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
  const usesCodexBackend =
    startupBackend === 'codex' ||
    startupBackend === 'codex-mcp' ||
    hasCodexBackendConfigured(config);

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

  const envelopeBootstrap = buildRuntimeEnvelopeBootstrap(db, config, process.env);
  const mamaDbPath = expandPath(config.database.path);
  const toolExecutor = new GatewayToolExecutor({
    mamaDbPath: mamaDbPath,
    sessionStore: sessionStore,
    rolesConfig: config.roles, // Pass roles from config.yaml
    envelopeIssuanceMode: envelopeBootstrap.metadata.issuance,
    metricsStore,
  });

  const validBackends = ['claude', 'codex', 'codex-mcp'] as const;
  const rawBackend = config.agent.backend;
  const isValidBackend = validBackends.includes(rawBackend as RuntimeBackend);
  const runtimeBackend: RuntimeBackend = isValidBackend ? (rawBackend as RuntimeBackend) : 'claude';
  process.env.MAMA_BACKEND = runtimeBackend;
  if (rawBackend && !isValidBackend) {
    console.warn(`[Config] Unknown backend "${rawBackend}", falling back to "claude"`);
  }
  const agentLoopBackend: 'claude' | 'codex-mcp' =
    runtimeBackend === 'codex' || runtimeBackend === 'codex-mcp' ? 'codex-mcp' : 'claude';

  // Initialize main agent loop + client (reasoning state is closure-scoped inside)
  const { agentLoop, agentLoopClient } = initMainAgentLoop(
    config,
    oauthManager,
    db,
    metricsStore,
    agentLoopBackend,
    toolExecutor,
    {
      ...options,
      envelopeIssuanceMode: envelopeBootstrap.metadata.issuance,
    }
  );

  // ── Phase 3: MAMA Core API ────────────────────────────────────────────────

  const { mamaApi, mamaApiClient, connectorExtractionFn } = await initMamaCore(config);
  // Wire the boot MAMA API onto the shared executor so it never lazily builds a
  // SECOND API/adapter stack against the same DB (initializeMAMAApi). This also
  // lets the memory agent fold into the shared executor (Task 7) instead of
  // carrying its own private instance just for this API.
  toolExecutor.setMamaApi(mamaApi as MAMAApiInterface);

  // getAdapter is still used directly in this file for DB queries after initDB has run
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getAdapter } = require('@jungjaehoon/mama-core/db-manager');
  const contextCompileService = createContextCompileService({
    memoryAdapter: getAdapter(),
  });
  toolExecutor.setContextCompileService(contextCompileService);
  agentLoop.setContextCompileService(contextCompileService);

  // ── Phase 4: Memory Agent + MessageRouter ─────────────────────────────────

  const messageRouter = new MessageRouter(
    sessionStore,
    agentLoopClient,
    mamaApiClient,
    resolveMessageRouterConfig(config, runtimeBackend),
    envelopeBootstrap.envelopeConfig,
    envelopeBootstrap.envelopeAuthority
  );
  messageRouter.setSessionsDb(db);

  // validationService wired after creation (Phase 5 below)

  const { memoryAgentLoop } = await initMemoryAgent(
    oauthManager,
    config,
    mamaApi,
    mamaApiClient,
    messageRouter,
    agentLoopBackend,
    toolExecutor
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
  let codeActRawConnectors: string[] = [];

  // Wire uiCommandQueue into messageRouter for page context awareness
  messageRouter.setUICommandQueue(uiCommandQueue);

  // Wire sessionsDb and uiCommandQueue into gateway tool executor
  toolExecutor.setSessionsDb(db);
  toolExecutor.setUICommandQueue(uiCommandQueue);
  agentLoop.setSessionsDb(db);
  agentLoop.setUICommandQueue(uiCommandQueue);

  // Wire up Code-Act executor for POST /api/code-act endpoint
  // Always register: Dashboard/Wiki agents use code-act via MCP → HTTP proxy
  graphHandlerOptions.executeCodeAct = async (
    code: string,
    codeActContext?: CodeActExecutionContext
  ) => {
    const { CodeActSandbox, HostBridge } = await import('../../agent/code-act/index.js');
    const sandbox = new CodeActSandbox();
    const resolvedCodeActPolicy = resolveCodeActAgentPolicy(
      codeActContext,
      config.multi_agent?.agents,
      config.multi_agent?.default_agent || 'conductor'
    );
    if (resolvedCodeActPolicy.error) {
      return { success: false, error: resolvedCodeActPolicy.error };
    }
    const codeActAgentId = resolvedCodeActPolicy.agentId;
    const codeActPolicy = resolvedCodeActPolicy.policy ?? {};
    const codeActRole = buildCodeActRole(codeActPolicy);
    const codeActReadOnly = isTruthyEnvValue(process.env.MAMA_CODE_ACT_READ_ONLY);
    const codeActTier = codeActReadOnly ? 3 : 2;
    const instanceId = randomUUID();
    let executionContext: GatewayToolExecutionContext | null = null;
    if (envelopeBootstrap.envelopeAuthority && envelopeBootstrap.metadata.issuance !== 'off') {
      const projectId = resolveReactiveProjectRoot(config, process.env);
      const projectRef = { kind: 'project' as const, id: projectId };
      const memoryScopes = resolveCodeActMemoryScopes(
        deriveMemoryScopes({
          source: 'watch',
          channelId: 'api:code-act',
          userId: 'api',
          projectId,
        }),
        getAdapter()
      );
      const wallSeconds = Math.min(
        Math.max(Math.floor((config.timeouts?.agent_ms ?? 300_000) / 1000), 1),
        300
      );
      const envelope = envelopeBootstrap.envelopeAuthority.buildAndPersist({
        agent_id: codeActAgentId,
        instance_id: instanceId,
        source: 'watch',
        channel_id: 'api:code-act',
        trigger_context: { user_text: '<api-code-act invocation>' },
        scope: {
          project_refs: [projectRef],
          raw_connectors: codeActRawConnectors,
          memory_scopes: memoryScopes,
          allowed_destinations: [],
        },
        tier: codeActTier,
        budget: { wall_seconds: wallSeconds },
        expires_at: new Date(Date.now() + wallSeconds * 1000 + 30_000).toISOString(),
      });
      const roleName = `code_act_${codeActAgentId}`;
      const role = codeActRole;
      const agentContext: AgentContext = {
        source: 'watch',
        platform: 'cli',
        roleName,
        role,
        session: {
          sessionId: `api:code-act:${instanceId}`,
          channelId: 'api:code-act',
          startedAt: new Date(),
        },
        capabilities: ['code_act'],
        limitations: codeActReadOnly ? ['Code-Act read-only mode: memory writes disabled'] : [],
        tier: codeActTier,
        backend: runtimeBackend,
      };
      executionContext = {
        agentContext,
        agentId: codeActAgentId,
        source: 'watch',
        channelId: 'api:code-act',
        envelope,
        executionSurface: 'code_act',
      };
    }
    const parentRun = bindCodeActParentModelRun(getAdapter(), executionContext, {
      inputSnapshotRef: `code-act:${instanceId}`,
      inputRefs: {
        tool: 'code_act',
        source: 'api',
        channel_id: 'api:code-act',
        read_only: codeActReadOnly,
      },
    });
    executionContext = parentRun.executionContext;
    const bridge = new HostBridge(
      toolExecutor,
      new RoleManager({ rolesConfig: config.roles ?? DEFAULT_ROLES }),
      executionContext
    );
    const toolCalls: { name: string; input: Record<string, unknown> }[] = [];
    bridge.onToolUse = (toolName, input, result) => {
      if (result !== undefined) {
        toolCalls.push({ name: toolName, input });
        if (CODE_ACT_MUTATION_TOOLS.has(toolName)) {
          codeActLogger.warn('[CodeAct] mutation tool call', {
            toolName,
            success: Boolean((result as { success?: unknown }).success),
            readOnly: codeActReadOnly,
            envelopeHash: executionContext?.envelope?.envelope_hash ?? null,
          });
        }
      }
    };
    const previousRoutingContext = toolExecutor.getCurrentAgentRoutingContext();
    try {
      // Set default agent context for /api/code-act calls (Conductor, tiered sandbox).
      // Per-request executionContext carries envelope data; this routing context is legacy fallback.
      toolExecutor.setCurrentAgentContext(codeActAgentId, 'api', 'code-act');
      bridge.injectInto(sandbox, codeActTier, codeActRole);
      const result = await sandbox.execute(code);
      finalizeCodeActParentModelRun(getAdapter(), parentRun.modelRunId, result);
      return {
        success: result.success,
        value: result.value,
        logs: result.logs,
        error: result.error?.message,
        metrics: result.metrics,
        toolCalls,
      };
    } catch (error) {
      failCodeActParentModelRun(getAdapter(), parentRun.modelRunId, error);
      throw error;
    } finally {
      toolExecutor.restoreCurrentAgentRoutingContext(previousRoutingContext);
    }
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

  const graphHandler = createGraphHandler(graphHandlerOptions);

  // Seed initial agent versions from config (version 1 for new agents)
  // initAgentTables is idempotent (CREATE IF NOT EXISTS) — safe to call before apiServer
  initAgentTables(db);
  initValidationTables(db);

  // Wire validation session service into tool executor + message router
  const validationService = new ValidationSessionService(db);
  toolExecutor.setValidationService(validationService);
  messageRouter.setValidationService(validationService);
  agentLoop.setValidationService(validationService);
  // Ensure current primary system agents exist in config. Legacy self-paced
  // dashboard/wiki agents are opt-in and must not be backfilled here.
  if (!config.multi_agent) {
    config.multi_agent = getDefaultMultiAgentConfig();
  }
  if (!config.multi_agent.agents) {
    config.multi_agent.agents = {};
  }
  const osAgents: Record<
    string,
    {
      name: string;
      display_name: string;
      trigger_prefix: string;
      persona_file: string;
      tier: 1 | 2 | 3;
      backend: RuntimeBackend;
      model: string;
      can_delegate?: boolean;
      enabled?: boolean;
    }
  > = {
    'os-agent': {
      name: 'OS Agent',
      display_name: '🖥️ OS Agent',
      trigger_prefix: '!os',
      persona_file: '~/.mama/personas/os-agent.md',
      tier: 1,
      backend: runtimeBackend,
      model: config.agent.model,
      can_delegate: true,
      enabled: true,
    },
    memory: {
      name: 'Memory Agent',
      display_name: '🧠 Memory',
      trigger_prefix: '!memory',
      persona_file: '~/.mama/personas/memory.md',
      tier: 3,
      backend: runtimeBackend,
      model: config.agent.model,
      can_delegate: false,
      enabled: true,
    },
  };
  let osAgentsAdded = false;
  for (const [id, cfg] of Object.entries(osAgents)) {
    if (!config.multi_agent.agents[id]) {
      config.multi_agent.agents[id] = cfg;
      osAgentsAdded = true;
    }
  }
  // Persist to config.yaml so /api/agents sees them too
  if (osAgentsAdded) {
    try {
      const { saveConfig } = await import('../config/config-manager.js');
      await saveConfig(config);
      console.log('✓ OS agents added to config.yaml');
    } catch {
      /* non-fatal — runtime config still has them */
    }
  }

  const agents = config.multi_agent.agents;
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

  await startEmbeddingServerIfAvailable(messageRouter, sessionStore, graphHandler);

  // ── Phase 6: Cron Scheduler ───────────────────────────────────────────────

  const { scheduler, cronWorker, cronEmitter } = initCronScheduler(config);

  // ── Phase 7: Gateways ────────────────────────────────────────────────────

  const gatewayInit = await initGateways(
    config,
    messageRouter,
    toolExecutor,
    agentLoop,
    runtimeBackend,
    db
  );
  const { discordGateway, slackGateway, telegramGateway, gateways } = gatewayInit;

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
  const fallbackMultiAgentConfig = config.multi_agent;
  const hasSystemRunAgents = Boolean(
    fallbackMultiAgentConfig?.agents?.['dashboard-agent'] ||
    fallbackMultiAgentConfig?.agents?.['wiki-agent']
  );
  if (
    fallbackMultiAgentConfig &&
    !toolExecutor.getAgentProcessManager() &&
    (fallbackMultiAgentConfig.enabled || hasSystemRunAgents)
  ) {
    const { AgentProcessManager } = await import('../../multi-agent/agent-process-manager.js');
    const pm = new AgentProcessManager(
      fallbackMultiAgentConfig,
      buildSystemAgentProcessDefaults(config),
      {
        backend: runtimeBackend,
        model: config.agent.model,
      }
    );
    toolExecutor.setAgentProcessManager(pm);
    agentLoop.setAgentProcessManager(pm);

    graphHandlerOptions.applyMultiAgentConfig = async (rawConfig: Record<string, unknown>) => {
      const nextConfig = rawConfig as unknown as import('../config/types.js').MultiAgentConfig;
      pm.updateConfig(nextConfig);
    };
    graphHandlerOptions.restartMultiAgentAgent = async (agentId: string) => {
      pm.reloadPersona(agentId);
    };
    toolExecutor.setApplyMultiAgentConfig(graphHandlerOptions.applyMultiAgentConfig);
    toolExecutor.setRestartMultiAgentAgent(graphHandlerOptions.restartMultiAgentAgent);
    agentLoop.setApplyMultiAgentConfig(graphHandlerOptions.applyMultiAgentConfig);
    agentLoop.setRestartMultiAgentAgent(graphHandlerOptions.restartMultiAgentAgent);

    if (fallbackMultiAgentConfig.enabled && !toolExecutor.hasDelegateSupport()) {
      const { DelegationManager } = await import('../../multi-agent/delegation-manager.js');
      const agentConfigs = Object.entries(fallbackMultiAgentConfig.agents || {}).map(
        ([id, cfg]) => ({
          id,
          ...cfg,
        })
      );
      const dm = new DelegationManager(agentConfigs);
      dm.setSessionsDb(db);
      toolExecutor.setDelegationManager(dm);
      agentLoop.setDelegationManager(dm);
      graphHandlerOptions.applyMultiAgentConfig = async (rawConfig: Record<string, unknown>) => {
        const nextConfig = rawConfig as unknown as import('../config/types.js').MultiAgentConfig;
        pm.updateConfig(nextConfig);
        dm.updateAgents(
          Object.entries(nextConfig.agents || {}).map(([id, cfg]) => ({ id, ...cfg }))
        );
      };
      toolExecutor.setApplyMultiAgentConfig(graphHandlerOptions.applyMultiAgentConfig);
      agentLoop.setApplyMultiAgentConfig(graphHandlerOptions.applyMultiAgentConfig);
      console.log('[start] ✓ Delegate tool wired (standalone — no Discord/Slack handler)');
    } else {
      console.log('[start] ✓ System agent process manager wired');
    }
  }

  // ── Phase 9: Heartbeat + Connectors ──────────────────────────────────────

  const { heartbeatScheduler, tokenKeepAlive, healthWarningInterval } = initHeartbeat(
    config,
    agentLoop,
    discordGateway,
    scheduler,
    healthCheckService
  );

  // M2.4 freshness: the connector sink nudges the trigger loop when a poll indexes new rows. The
  // loop is constructed AFTER initConnectors (below), so hand initConnectors a stable forwarder now
  // and point it at the loop once it exists. Null until then -> nudge no-ops (no loop = nothing to
  // wake), which preserves today's behavior when MAMA_TRIGGER_LOOP is unset.
  const triggerLoopNudge: { current: (() => void) | null } = { current: null };
  // M8: board-reconcile feed. The trigger loop is built BEFORE the event bus
  // exists (initApiServer), so it emits through this mutable sink (same
  // pattern as triggerLoopNudge above).
  const channelDeltaSink: { current: ((channelKey: string, lines: string[]) => void) | null } = {
    current: null,
  };

  // Operator DB + native task ledger (M8): wired UNCONDITIONALLY -- the task
  // tools are standard gateway tools and must work even when the trigger loop
  // is off (review finding on #142). Single handle, closed once at shutdown.
  const operatorDbPath = expandPath('~/.mama/operator/triggers.db');
  mkdirSync(dirname(operatorDbPath), { recursive: true });
  const operatorDb = new Database(operatorDbPath);
  let taskLedger: import('../../operator/task-ledger.js').TaskLedger;
  try {
    const { TaskLedger } = await import('../../operator/task-ledger.js');
    taskLedger = new TaskLedger(operatorDb);
    toolExecutor.setTaskLedger(taskLedger);
  } catch (err) {
    // Fail loud, but do not leak the handle on a failed boot.
    operatorDb.close();
    throw err;
  }
  // ── Stage-2 workorder consumer (plan S2-T3): unconditional of the trigger
  // loop, gated only by MAMA_STAGE2_WORKORDERS. Constructed BEFORE
  // registerApiRoutes (which registers the per-kind completion hooks) and
  // started AFTER it - the boot invariant below enforces that ordering.
  const { readStage2Flag } = await import('../../operator/workorder-publishers.js');
  const stage2Flag = readStage2Flag();
  let workOrderConsumer: import('../../operator/workorder-consumer.js').WorkOrderConsumer | null =
    null;

  gateways.push({
    stop: async () => {
      // Consumer stop BEFORE db close (same gateway = ordered; parallel
      // gateways would race an in-flight tick into "database is not open").
      await workOrderConsumer?.stop().catch(() => {});
      try {
        operatorDb.close();
      } catch {
        /* already closed */
      }
    },
  });
  if (stage2Flag !== 'off') {
    const { WorkOrderConsumer } = await import('../../operator/workorder-consumer.js');
    const { loadBrief, ensureBriefs } = await import('../../operator/briefs.js');
    // Seed missing default briefs (user edits win) BEFORE the consumer exists -
    // a normal install must never hit the brief-missing fail path.
    ensureBriefs();
    const { logActivity: logWorkOrderActivity } = await import('../../db/agent-store.js');
    const { validateWorkOrderPayload, boardManualKey, wikiBatchKey, promotionManualKey } =
      await import('../../operator/workorder-publishers.js');

    // Shadow harness (kill-list at cutover): board capture publisher.
    const shadowCapture =
      stage2Flag === 'shadow'
        ? (await import('../../operator/shadow-capture.js')).createShadowCapture()
        : null;

    // Ops alarm sink (plan D4/E1/G8): constructed OUTSIDE any trigger-loop
    // block - the consumer runs with the loop off, so its terminal alarms
    // must too. Chat id: MAMA_OPS_ALERT_CHAT, falling back to the loop's
    // report chat var.
    const opsAlertChat =
      process.env.MAMA_OPS_ALERT_CHAT || process.env.MAMA_TRIGGER_LOOP_REPORT_CHAT || '';
    const opsAlarm = {
      configured: Boolean(opsAlertChat && telegramGateway),
      send: async (line: string) => {
        if (telegramGateway && opsAlertChat) await telegramGateway.sendMessage(opsAlertChat, line);
      },
    };
    if (!opsAlarm.configured) {
      console.log(
        '[stage2] ops alarm sink unconfigured - terminal workorder alarms are LOG-ONLY ' +
          '(set MAMA_OPS_ALERT_CHAT or MAMA_TRIGGER_LOOP_REPORT_CHAT)'
      );
    }

    // AgentLoopClient.runWithContent is optional in its type; a missing method
    // is a boot-order fault and must throw, not no-op (WorkerRunner adapter).
    const workerRunner: import('../../operator/worker-run.js').WorkerRunner = {
      runWithContent: async (content, options) => {
        if (!agentLoopClient.runWithContent) {
          throw new Error('[stage2] agentLoopClient.runWithContent unavailable');
        }
        return agentLoopClient.runWithContent(
          content as Parameters<NonNullable<typeof agentLoopClient.runWithContent>>[0],
          options as Parameters<NonNullable<typeof agentLoopClient.runWithContent>>[1]
        );
      },
    };
    workOrderConsumer = new WorkOrderConsumer({
      ledger: taskLedger,
      runner: workerRunner,
      loadBrief: (kind) => loadBrief(kind),
      noticeOwner: (summary) => messageRouter.enqueueOperatorNotice(summary),
      opsAlarm,
      runOptionsFor: (wo) => {
        if (stage2Flag === 'shadow' && wo.workKind === 'board') {
          // A shadow board run without the capture publisher would publish
          // LIVE - refuse the run instead (throw -> failWorkOrder, plan T4).
          if (!shadowCapture) {
            throw new Error('[stage2] shadow capture publisher missing - refusing live publish');
          }
          return { reportPublisherOverride: shadowCapture.publisher };
        }
        return undefined;
      },
      onEvent: (event) => {
        // Telemetry replacement for executeValidatedRun's task_start/complete
        // rows (plan E4): the ledger row is the durable record; agent_activity
        // keeps the operational trace queryable.
        try {
          logWorkOrderActivity(db, {
            agent_id: `workorder-${event.workKind}`,
            agent_version: 0,
            type: `workorder_${event.type}`,
            input_summary: `#${event.workOrderId}`,
            output_summary: event.reason ?? '',
            execution_status: 'completed',
            trigger_reason: 'workorder-consumer',
          });
        } catch {
          /* telemetry only */
        }
      },
    });
    // (Consumer stop is folded into the operator-DB gateway above - ordering.)

    // Owner-issued workorders (workorder_request tool): enqueue+ack only.
    // Wired here - NOT inside any trigger-loop block (plan C11 class).
    toolExecutor.setWorkOrderRequestHandler((kind) => {
      // Shadow invariant (plan B1/C2): shadow ≡ board only. A wiki/promotion
      // workorder at shadow would run LIVE (no capture seam) while its legacy
      // path also runs - the exact double-execution shadow exists to prevent.
      if (stage2Flag === 'shadow' && kind !== 'board') {
        console.warn(`[stage2] workorder_request(${kind}) rejected: shadow is board-only`);
        return { accepted: false, reason: 'shadow-board-only' };
      }
      try {
        const now = Date.now();
        let idempotencyKey: string;
        let payload: Record<string, unknown>;
        if (kind === 'board') {
          idempotencyKey = boardManualKey(now);
          payload = { mode: 'full', force: true };
        } else if (kind === 'wiki') {
          idempotencyKey = wikiBatchKey('manual', now);
          payload = { batchId: `${now}-manual`, events: ['manual'] };
        } else {
          idempotencyKey = promotionManualKey(now);
          payload = { scheduledAt: new Date(now).toISOString() };
        }
        validateWorkOrderPayload(kind, payload);
        const wo = taskLedger.enqueueWorkOrder({
          workKind: kind,
          idempotencyKey,
          input: payload,
          priority: 'high',
        });
        console.log(`[stage2] owner workorder enqueued: ${kind}#${wo.id}`);
        return { accepted: true };
      } catch (err) {
        console.error(
          `[stage2] owner workorder enqueue failed (${kind}):`,
          err instanceof Error ? err.message : err
        );
        return { accepted: false, reason: 'enqueue-failed' };
      }
    });
  }
  const { rawStoreForApi, enabledConnectorNames, connectorSchedulerStop } = await initConnectors(
    connectorExtractionFn,
    { nudge: () => triggerLoopNudge.current?.() }
  );
  codeActRawConnectors = resolveCodeActRawConnectors(enabledConnectorNames);

  // Inject rawStore into tool executor for agent_test connector data access
  if (rawStoreForApi) {
    toolExecutor.setRawStore(rawStoreForApi);
    agentLoop.setRawStore(rawStoreForApi);
  }

  // Add connector scheduler to graceful shutdown if active
  if (connectorSchedulerStop) {
    gateways.push({ stop: () => Promise.resolve(connectorSchedulerStop()) });
  }

  // ── Trigger loop (M1, flag-gated, additive): agent-evolved triggers on the live stream ──
  // Runs ONLY with MAMA_TRIGGER_LOOP=1. Placed after initConnectors (which feeds
  // connector_event_index) and after mama-core initDB. Read-only: recall/surface/log.
  if (process.env.MAMA_TRIGGER_LOOP === '1') {
    // Component isolation (PR #119 review): a trigger-loop bootstrap failure (bad import,
    // DB permission, registry constructor) must not abort the whole daemon before Phase
    // 10/11 - the gateways/viewer/agent serve independently of this optional leg. The
    // failure is still surfaced LOUDLY below (console.error), never swallowed silently.
    try {
      const { OperatorTriggerLoop } = await import('../../operator/operator-trigger-loop.js');
      const { ConnectorDeltaRepo } = await import('../../operator/connector-delta-repo.js');
      const { TriggerRegistry } = await import('../../operator/trigger-registry.js');
      const { createMamaMemoryPort } = await import('../../operator/mama-memory-port.js');
      const { askAgentCLI } = await import('../../operator/trigger-author.js');
      const { reviewTriggerCLI } = await import('../../operator/trigger-review.js');
      const { ReportScheduler, FileReportScheduleStore, parseReportHours } =
        await import('../../operator/report-scheduler.js');
      const { persistLastFullReport } = await import('../../operator/report-carry.js');
      const { createPersonaReportAsk, OPERATOR_REPORT_SESSION_KEY } =
        await import('../../operator/report-run.js');
      const { OPERATOR_FULL_REPORT_TAG } = await import('../../operator/situation-report.js');
      const { buildBoardPublishLines } = await import('../../operator/board-slot-instructions.js');

      const triggerRegistry = new TriggerRegistry(operatorDb);
      // Owner-report leg (M1.5): destination chat comes from env (~/.mama/start.sh),
      // never source. No chat configured or no telegram gateway -> loop stays read-only.
      const reportChatId = process.env.MAMA_TRIGGER_LOOP_REPORT_CHAT || '';
      const reportOutput =
        reportChatId && telegramGateway
          ? { send: (text: string) => telegramGateway.sendMessage(reportChatId, text) }
          : undefined;
      // Scheduled full-report leg (M2): local hours from env (~/.mama/start.sh), never source.
      // Empty/absent -> [] -> leg off. Requires the same telegram sink as the digest leg.
      const fullReportHours = parseReportHours(
        process.env.MAMA_TRIGGER_LOOP_FULL_REPORT_HOURS || ''
      );
      // Constructed whenever the report SINK exists, even with no scheduled
      // hours (empty hours -> shouldFire never fires): on-demand reports
      // (report_request) need the persistent anchor state to load and advance
      // the delta window regardless of the scheduled leg (review PR#153).
      const reportScheduler = reportOutput
        ? new ReportScheduler(
            fullReportHours,
            new FileReportScheduleStore(expandPath('~/.mama/operator/report-schedule-state.json'))
          )
        : undefined;
      const triggerLoop = new OperatorTriggerLoop({
        delta: new ConnectorDeltaRepo(
          getAdapter(),
          expandPath('~/.mama/operator/trigger-loop-cursors.json')
        ),
        memory: createMamaMemoryPort(),
        registry: triggerRegistry,
        onChannelDelta: (channelKey, lines) => channelDeltaSink.current?.(channelKey, lines),
        askAgent: askAgentCLI,
        // M2.2: reports go through the daemon's persona agent (system prompt, pinned model,
        // session lanes) instead of the bare CLI - report tone comes from generation inputs.
        // JSON tasks (authoring/review) stay on the bare CLI for reliable parsing.
        // M3 (GAP1+GAP2): run reports in a dedicated persona session lane so the multi-turn gather
        // loop is isolated from chat and continuous across cadences (runWithContent honors
        // options.sessionKey - agent-loop.ts:879, no agent-loop internal change). Gateway
        // 'model_tool' executions are envelope-gated (gateway-tool-executor.ts:252-256) and
        // issuance defaults to 'enabled' (envelope-bootstrap.ts:28-30), so each report carries a
        // per-run scoped envelope (mirrors the code-act issuance at start.ts:1834-1865); without it
        // every call is denied with code 'envelope_missing'. Then audit the gateway tools the agent
        // actually EXECUTED: a full report that executed NO gateway gather tool is logged loudly
        // (no-fallback), and every write (mama_save) is logged (observability).
        reportAsk: createPersonaReportAsk({
          issueEnvelope:
            envelopeBootstrap.envelopeAuthority && envelopeBootstrap.metadata.issuance !== 'off'
              ? async () => {
                  const projectId = resolveReactiveProjectRoot(config, process.env);
                  // A report run is multi-turn (each turn may take up to agent_ms).
                  // The TTL must cover the RUN, not one request - otherwise every
                  // long gather structurally outlives its envelope and all
                  // end-of-run writes die '[expired]' (9 observed pre-fix).
                  const wallSeconds = Math.min(
                    Math.max(Number(process.env.MAMA_REPORT_WALL_SECONDS) || 900, 60),
                    1800
                  );
                  return envelopeBootstrap.envelopeAuthority!.buildAndPersist({
                    agent_id: 'operator-report',
                    instance_id: randomUUID(),
                    // 'operator' is not a member of EnvelopeSource (envelope/types.ts is a closed
                    // union); 'watch' is the daemon-internal source used by the mirrored code-act
                    // issuance (start.ts:1834-1865). This field is issuing-source metadata only -
                    // enforcement authorizes on scope.memory_scopes (which cover the operator:report
                    // run below), never on envelope.source (gateway-tool-executor.ts:1421,1511,1590).
                    source: 'watch',
                    channel_id: 'report',
                    trigger_context: { user_text: '<operator scheduled report>' },
                    scope: {
                      // Reads: the enabled raw connectors (kagemusha_* gathers) + memory scopes
                      // covering mama_recall/mama_save. allowed_destinations stays [] - NO new
                      // send surface (constraint 2).
                      project_refs: [{ kind: 'project' as const, id: projectId }],
                      raw_connectors: codeActRawConnectors,
                      memory_scopes: resolveCodeActMemoryScopes(
                        deriveMemoryScopes({ source: 'operator', channelId: 'report', projectId }),
                        getAdapter()
                      ),
                      allowed_destinations: [],
                    },
                    tier: 2, // write tier: the report may mama_save (matches code-act write tier)
                    budget: { wall_seconds: wallSeconds },
                    expires_at: new Date(Date.now() + wallSeconds * 1000 + 30_000).toISOString(),
                  });
                }
              : undefined,
          run: async (prompt, envelope) => {
            const result = await agentLoop.runWithContent(
              [{ type: 'text' as const, text: prompt }],
              {
                sessionKey: OPERATOR_REPORT_SESSION_KEY,
                source: 'operator',
                channelId: 'report',
                // Stateless report lane: each run starts on a fresh session so the
                // continuous session no longer accumulates every run's gather dumps
                // (measured 146s -> 521s growth over 3 days). Continuity comes from
                // the storage layer (self-gather + mama_recall + report store).
                freshSession: true,
                ...(envelope ? { envelope } : {}),
              }
            );
            return { response: result.response, history: result.history };
          },
          log: (line: string) => console.log(line),
          fullReportTag: OPERATOR_FULL_REPORT_TAG,
        }),
        review: (trigger, context) => reviewTriggerCLI(trigger, context),
        output: reportOutput,
        reportScheduler,
        // M2.3: the scheduled full report self-gathers via the persona agent's gateway tools
        // (the Kagemusha lesson: a reporter with tools has substance; a window summary alone
        // reports "quiet" whenever polling is between batches).
        fullReportSelfGather: ({ lastSuccessIso }: { lastSuccessIso: string | null }) => [
          'kagemusha_overview() for room/task/message counts',
          'kagemusha_tasks({}) for the open task board, plus kagemusha_tasks({ status: "review" }) for items awaiting review (status values must be real board statuses like pending/in_progress/review - invented labels match nothing)',
          lastSuccessIso
            ? `kagemusha_entities({ activeOnly: true }) for active channels, then kagemusha_messages({ channelId, since: "${lastSuccessIso}" }) on the busiest 2-3 - since is the last successful report; do NOT widen it`
            : 'kagemusha_entities({ activeOnly: true }) for active channels, then kagemusha_messages({ channelId }) on the busiest 2-3 (since defaults to the last 7 days; pass an ISO-8601 timestamp like since: "2026-07-09T00:00:00Z" to narrow it - never a phrase like "24h ago")',
          'mama_recall(query) for memory relevant to what you find',
          'schedule_upcoming({ days: 14 }) for upcoming calendar events -- cross-check task deadlines against them',
        ],
        // Kagemusha dual output: the same scheduled run updates the /ui operator board
        // slots via report_publish, then writes the plain-text owner report.
        fullReportBoardLines: buildBoardPublishLines(),
        // S1-T4 context carry: the delivered FULL report persists so the owner
        // console references it per turn instead of fabricating status.
        persistLastFullReport: (iso, text) => persistLastFullReport(iso, text),
        config: {
          tickMs: Number(process.env.MAMA_TRIGGER_LOOP_TICK_MS || 60_000),
          drainLimit: Number(process.env.MAMA_TRIGGER_LOOP_DRAIN_LIMIT || 200),
          authorEveryNTicks: Number(process.env.MAMA_TRIGGER_LOOP_AUTHOR_EVERY || 30),
          reviewEveryNTicks: Number(process.env.MAMA_TRIGGER_LOOP_REVIEW_EVERY || 240),
          authorWindowSize: 50,
          reportEveryNTicks: Number(process.env.MAMA_TRIGGER_LOOP_REPORT_EVERY || 15),
          nudgeDebounceMs: Number(process.env.MAMA_TRIGGER_LOOP_NUDGE_DEBOUNCE_MS || 15_000),
        },
        log: (line) => console.log(line),
      });
      if (reportOutput) {
        console.log('✓ Trigger loop owner-report leg enabled (telegram)');
      }
      if (reportScheduler) {
        console.log(
          `✓ Trigger loop scheduled full-report leg enabled (local hours: ${fullReportHours.join(', ')})`
        );
      }
      const stopTriggerLoop = triggerLoop.start();
      // M2.4: point the connector sink's forwarder at this loop now that it exists.
      triggerLoopNudge.current = () => triggerLoop.nudge();
      // S1-T3: owner-intent forwarder - report_request routes to the SAME
      // report machinery (fresh session, delta anchor, consume semantics).
      toolExecutor.setReportRequestHandler(() => triggerLoop.startFullReport());
      gateways.push({
        stop: async () => {
          triggerLoopNudge.current = null;
          stopTriggerLoop();
          // The shared operator DB handle is closed by the unconditional stop
          // hook above (single owner); nothing to close here.
        },
      });
      console.log('✓ Trigger loop enabled (MAMA_TRIGGER_LOOP=1, read-only surface mode)');
    } catch (error) {
      console.error(
        '[trigger-loop] FAILED to start - daemon continues WITHOUT the trigger loop. Fix and restart:',
        error
      );
    }
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
    envelopeMetadata: envelopeBootstrap.metadata,
    envelopeAuthority: envelopeBootstrap.envelopeAuthority,
    contextCompileService,
  });

  channelDeltaSink.current = (channelKey, lines) =>
    eventBus.emit({ type: 'operator:channel-delta', channelKey, lines });

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
    workOrderConsumer: workOrderConsumer ?? undefined,
  });

  // ── Stage-2 boot pass (plan S2-T3): hooks are registered above inside
  // registerApiRoutes; recovery/cleanup run here, then the consumer starts.
  if (stage2Flag === 'off') {
    // Rollback cleanup (plan D3): open system rows -> cancelled, ONE summary
    // line, no per-row alarms - a rollback is not a failure.
    const cancelled = taskLedger.cancelOpenWorkOrders('flag-off');
    if (cancelled > 0) {
      console.log(`[stage2] flag=off: cancelled ${cancelled} open workorder(s) (rollback cleanup)`);
    }
  } else {
    // Boot invariant (plan C13/G7): flag != off ⇒ consumer exists, hooks are
    // already registered, and start() succeeds - violation kills the boot.
    if (!workOrderConsumer) {
      throw new Error('[stage2] boot invariant violated: flag != off but consumer not constructed');
    }
    workOrderConsumer.bootRecover();
    workOrderConsumer.start();
    if (!workOrderConsumer.isStarted()) {
      throw new Error('[stage2] boot invariant violated: consumer failed to start');
    }
  }

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
