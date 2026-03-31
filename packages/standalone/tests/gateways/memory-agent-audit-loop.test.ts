import { describe, expect, it, vi } from 'vitest';

import { AuditTaskQueue } from '../../src/memory/audit-task-queue.js';

describe('memory agent audit loop', () => {
  it('should close an observed turn with an explicit ack', async () => {
    const worker = vi
      .fn()
      .mockResolvedValue({ status: 'applied', action: 'save', event_ids: ['evt_1'] });
    const queue = new AuditTaskQueue(worker);

    const result = await queue.enqueue({
      turnId: 'turn_1',
      scopeContext: [{ kind: 'project', id: '/repo' }],
      conversation: 'User: ...\nAssistant: ...',
    });

    expect(result.status).toBe('applied');
    expect(worker).toHaveBeenCalledTimes(1);
  });

  it('should reject with timeout when worker hangs beyond 30 seconds', async () => {
    vi.useFakeTimers();
    const worker = vi.fn().mockImplementation(
      () => new Promise(() => {}) // never resolves
    );
    const queue = new AuditTaskQueue(worker);

    const promise = queue.enqueue({
      turnId: 'turn_hang',
      scopeContext: [{ kind: 'project', id: '/repo' }],
      conversation: 'User: hang\nAssistant: ...',
    });

    // Attach catch handler before advancing timers to prevent unhandled rejection
    const caught = promise.catch((err: Error) => err);

    await vi.advanceTimersByTimeAsync(30_000);

    const error = await caught;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Memory audit timed out');
    vi.useRealTimers();
  });

  it('should proceed to the next job after a timeout', async () => {
    vi.useFakeTimers();
    const worker = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {})) // first call hangs
      .mockResolvedValueOnce({ status: 'applied', action: 'save', event_ids: ['evt_2'] });

    const queue = new AuditTaskQueue(worker);

    const first = queue.enqueue({
      turnId: 'turn_timeout',
      scopeContext: [{ kind: 'project', id: '/repo' }],
      conversation: 'User: timeout\nAssistant: ...',
    });

    const second = queue.enqueue({
      turnId: 'turn_next',
      scopeContext: [{ kind: 'project', id: '/repo' }],
      conversation: 'User: next\nAssistant: ...',
    });

    // Attach catch handler before advancing timers to prevent unhandled rejection
    const firstCaught = first.catch((err: Error) => err);

    await vi.advanceTimersByTimeAsync(30_000);

    const error = await firstCaught;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Memory audit timed out');

    const result = await second;
    expect(result.status).toBe('applied');
    expect(result.event_ids).toEqual(['evt_2']);
    expect(worker).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
