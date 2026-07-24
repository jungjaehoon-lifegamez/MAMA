import { assertStage2FlagCompatible } from './workorder-publishers.js';
import type { TemporalTickResult } from './temporal-reconcile.js';
import type { WorkOrderRecord } from './task-ledger.js';

export const TEMPORAL_RECONCILE_ENV = 'MAMA_TEMPORAL_RECONCILE';
export type TemporalReconcileFlag = 'off' | 'on';

export interface TemporalStartupPreflight {
  temporalFlag: TemporalReconcileFlag;
}

export function preflightTemporalStartup(
  env: NodeJS.ProcessEnv = process.env
): TemporalStartupPreflight {
  // The retired MAMA_STAGE2_WORKORDERS legacy pin fails the boot here, before
  // any runtime is assembled (workorders are the only run path since v0.28.0).
  assertStage2FlagCompatible(env);
  return { temporalFlag: resolveTemporalReconcileFlag(env) };
}

export function resolveTemporalReconcileFlag(
  env: NodeJS.ProcessEnv = process.env
): TemporalReconcileFlag {
  const raw = (env[TEMPORAL_RECONCILE_ENV] ?? '').trim();
  if (raw === '') return 'off';
  if (raw === 'off' || raw === 'on') return raw;
  throw new Error(`${TEMPORAL_RECONCILE_ENV} must be off|on (or unset), got: '${raw}'`);
}

export interface TemporalRuntimeLedger {
  repairClosedTemporalGenerations(): number;
  pauseActiveTemporalWork(reason: string): number;
  resumePausedTemporalWork(): WorkOrderRecord[];
}

export interface TemporalRuntimeConsumer {
  bootRecover(): void;
  stop(): Promise<void>;
}

export interface TemporalRuntimeScheduler {
  tick(): TemporalTickResult;
  start(): void;
  stop(): void;
}

export interface TemporalRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  flag?: TemporalReconcileFlag;
  backend: string;
  envelopeIssuanceMode: 'off' | 'enabled' | 'required';
  effectiveTools: readonly string[];
  availableTools: readonly string[];
  transportReady: boolean;
  timeZone: string;
  ledger: TemporalRuntimeLedger;
  consumer?: TemporalRuntimeConsumer;
  registerRole: () => void;
  createScheduler: () => TemporalRuntimeScheduler;
}

export interface TemporalRuntimeBootResult {
  enabled: boolean;
  paused: number;
  resumed: number;
  enqueued: number;
}

export interface TemporalRuntime {
  readonly enabled: boolean;
  boot(): TemporalRuntimeBootResult;
  stop(): Promise<void>;
}

export async function closeTemporalRuntimeBeforeDatabase(
  runtime: TemporalRuntime | null,
  consumer: TemporalRuntimeConsumer | null,
  closeDatabase: () => void
): Promise<void> {
  try {
    if (runtime) await runtime.stop();
    else await consumer?.stop();
  } finally {
    closeDatabase();
  }
}

export function createTemporalRuntime(options: TemporalRuntimeOptions): TemporalRuntime {
  const flag = options.flag ?? resolveTemporalReconcileFlag(options.env);
  new Intl.DateTimeFormat('en-US', { timeZone: options.timeZone }).format(0);
  let booted = false;
  let stopped = false;
  let scheduler: TemporalRuntimeScheduler | null = null;

  if (flag === 'on') {
    if (options.envelopeIssuanceMode === 'off') {
      throw new Error('temporal reconciliation requires envelope issuance');
    }
    if (options.backend !== 'claude' && options.backend !== 'codex') {
      throw new Error(`temporal reconciliation backend '${options.backend}' is incompatible`);
    }
    if (!options.effectiveTools.includes('task_temporal_reconcile')) {
      throw new Error('temporal reconciliation requires effective task_temporal_reconcile access');
    }
    if (!options.availableTools.includes('task_temporal_reconcile')) {
      throw new Error('temporal reconciliation transport tool task_temporal_reconcile unavailable');
    }
    if (!options.transportReady) {
      throw new Error('temporal reconciliation worker transport is unavailable');
    }
    if (!options.consumer) {
      throw new Error('temporal reconciliation requires the Stage-2 consumer');
    }
    options.registerRole();
    scheduler = options.createScheduler();
  }

  return {
    enabled: flag === 'on',
    boot(): TemporalRuntimeBootResult {
      if (booted) throw new Error('temporal reconciliation runtime already booted');
      booted = true;
      options.ledger.repairClosedTemporalGenerations();
      if (flag === 'off') {
        const paused = options.ledger.pauseActiveTemporalWork('temporal-reconcile-disabled');
        return {
          enabled: false,
          paused,
          resumed: 0,
          enqueued: 0,
        };
      }
      const resumed = options.ledger.resumePausedTemporalWork().length;
      options.consumer!.bootRecover();
      const scan = scheduler!.tick();
      scheduler!.start();
      return { enabled: true, paused: 0, resumed, enqueued: scan.enqueued };
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      scheduler?.stop();
      const consumerStop = options.consumer?.stop();
      try {
        if (flag === 'on') {
          options.ledger.pauseActiveTemporalWork('temporal-runtime-stopped');
        }
      } finally {
        await consumerStop;
      }
    },
  };
}
