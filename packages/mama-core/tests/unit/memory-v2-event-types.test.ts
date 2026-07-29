import { describe, expect, it } from 'vitest';

describe('Memory auditor truth-first contracts', () => {
  it('should expose the approved truth statuses', async () => {
    const types = await import('../../src/memory/types.js');
    const statuses = types.MEMORY_TRUTH_STATUSES;
    expect(statuses).toContain('quarantined');
  });

  it('should expose the approved memory-agent actions', async () => {
    const types = await import('../../src/memory/types.js');
    const actions = types.MEMORY_AGENT_ACTIONS;
    expect(actions).toContain('mark_stale');
  });

  it('should expose consult intents and ack statuses', async () => {
    const types = await import('../../src/memory/types.js');
    const ack = types.createMemoryAuditAck({ status: 'applied', action: 'save', event_ids: [] });

    expect(types.MEMORY_CONSULT_INTENTS).toContain('validate_claim');
    expect(ack.status).toBe('applied');
    expect(ack.action).toBe('save');
  });
});
