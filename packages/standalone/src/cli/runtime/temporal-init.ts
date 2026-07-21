import { buildTemporalWorkOrderHook } from '../../operator/workorder-hooks.js';
import {
  TemporalReconcileScheduler,
  type TemporalSchedulerOptions,
} from '../../operator/temporal-reconcile.js';
import {
  createTemporalRuntime,
  type TemporalReconcileFlag,
  type TemporalRuntime,
  type TemporalRuntimeBootResult,
} from '../../operator/temporal-runtime.js';
import type { TaskLedger } from '../../operator/task-ledger.js';
import type { WorkOrderConsumer } from '../../operator/workorder-consumer.js';
import type { Stage2Flag } from '../../operator/workorder-publishers.js';

export interface DaemonTemporalAssembly {
  runtime: TemporalRuntime;
  bootAfterRoutes(): TemporalRuntimeBootResult;
}

export interface DaemonTemporalAssemblyInput {
  flag: TemporalReconcileFlag;
  stage2Flag: Stage2Flag;
  backend: string;
  envelopeIssuanceMode: 'off' | 'enabled' | 'required';
  effectiveTools: readonly string[];
  availableTools: readonly string[];
  transportReady: boolean;
  timeZone: string;
  ledger: TaskLedger;
  consumer: WorkOrderConsumer | null;
  now?: () => number;
  setInterval?: TemporalSchedulerOptions['setInterval'];
  clearInterval?: TemporalSchedulerOptions['clearInterval'];
  log?: (line: string) => void;
}

/** Production composition boundary for daemon temporal reconciliation. */
export function assembleDaemonTemporalRuntime(
  input: DaemonTemporalAssemblyInput
): DaemonTemporalAssembly {
  const runtime = createTemporalRuntime({
    flag: input.flag,
    stage2Flag: input.stage2Flag,
    backend: input.backend,
    envelopeIssuanceMode: input.envelopeIssuanceMode,
    effectiveTools: input.effectiveTools,
    availableTools: input.availableTools,
    transportReady: input.transportReady,
    timeZone: input.timeZone,
    ledger: input.ledger,
    consumer: input.consumer ?? undefined,
    registerRole: () => {
      if (!input.consumer) {
        throw new Error('temporal reconciliation cannot register without the workorder consumer');
      }
      input.consumer.registerHook(
        'temporal',
        buildTemporalWorkOrderHook({
          loadTemporalWorkContext: (attemptId) => input.ledger.loadTemporalWorkContext(attemptId),
          getTemporalEffect: (attemptId) => input.ledger.getTemporalEffect(attemptId),
          getTask: (taskId) => input.ledger.getById(taskId),
          getTemporalGeneration: (generationKey) =>
            input.ledger.getTemporalGeneration(generationKey),
          getScopedNoteMaxId: (scope) => input.ledger.maxNoUpdateId(scope),
        })
      );
    },
    createScheduler: () =>
      new TemporalReconcileScheduler({
        ledger: input.ledger,
        now: input.now ?? (() => Date.now()),
        timeZone: input.timeZone,
        setInterval: input.setInterval,
        clearInterval: input.clearInterval,
        log: input.log,
      }),
  });

  return {
    runtime,
    bootAfterRoutes(): TemporalRuntimeBootResult {
      const result = runtime.boot();
      if (input.stage2Flag === 'off') {
        const cancelled = input.ledger.cancelOpenWorkOrders('flag-off');
        if (cancelled > 0) {
          input.log?.(`[stage2] flag=off: cancelled ${cancelled} open workorder(s)`);
        }
        return result;
      }
      if (!input.consumer) {
        throw new Error(
          '[stage2] boot invariant violated: flag != off but consumer not constructed'
        );
      }
      if (input.stage2Flag === 'shadow') {
        const cancelled = input.ledger.cancelOpenWorkOrders('shadow-board-only', [
          'wiki',
          'memory-curation',
        ]);
        if (cancelled > 0) {
          input.log?.(`[stage2] shadow: cancelled ${cancelled} non-board workorder(s)`);
        }
      }
      if (!runtime.enabled) input.consumer.bootRecover();
      input.consumer.start();
      if (!input.consumer.isStarted()) {
        throw new Error('[stage2] boot invariant violated: consumer failed to start');
      }
      return result;
    },
  };
}
