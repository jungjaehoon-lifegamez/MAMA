import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateEmbeddingMock = vi.fn();
const vectorSearchMock = vi.fn();
const expandWithGraphMock = vi.fn();

vi.mock('../../src/embeddings.js', () => ({
  generateEmbedding: generateEmbeddingMock,
}));

vi.mock('../../src/db-manager.js', () => ({
  initDB: vi.fn(async () => {}),
  getAdapter: vi.fn(() => ({
    prepare(sql: string) {
      return {
        all: (..._args: unknown[]) => {
          if (sql.includes('FROM memory_scope_bindings') || sql.includes('FROM decision_edges')) {
            return [];
          }
          if (sql.includes('FROM decisions')) {
            return [];
          }
          return [];
        },
        get: (..._args: unknown[]) => {
          if (sql.includes('SELECT status FROM decisions')) {
            return { status: 'active' };
          }
          return undefined;
        },
      };
    },
  })),
  insertDecisionWithEmbedding: vi.fn(),
  ensureMemoryScope: vi.fn(async () => 1),
  vectorSearch: vectorSearchMock,
  queryDecisionGraph: vi.fn(async () => []),
  querySemanticEdges: vi.fn(async () => []),
}));

vi.mock('../../src/mama-api.js', () => ({
  default: {
    expandWithGraph: expandWithGraphMock,
  },
}));

const BASE_VECTOR_RESULT = {
  id: 'memory-a',
  topic: 'project_architecture',
  decision: 'We use hexagonal architecture for testability.',
  reasoning: 'Separation of concerns improves testing.',
  similarity: 0.91,
  created_at: 1000,
  status: 'active',
};

const RELATED_RESULT = {
  id: 'memory-b',
  topic: 'project_architecture_v2',
  decision: 'We added ports-and-adapters to the hexagonal model.',
  reasoning: 'Extends the original design.',
  graph_rank: 0.75,
  graph_source: 'graph_expansion',
  created_at: 2000,
  status: 'active',
};

describe('recallMemory graph expansion', () => {
  beforeEach(() => {
    vi.resetModules();

    generateEmbeddingMock.mockResolvedValue(new Float32Array([0.1, 0.2, 0.3]));
    vectorSearchMock.mockResolvedValue([BASE_VECTOR_RESULT]);
    expandWithGraphMock.mockResolvedValue([BASE_VECTOR_RESULT, RELATED_RESULT]);
  });

  it('should populate graph_context.expanded when edges exist', async () => {
    const { recallMemory } = await import('../../src/memory/api.js');

    const bundle = await recallMemory('What architecture do we use?');

    // Primary matched memory should be present
    expect(bundle.memories.length).toBeGreaterThan(0);
    expect(bundle.memories[0]?.id).toBe('memory-a');

    // expandWithGraph returned memory-b as a new node → should be in expanded
    expect(bundle.graph_context.expanded.length).toBeGreaterThan(0);
    expect(bundle.graph_context.expanded[0]?.id).toBe('memory-b');
  });

  it('should return empty expanded when skipGraphExpansion is true', async () => {
    const { recallMemory } = await import('../../src/memory/api.js');

    const bundle = await recallMemory('What architecture do we use?', {
      skipGraphExpansion: true,
    });

    expect(bundle.graph_context.expanded).toEqual([]);
    expect(bundle.graph_context.edges).toEqual([]);
  });
});
