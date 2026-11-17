import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleApprovalSweeps } from '../../src/runtime/approval-runtime.js';

afterEach(() => vi.useRealTimers());

describe('approval sweep schedule', () => {
  it('skips a tick while a sweep runs, and settled waits for that sweep', async () => {
    vi.useFakeTimers();
    let finish: () => void = () => {};
    const sweep = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const schedule = scheduleApprovalSweeps(sweep, { intervalMs: 1000, onError: () => {} });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sweep).toHaveBeenCalledTimes(1);
    schedule.cancel();
    let settled = false;
    const waiting = schedule.settled().then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    finish();
    await waiting;
    expect(settled).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('reports a failed sweep and keeps the next tick', async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const sweep = vi.fn(async () => {
      throw new Error('database is locked');
    });
    const schedule = scheduleApprovalSweeps(sweep, {
      intervalMs: 1000,
      onError: (error) => errors.push(error),
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(2);
    schedule.cancel();
    await schedule.settled();
  });
});
