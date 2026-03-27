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
});
