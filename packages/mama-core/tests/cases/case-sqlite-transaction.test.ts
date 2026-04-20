import { describe, expect, it, vi } from 'vitest';

import {
  runImmediateTransaction,
  type ImmediateTransactionAdapter,
} from '../../src/cases/sqlite-transaction.js';

describe('runImmediateTransaction', () => {
  it('wraps successful callbacks with BEGIN IMMEDIATE and COMMIT', () => {
    const execCalls: string[] = [];
    const adapter: ImmediateTransactionAdapter = {
      exec(sql: string) {
        execCalls.push(sql);
      },
      transaction: vi.fn(),
    };

    const result = runImmediateTransaction(adapter, () => 'ok');

    expect(result).toBe('ok');
    expect(execCalls).toEqual(['BEGIN IMMEDIATE', 'COMMIT']);
    expect(adapter.transaction).not.toHaveBeenCalled();
  });

  it('runs ROLLBACK when the callback throws', () => {
    const execCalls: string[] = [];
    const adapter: ImmediateTransactionAdapter = {
      exec(sql: string) {
        execCalls.push(sql);
      },
      transaction: vi.fn(),
    };

    expect(() =>
      runImmediateTransaction(adapter, () => {
        throw new Error('write failed');
      })
    ).toThrow('write failed');

    expect(execCalls).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
  });

  it('retries SQLITE_BUSY errors up to maxBusyRetries and then rethrows', () => {
    const execCalls: string[] = [];
    const busy = new Error('database is locked');
    (busy as { code?: string }).code = 'SQLITE_BUSY';
    const adapter: ImmediateTransactionAdapter = {
      exec(sql: string) {
        execCalls.push(sql);
        throw busy;
      },
      transaction: vi.fn(),
    };

    expect(() =>
      runImmediateTransaction(adapter, () => 'unreachable', {
        maxBusyRetries: 2,
        busyRetryDelayMs: 0,
      })
    ).toThrow('database is locked');

    expect(execCalls).toEqual(['BEGIN IMMEDIATE', 'BEGIN IMMEDIATE', 'BEGIN IMMEDIATE']);
  });

  it('retries a busy BEGIN IMMEDIATE and commits once a later attempt succeeds', () => {
    const execCalls: string[] = [];
    let beginAttempts = 0;
    const adapter: ImmediateTransactionAdapter = {
      exec(sql: string) {
        execCalls.push(sql);
        if (sql === 'BEGIN IMMEDIATE') {
          beginAttempts += 1;
          if (beginAttempts < 2) {
            const busy = new Error('SQLITE_BUSY');
            (busy as { code?: string }).code = 'SQLITE_BUSY';
            throw busy;
          }
        }
      },
      transaction: vi.fn(),
    };

    const result = runImmediateTransaction(adapter, () => 'committed', {
      maxBusyRetries: 2,
      busyRetryDelayMs: 0,
    });

    expect(result).toBe('committed');
    expect(execCalls).toEqual(['BEGIN IMMEDIATE', 'BEGIN IMMEDIATE', 'COMMIT']);
  });

  it('rejects async callback thenables', () => {
    const execCalls: string[] = [];
    const adapter: ImmediateTransactionAdapter = {
      exec(sql: string) {
        execCalls.push(sql);
      },
      transaction: vi.fn(),
    };

    expect(() =>
      runImmediateTransaction(adapter, () => Promise.resolve('later') as unknown as string)
    ).toThrow('callbacks must be synchronous');

    expect(execCalls).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
  });
});
