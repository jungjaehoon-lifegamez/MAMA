import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateEmbeddingMock = vi.fn();
const vectorSearchMock = vi.fn();

let decisionRows: Array<Record<string, unknown>> = [];

vi.mock('../../src/embeddings.js', () => ({
  generateEmbedding: generateEmbeddingMock,
}));

vi.mock('../../src/db-manager.js', () => ({
  initDB: vi.fn(async () => {}),
  getAdapter: vi.fn(() => ({
    prepare(sql: string) {
      return {
        all: (..._args: unknown[]) => {
          if (sql.includes('FROM memory_scope_bindings')) {
            return [];
          }
          if (sql.includes('FROM decisions')) {
            return decisionRows;
          }
          return [];
        },
      };
    },
  })),
  insertDecisionWithEmbedding: vi.fn(),
  ensureMemoryScope: vi.fn(async () => 1),
  vectorSearch: vectorSearchMock,
}));

describe('memory v2 recall ranking', () => {
  beforeEach(() => {
    vi.resetModules();
    decisionRows = [
      {
        id: 'answer-memory',
        topic: 'asylum_wait_time',
        decision: 'You waited over a year for the decision on your asylum application.',
        reasoning: 'The wait time was over a year.',
        confidence: 0.9,
        created_at: 200,
        updated_at: 200,
        trust_context: null,
        kind: 'decision',
        status: 'active',
        summary: 'You waited over a year for the decision on your asylum application.',
      },
      {
        id: 'distractor-memory',
        topic: 'general_housing_help',
        decision: 'You were asking for help finding a permanent place to live.',
        reasoning: 'General housing discussion with no asylum timeline.',
        confidence: 0.82,
        created_at: 100,
        updated_at: 100,
        trust_context: null,
        kind: 'decision',
        status: 'active',
        summary: 'You were asking for help finding a permanent place to live.',
      },
    ];

    generateEmbeddingMock.mockResolvedValue(new Float32Array([0.1, 0.2, 0.3]));
    vectorSearchMock.mockResolvedValue([
      {
        id: 'distractor-memory',
        topic: 'general_housing_help',
        decision: 'You were asking for help finding a permanent place to live.',
        reasoning: 'General housing discussion with no asylum timeline.',
        similarity: 0.82,
        created_at: 100,
      },
    ]);
  });

  it('should augment sparse vector recall with lexical exact-match memories', async () => {
    const { recallMemory } = await import('../../src/memory/api.js');

    const bundle = await recallMemory(
      'How long did I wait for the decision on my asylum application?'
    );

    // Hybrid RRF: both vector and lexical results should be present
    const ids = bundle.memories.map((m) => m.id);
    expect(ids).toContain('answer-memory');
    expect(ids).toContain('distractor-memory');
  });
});
