import {
  newQuickJSAsyncWASMModule,
  shouldInterruptAfterDeadline,
  type QuickJSAsyncWASMModule,
  type QuickJSAsyncRuntime,
  type QuickJSAsyncContext,
  type QuickJSHandle,
  type VmCallResult,
} from 'quickjs-emscripten';

import type { SandboxConfig, ExecutionResult, HostFunction } from './types.js';
import { DEFAULT_SANDBOX_CONFIG } from './types.js';

let _modulePromise: Promise<QuickJSAsyncWASMModule> | null = null;

/** Singleton WASM module loader — called once at server start (uses default RELEASE_ASYNC variant) */
async function getModule(): Promise<QuickJSAsyncWASMModule> {
  if (!_modulePromise) {
    _modulePromise = newQuickJSAsyncWASMModule();
  }
  return _modulePromise;
}

/** Convert a JS value to a QuickJS handle using native API (no evalCode) */
function jsonToHandle(ctx: QuickJSAsyncContext, value: unknown): QuickJSHandle {
  if (value === null || value === undefined) return ctx.undefined;
  if (value === true) return ctx.true;
  if (value === false) return ctx.false;
  if (typeof value === 'string') return ctx.newString(value);
  if (typeof value === 'number') return ctx.newNumber(value);

  if (Array.isArray(value)) {
    const arr = ctx.newArray();
    for (let i = 0; i < value.length; i++) {
      const h = jsonToHandle(ctx, value[i]);
      ctx.setProp(arr, i, h);
      h.dispose();
    }
    return arr;
  }

  if (typeof value === 'object') {
    const obj = ctx.newObject();
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const h = jsonToHandle(ctx, v);
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
  private registeredFunctions = new Map<string, HostFunction>();

  constructor(config?: Partial<SandboxConfig>) {
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...config };
  }

  /** Pre-load WASM module (call at server startup for fast first execution) */
  static async warmup(): Promise<void> {
    await getModule();
  }

  /** Register an async host function to be injected into sandbox */
  registerFunction(name: string, fn: HostFunction): void {
    this.registeredFunctions.set(name, fn);
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
  async execute(code: string): Promise<ExecutionResult> {
    const startTime = performance.now();
    const logs: string[] = [];
    let hostCallCount = 0;

    const module = await getModule();
    const rt: QuickJSAsyncRuntime = module.newRuntime();
    rt.setMemoryLimit(this.config.memoryLimitBytes);
    rt.setMaxStackSize(this.config.maxStackSizeBytes);
    rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + this.config.timeoutMs));

    const ctx: QuickJSAsyncContext = rt.newContext();

    try {
      // Inject console.log
      this._injectConsole(ctx, logs);

      // Inject registered host functions
      for (const [name, fn] of this.registeredFunctions) {
        this._injectAsyncFunction(ctx, name, fn, () => {
          hostCallCount++;
          if (hostCallCount > this.config.maxConcurrentCalls) {
            throw new Error(`Host call limit exceeded (max ${this.config.maxConcurrentCalls})`);
          }
        });
      }

      // Execute code
      const result = await ctx.evalCodeAsync(code, 'code-act.js');

      const durationMs = performance.now() - startTime;
      const memUsage = ctx.dump(rt.computeMemoryUsage());
      const memObj = memUsage as Record<string, unknown> | null;
      const memoryUsedBytes =
        memObj && typeof memObj.malloc_size === 'number' ? memObj.malloc_size : 0;

      if (result.error) {
        const err = ctx.dump(result.error);
        result.error.dispose();
        return {
          success: false,
          error: this._normalizeError(err),
          logs,
          metrics: { durationMs, hostCallCount, memoryUsedBytes },
        };
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
          return {
            success: false,
            error: this._normalizeError(value.value),
            logs,
            metrics: { durationMs, hostCallCount, memoryUsedBytes },
          };
        }
      }

      return {
        success: true,
        value,
        logs,
        metrics: { durationMs, hostCallCount, memoryUsedBytes },
      };
    } catch (err) {
      const durationMs = performance.now() - startTime;
      return {
        success: false,
        error: {
          name: err instanceof Error ? err.constructor.name : 'Error',
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        logs,
        metrics: { durationMs, hostCallCount, memoryUsedBytes: 0 },
      };
    } finally {
      ctx.dispose();
      try {
        rt.dispose();
      } catch {
        /* HostRef cleanup — non-critical */
      }
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
    fn: HostFunction,
    onCall: () => void
  ): void {
    const handle = ctx.newAsyncifiedFunction(name, async (...argHandles) => {
      onCall();
      const args = argHandles.map((h) => ctx.dump(h));

      try {
        const result = await fn(...args);

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
      }
    });
    ctx.setProp(ctx.global, name, handle);
    handle.dispose();
  }

  private _normalizeError(err: unknown): { name: string; message: string; stack?: string } {
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
