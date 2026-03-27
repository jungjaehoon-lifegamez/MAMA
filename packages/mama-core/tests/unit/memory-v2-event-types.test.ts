import { describe, expect, it } from 'vitest';

describe('Memory auditor truth-first contracts', () => {
  it('should expose the approved truth statuses', async () => {
    const types = await import('../../src/memory-v2/types.js');
    const statuses = types.MEMORY_TRUTH_STATUSES;
    expect(statuses).toContain('quarantined');
  });

  it('should expose the approved memory-agent actions', async () => {
    const types = await import('../../src/memory-v2/types.js');
    const actions = types.MEMORY_AGENT_ACTIONS;
    expect(actions).toContain('mark_stale');
  });

  it('should build a bootstrap payload shape', async () => {
    const types = await import('../../src/memory-v2/types.js');
    const packet = types.createEmptyMemoryAgentBootstrap({
      scope_context: [{ kind: 'project', id: '/repo' }],
    });

    expect(packet.scope_context[0]?.kind).toBe('project');
    expect(packet.truth_snapshot).toEqual([]);
  });

  it('should expose consult intents and ack statuses', async () => {
    const types = await import('../../src/memory-v2/types.js');
    const intent = types.MEMORY_CONSULT_INTENTS[1];
    const ack = types.createMemoryAuditAck({ status: 'applied', action: 'save', event_ids: [] });

    expect(intent).toBe('validate_claim');
    expect(ack.status).toBe('applied');
    expect(ack.action).toBe('save');
  });
});
