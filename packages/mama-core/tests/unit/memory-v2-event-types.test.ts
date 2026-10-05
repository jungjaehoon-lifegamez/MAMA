import { describe, expect, it } from 'vitest';

describe('Memory auditor truth-first contracts', () => {
  it('should expose the approved truth statuses', async () => {
    const types = await import('../../src/memory/types.js');
    const statuses = types.MEMORY_TRUTH_STATUSES;
    // No path writes `quarantined` and the decisions CHECK refuses it (migration 098).
    expect(statuses).toEqual(['active', 'superseded', 'contradicted', 'stale']);
  });

  it('should expose the approved memory-agent actions', async () => {
    const types = await import('../../src/memory/types.js');
    const actions = types.MEMORY_AGENT_ACTIONS;
    expect(actions).toContain('mark_stale');
  });

  it('should expose consult intents', async () => {
    const types = await import('../../src/memory/types.js');

    expect(types.MEMORY_CONSULT_INTENTS).toContain('validate_claim');
  });
});
