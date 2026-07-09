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
import type { AgentContext, GatewayToolExecutionContext } from '../../agent/types.js';
import {
  SessionStore,
  MessageRouter,
  initChannelHistory,
  PluginLoader,
} from '../../gateways/index.js';
import { createGraphHandler } from '../../api/graph-api.js';
import type { CodeActExecutionContext, GraphHandlerOptions } from '../../api/graph-api-types.js';
import Database from '../../sqlite.js';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { minimatch } from 'minimatch';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
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
import { initVNextWikiPublishAdapter } from '../runtime/wiki-publish-adapter-init.js';
import { startServer } from '../runtime/server-start.js';
import { installShutdownHandlers } from '../runtime/shutdown.js';
import { buildRuntimeEnvelopeBootstrap } from '../runtime/envelope-bootstrap.js';
import { resolveMessageRouterConfig } from '../runtime/message-router-config.js';
import { requireAdminAuth, requireAuth } from '../../api/auth-middleware.js';
import { buildPublicVNextProjectionPayload } from '../../api/report-handler.js';
import {
  buildVNextBootstrapPlan,
  buildVNextPrimaryOperatorReadyStatus,
  VNEXT_PRIMARY_OPERATOR_CONNECTOR,
  VNEXT_PRIMARY_OPERATOR_CURSOR_NAME,
  shouldSkipVNextFanout,
  startVNextBootstrapRuntime,
  type VNextBootstrapRuntimeHandles,
  type VNextBootstrapRuntimeStatus,
  type VNextPrimaryOperatorRuntimeHandle,
} from '../../runtime-vnext/bootstrap.js';
import { resolveVNextRuntimeFlags } from '../../runtime-vnext/feature-flags.js';
import { ensureVNextOperatorSchema } from '../../operator-vnext/schema.js';
import { PrimaryOperatorRuntime } from '../../operator-vnext/primary-operator-runtime.js';
import {
  buildReportSlotsFromSituationProjection,
  buildSituationProjection,
} from '../../operator-vnext/situation-projection.js';
import {
  createConnectorEventIngressPreviewProvider,
  resolveConnectorEventIngressConfig,
  type ConnectorEventIngressAdapter,
  type ConnectorEventIngressPreview,
} from '../../operator-vnext/connector-event-ingress.js';
import {
  createConnectorIngressMigrationDryRunProvider,
  type ConnectorIngressMigrationDryRun,
} from '../../operator-vnext/connector-ingress-migration-dry-run.js';
import {
  createConnectorIngressManualNoUpdateCommitProvider,
  isConnectorIngressManualCommitRequestError,
  MAX_MANUAL_NO_UPDATE_EVENT_INDEX_IDS,
  type ConnectorIngressManualCommitResult,
} from '../../operator-vnext/connector-ingress-manual-commit.js';
import {
  createDefaultConnectorIngressManualMemoryCommitProvider,
  MAX_MANUAL_MEMORY_COMMIT_TOTAL_MEMORIES,
  type ConnectorIngressManualMemoryCommitResult,
  type ManualMemorySaveInput,
} from '../../operator-vnext/connector-ingress-manual-memory-commit.js';
import {
  createConnectorIngressManualWikiCommitProvider,
  MAX_MANUAL_WIKI_COMMIT_TOTAL_PAGES,
  type ConnectorIngressManualWikiCommitResult,
} from '../../operator-vnext/connector-ingress-manual-wiki-commit.js';
import {
  MAX_WIKI_PAGE_CONTENT_CHARS,
  MAX_WIKI_PUBLISH_PAGES,
} from '../../wiki-artifacts/wiki-publish-adapter.js';
import type { WikiPublishPageInput } from '../../wiki-artifacts/types.js';
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
const vNextOperatorLogger = new DebugLogger('VNextPrimaryOperator');
type RuntimeBackend = 'claude' | 'codex' | 'codex-mcp';
const TRUTHY_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);
const JSON_ESCAPE_BYTES_PER_UTF16_UNIT = 6;
const MANUAL_WIKI_COMMIT_JSON_ENVELOPE_BYTES = 1024 * 1024;
const MANUAL_WIKI_COMMIT_JSON_LIMIT_BYTES =
  MAX_MANUAL_WIKI_COMMIT_TOTAL_PAGES *
    MAX_WIKI_PAGE_CONTENT_CHARS *
    JSON_ESCAPE_BYTES_PER_UTF16_UNIT +
  MANUAL_WIKI_COMMIT_JSON_ENVELOPE_BYTES;
const CODE_ACT_MUTATION_TOOLS = new Set([
  'mama_save',
  'context_compile',
  'mama_update',
  'mama_add',
  'mama_ingest',
  'report_publish',
  'wiki_publish',
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
  const vNextFlags = resolveVNextRuntimeFlags(config, process.env);
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
    if (!vNextFlags.enabled && shouldAutoOpenBrowser()) {
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
      if (!vNextFlags.enabled && shouldAutoOpenBrowser()) {
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

function buildVNextPrimaryOperatorPayload(
  primaryOperator: VNextBootstrapRuntimeStatus['primaryOperator']
): Record<string, unknown> {
  return {
    kind: primaryOperator.kind,
    status: primaryOperator.status,
    mode: primaryOperator.mode,
    ingress: primaryOperator.ingress,
    cursor_name: primaryOperator.cursorName,
    connector: primaryOperator.connector,
    advanced_through_seq: primaryOperator.advancedThroughSeq,
    last_batch_status: primaryOperator.lastBatchStatus,
    failed_seq: primaryOperator.failedSeq,
    error_message: primaryOperator.errorMessage,
  };
}

function buildVNextLegacyPrimaryOperatorPayload(): Record<string, unknown> {
  return {
    kind: 'primary_operator',
    status: 'noop',
    reason: 'vNext primary operator runtime is exposed as primary_operator_runtime.',
  };
}

export interface VNextIngressPreviewRequest {
  connector: string;
  channel: string;
  limit?: number;
}

export interface VNextIngressManualNoUpdateCommitRequest {
  connector: string;
  channel: string;
  expectedAdvancedThroughSeq: number;
  eventIndexIds: string[];
}

export interface VNextIngressManualWikiCommitRequest {
  connector: string;
  channel: string;
  expectedAdvancedThroughSeq: number;
  eventPages: Array<{
    eventIndexId: string;
    pages: WikiPublishPageInput[];
  }>;
}

export interface VNextIngressManualMemoryCommitRequest {
  connector: string;
  channel: string;
  expectedAdvancedThroughSeq: number;
  eventMemories: Array<{
    eventIndexId: string;
    memories: ManualMemorySaveInput[];
  }>;
}

export interface VNextBootstrapApiServerOptions {
  ingressPreviewProvider?: (input: VNextIngressPreviewRequest) => ConnectorEventIngressPreview;
  ingressMigrationDryRunProvider?: (
    input: VNextIngressPreviewRequest
  ) => ConnectorIngressMigrationDryRun;
  ingressManualNoUpdateCommitProvider?: (
    input: VNextIngressManualNoUpdateCommitRequest
  ) => Promise<ConnectorIngressManualCommitResult> | ConnectorIngressManualCommitResult;
  ingressManualWikiCommitProvider?: (
    input: VNextIngressManualWikiCommitRequest
  ) => Promise<ConnectorIngressManualWikiCommitResult> | ConnectorIngressManualWikiCommitResult;
  ingressManualMemoryCommitProvider?: (
    input: VNextIngressManualMemoryCommitRequest
  ) => Promise<ConnectorIngressManualMemoryCommitResult> | ConnectorIngressManualMemoryCommitResult;
}

function firstQueryString(value: unknown): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== 'string') {
    return null;
  }
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function queryLimit(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const raw = firstQueryString(value);
  if (raw === null) {
    throw new Error('limit must be a number');
  }
  const limit = Number(raw);
  if (!Number.isFinite(limit)) {
    throw new Error('limit must be a number');
  }
  return limit;
}

function requireRequestBodyRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('request body must be an object');
  }
  return value as Record<string, unknown>;
}

function bodyString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function bodyNonNegativeInteger(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function bodyStringArray(body: Record<string, unknown>, field: string, maxItems: number): string[] {
  const value = body[field];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === 'string' && item.trim().length > 0)
  ) {
    throw new Error(`${field} must be a non-empty string array`);
  }
  if (value.length > maxItems) {
    throw new Error(`${field} must contain at most ${maxItems} items`);
  }
  return value.map((item) => item.trim());
}

function bodyWikiPages(value: unknown): WikiPublishPageInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('event_pages[].pages must be a non-empty array');
  }
  if (value.length > MAX_WIKI_PUBLISH_PAGES) {
    throw new Error(`event_pages[].pages must contain at most ${MAX_WIKI_PUBLISH_PAGES} pages`);
  }
  return value.map((item) => {
    const page = requireRequestBodyRecord(item);
    if (
      Object.prototype.hasOwnProperty.call(page, 'sourceRefs') ||
      Object.prototype.hasOwnProperty.call(page, 'source_refs') ||
      Object.prototype.hasOwnProperty.call(page, 'sourceIds') ||
      Object.prototype.hasOwnProperty.call(page, 'source_ids') ||
      Object.prototype.hasOwnProperty.call(page, 'changedRefs') ||
      Object.prototype.hasOwnProperty.call(page, 'changed_refs')
    ) {
      throw new Error(
        'manual wiki commits derive source refs from reviewed events and changed refs from wiki page paths'
      );
    }
    const parsed: WikiPublishPageInput = {
      path: bodyString(page, 'path'),
      title: bodyString(page, 'title'),
      content: bodyString(page, 'content'),
    };
    const type = page.type;
    if (type !== undefined) {
      if (typeof type !== 'string' || type.trim().length === 0) {
        throw new Error('type must be a non-empty string');
      }
      parsed.type = type.trim();
    }
    const confidence = page.confidence;
    if (confidence !== undefined) {
      if (typeof confidence !== 'string' || confidence.trim().length === 0) {
        throw new Error('confidence must be a non-empty string');
      }
      parsed.confidence = confidence.trim();
    }
    return parsed;
  });
}

function bodyManualWikiEventPages(
  body: Record<string, unknown>
): VNextIngressManualWikiCommitRequest['eventPages'] {
  const value = body.event_pages;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('event_pages must be a non-empty array');
  }
  if (value.length > MAX_MANUAL_NO_UPDATE_EVENT_INDEX_IDS) {
    throw new Error(
      `event_pages must contain at most ${MAX_MANUAL_NO_UPDATE_EVENT_INDEX_IDS} items`
    );
  }
  const parsed = value.map((item) => {
    const eventPage = requireRequestBodyRecord(item);
    return {
      eventIndexId: bodyString(eventPage, 'event_index_id'),
      pages: bodyWikiPages(eventPage.pages),
    };
  });
  const totalPages = parsed.reduce((total, eventPage) => total + eventPage.pages.length, 0);
  if (totalPages > MAX_MANUAL_WIKI_COMMIT_TOTAL_PAGES) {
    throw new Error(
      `event_pages must contain at most ${MAX_MANUAL_WIKI_COMMIT_TOTAL_PAGES} total pages`
    );
  }
  return parsed;
}

function bodyMemoryScopes(value: unknown): MemoryScopeRef[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('memories[].scopes must be a non-empty array');
  }
  return value.map((item) => {
    const scope = requireRequestBodyRecord(item);
    const kind = bodyString(scope, 'kind');
    if (kind !== 'global' && kind !== 'user' && kind !== 'channel' && kind !== 'project') {
      throw new Error(`Unsupported memory scope kind: ${kind}`);
    }
    return {
      kind,
      id: bodyString(scope, 'id'),
    };
  });
}

function rejectManualMemoryDerivedFields(memory: Record<string, unknown>): void {
  const forbiddenKeys = [
    'source',
    'provenance',
    'sourceRefs',
    'source_refs',
    'sourceIds',
    'source_ids',
    'changedRefs',
    'changed_refs',
    'gatewayCallId',
    'gateway_call_id',
    'agentId',
    'agent_id',
    'modelRunId',
    'model_run_id',
    'envelopeHash',
    'envelope_hash',
    'timelineEvent',
    'timeline_event',
    'entityObservationIds',
    'entity_observation_ids',
  ];
  if (forbiddenKeys.some((key) => Object.prototype.hasOwnProperty.call(memory, key))) {
    throw new Error('manual memory commits derive source and provenance refs from reviewed events');
  }
}

function bodyManualMemory(value: unknown): ManualMemorySaveInput {
  const memory = requireRequestBodyRecord(value);
  rejectManualMemoryDerivedFields(memory);
  const parsed: ManualMemorySaveInput = {
    topic: bodyString(memory, 'topic'),
    kind: bodyString(memory, 'kind') as ManualMemorySaveInput['kind'],
    summary: bodyString(memory, 'summary'),
    details: bodyString(memory, 'details'),
    scopes: bodyMemoryScopes(memory.scopes),
  };
  const confidence = memory.confidence;
  if (confidence !== undefined) {
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
      throw new Error('confidence must be a number');
    }
    parsed.confidence = confidence;
  }
  const status = memory.status;
  if (status !== undefined) {
    parsed.status = bodyString(memory, 'status') as ManualMemorySaveInput['status'];
  }
  const eventDate = memory.event_date ?? memory.eventDate;
  if (eventDate !== undefined) {
    if (typeof eventDate !== 'string' || eventDate.trim().length === 0) {
      throw new Error('event_date must be a non-empty string');
    }
    parsed.eventDate = eventDate.trim();
  }
  const eventDateTime = memory.event_datetime ?? memory.eventDateTime;
  if (eventDateTime !== undefined) {
    if (typeof eventDateTime !== 'number' || !Number.isFinite(eventDateTime)) {
      throw new Error('event_datetime must be a number');
    }
    parsed.eventDateTime = eventDateTime;
  }
  return parsed;
}

function bodyManualMemoryEventMemories(
  body: Record<string, unknown>
): VNextIngressManualMemoryCommitRequest['eventMemories'] {
  const value = body.event_memories;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('event_memories must be a non-empty array');
  }
  if (value.length > MAX_MANUAL_NO_UPDATE_EVENT_INDEX_IDS) {
    throw new Error(
      `event_memories must contain at most ${MAX_MANUAL_NO_UPDATE_EVENT_INDEX_IDS} items`
    );
  }
  const parsed = value.map((item) => {
    const eventMemory = requireRequestBodyRecord(item);
    const memories = eventMemory.memories;
    if (!Array.isArray(memories) || memories.length === 0) {
      throw new Error('event_memories[].memories must be a non-empty array');
    }
    return {
      eventIndexId: bodyString(eventMemory, 'event_index_id'),
      memories: memories.map((memory) => bodyManualMemory(memory)),
    };
  });
  const totalMemories = parsed.reduce(
    (total, eventMemory) => total + eventMemory.memories.length,
    0
  );
  if (totalMemories > MAX_MANUAL_MEMORY_COMMIT_TOTAL_MEMORIES) {
    throw new Error(
      `event_memories must contain at most ${MAX_MANUAL_MEMORY_COMMIT_TOTAL_MEMORIES} total memories`
    );
  }
  return parsed;
}

function parseManualNoUpdateCommitBody(rawBody: unknown): VNextIngressManualNoUpdateCommitRequest {
  const body = requireRequestBodyRecord(rawBody);
  if (
    Object.prototype.hasOwnProperty.call(body, 'changedRefs') ||
    Object.prototype.hasOwnProperty.call(body, 'changed_refs')
  ) {
    throw new Error('manual no-update commits do not accept changed refs');
  }
  return {
    connector: bodyString(body, 'connector'),
    channel: bodyString(body, 'channel'),
    expectedAdvancedThroughSeq: bodyNonNegativeInteger(body, 'expected_advanced_through_seq'),
    eventIndexIds: bodyStringArray(body, 'event_index_ids', MAX_MANUAL_NO_UPDATE_EVENT_INDEX_IDS),
  };
}

function parseManualWikiCommitBody(rawBody: unknown): VNextIngressManualWikiCommitRequest {
  const body = requireRequestBodyRecord(rawBody);
  if (
    Object.prototype.hasOwnProperty.call(body, 'changedRefs') ||
    Object.prototype.hasOwnProperty.call(body, 'changed_refs')
  ) {
    throw new Error('manual wiki commits do not accept changed refs');
  }
  return {
    connector: bodyString(body, 'connector'),
    channel: bodyString(body, 'channel'),
    expectedAdvancedThroughSeq: bodyNonNegativeInteger(body, 'expected_advanced_through_seq'),
    eventPages: bodyManualWikiEventPages(body),
  };
}

function parseManualMemoryCommitBody(rawBody: unknown): VNextIngressManualMemoryCommitRequest {
  const body = requireRequestBodyRecord(rawBody);
  if (
    Object.prototype.hasOwnProperty.call(body, 'changedRefs') ||
    Object.prototype.hasOwnProperty.call(body, 'changed_refs') ||
    Object.prototype.hasOwnProperty.call(body, 'sourceRefs') ||
    Object.prototype.hasOwnProperty.call(body, 'source_refs') ||
    Object.prototype.hasOwnProperty.call(body, 'source') ||
    Object.prototype.hasOwnProperty.call(body, 'provenance') ||
    Object.prototype.hasOwnProperty.call(body, 'gatewayCallId') ||
    Object.prototype.hasOwnProperty.call(body, 'gateway_call_id') ||
    Object.prototype.hasOwnProperty.call(body, 'agentId') ||
    Object.prototype.hasOwnProperty.call(body, 'agent_id') ||
    Object.prototype.hasOwnProperty.call(body, 'modelRunId') ||
    Object.prototype.hasOwnProperty.call(body, 'model_run_id') ||
    Object.prototype.hasOwnProperty.call(body, 'envelopeHash') ||
    Object.prototype.hasOwnProperty.call(body, 'envelope_hash')
  ) {
    throw new Error('manual memory commits do not accept request-supplied refs or provenance');
  }
  return {
    connector: bodyString(body, 'connector'),
    channel: bodyString(body, 'channel'),
    expectedAdvancedThroughSeq: bodyNonNegativeInteger(body, 'expected_advanced_through_seq'),
    eventMemories: bodyManualMemoryEventMemories(body),
  };
}

const SAFE_MANUAL_MEMORY_COMMIT_PARTIAL_FAILURE_ERROR = 'Manual memory commit partially failed.';

function manualMemoryCommitResponse(
  result: ConnectorIngressManualMemoryCommitResult
): ConnectorIngressManualMemoryCommitResult {
  return {
    ok: result.ok,
    mode: 'manual_memory_commit',
    status: result.status,
    cursorName: result.cursorName,
    connector: result.connector,
    channel: result.channel,
    requestedCount: result.requestedCount,
    processed: result.processed,
    advancedThroughSeq: result.advancedThroughSeq,
    firstSeq: result.firstSeq,
    lastSeq: result.lastSeq,
    memoriesSaved: result.memoriesSaved,
    ...(result.promotionPending === true ? { promotionPending: true } : {}),
    commits: result.commits.map((commit) => ({
      seq: commit.seq,
      status: 'changed',
      outcome: commit.outcome,
      cursorAdvanced: commit.cursorAdvanced,
    })),
    ...(result.failedSeq !== undefined ? { failedSeq: result.failedSeq } : {}),
    ...(result.error !== undefined
      ? { error: SAFE_MANUAL_MEMORY_COMMIT_PARTIAL_FAILURE_ERROR }
      : {}),
  };
}

function isVNextIngressClientError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('locked to the configured connector/channel') ||
      error.message === 'limit must be a positive integer')
  );
}

function isVNextManualCommitClientError(error: unknown): boolean {
  return isConnectorIngressManualCommitRequestError(error);
}

function handleVNextManualCommitJsonError(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    res.status(typeof status === 'number' && status >= 400 && status < 500 ? status : 400).json({
      ok: false,
      code: 'vnext_ingress_manual_commit_invalid_json',
      error: 'Invalid JSON request body.',
    });
    return;
  }
  next(error);
}

function buildVNextStatusPayload(status: VNextBootstrapRuntimeStatus): Record<string, unknown> {
  return {
    ok: true,
    runtime: 'vnext',
    mode: status.mode,
    source: status.source,
    started_at_ms: status.startedAtMs,
    primary_operator: buildVNextLegacyPrimaryOperatorPayload(),
    primary_operator_runtime: buildVNextPrimaryOperatorPayload(status.primaryOperator),
    executed_startup_steps: status.executedStartupSteps,
  };
}

function buildVNextBootstrapSituationProjection(status: VNextBootstrapRuntimeStatus) {
  const primaryOperator = status.primaryOperator;
  const degraded = primaryOperator.status === 'degraded';
  const cursorSeq = primaryOperator.advancedThroughSeq;
  const viewModelHash = [
    'vnext-primary-operator',
    primaryOperator.status,
    cursorSeq,
    primaryOperator.lastBatchStatus ?? 'none',
    primaryOperator.failedSeq ?? 'none',
  ].join(':');

  return buildSituationProjection(
    [
      {
        situationId: 'vnext_primary_operator',
        situationVersion: cursorSeq,
        awarenessRunId: `vnext-bootstrap-${status.startedAtMs}`,
        title: 'Primary operator runtime',
        status: degraded ? 'blocked' : 'in_progress',
        summary: degraded
          ? 'Primary operator runtime is degraded and needs manual inspection.'
          : 'Primary operator runtime is prepared and owns vNext durable commits.',
        nextAction: degraded
          ? 'Inspect the failed batch and replay only verified source events.'
          : 'Continue verified manual batches through the primary operator cursor.',
        freshness: degraded ? 'degraded' : 'live',
        verificationState: degraded ? 'conflicting' : 'verified',
        confidence: degraded ? 0.4 : 1,
        evidenceRefs: [
          {
            kind: 'raw',
            connector: primaryOperator.connector,
            id: `${primaryOperator.cursorName}:${cursorSeq}`,
          },
        ],
        updatedAtMs: status.startedAtMs,
        viewModelHash,
        priority: degraded ? 0 : 10,
        tags: ['vnext', 'primary_operator'],
        pendingReason: degraded ? (primaryOperator.errorMessage ?? 'Runtime degraded.') : undefined,
        ownerHint: primaryOperator.cursorName,
        issueCount: degraded ? 1 : 0,
      },
    ],
    Date.now()
  );
}

function readVNextPrimaryOperatorCursorSeq(db: Database, cursorName: string): number {
  const row = db
    .prepare('SELECT last_change_seq FROM vnext_operator_cursors WHERE cursor_name = ?')
    .get(cursorName) as { last_change_seq: number } | undefined;
  return row?.last_change_seq ?? 0;
}

export interface VNextPrimaryOperatorRuntimeOptions {
  wikiPublishAdapter?: VNextPrimaryOperatorRuntimeHandle['wikiPublishAdapter'];
}

export function createVNextPrimaryOperatorRuntime(
  db: Database,
  options: VNextPrimaryOperatorRuntimeOptions = {}
): VNextPrimaryOperatorRuntimeHandle {
  const runtime = new PrimaryOperatorRuntime({
    db,
    cursorName: VNEXT_PRIMARY_OPERATOR_CURSOR_NAME,
    connector: VNEXT_PRIMARY_OPERATOR_CONNECTOR,
  });
  const status = buildVNextPrimaryOperatorReadyStatus(
    readVNextPrimaryOperatorCursorSeq(db, VNEXT_PRIMARY_OPERATOR_CURSOR_NAME)
  );
  const sanitizeBatchErrorForStatus = (): string =>
    'Primary operator batch failed. Check local logs for details.';
  const applyBatchResult = (result: Awaited<ReturnType<typeof runtime.processBatch>>): void => {
    status.advancedThroughSeq = result.advancedThroughSeq;
    status.lastBatchStatus = result.status;
    if (result.status === 'partial_failure') {
      vNextOperatorLogger.warn('Primary operator batch failed', {
        failedSeq: result.failedSeq,
        error: result.error.message,
      });
      status.status = 'degraded';
      status.failedSeq = result.failedSeq;
      status.errorMessage = sanitizeBatchErrorForStatus();
    } else if (result.status === 'committed') {
      status.status = 'prepared';
      delete status.failedSeq;
      delete status.errorMessage;
    }
  };

  return {
    status,
    wikiPublishAdapter: options.wikiPublishAdapter ?? null,
    processBatch: async (events, decide) => {
      const result = await runtime.processBatch(events, decide);
      applyBatchResult(result);
      return result;
    },
    processBatchWithChangedCommit: async (events, decide, commitChanged) => {
      const result = await runtime.processBatchWithChangedCommit(events, decide, commitChanged);
      applyBatchResult(result);
      return result;
    },
  };
}

export function createVNextBootstrapPrimaryOperatorRuntime(
  db: Database,
  plan: Pick<ReturnType<typeof buildVNextBootstrapPlan>, 'enabled'>
): VNextPrimaryOperatorRuntimeHandle {
  return createVNextPrimaryOperatorRuntime(db, {
    wikiPublishAdapter: initVNextWikiPublishAdapter(db, { enabled: plan.enabled }),
  });
}

export function createVNextBootstrapApiServer(
  status: VNextBootstrapRuntimeStatus,
  options: VNextBootstrapApiServerOptions = {}
): {
  app: Express;
  server: HttpServer | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  const app = express();
  app.disable('x-powered-by');
  const jsonBodyParser = express.json({ limit: '128kb' });
  const manualWikiCommitJsonBodyParser = express.json({
    limit: MANUAL_WIKI_COMMIT_JSON_LIMIT_BYTES,
  });

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      runtime: 'vnext',
      timestamp: Date.now(),
    });
  });
  app.post(
    '/api/vnext/ingress/manual-no-update-commit',
    requireAdminAuth,
    jsonBodyParser,
    async (req, res) => {
      if (!options.ingressManualNoUpdateCommitProvider) {
        res.status(404).json({
          ok: false,
          code: 'vnext_ingress_manual_commit_unavailable',
          error: 'vNext manual ingress commit is not configured.',
        });
        return;
      }

      let input: VNextIngressManualNoUpdateCommitRequest;
      try {
        input = parseManualNoUpdateCommitBody(req.body);
      } catch (error) {
        res.status(400).json({
          ok: false,
          code: 'vnext_ingress_manual_commit_invalid_request',
          error: error instanceof Error ? error.message : 'Invalid manual ingress commit request.',
        });
        return;
      }

      try {
        const result = await options.ingressManualNoUpdateCommitProvider(input);
        res.status(result.ok ? 200 : 409).json(result);
      } catch (error) {
        const clientError = isVNextManualCommitClientError(error);
        res.status(clientError ? 400 : 500).json({
          ok: false,
          code: clientError
            ? 'vnext_ingress_manual_commit_invalid_request'
            : 'vnext_ingress_manual_commit_failed',
          error: clientError
            ? error instanceof Error
              ? error.message
              : 'Invalid manual ingress commit request.'
            : 'vNext manual ingress commit failed.',
        });
      }
    }
  );
  app.use('/api/vnext/ingress/manual-no-update-commit', handleVNextManualCommitJsonError);
  app.post(
    '/api/vnext/ingress/manual-wiki-commit',
    requireAdminAuth,
    manualWikiCommitJsonBodyParser,
    async (req, res) => {
      if (!options.ingressManualWikiCommitProvider) {
        res.status(404).json({
          ok: false,
          code: 'vnext_ingress_manual_wiki_commit_unavailable',
          error: 'vNext manual wiki ingress commit is not configured.',
        });
        return;
      }

      let input: VNextIngressManualWikiCommitRequest;
      try {
        input = parseManualWikiCommitBody(req.body);
      } catch (error) {
        res.status(400).json({
          ok: false,
          code: 'vnext_ingress_manual_wiki_commit_invalid_request',
          error: error instanceof Error ? error.message : 'Invalid manual wiki commit request.',
        });
        return;
      }

      try {
        const result = await options.ingressManualWikiCommitProvider(input);
        res.status(result.ok ? 200 : 409).json(result);
      } catch (error) {
        const clientError = isVNextManualCommitClientError(error);
        res.status(clientError ? 400 : 500).json({
          ok: false,
          code: clientError
            ? 'vnext_ingress_manual_wiki_commit_invalid_request'
            : 'vnext_ingress_manual_wiki_commit_failed',
          error: clientError
            ? error instanceof Error
              ? error.message
              : 'Invalid manual wiki commit request.'
            : 'vNext manual wiki ingress commit failed.',
        });
      }
    }
  );
  app.use('/api/vnext/ingress/manual-wiki-commit', handleVNextManualCommitJsonError);
  app.post(
    '/api/vnext/ingress/manual-memory-commit',
    requireAdminAuth,
    jsonBodyParser,
    async (req, res) => {
      if (!options.ingressManualMemoryCommitProvider) {
        res.status(404).json({
          ok: false,
          code: 'vnext_ingress_manual_memory_commit_unavailable',
          error: 'vNext manual memory ingress commit is not configured.',
        });
        return;
      }

      let input: VNextIngressManualMemoryCommitRequest;
      try {
        input = parseManualMemoryCommitBody(req.body);
      } catch (error) {
        res.status(400).json({
          ok: false,
          code: 'vnext_ingress_manual_memory_commit_invalid_request',
          error: error instanceof Error ? error.message : 'Invalid manual memory commit request.',
        });
        return;
      }

      try {
        const result = await options.ingressManualMemoryCommitProvider(input);
        res.status(result.ok ? 200 : 409).json(manualMemoryCommitResponse(result));
      } catch (error) {
        const clientError = isVNextManualCommitClientError(error);
        res.status(clientError ? 400 : 500).json({
          ok: false,
          code: clientError
            ? 'vnext_ingress_manual_memory_commit_invalid_request'
            : 'vnext_ingress_manual_memory_commit_failed',
          error: clientError
            ? error instanceof Error
              ? error.message
              : 'Invalid manual memory commit request.'
            : 'vNext manual memory ingress commit failed.',
        });
      }
    }
  );
  app.use('/api/vnext/ingress/manual-memory-commit', handleVNextManualCommitJsonError);
  app.use(jsonBodyParser);
  app.use('/api', requireAuth);
  app.get('/api/vnext/status', (_req, res) => {
    res.json(buildVNextStatusPayload(status));
  });
  app.get('/api/status', (_req, res) => {
    res.json(buildVNextStatusPayload(status));
  });
  app.get('/api/vnext/ingress/preview', (req, res) => {
    if (!options.ingressPreviewProvider) {
      res.status(404).json({
        ok: false,
        code: 'vnext_ingress_preview_unavailable',
        error: 'vNext connector ingress preview is not configured.',
      });
      return;
    }

    const connector = firstQueryString(req.query.connector);
    const channel = firstQueryString(req.query.channel);
    if (!connector || !channel) {
      res.status(400).json({
        ok: false,
        code: 'vnext_ingress_preview_invalid_request',
        error: 'connector and channel query parameters are required.',
      });
      return;
    }

    let limit: number | undefined;
    try {
      limit = queryLimit(req.query.limit);
    } catch (error) {
      res.status(400).json({
        ok: false,
        code: 'vnext_ingress_preview_invalid_request',
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    try {
      res.json({
        ok: true,
        mode: 'dry_run',
        preview: options.ingressPreviewProvider({ connector, channel, limit }),
      });
    } catch (error) {
      const clientError = isVNextIngressClientError(error);
      res.status(clientError ? 400 : 500).json({
        ok: false,
        code: clientError
          ? 'vnext_ingress_preview_invalid_request'
          : 'vnext_ingress_preview_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.get('/api/vnext/ingress/migration-dry-run', (req, res) => {
    if (!options.ingressMigrationDryRunProvider) {
      res.status(404).json({
        ok: false,
        code: 'vnext_ingress_migration_dry_run_unavailable',
        error: 'vNext connector ingress migration dry-run is not configured.',
      });
      return;
    }

    const connector = firstQueryString(req.query.connector);
    const channel = firstQueryString(req.query.channel);
    if (!connector || !channel) {
      res.status(400).json({
        ok: false,
        code: 'vnext_ingress_migration_dry_run_invalid_request',
        error: 'connector and channel query parameters are required.',
      });
      return;
    }

    let limit: number | undefined;
    try {
      limit = queryLimit(req.query.limit);
    } catch (error) {
      res.status(400).json({
        ok: false,
        code: 'vnext_ingress_migration_dry_run_invalid_request',
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    try {
      res.json({
        ok: true,
        mode: 'dry_run',
        dry_run: options.ingressMigrationDryRunProvider({ connector, channel, limit }),
      });
    } catch (error) {
      const clientError = isVNextIngressClientError(error);
      res.status(clientError ? 400 : 500).json({
        ok: false,
        code: clientError
          ? 'vnext_ingress_migration_dry_run_invalid_request'
          : 'vnext_ingress_migration_dry_run_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.get('/api/report', (_req, res) => {
    const projection = buildVNextBootstrapSituationProjection(status);
    res.json({
      mode: 'vnext',
      projection: buildPublicVNextProjectionPayload(projection),
      slots: buildReportSlotsFromSituationProjection(projection),
    });
  });

  let server: HttpServer | null = null;
  let actualPort = API_PORT;

  return {
    app,
    get server() {
      return server;
    },
    async start(): Promise<void> {
      const host = process.env.MAMA_API_HOST || '127.0.0.1';
      await new Promise<void>((resolve, reject) => {
        const candidate = createServer(app);
        let settled = false;

        candidate.on('error', (error) => {
          if (settled) {
            return;
          }
          settled = true;
          candidate.close();
          reject(error);
        });
        candidate.listen({ port: API_PORT, host, exclusive: false }, () => {
          if (settled) {
            return;
          }
          settled = true;
          const address = candidate.address();
          if (!address || typeof address !== 'object') {
            candidate.close();
            reject(new Error(`Failed to bind vNext bootstrap API on port ${API_PORT}`));
            return;
          }
          server = candidate;
          actualPort = address.port;
          console.log(`vNext bootstrap API listening on http://${host}:${actualPort}`);
          if (host === '0.0.0.0') {
            console.warn('⚠️  WARNING: vNext bootstrap API exposed to all interfaces.');
          }
          resolve();
        });
      });
    },
    async stop(): Promise<void> {
      if (!server) {
        return;
      }
      const activeServer = server;
      server = null;
      activeServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        let settled = false;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        const done = () => {
          if (settled) {
            return;
          }
          settled = true;
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          resolve();
        };
        timeoutId = setTimeout(done, 2000);
        activeServer.close(done);
      });
    },
  };
}

function installVNextBootstrapShutdownHandlers(
  handles: VNextBootstrapRuntimeHandles<Database>
): void {
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log('\n\n🛑 Shutting down MAMA vNext bootstrap...');
    try {
      await handles.apiServer.stop();
    } catch (error) {
      console.error('Failed to stop vNext bootstrap API server during shutdown:', error);
    }
    try {
      handles.database.close();
    } catch (error) {
      console.error('Failed to close vNext bootstrap database during shutdown:', error);
    }
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
  process.once('SIGHUP', () => {
    void shutdown();
  });
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

  const vNext = buildVNextBootstrapPlan(resolveVNextRuntimeFlags(config, process.env));
  if (vNext.enabled) {
    console.log('✓ MAMA vNext bootstrap mode enabled (legacy fanout disabled)');
    const vNextIngressConfig = resolveConnectorEventIngressConfig(process.env);
    let vNextRawAdapter: ConnectorEventIngressAdapter | null = null;
    if (vNextIngressConfig.enabled) {
      process.env.MAMA_DB_PATH = expandPath(config.database.path);
      const { initDB, getAdapter } = (await import('@jungjaehoon/mama-core/db-manager')) as {
        initDB: () => Promise<unknown>;
        getAdapter: () => ConnectorEventIngressAdapter;
      };
      await initDB();
      vNextRawAdapter = getAdapter();
      console.log(
        `✓ vNext connector ingress preview enabled (${vNextIngressConfig.connector}/${vNextIngressConfig.channel})`
      );
    }
    let vNextOperatorDb: Database | null = null;
    await startVNextBootstrapRuntime(vNext, {
      openDatabase: () => {
        const dbPath = expandPath(config.database.path).replace(
          'mama-memory.db',
          'mama-sessions.db'
        );
        vNextOperatorDb = new Database(dbPath);
        return vNextOperatorDb;
      },
      initializeOperatorSchema: ensureVNextOperatorSchema,
      createPrimaryOperator: (database) =>
        createVNextBootstrapPrimaryOperatorRuntime(database, vNext),
      createApiServer: (status) => {
        if (!vNextIngressConfig.enabled) {
          return createVNextBootstrapApiServer(status);
        }
        if (!vNextRawAdapter || !vNextOperatorDb) {
          throw new Error(
            'vNext connector ingress preview requires initialized raw and operator DBs'
          );
        }
        return createVNextBootstrapApiServer(status, {
          ingressPreviewProvider: createConnectorEventIngressPreviewProvider({
            rawAdapter: vNextRawAdapter,
            operatorDb: vNextOperatorDb,
            connector: vNextIngressConfig.connector,
            channel: vNextIngressConfig.channel,
          }),
          ingressMigrationDryRunProvider: createConnectorIngressMigrationDryRunProvider({
            rawAdapter: vNextRawAdapter,
            operatorDb: vNextOperatorDb,
            connector: vNextIngressConfig.connector,
            channel: vNextIngressConfig.channel,
          }),
          ingressManualNoUpdateCommitProvider: createConnectorIngressManualNoUpdateCommitProvider({
            rawAdapter: vNextRawAdapter,
            operatorDb: vNextOperatorDb,
            connector: vNextIngressConfig.connector,
            channel: vNextIngressConfig.channel,
          }),
          ingressManualWikiCommitProvider: createConnectorIngressManualWikiCommitProvider({
            rawAdapter: vNextRawAdapter,
            operatorDb: vNextOperatorDb,
            wikiPublishAdapter: initVNextWikiPublishAdapter(vNextOperatorDb, { enabled: true })!,
            connector: vNextIngressConfig.connector,
            channel: vNextIngressConfig.channel,
          }),
          ingressManualMemoryCommitProvider:
            createDefaultConnectorIngressManualMemoryCommitProvider({
              rawAdapter: vNextRawAdapter,
              operatorDb: vNextOperatorDb,
              connector: vNextIngressConfig.connector,
              channel: vNextIngressConfig.channel,
            }),
        });
      },
      installShutdownHandlers: installVNextBootstrapShutdownHandlers,
    });
    return;
  }

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

  if (
    !shouldSkipVNextFanout(vNext, 'persona_write') &&
    !shouldSkipVNextFanout(vNext, 'agent_config_mutation')
  ) {
    // Provision default persona templates and multi-agent config on first start
    try {
      await provisionDefaults();
    } catch (error) {
      console.warn(
        `[Provision] Warning: ${error instanceof Error ? error.message : String(error)}`
      );
    }
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
    vNextRuntimeEnabled: vNext.enabled,
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
    {
      ...options,
      envelopeIssuanceMode: envelopeBootstrap.metadata.issuance,
      vNextRuntimeEnabled: vNext.enabled,
    }
  );

  // ── Phase 3: MAMA Core API ────────────────────────────────────────────────

  const { mamaApi, mamaApiClient, connectorExtractionFn } = await initMamaCore(config);

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

  const { memoryAgentLoop } =
    shouldSkipVNextFanout(vNext, 'ledger_memory_compose') ||
    shouldSkipVNextFanout(vNext, 'persona_write')
      ? { memoryAgentLoop: null }
      : await initMemoryAgent(
          oauthManager,
          config,
          mamaApi,
          mamaApiClient,
          messageRouter,
          agentLoopBackend
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
  if (
    !shouldSkipVNextFanout(vNext, 'agent_config_mutation') &&
    !shouldSkipVNextFanout(vNext, 'persona_write')
  ) {
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
          backend: 'claude',
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
  }

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
  if (
    !shouldSkipVNextFanout(vNext, 'agent_config_mutation') &&
    !shouldSkipVNextFanout(vNext, 'persona_write')
  ) {
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
  }

  if (!vNext.enabled) {
    await startEmbeddingServerIfAvailable(messageRouter, sessionStore, graphHandler);
  }

  // ── Phase 6: Cron Scheduler ───────────────────────────────────────────────

  const { scheduler, cronWorker, cronEmitter } = initCronScheduler(config, { vNext });

  // ── Phase 7: Gateways ────────────────────────────────────────────────────

  const gatewayInit = shouldSkipVNextFanout(vNext, 'connector_mode')
    ? {
        discordGateway: null,
        slackGateway: null,
        telegramGateway: null,
        gateways: [],
      }
    : await initGateways(config, messageRouter, toolExecutor, agentLoop, runtimeBackend, db);
  const { discordGateway, slackGateway, telegramGateway, gateways } = gatewayInit;

  // ── Phase 8: Gateway Wiring ──────────────────────────────────────────────

  const { pluginLoader } = shouldSkipVNextFanout(vNext, 'connector_mode')
    ? { pluginLoader: new PluginLoader({ pluginsDir: '/__mama_vnext_no_plugins__' }) }
    : await wireGateways({
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
    !shouldSkipVNextFanout(vNext, 'agent_config_mutation') &&
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
    healthCheckService,
    { vNext }
  );

  const { rawStoreForApi, enabledConnectorNames, connectorSchedulerStop } = await initConnectors(
    connectorExtractionFn,
    { vNext }
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
    const { OperatorTriggerLoop } = await import('../../operator/operator-trigger-loop.js');
    const { ConnectorDeltaRepo } = await import('../../operator/connector-delta-repo.js');
    const { TriggerRegistry } = await import('../../operator/trigger-registry.js');
    const { createMamaMemoryPort } = await import('../../operator/mama-memory-port.js');
    const { askAgentCLI } = await import('../../operator/trigger-author.js');
    const { reviewTriggerCLI } = await import('../../operator/trigger-review.js');
    const { mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const { ReportScheduler, FileReportScheduleStore, parseReportHours } = await import(
      '../../operator/report-scheduler.js'
    );

    const triggerDbPath = expandPath('~/.mama/operator/triggers.db');
    mkdirSync(dirname(triggerDbPath), { recursive: true });
    const triggerRegistry = new TriggerRegistry(new Database(triggerDbPath));
    // Owner-report leg (M1.5): destination chat comes from env (~/.mama/start.sh),
    // never source. No chat configured or no telegram gateway -> loop stays read-only.
    const reportChatId = process.env.MAMA_TRIGGER_LOOP_REPORT_CHAT || '';
    const reportOutput =
      reportChatId && telegramGateway
        ? { send: (text: string) => telegramGateway.sendMessage(reportChatId, text) }
        : undefined;
    // Scheduled full-report leg (M2): local hours from env (~/.mama/start.sh), never source.
    // Empty/absent -> [] -> leg off. Requires the same telegram sink as the digest leg.
    const fullReportHours = parseReportHours(process.env.MAMA_TRIGGER_LOOP_FULL_REPORT_HOURS || '');
    const reportScheduler =
      fullReportHours.length > 0 && reportOutput
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
      askAgent: askAgentCLI,
      review: (trigger, context) => reviewTriggerCLI(trigger, context),
      output: reportOutput,
      reportScheduler,
      config: {
        tickMs: Number(process.env.MAMA_TRIGGER_LOOP_TICK_MS || 60_000),
        drainLimit: Number(process.env.MAMA_TRIGGER_LOOP_DRAIN_LIMIT || 200),
        authorEveryNTicks: Number(process.env.MAMA_TRIGGER_LOOP_AUTHOR_EVERY || 30),
        reviewEveryNTicks: Number(process.env.MAMA_TRIGGER_LOOP_REVIEW_EVERY || 240),
        authorWindowSize: 50,
        reportEveryNTicks: Number(process.env.MAMA_TRIGGER_LOOP_REPORT_EVERY || 15),
      },
      log: (line) => console.log(line),
    });
    if (reportOutput) {
      console.log('✓ Trigger loop owner-report leg enabled (telegram)');
    }
    if (reportScheduler) {
      console.log(`✓ Trigger loop scheduled full-report leg enabled (local hours: ${fullReportHours.join(', ')})`);
    }
    const stopTriggerLoop = triggerLoop.start();
    gateways.push({
      stop: () => {
        stopTriggerLoop();
        return Promise.resolve();
      },
    });
    console.log('✓ Trigger loop enabled (MAMA_TRIGGER_LOOP=1, read-only surface mode)');
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
    vNext,
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
