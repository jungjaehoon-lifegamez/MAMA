import { describe, it, expect } from 'vitest';

describe('Memory V2 types', () => {
  it('should allow the approved scope kinds', async () => {
    const types = await import('../../src/memory-v2/types.js');
    const scopeKinds = types.MEMORY_SCOPE_KINDS;

    expect(scopeKinds).toEqual(['global', 'user', 'channel', 'project']);
  });

  it('should expose the approved edge types', async () => {
    const types = await import('../../src/memory-v2/types.js');
    const edgeTypes = types.MEMORY_EDGE_TYPES;

    expect(edgeTypes).toContain('contradicts');
  });

  it('should export a helper to build an empty recall bundle shape', async () => {
    const types = await import('../../src/memory-v2/types.js');
    const bundle = types.createEmptyRecallBundle('auth');

    expect(bundle).toEqual({
      profile: { static: [], dynamic: [], evidence: [] },
      memories: [],
      graph_context: { primary: [], expanded: [], edges: [] },
      search_meta: { query: 'auth', scope_order: ['project'], retrieval_sources: ['vector'] },
    });
  });
});
