import type { VNextRuntimeFlags } from './feature-flags.js';

export const VNEXT_ALLOWED_STARTUP_STEPS = [
  'config_read',
  'db_initialization',
  'api_server_health',
  'manual_status_endpoints',
  'primary_operator_placeholder',
] as const;

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

export interface VNextPrimaryOperatorPlaceholder {
  kind: 'primary_operator';
  status: 'noop';
  reason: string;
}

export interface VNextBootstrapPlan extends VNextRuntimeFlags {
  allowedStartupSteps: VNextAllowedStartupStep[];
  forbiddenFanout: VNextForbiddenFanout[];
  primaryOperator: VNextPrimaryOperatorPlaceholder;
}

export interface VNextBootstrapRuntimeStatus {
  enabled: true;
  mode: 'bootstrap';
  source: VNextBootstrapPlan['source'];
  startedAtMs: number;
  primaryOperator: VNextPrimaryOperatorPlaceholder;
  executedStartupSteps: VNextAllowedStartupStep[];
}

export interface VNextBootstrapApiServer {
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface VNextBootstrapRuntimeHandles<DatabaseHandle> {
  apiServer: VNextBootstrapApiServer;
  database: DatabaseHandle;
  status: VNextBootstrapRuntimeStatus;
}

export interface VNextBootstrapRuntimeDeps<DatabaseHandle> {
  openDatabase: () => DatabaseHandle;
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
    primaryOperator: {
      kind: 'primary_operator',
      status: 'noop',
      reason: 'PR1 only installs the startup boundary; the operator loop lands later.',
    },
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

  executeAllowedStep('api_server_health');
  executeAllowedStep('manual_status_endpoints');
  executeAllowedStep('primary_operator_placeholder');

  const status: VNextBootstrapRuntimeStatus = {
    enabled: true,
    mode: 'bootstrap',
    source: plan.source,
    startedAtMs: deps.now?.() ?? Date.now(),
    primaryOperator: plan.primaryOperator,
    executedStartupSteps: [...executedStartupSteps],
  };
  const apiServer = deps.createApiServer(status);
  try {
    await apiServer.start();
  } catch (error) {
    closeDatabaseIfPossible(database);
    throw error;
  }

  const handles = { apiServer, database, status };
  deps.installShutdownHandlers?.(handles);
  return handles;
}
