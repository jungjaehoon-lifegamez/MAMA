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

  it('should process jobs sequentially (second waits for first)', async () => {
    let resolveFirst: (v: unknown) => void;
    const worker = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce({ status: 'applied', action: 'save', event_ids: ['evt_2'] });

    const queue = new AuditTaskQueue(worker);

    const first = queue.enqueue({
      turnId: 'turn_1',
      scopeContext: [{ kind: 'project', id: '/repo' }],
      conversation: 'User: first\nAssistant: ...',
    });

    const second = queue.enqueue({
      turnId: 'turn_2',
      scopeContext: [{ kind: 'project', id: '/repo' }],
      conversation: 'User: second\nAssistant: ...',
    });

    // Wait for worker to be called
    await new Promise((r) => setTimeout(r, 10));
    resolveFirst!({ status: 'applied', action: 'save', event_ids: ['evt_1'] });

    const r1 = await first;
    const r2 = await second;
    expect(r1.event_ids).toEqual(['evt_1']);
    expect(r2.event_ids).toEqual(['evt_2']);
    // Both jobs processed sequentially
    expect(worker).toHaveBeenCalledTimes(2);
  });
});
