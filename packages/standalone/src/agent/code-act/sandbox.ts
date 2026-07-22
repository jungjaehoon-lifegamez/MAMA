import {
  newQuickJSAsyncWASMModule,
  shouldInterruptAfterDeadline,
  type QuickJSAsyncWASMModule,
  type QuickJSAsyncRuntime,
  type QuickJSAsyncContext,
  type QuickJSHandle,
  type VmCallResult,
} from 'quickjs-emscripten';

import type {
  SandboxConfig,
  ExecutionResult,
  SandboxExecutionOptions,
  HostFunction,
  HostFunctionContext,
  AbortableHostFunction,
  HostFunctionRegistrationOptions,
} from './types.js';
import { DEFAULT_SANDBOX_CONFIG } from './types.js';
import {
  CODE_ACT_MUTATION_COMMITTED_AFTER_ABORT,
  CODE_ACT_MUTATION_OUTCOME_UNKNOWN,
  type CodeActTerminalMutationCode,
} from './types.js';

const MAX_LIVE_SANDBOXES = 8;

interface ExecutionWaiter {
  limit: number;
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
}

let activeExecutions = 0;
const executionWaiters: ExecutionWaiter[] = [];

function releaseExecutionSlot(): void {
  activeExecutions = Math.max(0, activeExecutions - 1);
  drainExecutionWaiters();
}

function createExecutionRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseExecutionSlot();
  };
}

function drainExecutionWaiters(): void {
  while (executionWaiters.length > 0) {
    const waiter = executionWaiters[0];
    if (waiter.signal.aborted) {
      executionWaiters.shift();
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.reject(waiter.signal.reason);
      continue;
    }
    if (activeExecutions >= waiter.limit) return;
    executionWaiters.shift();
    waiter.signal.removeEventListener('abort', waiter.onAbort);
    activeExecutions++;
    waiter.resolve(createExecutionRelease());
  }
}

function acquireExecutionSlot(requestedLimit: number, signal: AbortSignal): Promise<() => void> {
  const normalizedLimit = Number.isFinite(requestedLimit)
    ? Math.floor(requestedLimit)
    : DEFAULT_SANDBOX_CONFIG.maxConcurrentExecutions;
  const limit = Math.max(1, Math.min(MAX_LIVE_SANDBOXES, normalizedLimit));
  if (signal.aborted) return Promise.reject(signal.reason);
  if (executionWaiters.length === 0 && activeExecutions < limit) {
    activeExecutions++;
    return Promise.resolve(createExecutionRelease());
  }

  return new Promise<() => void>((resolve, reject) => {
    const waiter: ExecutionWaiter = {
      limit,
      signal,
      resolve,
      reject,
      onAbort: () => {
        const index = executionWaiters.indexOf(waiter);
        if (index >= 0) executionWaiters.splice(index, 1);
        signal.removeEventListener('abort', waiter.onAbort);
        reject(signal.reason);
        drainExecutionWaiters();
      },
    };
    executionWaiters.push(waiter);
    signal.addEventListener('abort', waiter.onAbort, { once: true });
  });
}

type RegisteredHostFunction =
  | { abortable: false; fn: HostFunction; settleOnAbort: false }
  | { abortable: true; fn: AbortableHostFunction; settleOnAbort: boolean };

class CodeActTerminalMutationError extends Error {
  readonly retryable = false;

  constructor(
    readonly code: CodeActTerminalMutationCode,
    message: string
  ) {
    super(`[${code}] ${message}`);
    this.name = 'CodeActTerminalMutationError';
  }
}

/**
 * Create an isolated async QuickJS module for each execution.
 *
 * quickjs-emscripten's async module cannot safely dispose concurrent runtimes that share one
 * module. Keeping executions independent also prevents one stalled host function from owning a
 * process-global execution lock.
 */
async function getModule(): Promise<QuickJSAsyncWASMModule> {
  return newQuickJSAsyncWASMModule();
}

/** Convert a JS value to a QuickJS handle using native API (no evalCode) */
function jsonToHandle(
  ctx: QuickJSAsyncContext,
  value: unknown,
  visited = new Set<unknown>()
): QuickJSHandle {
  if (value === null || value === undefined) return ctx.undefined;
  if (value === true) return ctx.true;
  if (value === false) return ctx.false;
  if (typeof value === 'string') return ctx.newString(value);
  if (typeof value === 'number') return ctx.newNumber(value);

  if (typeof value === 'object') {
    if (visited.has(value)) return ctx.newString('[Circular]');
    visited.add(value);
  }

  if (Array.isArray(value)) {
    const arr = ctx.newArray();
    for (let i = 0; i < value.length; i++) {
      const h = jsonToHandle(ctx, value[i], visited);
      ctx.setProp(arr, i, h);
      h.dispose();
    }
    return arr;
  }

  if (typeof value === 'object') {
    const obj = ctx.newObject();
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const h = jsonToHandle(ctx, v, visited);
      ctx.setProp(obj, k, h);
      h.dispose();
    }
    return obj;
  }

  // Fallback for bigint etc — stringify
  return ctx.newString(String(value));
}

export class CodeActSandbox {
  private config: SandboxConfig;
  private registeredFunctions = new Map<string, RegisteredHostFunction>();

  constructor(config?: Partial<SandboxConfig>) {
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...config };
  }

  /** Pre-load WASM module (call at server startup for fast first execution) */
  static async warmup(): Promise<void> {
    await getModule();
  }

  /** Register an async host function to be injected into sandbox */
  registerFunction(name: string, fn: HostFunction): void {
    this.registeredFunctions.set(name, { abortable: false, fn, settleOnAbort: false });
  }

  /** Register a host function that can cancel its own work when the execution deadline fires. */
  registerAbortableFunction(
    name: string,
    fn: AbortableHostFunction,
    options: HostFunctionRegistrationOptions = {}
  ): void {
    this.registeredFunctions.set(name, {
      abortable: true,
      fn,
      settleOnAbort: options.settleOnAbort === true,
    });
  }

  /** Unregister a host function */
  unregisterFunction(name: string): void {
    this.registeredFunctions.delete(name);
  }

  /** Get list of registered function names */
  getRegisteredFunctions(): string[] {
    return Array.from(this.registeredFunctions.keys());
  }

  /** Execute JS code in a sandboxed QuickJS context */
  async execute(code: string, options: SandboxExecutionOptions = {}): Promise<ExecutionResult> {
    const startTime = performance.now();
    const logs: string[] = [];
    const inFlightCount = { value: 0 };
    const totalCallCount = { value: 0 };
    const mutationSettlementDrains = new Set<Promise<void>>();
    const terminalMutation = { error: undefined as Error | undefined };
    const deadlineMs = Date.now() + this.config.timeoutMs;
    const controller = new AbortController();
    const onParentAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) {
      onParentAbort();
    } else {
      options.signal?.addEventListener('abort', onParentAbort, { once: true });
    }
    const deadlineTimer = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort(
          new Error(`Code-Act execution timed out after ${this.config.timeoutMs}ms`)
        );
      }
    }, this.config.timeoutMs);
    let releaseSlot: (() => void) | undefined;
    let rt: QuickJSAsyncRuntime | undefined;
    let ctx: QuickJSAsyncContext | undefined;
    let executionResult: ExecutionResult | undefined;
    const complete = (result: ExecutionResult): ExecutionResult => {
      executionResult = result;
      return result;
    };

    try {
      releaseSlot = await acquireExecutionSlot(
        this.config.maxConcurrentExecutions,
        controller.signal
      );
      controller.signal.throwIfAborted();

      const module = await getModule();
      controller.signal.throwIfAborted();
      rt = module.newRuntime();
      rt.setMemoryLimit(this.config.memoryLimitBytes);
      rt.setMaxStackSize(this.config.maxStackSizeBytes);
      rt.setInterruptHandler(shouldInterruptAfterDeadline(deadlineMs));

      ctx = rt.newContext();

      // Inject console.log
      this._injectConsole(ctx, logs);

      // Inject registered host functions
      for (const [name, registered] of this.registeredFunctions) {
        this._injectAsyncFunction(
          ctx,
          name,
          registered,
          inFlightCount,
          totalCallCount,
          this.config.maxConcurrentCalls,
          { signal: controller.signal, deadlineMs },
          mutationSettlementDrains,
          (error) => {
            terminalMutation.error ??= error;
          }
        );
      }

      // Execute code
      const result = await ctx.evalCodeAsync(code, 'code-act.js');

      const durationMs = performance.now() - startTime;
      const memUsage = ctx.dump(rt.computeMemoryUsage());
      const memObj = memUsage as Record<string, unknown> | null;
      const memoryUsedBytes =
        memObj && typeof memObj.malloc_size === 'number' ? memObj.malloc_size : 0;

      if (terminalMutation.error) {
        try {
          if (result.error) {
            result.error.dispose();
          } else {
            result.value.dispose();
          }
        } catch {
          /* async result handle managed internally */
        }
        return complete({
          success: false,
          error: this._normalizeError(terminalMutation.error),
          logs,
          metrics: { durationMs, hostCallCount: totalCallCount.value, memoryUsedBytes },
        });
      }

      if (result.error) {
        const err = ctx.dump(result.error);
        result.error.dispose();
        return complete({
          success: false,
          error: this._normalizeError(err),
          logs,
          metrics: { durationMs, hostCallCount: totalCallCount.value, memoryUsedBytes },
        });
      }

      let value = ctx.dump(result.value);
      try {
        result.value.dispose();
      } catch {
        /* async result handle managed internally */
      }

      // Unwrap promise result wrapper from evalCodeAsync
      if (value && typeof value === 'object' && 'type' in value) {
        if (value.type === 'fulfilled') {
          value = value.value;
        } else if (value.type === 'rejected') {
          return complete({
            success: false,
            error: this._normalizeError(value.value),
            logs,
            metrics: { durationMs, hostCallCount: totalCallCount.value, memoryUsedBytes },
          });
        }
      }

      return complete({
        success: true,
        value,
        logs,
        metrics: { durationMs, hostCallCount: totalCallCount.value, memoryUsedBytes },
      });
    } catch (err) {
      const durationMs = performance.now() - startTime;
      return complete({
        success: false,
        error: this._normalizeError(terminalMutation.error ?? err),
        logs,
        metrics: { durationMs, hostCallCount: totalCallCount.value, memoryUsedBytes: 0 },
      });
    } finally {
      options.signal?.removeEventListener('abort', onParentAbort);
      while (mutationSettlementDrains.size > 0) {
        await Promise.all([...mutationSettlementDrains]);
      }
      if (terminalMutation.error && executionResult) {
        executionResult.success = false;
        delete executionResult.value;
        executionResult.error = this._normalizeError(terminalMutation.error);
        executionResult.metrics.durationMs = performance.now() - startTime;
      }
      clearTimeout(deadlineTimer);
      try {
        ctx?.dispose();
      } catch {
        /* async result handle managed internally */
      }
      try {
        rt?.dispose();
      } catch {
        /* HostRef cleanup — non-critical */
      }
      releaseSlot?.();
    }
  }

  private _injectConsole(ctx: QuickJSAsyncContext, logs: string[]): void {
    const consoleObj = ctx.newObject();
    const logFn = ctx.newFunction('log', (...args) => {
      const msg = args
        .map((a) => {
          const v = ctx.dump(a);
          return typeof v === 'object' ? JSON.stringify(v) : String(v);
        })
        .join(' ');
      logs.push(msg);
    });
    ctx.setProp(consoleObj, 'log', logFn);
    ctx.setProp(ctx.global, 'console', consoleObj);
    logFn.dispose();
    consoleObj.dispose();
  }

  private _injectAsyncFunction(
    ctx: QuickJSAsyncContext,
    name: string,
    registered: RegisteredHostFunction,
    inFlightCount: { value: number },
    totalCallCount: { value: number },
    maxConcurrentCalls: number,
    hostContext: HostFunctionContext,
    mutationSettlementDrains: Set<Promise<void>>,
    onTerminalMutation: (error: Error) => void
  ): void {
    const handle = ctx.newAsyncifiedFunction(name, async (...argHandles) => {
      totalCallCount.value++;
      if (totalCallCount.value > maxConcurrentCalls) {
        throw new Error(`Host call limit exceeded (max ${maxConcurrentCalls})`);
      }
      // Track in-flight for potential future concurrency reporting
      inFlightCount.value++;
      const args = argHandles.map((h) => ctx.dump(h));

      try {
        hostContext.signal.throwIfAborted();
        const hostPromise = registered.abortable
          ? registered.fn(hostContext, ...args)
          : registered.fn(...args);
        const hostResult = this._awaitHostResult(
          hostPromise,
          hostContext.signal,
          registered.settleOnAbort,
          this.config.mutationSettlementGraceMs,
          onTerminalMutation
        );
        if (registered.settleOnAbort) {
          const drain = hostResult.then(
            () => undefined,
            () => undefined
          );
          mutationSettlementDrains.add(drain);
          void drain.then(() => mutationSettlementDrains.delete(drain));
        }
        const result = await hostResult;

        if (result === undefined || result === null) return ctx.undefined;
        if (result === true) return ctx.true;
        if (result === false) return ctx.false;
        if (typeof result === 'string') return ctx.newString(result);
        if (typeof result === 'number') return ctx.newNumber(result);

        // Complex objects: JSON round-trip
        return jsonToHandle(ctx, result);
      } catch (err) {
        // Propagate host error to sandbox as a thrown exception
        const errMsg = err instanceof Error ? err.message : String(err);
        const errHandle = ctx.newError(errMsg);
        return { error: errHandle } as VmCallResult<QuickJSHandle>;
      } finally {
        inFlightCount.value--;
      }
    });
    ctx.setProp(ctx.global, name, handle);
    handle.dispose();
  }

  private _awaitHostResult(
    result: Promise<unknown>,
    signal: AbortSignal,
    settleOnAbort: boolean,
    mutationSettlementGraceMs: number,
    onTerminalMutation: (error: Error) => void
  ): Promise<unknown> {
    if (settleOnAbort) {
      return new Promise((resolve, reject) => {
        let completed = false;
        let abortObserved = false;
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = (callback: () => void) => {
          if (completed) {
            return;
          }
          completed = true;
          if (graceTimer) {
            clearTimeout(graceTimer);
          }
          signal.removeEventListener('abort', onAbort);
          callback();
        };
        const rejectTerminal = (code: CodeActTerminalMutationCode, message: string) => {
          const error = this._terminalMutationError(code, message);
          onTerminalMutation(error);
          finish(() => reject(error));
        };
        const onAbort = () => {
          if (abortObserved || completed) {
            return;
          }
          abortObserved = true;
          const graceMs = Math.max(0, mutationSettlementGraceMs);
          graceTimer = setTimeout(() => {
            rejectTerminal(
              CODE_ACT_MUTATION_OUTCOME_UNKNOWN,
              `Host mutation did not settle within ${graceMs}ms after Code-Act abort; ` +
                'its outcome is unknown and it must not be retried automatically'
            );
          }, graceMs);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
        }
        result.then(
          (value) => {
            if (abortObserved || signal.aborted) {
              rejectTerminal(
                CODE_ACT_MUTATION_COMMITTED_AFTER_ABORT,
                'Host mutation settled after Code-Act abort and may be committed; ' +
                  'do not retry automatically'
              );
              return;
            }
            finish(() => resolve(value));
          },
          (error) => {
            if (abortObserved || signal.aborted) {
              rejectTerminal(
                CODE_ACT_MUTATION_OUTCOME_UNKNOWN,
                'Host mutation failed after Code-Act abort and may be partially committed; ' +
                  'do not retry automatically'
              );
              return;
            }
            finish(() => reject(error));
          }
        );
      });
    }
    if (signal.aborted) {
      return Promise.reject(signal.reason);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = () => finish(() => reject(signal.reason));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
      result.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error))
      );
    });
  }

  private _terminalMutationError(code: CodeActTerminalMutationCode, message: string): Error {
    return new CodeActTerminalMutationError(code, message);
  }

  private _normalizeError(err: unknown): {
    name: string;
    message: string;
    stack?: string;
    code?: CodeActTerminalMutationCode;
    retryable?: boolean;
  } {
    if (err instanceof CodeActTerminalMutationError) {
      return {
        name: err.name,
        message: err.message,
        stack: err.stack,
        code: err.code,
        retryable: false,
      };
    }
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>;
      return {
        name: String(e.name ?? 'Error'),
        message: String(e.message ?? e.name ?? JSON.stringify(err)),
        stack: e.stack ? String(e.stack) : undefined,
      };
    }
    return { name: 'Error', message: String(err) };
  }
}
