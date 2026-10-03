import fs from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lexical search is the channel the fusion ranks first. For Korean, Japanese and Chinese text the
 * vector channel ranks by writing style more than by content, so lexical search must run for such
 * a query even when vector search already returned enough rows. Before short CJK words were kept,
 * a long Korean query reduced to three or fewer tokens and forced lexical search by accident.
 */

// Korean text lives in a fixture: the pre-commit guard keeps it out of .ts files.
const { longKoreanQuery, particleText } = JSON.parse(
  fs.readFileSync(new URL('../fixtures/cjk-short-tokens.json', import.meta.url), 'utf8')
) as { longKoreanQuery: string; particleText: string };

const generateEmbeddingMock = vi.fn();
const vectorSearchMock = vi.fn();
const fts5SearchMock = vi.fn();
let decisionRows: Array<Record<string, unknown>> = [];

vi.mock('../../src/embedding/embedder.js', () => ({
  generateEmbedding: generateEmbeddingMock,
  generateEnhancedEmbedding: generateEmbeddingMock,
  isForceTier3Enabled: () => false,
}));

vi.mock('../../src/db-manager.js', () => ({
  initDB: vi.fn(async () => {}),
  getAdapter: vi.fn(() => ({
    prepare(sql: string) {
      return {
        // Rows for the in-memory lexical scan; nothing else is stored.
        all: () =>
          sql.includes('FROM decisions') && !sql.includes("'$.amended'") ? decisionRows : [],
        get: () => undefined,
      };
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
    decisionRows = [];
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

  it('runs lexical search for an English query whose short tokens are acronyms or versions', async () => {
    const { recallMemory } = await import('../../src/memory/api.js');

    // Kept short tokens raise the count to five; without them it is three, as before the change.
    await recallMemory(getAdapter(), 'fix FB login bug v2', { includeRelated: false });

    expect(fts5SearchMock).toHaveBeenCalled();
  });

  it('matches a short Latin token as a whole word in the in-memory scan', async () => {
    vectorSearchMock.mockResolvedValue([]);
    const row = (id: string, topic: string, text: string) => ({
      id,
      topic,
      decision: text,
      reasoning: text,
      confidence: 0.8,
      created_at: 100,
      updated_at: 100,
      trust_context: null,
      kind: 'decision',
      status: 'active',
      summary: text,
    });
    decisionRows = [
      row('mail-note', 'mail_notes', 'Email about the lunch order.'),
      row('ai-policy', 'usage_policy', 'AI usage policy for the team.'),
      // A Korean particle follows the acronym directly; it still counts as the word.
      row('qa-particle', 'notes', particleText),
    ];
    const { recallMemory } = await import('../../src/memory/api.js');

    const ai = await recallMemory(getAdapter(), 'AI policy', { includeRelated: false });
    const qa = await recallMemory(getAdapter(), 'QA policy', { includeRelated: false });

    const aiIds = ai.memories.map((memory) => memory.id);
    expect(aiIds).toContain('ai-policy');
    expect(aiIds).not.toContain('mail-note');
    expect(qa.memories.map((memory) => memory.id)).toContain('qa-particle');
  });
});
