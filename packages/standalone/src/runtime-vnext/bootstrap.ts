import type { VNextRuntimeFlags } from './feature-flags.js';
import type {
  PrimaryOperatorBatchResult,
  PrimaryOperatorEvent,
} from '../operator-vnext/primary-operator-runtime.js';

export const VNEXT_ALLOWED_STARTUP_STEPS = [
  'config_read',
  'db_initialization',
  'primary_operator_schema',
  'primary_operator_runtime',
  'api_server_health',
  'manual_status_endpoints',
] as const;

export const VNEXT_PRIMARY_OPERATOR_CURSOR_NAME = 'operator:primary';
export const VNEXT_PRIMARY_OPERATOR_CONNECTOR = 'manual';

export const VNEXT_FORBIDDEN_FANOUT = [
  'dashboard_agent_interval',
  'wiki_agent_interval',
  'ledger_memory_compose',
  'obsidian_launch',
  'mcp_config_rewrite',
  'agent_config_mutation',
  'persona_write',
  'heartbeat_timer',
  'token_keepalive_timer',
  'conductor_audit',
  'message_router_autonomous_process',
  'connector_polling',
  'connector_mode',
] as const;

export type VNextAllowedStartupStep = (typeof VNEXT_ALLOWED_STARTUP_STEPS)[number];
export type VNextForbiddenFanout = (typeof VNEXT_FORBIDDEN_FANOUT)[number];

export interface VNextPrimaryOperatorReadyStatus {
  kind: 'primary_operator';
  status: 'prepared' | 'degraded';
  mode: 'manual_batch';
  ingress: 'not_wired';
  cursorName: string;
  connector: string;
  advancedThroughSeq: number;
  lastBatchStatus?: PrimaryOperatorBatchResult['status'];
  failedSeq?: number;
  errorMessage?: string;
}

export interface VNextPrimaryOperatorRuntimeHandle {
  status: VNextPrimaryOperatorReadyStatus;
  processBatch: (
    events: readonly PrimaryOperatorEvent[],
    decide: (event: PrimaryOperatorEvent) => Promise<unknown> | unknown
  ) => Promise<PrimaryOperatorBatchResult>;
}

export interface VNextBootstrapPlan extends VNextRuntimeFlags {
  allowedStartupSteps: VNextAllowedStartupStep[];
  forbiddenFanout: VNextForbiddenFanout[];
  primaryOperator: VNextPrimaryOperatorReadyStatus;
}

export interface VNextBootstrapRuntimeStatus {
  enabled: true;
  mode: 'bootstrap';
  source: VNextBootstrapPlan['source'];
  startedAtMs: number;
  primaryOperator: VNextPrimaryOperatorReadyStatus;
  executedStartupSteps: VNextAllowedStartupStep[];
}

export interface VNextBootstrapApiServer {
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface VNextBootstrapRuntimeHandles<DatabaseHandle> {
  apiServer: VNextBootstrapApiServer;
  database: DatabaseHandle;
  primaryOperator: VNextPrimaryOperatorRuntimeHandle;
  status: VNextBootstrapRuntimeStatus;
}

export interface VNextBootstrapRuntimeDeps<DatabaseHandle> {
  openDatabase: () => DatabaseHandle;
  initializeOperatorSchema: (database: DatabaseHandle) => void;
  createPrimaryOperator: (database: DatabaseHandle) => VNextPrimaryOperatorRuntimeHandle;
  createApiServer: (status: VNextBootstrapRuntimeStatus) => VNextBootstrapApiServer;
  installShutdownHandlers?: (handles: VNextBootstrapRuntimeHandles<DatabaseHandle>) => void;
  now?: () => number;
}

function hasCloseMethod(value: unknown): value is { close: () => void } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { close?: unknown }).close === 'function'
  );
}

function closeDatabaseIfPossible(database: unknown): void {
  if (!hasCloseMethod(database)) {
    return;
  }

  try {
    database.close();
  } catch {
    // Preserve the original startup failure.
  }
}

export function buildVNextBootstrapPlan(flags: VNextRuntimeFlags): VNextBootstrapPlan {
  return {
    ...flags,
    allowedStartupSteps: [...VNEXT_ALLOWED_STARTUP_STEPS],
    forbiddenFanout: [...VNEXT_FORBIDDEN_FANOUT],
    primaryOperator: buildVNextPrimaryOperatorReadyStatus(0),
  };
}

export function buildVNextPrimaryOperatorReadyStatus(
  advancedThroughSeq: number
): VNextPrimaryOperatorReadyStatus {
  return {
    kind: 'primary_operator',
    status: 'prepared',
    mode: 'manual_batch',
    ingress: 'not_wired',
    cursorName: VNEXT_PRIMARY_OPERATOR_CURSOR_NAME,
    connector: VNEXT_PRIMARY_OPERATOR_CONNECTOR,
    advancedThroughSeq,
  };
}

export function isVNextStartupStepAllowed(plan: VNextBootstrapPlan, step: string): boolean {
  if (!plan.enabled) {
    return true;
  }
  return plan.allowedStartupSteps.includes(step as VNextAllowedStartupStep);
}

export function assertVNextStartupStepAllowed(
  plan: VNextBootstrapPlan,
  step: VNextAllowedStartupStep
): void {
  if (!isVNextStartupStepAllowed(plan, step)) {
    throw new Error(`vNext bootstrap blocked non-allowlisted startup step: ${step}`);
  }
}

export function shouldSkipVNextFanout(
  plan: VNextBootstrapPlan | undefined,
  fanout: string
): boolean {
  if (!plan?.enabled) {
    return false;
  }
  return plan.forbiddenFanout.includes(fanout as VNextForbiddenFanout);
}

export async function startVNextBootstrapRuntime<DatabaseHandle>(
  plan: VNextBootstrapPlan,
  deps: VNextBootstrapRuntimeDeps<DatabaseHandle>
): Promise<VNextBootstrapRuntimeHandles<DatabaseHandle>> {
  if (!plan.enabled || plan.mode !== 'bootstrap') {
    throw new Error('vNext bootstrap runtime requires enabled bootstrap mode');
  }

  const executedStartupSteps: VNextAllowedStartupStep[] = [];
  const executeAllowedStep = (step: VNextAllowedStartupStep): void => {
    assertVNextStartupStepAllowed(plan, step);
    executedStartupSteps.push(step);
  };

  executeAllowedStep('config_read');

  executeAllowedStep('db_initialization');
  const database = deps.openDatabase();

  let primaryOperator: VNextPrimaryOperatorRuntimeHandle;
  let apiServer: VNextBootstrapApiServer;

  try {
    executeAllowedStep('primary_operator_schema');
    deps.initializeOperatorSchema(database);

    executeAllowedStep('primary_operator_runtime');
    primaryOperator = deps.createPrimaryOperator(database);

    executeAllowedStep('api_server_health');
    executeAllowedStep('manual_status_endpoints');

    const status: VNextBootstrapRuntimeStatus = {
      enabled: true,
      mode: 'bootstrap',
      source: plan.source,
      startedAtMs: deps.now?.() ?? Date.now(),
      primaryOperator: primaryOperator.status,
      executedStartupSteps: [...executedStartupSteps],
    };
    apiServer = deps.createApiServer(status);
    await apiServer.start();

    const handles = { apiServer, database, primaryOperator, status };
    deps.installShutdownHandlers?.(handles);
    return handles;
  } catch (error) {
    closeDatabaseIfPossible(database);
    throw error;
  }
}
