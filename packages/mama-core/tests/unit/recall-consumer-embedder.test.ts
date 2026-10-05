import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A consumer passes recall the embedder it writes with. One that answers null searches by text
 * only: the core's own embedder never loads (on a packed install its first call started a model
 * download), and nothing is reported as a failure. Absent, recall keeps the core's embedder.
 */

const generateEmbeddingMock = vi.fn();
const vectorSearchMock = vi.fn();
const fts5SearchMock = vi.fn();
const warnMock = vi.fn();

vi.mock('../../src/embedding/embedder.js', () => ({
  generateEmbedding: generateEmbeddingMock,
  generateEnhancedEmbedding: generateEmbeddingMock,
  isForceTier3Enabled: () => false,
}));

vi.mock('../../src/db-manager.js', () => ({
  initDB: vi.fn(async () => {}),
  getAdapter: vi.fn(() => ({
    prepare() {
      return { all: () => [], get: () => undefined };
    },
  })),
  insertDecisionWithEmbedding: vi.fn(),
  ensureMemoryScope: vi.fn(() => 1),
}));

vi.mock('../../src/knowledge/search.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/knowledge/search.js')>()),
  vectorSearch: vectorSearchMock,
  fts5Search: fts5SearchMock,
}));

vi.mock('../../src/debug-logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/debug-logger.js')>()),
  warn: warnMock,
}));

const { getAdapter } = await import('../../src/db-manager.js');

describe("recall with the consumer's embedder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateEmbeddingMock.mockResolvedValue(new Float32Array([0.1, 0.2, 0.3]));
    vectorSearchMock.mockResolvedValue([]);
    fts5SearchMock.mockResolvedValue([]);
  });

  it('searches by text only when the embedder answers null', async () => {
    const { recallMemory } = await import('../../src/memory/api.js');
    const embed = vi.fn(async () => null);

    await recallMemory(getAdapter(), 'sample drift', { embedder: { embed } });

    expect(embed).toHaveBeenCalledWith('sample drift', 'query');
    expect(generateEmbeddingMock).not.toHaveBeenCalled();
    expect(vectorSearchMock).not.toHaveBeenCalled();
    expect(fts5SearchMock).toHaveBeenCalled();
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('searches by text when the embedder declines a later sub-query, whatever vectors found', async () => {
    const { recallMemory } = await import('../../src/memory/api.js');
    // Six vector hits for the first sub-query would have skipped lexical confirmation.
    vectorSearchMock.mockResolvedValue(
      Array.from({ length: 6 }, (_, index) => ({
        id: `vector-${index}`,
        topic: `topic_${index}`,
        decision: `row ${index}`,
        reasoning: '',
        similarity: 0.8,
        created_at: 100 + index,
      }))
    );
    let calls = 0;
    const embed = async () => (calls++ === 0 ? new Float32Array([0.4, 0.5, 0.6]) : null);

    await recallMemory(
      getAdapter(),
      'calibration notes for bench one and drift readings for bench two',
      {
        embedder: { embed },
      }
    );

    expect(calls).toBe(2);
    expect(fts5SearchMock).toHaveBeenCalled();
  });

  it("searches vectors with the consumer's embedding when it gives one", async () => {
    const { recallMemory } = await import('../../src/memory/api.js');
    const vector = new Float32Array([0.4, 0.5, 0.6]);

    await recallMemory(getAdapter(), 'sample drift', { embedder: { embed: async () => vector } });

    expect(generateEmbeddingMock).not.toHaveBeenCalled();
    expect(vectorSearchMock.mock.calls[0]![1]).toBe(vector);
  });

  it("keeps the core's embedder when none is passed", async () => {
    const { recallMemory } = await import('../../src/memory/api.js');

    await recallMemory(getAdapter(), 'sample drift', {});

    expect(generateEmbeddingMock).toHaveBeenCalledWith('sample drift', 'query');
  });
});
