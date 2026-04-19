export interface ImmediateTransactionAdapter {
  exec?: (sql: string) => void;
  transaction: <T>(fn: () => T) => T;
}

export interface ImmediateTransactionOptions {
  maxBusyRetries?: number;
  busyRetryDelayMs?: number;
}

function isThenable(value: unknown): boolean {
  return (
    ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function isBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return code === 'SQLITE_BUSY' || /SQLITE_BUSY|database is locked/i.test(error.message);
}

function sleepSync(ms: number): void {
  if (ms <= 0) {
    return;
  }

  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function requireSynchronousResult<T>(result: T): T {
  if (isThenable(result)) {
    throw new Error('runImmediateTransaction() callbacks must be synchronous');
  }
  return result;
}

export function runImmediateTransaction<T>(
  adapter: ImmediateTransactionAdapter,
  fn: () => T,
  options?: ImmediateTransactionOptions
): T {
  const maxBusyRetries = options?.maxBusyRetries ?? 3;
  const busyRetryDelayMs = options?.busyRetryDelayMs ?? 20;

  if (!adapter.exec) {
    // Fake test adapters without exec can only provide deferred transaction
    // semantics; production SQLite adapters should expose exec for BEGIN IMMEDIATE.
    return adapter.transaction(() => requireSynchronousResult(fn()));
  }

  let attempt = 0;
  for (;;) {
    try {
      adapter.exec('BEGIN IMMEDIATE');
      try {
        const result = requireSynchronousResult(fn());
        adapter.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          adapter.exec('ROLLBACK');
        } catch {
          // Preserve the original transaction failure when rollback also fails.
        }
        throw error;
      }
    } catch (error) {
      if (isBusyError(error) && attempt < maxBusyRetries) {
        attempt += 1;
        sleepSync(busyRetryDelayMs);
        continue;
      }
      throw error;
    }
  }
}
