import fs from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lexical search is the channel the fusion ranks first. For Korean, Japanese and Chinese text the
 * vector channel ranks by writing style more than by content, so lexical search must run for such
 * a query even when vector search already returned enough rows. Before short CJK words were kept,
 * a long Korean query reduced to three or fewer tokens and forced lexical search by accident.
 */

// Korean text lives in a fixture: the pre-commit guard keeps it out of .ts files.
const { longKoreanQuery } = JSON.parse(
  fs.readFileSync(new URL('../fixtures/cjk-short-tokens.json', import.meta.url), 'utf8')
) as { longKoreanQuery: string };

const generateEmbeddingMock = vi.fn();
const vectorSearchMock = vi.fn();
const fts5SearchMock = vi.fn();

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

const { getAdapter } = await import('../../src/db-manager.js');

describe('lexical confirmation for CJK queries', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    generateEmbeddingMock.mockResolvedValue(new Float32Array([0.1, 0.2, 0.3]));
    vectorSearchMock.mockResolvedValue(
      Array.from({ length: 6 }, (_, index) => ({
        id: `vector-${index}`,
        topic: `topic_${index}`,
        decision: `vector row ${index}`,
        reasoning: '',
        similarity: 0.8,
        created_at: 100 + index,
      }))
    );
    fts5SearchMock.mockResolvedValue([]);
  });

  it('runs lexical search for a long Korean query when vector search returned enough rows', async () => {
    const { recallMemory } = await import('../../src/memory/api.js');

    await recallMemory(getAdapter(), longKoreanQuery, {
      includeRelated: false,
    });

    expect(fts5SearchMock).toHaveBeenCalled();
  });

  it('still skips lexical search for a long English query when vector search returned enough rows', async () => {
    const { recallMemory } = await import('../../src/memory/api.js');

    await recallMemory(getAdapter(), 'client revision requests kept coming back again', {
      includeRelated: false,
    });

    expect(fts5SearchMock).not.toHaveBeenCalled();
  });
});
