import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock the model so no 560MB pipeline is ever loaded. Both save (enhanced) and recall
// (query) resolve to fixed 1024-dim vectors; we only assert the role argument.
const generateEmbeddingMock = vi.fn(async () => new Float32Array(1024).fill(0.01));
const generateEnhancedEmbeddingMock = vi.fn(async () => new Float32Array(1024).fill(0.01));
vi.mock('../../src/embeddings.js', () => ({
  generateEmbedding: generateEmbeddingMock,
  generateEnhancedEmbedding: generateEnhancedEmbeddingMock,
  generateBatchEmbeddings: vi.fn(async (texts: string[]) =>
    texts.map(() => new Float32Array(1024).fill(0.01))
  ),
  cosineSimilarity: () => 0.5,
  embeddingCache: { clear: () => {}, get: () => undefined, set: () => {} },
  EMBEDDING_DIM: 1024,
  MODEL_NAME: 'x',
  EMBEDDING_PREFIX_SCHEME: 'e5-prefixed-v1',
}));

const tmpDir = mkdtempSync(join(tmpdir(), 'recall-query-role-'));
process.env.MAMA_DB_PATH = join(tmpDir, 'test-memory.db');

const { initDB, closeDB } = await import('../../src/db-manager.js');
const { saveMemory, recallMemory } = await import('../../src/memory/api.js');

describe('M5: recall embeds queries with the query role', () => {
  beforeAll(async () => {
    await initDB();
    for (let i = 0; i < 4; i++) {
      await saveMemory({
        topic: `deploy-note-${i}`,
        kind: 'decision',
        summary: `Deployment rollout note ${i} about the canary pipeline`,
        details: `Deployment rollout detail ${i} about the canary pipeline stage`,
        scopes: [{ kind: 'global', id: 'global' }],
        source: { package: 'mama-core', source_type: 'test' },
      });
    }
  }, 30000);

  afterAll(async () => {
    await closeDB();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => generateEmbeddingMock.mockClear());

  it('recallMemory passes role="query" to every generateEmbedding call', async () => {
    await recallMemory('deployment canary', { limit: 3 });
    expect(generateEmbeddingMock).toHaveBeenCalled();
    for (const call of generateEmbeddingMock.mock.calls) {
      expect(call[1]).toBe('query');
    }
  });
});
