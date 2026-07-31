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
import { liveBoundaryChannels } from '../../evidence/read.js';
import type { AgentContext, GatewayToolExecutionContext } from '../../agent/types.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import { projectCodeActToolPolicy, requireCodeActTier } from '../../agent/code-act/tool-policy.js';
import type { ExecutionResult } from '../../agent/code-act/types.js';
import { SessionStore, MessageRouter, initChannelHistory } from '../../gateways/index.js';
import { createGraphHandler } from '../../api/graph-api.js';
import type {
  CodeActExecutionContext,
  CodeActResult,
  GraphHandlerOptions,
} from '../../api/graph-api-types.js';
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
import {
  DEFAULT_CONFIG,
  DEFAULT_ROLES,
  type AgentPersonaConfig,
  type RoleConfig,
} from '../config/types.js';
import { RoleManager } from '../../agent/role-manager.js';
import { randomUUID } from 'node:crypto';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';
import {
  beginModelRunInAdapter,
  commitModelRunInAdapter,
  failModelRunInAdapter,
} from '@jungjaehoon/mama-core';
import type { DBManagerAdapter as DatabaseAdapter } from '@jungjaehoon/mama-core';
import { OPERATOR_REPORT_SESSION_KEY } from '../../operator/report-run.js';
import { ensureConsoleBrief } from '../../operator/console-brief.js';
import { TaskLedger, type WorkOrderKind } from '../../operator/task-ledger.js';
import { ConductorInbox } from '../../operator/conductor-inbox.js';
import { ConductorSession } from '../../operator/conductor-session.js';
import { Conductor } from '../../operator/conductor.js';
import { buildBoardReground } from '../../operator/board-reground.js';
import { initLegCadence, getLegCadence, getLegPageNotifier } from '../../operator/leg-cadence.js';
import { getSessionPool } from '../../agent/session-pool.js';
import { buildTemporalWorkerContext } from '../../operator/temporal-worker.js';
import {
  closeTemporalRuntimeBeforeDatabase,
  preflightTemporalStartup,
  type TemporalRuntime,
} from '../../operator/temporal-runtime.js';
import { assembleDaemonTemporalRuntime } from '../runtime/temporal-init.js';
import { DEFAULT_TICK_MS as WORKORDER_CONSUMER_TICK_MS } from '../../operator/workorder-consumer.js';

const { DebugLogger } = debugLogger as unknown as {
  DebugLogger: new (context?: string) => {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
};
const codeActLogger = new DebugLogger('CodeAct');
const temporalLogger = new DebugLogger('TemporalReconcile');
type RuntimeBackend = 'claude' | 'codex';

export function requireRuntimeBackend(value: unknown): RuntimeBackend {
  if (value === 'claude' || value === 'codex') {
    return value;
  }
  throw new Error(`Unsupported agent backend: ${String(value)}`);
}

export function serializeCodeActExecutionResult(
  result: ExecutionResult,
  toolCalls: { name: string; input: Record<string, unknown> }[]
): CodeActResult & { toolCalls: { name: string; input: Record<string, unknown> }[] } {
  return {
    success: result.success,
    value: result.value,
    logs: result.logs,
    error: result.error?.message,
    ...(result.error?.code
      ? { terminalCode: result.error.code, retryable: false, abort: true }
      : {}),
    metrics: result.metrics,
    toolCalls,
  };
}
const TRUTHY_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);
const CODE_ACT_MUTATION_TOOLS = new Set([
  'mama_save',
  'context_compile',
  'mama_update',
  'report_publish',
  'wiki_publish',
  'task_create',
  'task_update',
  'task_temporal_reconcile',
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

/**
 * READS ARE NOT GATED (2026-07-30, owner rules "observability over
 * restriction" + "answers read direct, gates guard writes only"). The
 * per-principal trello filter this replaced (#199) collided with the 07-28
 * code-act transport switch: owner chat's tool calls moved onto the
 * api-code-act envelope and its board questions died 100%
 * connector_out_of_scope, while the board drifted 3 weeks undetected
 * (7 delivered items shown overdue - operator lesson 07-30). Kagemusha's
 * model - reads free, actions receipted, sends confirmed - is the standard.
 * Every daemon envelope still grants allowed_destinations: [] (the real,
 * irreversible-side-effect gate) and every read lands in tool traces.
 */

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

/**
 * The connector and channel a temporal task is bound to, as plain values.
 *
 * The workorder payload carries only HASHED source identifiers (they are compared, never
 * read), so the binding has to come from the owner task row. Split on the FIRST colon:
 * `source_channel` is `<connector>:<channelId>` and channel ids contain colons of their own.
 *
 * Returns null when the task names no channel - which is not a failure, it is a task whose
 * reconcile may rest on no raw evidence at all.
 */
/**
 * The scope a workorder envelope carries.
 *
 * Extracted so the binding can be asserted directly. Composed inline, the only way to test
 * it was to re-compose it in the test - which tests the copy, and a copy of a scope
 * construction is how this subsystem's authority drifts from what it claims.
 */
/**
 * What the scheduled full report is INSTRUCTED to gather with.
 *
 * Exported so a test can hold it against the lane's tool grant. Every defect this session
 * found was a wiring defect - a tool granted and never instructed, a lane wired zero times,
 * a binder that never bound - and all of them live in this file and its neighbour, the two
 * directories the suite covers at a third. An instruction list that cannot be read by a
 * test is one nobody can check against the grant it depends on.
 */
export function buildFullReportGatherLines({
  lastSuccessIso,
}: {
  lastSuccessIso: string | null;
}): string[] {
  // Product premise (S1): MAMA presupposes no Kagemusha. The report gathers
  // the NATIVE board; message evidence is the SituationReporter's accumulated
  // window, never a re-fetch through a personal system.
  return [
    'task_list({}) for the open native task board, plus task_list({ status: "review" }) for items awaiting review (status values must be real board statuses like pending/in_progress/review - invented labels match nothing)',
    'mama_recall(query) for memory relevant to what you find',
    'schedule_upcoming({ days: 14 }) for upcoming calendar events -- cross-check task deadlines against them',
    lastSuccessIso
      ? `changes_read({ since: "${lastSuccessIso}" }) for what THIS system durably changed since the last report -- lead with it, and say what each change rested on`
      : 'changes_read({ since: "7d" }) for what THIS system durably changed in the window -- lead with it, and say what each change rested on',
    'On changes_read: cause_state "unattributed" means the system cannot explain that change, NOT that nothing happened -- report the coverage counts as they are rather than rounding them up. It is ONE PAGE: if returned is less than total, say so instead of describing the page as the whole. It covers work items only today, so the absence of report or memory changes there is not evidence they did not happen.',
  ];
}

/**
 * The batch a work order carries, as the run's cause.
 *
 * Exported because it was an inline closure and therefore untestable, while being the ONE
 * hop that carries this branch's whole claim: the system knew the batch before the run
 * began, so the agent never has to restate it. Review pointed out that `causeEventIds`
 * appeared in exactly two test files and both called the ledger directly - a rename or a
 * payload-shape drift here would have returned attribution to 32% with the suite green.
 *
 * Only per-channel reconcile work orders carry `eventIds`; `board:full`, wiki and
 * memory-curation do not, and get an empty batch rather than an invented one.
 */
export function causeEventIdsFromPayload(payload: unknown): string[] {
  if (payload === null || typeof payload !== 'object') return [];
  const batch = (payload as { eventIds?: unknown }).eventIds;
  if (!Array.isArray(batch)) return [];
  return batch.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
}

export function workOrderEnvelopeScope(input: {
  workKind: string;
  projectId: string;
  laneConnectors: string[];
  temporalBinding: { connector: string; channel: string } | null;
}): {
  project_refs: Array<{ kind: 'project'; id: string }>;
  raw_connectors: string[];
  memory_scopes: MemoryScopeRef[];
  allowed_destinations: never[];
} {
  const isTemporal = input.workKind === 'temporal';
  return {
    project_refs: [{ kind: 'project' as const, id: input.projectId }],
    // A temporal run reads its task's connector or nothing. Every other lane keeps the
    // connectors it was configured with.
    raw_connectors: isTemporal
      ? input.temporalBinding
        ? [input.temporalBinding.connector]
        : []
      : input.laneConnectors,
    memory_scopes: [
      ...deriveMemoryScopes({
        source: 'operator',
        channelId: `worker:${input.workKind}`,
        projectId: input.projectId,
      }),
      // Identity scopes ONLY. Wider memory READ visibility (the grant mirror)
      // is granted at the enforcement layer, never issued into the envelope:
      // envelope channel scopes double as the raw-narrowing input AND as
      // mama_save's write binding, so issuing the mirror here re-opened
      // per-channel raw isolation and bound every saved memory to every
      // granted channel (PR #217 review, blocking #2/#3).
      ...(input.temporalBinding
        ? [
            {
              kind: 'channel' as const,
              id: `${input.temporalBinding.connector}:${input.temporalBinding.channel}`,
            },
          ]
        : []),
    ],
    allowed_destinations: [],
  };
}

export function temporalTaskBinding(
  ledger: { getById: (id: number) => { sourceChannel?: string | null } | null },
  taskId: number
): { connector: string; channel: string } | null {
  const sourceChannel = ledger.getById(taskId)?.sourceChannel;
  if (typeof sourceChannel !== 'string') return null;
  const separator = sourceChannel.indexOf(':');
  if (separator <= 0 || separator === sourceChannel.length - 1) return null;
  return {
    connector: sourceChannel.slice(0, separator),
    channel: sourceChannel.slice(separator + 1),
  };
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

interface WorkOrderToolPolicy {
  roleName: string;
  allowedTools: readonly string[];
}

// Stage-2 workers are short-lived operator jobs, not standing multi-agent
// personas. Their permissions must therefore be complete on a default install
// and must not vary with optional legacy agent configuration.
export const WORKORDER_TOOL_POLICIES = {
  board: {
    roleName: 'workorder-board',
    allowedTools: [
      'agent_notices',
      'changes_read',
      'context_compile',
      'contract_no_update',
      'kagemusha_entities',
      'kagemusha_messages',
      'kagemusha_overview',
      'kagemusha_tasks',
      'mama_search',
      'report_publish',
      'task_create',
      'task_list',
      'task_update',
      'trello_card',
      'trello_kanban',
      'trello_search',
    ],
  },
  wiki: {
    roleName: 'workorder-wiki',
    allowedTools: ['agent_notices', 'context_compile', 'mama_search', 'obsidian', 'wiki_publish'],
  },
  'memory-curation': {
    roleName: 'workorder-memory-curation',
    allowedTools: [
      'agent_notices',
      'kagemusha_entities',
      'kagemusha_messages',
      'mama_save',
      'mama_search',
    ],
  },
  temporal: {
    roleName: 'workorder-temporal',
    allowedTools: [
      'agent_notices',
      'context_compile',
      'kagemusha_entities',
      'kagemusha_messages',
      'kagemusha_overview',
      'kagemusha_tasks',
      'schedule_upcoming',
      'task_list',
      'task_temporal_reconcile',
    ],
  },
} as const satisfies Record<WorkOrderKind, WorkOrderToolPolicy>;

/**
 * Gateway tools the scheduled operator report must be able to EXECUTE.
 *
 * The report lane is a short-lived operator job like the Stage-2 workers, so its permissions
 * are built in rather than derived from optional persona config. Membership is dictated by
 * what the report is actually instructed to call: report-run.ts GATHER_TOOLS (the audit that
 * decides whether a full report has task-board substance), the fullReportSelfGather lines,
 * the board_publish lines, and the single mama_save the report may make.
 *
 * Its envelope grants no destinations, so no send tool belongs here, and no task-mutation
 * tool either: the report observes, the board workorder maintains.
 *
 * trello_kanban is the ONE whole-board live read. Without it the report could only restate the
 * native ledger, which is a derived store the board workorder is forbidden to sync from Trello -
 * so a card that moved days ago still reported as "no completion signal" (live 2026-07-28).
 * Reading it is scoped by the envelope now that direct connector readers are mapped in
 * envelope/tool-connector-scope.ts; without that mapping this entry alone would have granted
 * unscoped access.
 */
export const OPERATOR_REPORT_TOOL_POLICY = {
  roleName: 'operator-report',
  allowedTools: [
    // context_compile is deliberately ABSENT. Envelope scope is connector-level, so
    // granting the board connector for trello_kanban would otherwise also permit
    // context_compile({connectors:['trello']}) - raw card bodies pulled into a tier-2
    // lane that can write durable memory. The report needs the whole-board read, not
    // raw compilation, and its gather instructions never ask for it.
    // What the report is FOR: what moved since last time. Until now the only way to
    // answer that was to re-read current state and infer the delta, which is how a
    // report ends up restating the board instead of naming the change.
    'changes_read',
    'kagemusha_entities',
    'kagemusha_messages',
    'kagemusha_overview',
    'kagemusha_tasks',
    'mama_provenance',
    'mama_recall',
    'mama_save',
    'mama_search',
    'report_publish',
    'schedule_upcoming',
    'task_external_correlation',
    'task_list',
    'trello_kanban',
  ],
} as const satisfies WorkOrderToolPolicy;

export interface WorkOrderAgentPolicy {
  agentContext: AgentContext;
  gatewayToolsPrompt: string;
}

/**
 * The conductor's grant (S1). Reads and judgment surfaces plus the ONE write
 * family the spec's center names: committing work orders and board cards. No
 * sends, no memory writes, no compile - the untrusted-input lane stays the
 * most restricted lane, not the least (review F2/security).
 */
export const CONDUCTOR_TOOL_POLICY = {
  roleName: 'conductor',
  allowedTools: [
    'board_read',
    'changes_read',
    'mama_recall',
    'mama_search',
    'task_create',
    'task_list',
    'task_update',
    'workorder_request',
    'workorder_status',
  ],
} as const satisfies WorkOrderToolPolicy;

/** Mirrors buildOperatorReportAgentPolicy - same shape, conductor grant. */
export function buildConductorAgentPolicy(
  model: string,
  backend: RuntimeBackend
): WorkOrderAgentPolicy {
  const blockedTools: string[] = [];
  const innerTools = uniqueToolList(CONDUCTOR_TOOL_POLICY.allowedTools);
  const allowedTools = uniqueToolList([...innerTools]);
  const agentContext: AgentContext = {
    source: 'conductor',
    platform: 'cli',
    roleName: CONDUCTOR_TOOL_POLICY.roleName,
    role: {
      allowedTools,
      blockedTools,
      allowedPaths: [],
      systemControl: false,
      sensitiveAccess: false,
      model,
    },
    session: {
      sessionId: 'conductor:main',
      channelId: 'conductor',
      startedAt: new Date(),
    },
    capabilities: allowedTools,
    limitations: blockedTools.map((tool) => `Cannot use ${tool}`),
    // Write tier: board cards and work orders only - matches the envelope.
    tier: 2,
    backend,
  };
  return { agentContext, gatewayToolsPrompt: ToolRegistry.generatePrompt(innerTools) };
}

/**
 * Merge + validate the conductor config at boot. No-fallback: a malformed
 * value must crash loudly, not silently clamp (review F10: tickMs 0 spins
 * the event loop with a DB write per iteration).
 */
export function resolveConductorConfig(
  config: Pick<import('../config/types.js').MAMAConfig, 'conductor'>
): import('../config/types.js').ConductorConfig {
  const resolved = {
    ...DEFAULT_CONFIG.conductor!,
    ...(config.conductor ?? {}),
  };
  const positive: Array<[string, number, number]> = [
    ['tickMs', resolved.tickMs, 1_000],
    ['maxAgeMs', resolved.maxAgeMs, 60_000],
    ['maxTurns', resolved.maxTurns, 1],
    ['maxTokens', resolved.maxTokens, 1_000],
  ];
  for (const [name, value, min] of positive) {
    if (!Number.isFinite(value) || value < min) {
      throw new Error(`conductor.${name} must be a number >= ${min}, got ${String(value)}`);
    }
  }
  return resolved;
}

/**
 * Build the Code-Act role the operator report lane runs under.
 *
 * Without an agentContext.role, roleAllowsOuterCodeAct() returns false (agent-loop.ts), the
 * Code-Act branch of prepareSystemPrompt strips the generic gateway catalog, and NOTHING
 * replaces it - the report agent then runs with zero tool definitions and every full report
 * logs "executed NO gateway gather tools" while still being delivered. Mirrors
 * buildWorkOrderAgentPolicy so both operator job families get their permissions the same way.
 */
export function buildOperatorReportAgentPolicy(
  model: string,
  backend: RuntimeBackend
): WorkOrderAgentPolicy {
  const blockedTools: string[] = [];
  const innerTools = uniqueToolList(OPERATOR_REPORT_TOOL_POLICY.allowedTools);
  const allowedTools = uniqueToolList(['code_act', ...innerTools]);
  const agentContext: AgentContext = {
    source: 'operator',
    platform: 'cli',
    roleName: OPERATOR_REPORT_TOOL_POLICY.roleName,
    role: {
      allowedTools,
      blockedTools,
      allowedPaths: [],
      systemControl: false,
      sensitiveAccess: false,
      model,
    },
    session: {
      sessionId: OPERATOR_REPORT_SESSION_KEY,
      channelId: 'report',
      startedAt: new Date(),
    },
    capabilities: allowedTools,
    limitations: blockedTools.map((tool) => `Cannot use ${tool}`),
    // Write tier: the report may persist one durable decision via mama_save, matching the
    // tier its envelope already carries.
    tier: 2,
    backend,
  };
  return { agentContext, gatewayToolsPrompt: ToolRegistry.generatePrompt(innerTools) };
}

export function buildWorkOrderAgentPolicy(
  kind: WorkOrderKind,
  model: string,
  backend: RuntimeBackend
): WorkOrderAgentPolicy {
  const policy = WORKORDER_TOOL_POLICIES[kind];
  if (!policy) {
    throw new Error(`Missing built-in workorder tool policy for '${kind}'`);
  }
  const blockedTools: string[] = [];
  const innerTools = uniqueToolList(policy.allowedTools);
  const allowedTools = uniqueToolList(['code_act', ...innerTools]);
  const agentContext: AgentContext = {
    source: 'operator',
    platform: 'cli',
    roleName: policy.roleName,
    role: {
      allowedTools,
      blockedTools,
      allowedPaths: [],
      systemControl: false,
      sensitiveAccess: false,
      model,
    },
    session: {
      sessionId: `operator:worker:${kind}`,
      channelId: `worker:${kind}`,
      startedAt: new Date(),
    },
    capabilities: allowedTools,
    limitations: blockedTools.map((tool) => `Cannot use ${tool}`),
    tier: 2,
    backend,
  };
  return {
    agentContext,
    gatewayToolsPrompt: ToolRegistry.generatePrompt(innerTools),
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

  const backend = requireRuntimeBackend(config.agent.backend);
  process.env.MAMA_BACKEND = backend;

  if (backend === 'codex') {
    console.log('✓ Codex app-server backend (authentication handled by Codex login)');
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

  // Fails the boot on the retired MAMA_STAGE2_WORKORDERS legacy pin
  // (workorders are the only run path since v0.28.0).
  const temporalStartup = preflightTemporalStartup(process.env);

  const runtimeBackend = requireRuntimeBackend(config.agent.backend);
  const temporalPolicy =
    temporalStartup.temporalFlag === 'on'
      ? buildWorkOrderAgentPolicy('temporal', config.agent.model, runtimeBackend)
      : null;
  const temporalEffectiveTools = temporalPolicy
    ? projectCodeActToolPolicy({
        tier: requireCodeActTier(temporalPolicy.agentContext.tier),
        role: temporalPolicy.agentContext.role,
      }).names
    : [];
  const temporalAvailableTools = ToolRegistry.getValidToolNames();
  if (
    temporalStartup.temporalFlag === 'on' &&
    (!temporalEffectiveTools.includes('task_temporal_reconcile') ||
      !temporalAvailableTools.includes('task_temporal_reconcile'))
  ) {
    throw new Error('temporal reconciliation tool policy or transport registry is incompatible');
  }

  const startupBackend = runtimeBackend;
  const usesCodexBackend = startupBackend === 'codex' || hasCodexBackendConfigured(config);

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

  // ── Phase 2: Session + Tool + Agent Loop ──────────────────────────────────

  const sessionStore = new SessionStore(db);

  // Establish one canonical private workspace for gateway files, OCR, Drive,
  // Telegram media, and the persona runtime. An explicit environment override
  // remains authoritative; otherwise honor config.workspace.path.
  const workspaceRoot = expandPath(
    process.env.MAMA_WORKSPACE || config.workspace?.path || '~/.mama/workspace'
  );
  process.env.MAMA_WORKSPACE = workspaceRoot;

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

  process.env.MAMA_BACKEND = runtimeBackend;
  const agentLoopBackend: 'claude' | 'codex' = runtimeBackend;

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
  toolExecutor.setMamaApi(mamaApi);

  // getAdapter is still used directly in this file for DB queries after initDB has run
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getAdapter } = require('@jungjaehoon/mama-core/db-manager');
  const contextCompileService = createContextCompileService({
    memoryAdapter: getAdapter(),
    // Raw visibility comes from the owner's connector config, not from the derived scope
    // columns. Without this the compile reads nothing: measured on the live index, the
    // scope-based predicate returns 0 of 30,671 events for the input shape sent here.
    channelGrant: liveBoundaryChannels,
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

  // Wire sessionsDb into gateway tool executor
  toolExecutor.setSessionsDb(db);
  agentLoop.setSessionsDb(db);

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
      const memoryScopes = uniqueMemoryScopes(
        deriveMemoryScopes({
          source: 'watch',
          channelId: 'api:code-act',
          userId: 'api',
          projectId,
        })
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
      const result = await sandbox.execute(code, { signal: executionContext?.signal });
      finalizeCodeActParentModelRun(getAdapter(), parentRun.modelRunId, result);
      return serializeCodeActExecutionResult(result, toolCalls);
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

    // The delegate wiring was here. Over the full log history it was wired ZERO times and
    // its only runtime trace was one call refused by role permission. The process manager
    // above stays: that one IS wired on every boot (113 so far) and runs the dashboard and
    // wiki agents.
    console.log('[start] ✓ System agent process manager wired');
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
  // wake), which remains safe while the trigger loop is still booting or explicitly disabled.
  const triggerLoopNudge: { current: (() => void) | null } = { current: null };
  // M8: board-reconcile feed. The trigger loop is built BEFORE the event bus
  // exists (initApiServer), so it emits through this mutable sink (same
  // pattern as triggerLoopNudge above).
  const channelDeltaSink: {
    current: ((channelKey: string, lines: string[], eventIds: string[]) => void) | null;
  } = {
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
    taskLedger = new TaskLedger(operatorDb);
    toolExecutor.setTaskLedger(taskLedger);
  } catch (err) {
    // Fail loud, but do not leak the handle on a failed boot.
    operatorDb.close();
    throw err;
  }
  // S1: durable conductor inbox - constructed UNCONDITIONALLY so drained
  // batches persist before the cursor commits even while the conductor is
  // disabled (that accumulation IS the shadow-mode data; retention inside
  // ConductorInbox keeps it bounded).
  const conductorInbox = new ConductorInbox(operatorDb);
  // S2: leg cadence watchdog - its OWN timer, deliberately outside the
  // trigger loop (a watchdog inside the thing it watches dies with it).
  // Legs declare+beat at their own tick sites via the singleton; pages ride
  // the owner-alert targets registered in gateway wiring. Alarm, never
  // enforcement; quiet hours honored inside check().
  const legCadence = initLegCadence(operatorDb);
  legCadence.declare('workorder-consumer', WORKORDER_CONSUMER_TICK_MS);
  // Declared HERE, not in HeartbeatScheduler.start(): the heartbeat starts
  // 47 lines before this singleton exists, so a declare there hit null and
  // the leg was silently unwatched (review, blocking). The scheduler owns
  // the number; boot owns the ordering.
  const heartbeatCadenceMs = heartbeatScheduler.declaredCadence();
  if (heartbeatCadenceMs !== null) {
    legCadence.declare('heartbeat', heartbeatCadenceMs);
  }
  const legWatchdog = setInterval(() => {
    try {
      const { pages, recoveries } = legCadence.check();
      for (const page of pages) {
        const minutes = Math.round(page.silentForMs / 60_000);
        const message = `[leg-watchdog] '${page.name}' has been silent ${minutes}min (declared ${Math.round(page.declaredCadenceMs / 60_000)}min cadence)`;
        console.error(message);
        void getLegPageNotifier()?.(message).catch(() => {});
      }
      for (const name of recoveries) {
        const message = `[leg-watchdog] '${name}' recovered`;
        console.log(message);
        void getLegPageNotifier()?.(message).catch(() => {});
      }
    } catch (err) {
      console.error('[leg-watchdog] check failed:', err);
    }
  }, 60_000);
  const conductorConfig = resolveConductorConfig(config);
  if (conductorConfig.enabled && runtimeBackend !== 'claude') {
    // S1 pins the claude backend: codex sessions do not reset on token usage
    // (session-pool.ts), so the lifecycle contract cannot hold there yet.
    operatorDb.close();
    throw new Error(
      'conductor.enabled requires the claude backend in S1 - codex session lifecycle lands in S2'
    );
  }
  // ── Stage-2 workorder consumer (plan S2-T3): the only system run path.
  // Constructed before production runtime assembly registers per-kind
  // completion hooks, and started only after route registration and recovery
  // complete.
  const { temporalFlag } = temporalStartup;
  // Validate the worker-run timeout override at boot (no-fallback): a malformed
  // MAMA_WORKER_TIMEOUT_SECONDS must crash the daemon loudly, not silently
  // revert worker runs to the 300s bound. Mirrors readStage2Flag above.
  const { resolveWorkerRequestTimeoutMs, attachWorkOrderAttemptContext } =
    await import('../../operator/worker-run.js');
  resolveWorkerRequestTimeoutMs();
  let workOrderConsumer: import('../../operator/workorder-consumer.js').WorkOrderConsumer | null =
    null;
  let temporalRuntime: TemporalRuntime | null = null;

  gateways.push({
    stop: async () => {
      clearInterval(legWatchdog);
      // Consumer stop BEFORE db close (same gateway = ordered; parallel
      // gateways would race an in-flight tick into "database is not open").
      await closeTemporalRuntimeBeforeDatabase(temporalRuntime, workOrderConsumer, () => {
        try {
          operatorDb.close();
        } catch {
          /* already closed */
        }
      }).catch(() => {});
    },
  });
  {
    const { WorkOrderConsumer } = await import('../../operator/workorder-consumer.js');
    const { loadBrief, ensureBriefs } = await import('../../operator/briefs.js');
    // Seed missing default briefs (user edits win) BEFORE the consumer exists -
    // a normal install must never hit the brief-missing fail path.
    ensureBriefs();
    ensureConsoleBrief();
    const { logActivity: logWorkOrderActivity } = await import('../../db/agent-store.js');
    const {
      validateWorkOrderPayload,
      boardManualKey,
      boardBatchKey,
      wikiBatchKey,
      promotionManualKey,
    } = await import('../../operator/workorder-publishers.js');

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
      runOptionsFor: async (wo) => {
        // Worker prompt selects the provider's supported tool path: Claude's
        // text gateway or Codex's injected native host tools. Both avoid the
        // spawn-default code-act path, where per-run envelope/capture overrides
        // cannot reach (shadow-gate §8.2).
        const { buildWorkerSystemPrompt } = await import('../../operator/worker-run.js');
        const workOrderPolicy = buildWorkOrderAgentPolicy(
          wo.workKind,
          config.agent.model,
          runtimeBackend
        );
        const runOptions: Record<string, unknown> = attachWorkOrderAttemptContext(
          {
            systemPrompt: buildWorkerSystemPrompt(
              workOrderPolicy.gatewayToolsPrompt,
              runtimeBackend,
              wo.workKind
            ),
            agentContext: workOrderPolicy.agentContext,
          },
          wo.id
        );
        // A temporal run is bound to ONE task on ONE channel, and the packet check
        // (temporalPacketRawSourcesWithinBoundSource) enforces exactly that: every raw ref
        // must match the task's connector:channel or the reconcile is refused.
        //
        // While raw reads returned nothing that check was vacuous. Once the channel grant
        // makes them return rows it stops being vacuous, and a lane-wide envelope hands
        // the compile every configured channel of every granted connector - so every
        // raw-backed temporal run would fail a check it cannot satisfy. The envelope has
        // to say what the run is actually bound to.
        //
        // A task with no source channel gets no connector at all, which is the same answer
        // from the other direction: the check requires zero raw refs for those, so the
        // grant must be empty rather than merely narrow.
        // A reconcile carries the channel's delta batch. Handing it to the run makes every
        // durable change the run produces rest on it WITHOUT the agent restating anything -
        // the system knew the batch before the run began. This is the whole difference
        // between a bounded run and an unbounded one.
        const workOrderBatch = causeEventIdsFromPayload(wo.payload);
        if (workOrderBatch.length > 0) {
          runOptions.causeEventIds = workOrderBatch;
        }
        let temporalBinding: { connector: string; channel: string } | null = null;
        if (wo.workKind === 'temporal') {
          const temporalContext = buildTemporalWorkerContext(taskLedger, wo);
          runOptions.temporalWorkContext = temporalContext;
          temporalBinding = temporalTaskBinding(taskLedger, temporalContext.taskId);
        }
        // Per-run scoped envelope (live-gate finding, 2026-07-18): gateway
        // 'model_tool' executions are envelope-gated, and workerRun is a new
        // caller class with no issuer - without this, every worker tool call
        // (incl. report_publish) dies 'envelope_missing'. Mirrors the report
        // lane's issuance (createPersonaReportAsk wiring below); issuance
        // failure rejects -> failWorkOrder (no envelope-less fallback run).
        if (envelopeBootstrap.envelopeAuthority && envelopeBootstrap.metadata.issuance !== 'off') {
          const projectId = resolveReactiveProjectRoot(config, process.env);
          const wallSeconds = Math.min(
            Math.max(Number(process.env.MAMA_REPORT_WALL_SECONDS) || 900, 60),
            1800
          );
          runOptions.envelope = await envelopeBootstrap.envelopeAuthority.buildAndPersist({
            agent_id: `workorder-${wo.workKind}`,
            instance_id: randomUUID(),
            // 'watch' = daemon-internal issuing source (closed EnvelopeSource
            // union; enforcement authorizes on scope, never on source).
            source: 'watch',
            channel_id: `worker:${wo.workKind}`,
            trigger_context: { user_text: `<stage2 workorder ${wo.workKind}#${wo.id}>` },
            scope: (() => {
              const scope = workOrderEnvelopeScope({
                workKind: wo.workKind,
                projectId,
                laneConnectors: codeActRawConnectors,
                temporalBinding,
              });
              // Identity scopes only - the read mirror is enforcement-layer.
              return scope;
            })(),
            tier: 2,
            budget: { wall_seconds: wallSeconds },
            expires_at: new Date(Date.now() + wallSeconds * 1000 + 30_000).toISOString(),
          });
        }
        return Object.keys(runOptions).length > 0 ? runOptions : undefined;
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
            // Token telemetry continuity: the legacy persona path recorded
            // tokens_used via executeValidatedRun; the Stage-2 cutover
            // (2026-07-21) silently zeroed it, blinding all cost measurement.
            tokens_used: event.tokensUsed,
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
    toolExecutor.setWorkOrderRequestHandler((kind, causeEventIds) => {
      try {
        const now = Date.now();
        let idempotencyKey: string;
        let payload: Record<string, unknown>;
        if (kind === 'board') {
          if (causeEventIds && causeEventIds.length > 0) {
            // Batch-carrying delegation: FULL mode (reconcile requires
            // channelKey+deltaLines the requester does not have - proven by
            // review running the validator) with the batch riding as
            // eventIds, which the validator allows on full and
            // causeEventIdsFromPayload lifts as the worker's cause. The
            // batch-deterministic key dedups a redelivered judgment while
            // the first order is still open.
            idempotencyKey = boardBatchKey(causeEventIds);
            payload = { mode: 'full', force: true, eventIds: [...causeEventIds] };
          } else {
            idempotencyKey = boardManualKey(now);
            payload = { mode: 'full', force: true };
          }
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
  const temporalTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const temporalAssembly = assembleDaemonTemporalRuntime({
    flag: temporalFlag,
    backend: runtimeBackend,
    envelopeIssuanceMode: envelopeBootstrap.metadata.issuance,
    effectiveTools: temporalEffectiveTools,
    availableTools: temporalAvailableTools,
    transportReady: Boolean(agentLoopClient.runWithContent),
    timeZone: temporalTimeZone,
    ledger: taskLedger,
    consumer: workOrderConsumer,
    log: (line) => temporalLogger.info(line),
  });
  temporalRuntime = temporalAssembly.runtime;
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

  // ── Trigger loop (M1, default-on): agent-evolved triggers on the live stream ──
  // MAMA_TRIGGER_LOOP=0 is the explicit opt-out. Placed after initConnectors (which feeds
  // connector_event_index) and after mama-core initDB. Read-only: recall/surface/log.
  const { isOperatorTriggerLoopEnabled, resolveOperatorReportChatId } =
    await import('../../operator/runtime-config.js');
  if (!isOperatorTriggerLoopEnabled(process.env) && conductorConfig.enabled) {
    // The conductor lives inside the trigger-loop branch (its inbox is fed by
    // the loop's drain). enabled=true with the loop off would otherwise boot
    // silently into a conductor that never runs (review).
    console.error(
      '[conductor] conductor.enabled=true but the trigger loop is disabled - the conductor will NOT run. Enable the trigger loop or disable the conductor.'
    );
  }
  if (isOperatorTriggerLoopEnabled(process.env)) {
    let stopTriggerAgentRuntime: (() => Promise<void>) | undefined;
    // Component isolation (PR #119 review): a trigger-loop bootstrap failure (bad import,
    // DB permission, registry constructor) must not abort the whole daemon before Phase
    // 10/11 - the gateways/viewer/agent serve independently of this optional leg. The
    // failure is still surfaced LOUDLY below (console.error), never swallowed silently.
    try {
      const { OperatorTriggerLoop } = await import('../../operator/operator-trigger-loop.js');
      const { ConnectorDeltaRepo } = await import('../../operator/connector-delta-repo.js');
      const { TriggerRegistry } = await import('../../operator/trigger-registry.js');
      const { createMamaMemoryPort } = await import('../../operator/mama-memory-port.js');
      const { createTriggerAgentRuntime } = await import('../../operator/trigger-author.js');
      const { reviewTriggerCLI } = await import('../../operator/trigger-review.js');
      const { ReportScheduler, FileReportScheduleStore, parseReportHours } =
        await import('../../operator/report-scheduler.js');
      const { persistLastFullReport } = await import('../../operator/report-carry.js');
      type ArtifactProvenance = import('../../operator/report-carry.js').ArtifactProvenance;
      // Set when a report is composed, read when that same report is delivered. Safe
      // because ALL operator work serializes on the operator lane (SOURCE_GLOBAL_LANES),
      // so compose and deliver cannot interleave with another report - stated here
      // because the safety comes from the lane, not from this file.
      let lastReportProvenance: ArtifactProvenance = {
        status: 'unavailable',
        reason: 'no_run_handle',
      };
      const { createPersonaReportAsk } = await import('../../operator/report-run.js');
      const { OPERATOR_FULL_REPORT_TAG } = await import('../../operator/situation-report.js');
      const { buildBoardPublishLines } = await import('../../operator/board-slot-instructions.js');
      const { FilePendingReportStore } = await import('../../operator/pending-report-store.js');

      const triggerRegistry = new TriggerRegistry(operatorDb);
      // Owner-report leg (M1.5): destination chat comes from env (~/.mama/start.sh),
      // never source. No chat configured or no telegram gateway -> loop stays read-only.
      const reportChatId = resolveOperatorReportChatId(process.env, config.telegram?.allowed_chats);
      const reportOutput =
        reportChatId && telegramGateway
          ? {
              send: (text: string, deliveryId?: string) =>
                telegramGateway.sendMessage(
                  reportChatId,
                  text,
                  deliveryId ?? `operator-report:legacy:${randomUUID()}`
                ),
            }
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
      const triggerAgentRuntime = createTriggerAgentRuntime(runtimeBackend, {
        model: config.agent.model,
        cwd: workspaceRoot,
        command: process.env.MAMA_CODEX_COMMAND,
      });
      stopTriggerAgentRuntime = () => triggerAgentRuntime.stop();
      const triggerLoop = new OperatorTriggerLoop({
        backend: runtimeBackend,
        delta: new ConnectorDeltaRepo(
          getAdapter(),
          expandPath('~/.mama/operator/trigger-loop-cursors.json')
        ),
        memory: createMamaMemoryPort(),
        registry: triggerRegistry,
        conductorInbox,
        onChannelDelta: (channelKey, lines, eventIds) =>
          channelDeltaSink.current?.(channelKey, lines, eventIds),
        askAgent: triggerAgentRuntime.askAuthor,
        // M2.2: reports go through the daemon's persona agent (system prompt, pinned model,
        // session lanes) instead of the bare CLI - report tone comes from generation inputs.
        // JSON tasks (authoring/review) use a provider-specific, tool-free runtime.
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
                      // Reads: enabled raw connectors (kagemusha_* gathers plus the live board
                      // cross-check) + memory scopes covering mama_recall/mama_save.
                      // allowed_destinations stays [] - NO send surface. That bounds SENDS only;
                      // read authority is bounded per tool by envelope/tool-connector-scope.ts
                      // against the connectors granted here.
                      project_refs: [{ kind: 'project' as const, id: projectId }],
                      raw_connectors: codeActRawConnectors,
                      memory_scopes: uniqueMemoryScopes(
                        deriveMemoryScopes({ source: 'operator', channelId: 'report', projectId })
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
                // Without a role the Code-Act branch strips the gateway catalog and
                // injects nothing back, so the report agent gets ZERO tools and cannot
                // gather no matter what the prompt instructs (roleAllowsOuterCodeAct
                // fails closed on an absent role - agent-loop.ts). Same built-in
                // least-privilege treatment the Stage-2 workers get.
                agentContext: buildOperatorReportAgentPolicy(config.agent.model, runtimeBackend)
                  .agentContext,
                // Stateless report lane: each run starts on a fresh session so the
                // continuous session no longer accumulates every run's gather dumps
                // (measured 146s -> 521s growth over 3 days). Continuity comes from
                // the storage layer (self-gather + mama_recall + report store).
                freshSession: true,
                ...(envelope ? { envelope } : {}),
              }
            );
            return {
              response: result.response,
              history: result.history,
              // Dropped here until now: the loop already resolves a run handle, and
              // discarding it meant a delivered report could not be traced to the run
              // that wrote it.
              modelRunId: result.modelRunId,
              ...(result.modelRunProvenance === undefined
                ? {}
                : { modelRunProvenance: result.modelRunProvenance }),
            };
          },
          log: (line: string) => console.log(line),
          fullReportTag: OPERATOR_FULL_REPORT_TAG,
          onRunProvenance: (provenance) => {
            lastReportProvenance = provenance;
          },
        }),
        review: (trigger, context) =>
          reviewTriggerCLI(trigger, context, triggerAgentRuntime.askReview),
        output: reportOutput,
        reportScheduler,
        // M2.3: the scheduled full report self-gathers via the persona agent's gateway tools
        // (the Kagemusha lesson: a reporter with tools has substance; a window summary alone
        // reports "quiet" whenever polling is between batches).
        fullReportSelfGather: buildFullReportGatherLines,
        // Kagemusha dual output: the same scheduled run updates the /ui operator board
        // slots via report_publish, then writes the plain-text owner report.
        fullReportBoardLines: buildBoardPublishLines(),
        // S1-T4 context carry: the delivered FULL report persists so the owner
        // console references it per turn instead of fabricating status.
        persistLastFullReport: (iso, text) => {
          getLegCadence()?.beat('full-report');
          return persistLastFullReport(iso, text, lastReportProvenance);
        },
        pendingReportStore: new FilePendingReportStore(
          expandPath('~/.mama/operator/pending-owner-reports.json'),
          (line) => console.error(line)
        ),
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
      // Watched only when actually started, at its REAL tick (review: an
      // unconditional 60s declare pages forever when the loop is opted out
      // or the env raises the tick). Cadence covers a long full-report tick
      // (the re-entrancy guard skips beats while one runs).
      // A non-numeric env value yields NaN, and silentFor > NaN*2 is always
      // false - the watchdog would silently disable itself, which is the one
      // thing a watchdog must not do. Unparseable falls back to the default.
      const trigTickRaw = Number(process.env.MAMA_TRIGGER_LOOP_TICK_MS || 60_000);
      getLegCadence()?.declare(
        'trigger-loop',
        Math.max(Number.isFinite(trigTickRaw) ? trigTickRaw : 60_000, 15 * 60_000)
      );
      if (reportScheduler && fullReportHours.length > 0) {
        // Hours alone are not a leg: without the report sink the scheduler
        // is undefined, the leg could never beat, and the only outcome is a
        // false page 52 hours in.
        // Declared at BOOT, not on first success - a report leg that never
        // fires is exactly what this watches. 26h covers the daily schedule.
        getLegCadence()?.declare('full-report', 26 * 60 * 60 * 1000);
      }
      const stopTriggerLoop = triggerLoop.start();
      // M2.4: point the connector sink's forwarder at this loop now that it exists.
      triggerLoopNudge.current = () => triggerLoop.nudge();
      // S1-T3: owner-intent forwarder - report_request routes to the SAME
      // report machinery (fresh session, delta anchor, consume semantics).
      toolExecutor.setReportRequestHandler(() => triggerLoop.startFullReport());

      // S1: the stateful conductor consumes the durable inbox on its own
      // session:conductor:main lane. Default-off; the inbox records
      // either way (shadow-mode data).
      let conductorTimer: NodeJS.Timeout | null = null;
      let conductorTickPromise: Promise<unknown> | null = null;
      if (conductorConfig.enabled) {
        const conductorSession = new ConductorSession(getSessionPool(), {
          maxAgeMs: conductorConfig.maxAgeMs,
          maxTurns: conductorConfig.maxTurns,
          maxTokens: conductorConfig.maxTokens,
        });
        const conductorPolicy = buildConductorAgentPolicy(config.agent.model, runtimeBackend);
        // Per-run envelope, mirroring the report lane: without it every
        // model_tool call dies 'envelope_missing' while the run resolves and
        // acks the batch - zero work, green ledger (review F2).
        const conductorIssueEnvelope =
          envelopeBootstrap.envelopeAuthority && envelopeBootstrap.metadata.issuance !== 'off'
            ? async () => {
                const projectId = resolveReactiveProjectRoot(config, process.env);
                const wallSeconds = 300; // one judgment turn, not a gather run
                return envelopeBootstrap.envelopeAuthority!.buildAndPersist({
                  agent_id: 'conductor',
                  instance_id: randomUUID(),
                  source: 'watch',
                  channel_id: 'conductor',
                  trigger_context: { user_text: '<conductor batch judgment>' },
                  scope: {
                    project_refs: [{ kind: 'project' as const, id: projectId }],
                    // The conductor reads channel text from its own durable
                    // inbox, never from connectors - no raw read authority.
                    raw_connectors: [],
                    memory_scopes: uniqueMemoryScopes(
                      deriveMemoryScopes({
                        source: 'conductor',
                        channelId: 'conductor',
                        projectId,
                      })
                    ),
                    allowed_destinations: [], // NO send surface
                  },
                  tier: 2,
                  budget: { wall_seconds: wallSeconds },
                  expires_at: new Date(Date.now() + wallSeconds * 1000 + 30_000).toISOString(),
                });
              }
            : undefined;
        const conductor = new Conductor({
          inbox: conductorInbox,
          session: conductorSession,
          runner: agentLoop,
          reground: () => buildBoardReground(taskLedger),
          agentContext: conductorPolicy.agentContext,
          issueEnvelope: conductorIssueEnvelope,
          log: (line) => console.log(line),
        });
        conductorTimer = setInterval(() => {
          if (conductorTickPromise) return; // never overlap ticks
          conductorTickPromise = conductor
            .tick()
            .catch((err) =>
              console.error(
                `[conductor] tick failed: ${err instanceof Error ? err.message : String(err)}`
              )
            )
            .finally(() => {
              conductorTickPromise = null;
            });
        }, conductorConfig.tickMs);
        console.log(`✓ Conductor enabled (tick ${conductorConfig.tickMs}ms)`);
      } else {
        console.log('Conductor inbox recording (conductor disabled)');
      }

      gateways.push({
        stop: async () => {
          triggerLoopNudge.current = null;
          if (conductorTimer) clearInterval(conductorTimer);
          // Let an in-flight tick finish BEFORE the operator DB closes: a
          // SIGTERM mid-ack otherwise throws on a closed handle, the row
          // stays 'claimed', and every launchd restart replays the batch
          // (review F7).
          if (conductorTickPromise) await conductorTickPromise;
          stopTriggerLoop();
          await triggerAgentRuntime.stop();
          // The shared operator DB handle is closed by the unconditional stop
          // hook above (single owner); nothing to close here.
        },
      });
      temporalLogger.info('Trigger loop enabled (default-on, read-only surface mode)');
    } catch (error) {
      await stopTriggerAgentRuntime?.().catch(() => {});
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

  channelDeltaSink.current = (channelKey, lines, eventIds) =>
    eventBus.emit({ type: 'operator:channel-delta', channelKey, lines, eventIds });

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

  // ── Stage-2 boot pass (plan S2-T3): runtime assembly registered hooks;
  // recovery/cleanup run after routes are ready, then the consumer starts.
  const temporalBoot = temporalAssembly.bootAfterRoutes();
  if (temporalBoot.paused > 0) {
    temporalLogger.info(`paused ${temporalBoot.paused} open workorder(s)`);
  }
  if (temporalBoot.enabled && (temporalBoot.resumed > 0 || temporalBoot.enqueued > 0)) {
    temporalLogger.info(`resumed ${temporalBoot.resumed}, enqueued ${temporalBoot.enqueued}`);
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
