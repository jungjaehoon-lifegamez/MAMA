import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock the model so no 560MB pipeline is ever loaded. All embeddings resolve to the
// same fixed vector, so any query matches every stored row with cosine 1.0.
const FIXED = () => new Float32Array(1024).fill(0.01);
vi.mock('../../src/embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => FIXED()),
  generateEnhancedEmbedding: vi.fn(async () => FIXED()),
  generateBatchEmbeddings: vi.fn(async (texts: string[]) => texts.map(() => FIXED())),
  cosineSimilarity: () => 1,
  embeddingCache: { clear: () => {}, get: () => undefined, set: () => {} },
  EMBEDDING_DIM: 1024,
  MODEL_NAME: 'x',
  EMBEDDING_PREFIX_SCHEME: 'e5-prefixed-v1',
}));

const tmpDir = mkdtempSync(join(tmpdir(), 'promote-status-visibility-'));
process.env.MAMA_DB_PATH = join(tmpDir, 'test-memory.db');

const { initDB, closeDB, vectorSearch } = await import('../../src/db-manager.js');
const { saveMemory, promoteMemoryStatus } = await import('../../src/memory/api.js');

const EXCLUDED = ['superseded', 'quarantined', 'contradicted', 'stale'];

describe('Story R1: promoted memories stay vector-searchable', () => {
  beforeAll(async () => {
    await initDB();
  }, 30000);

  afterAll(async () => {
    await closeDB();
  });

  describe('AC #4: staging->active promotion re-enters the pre-filtered search', () => {
    it('finds a stale-staged memory after promoteMemoryStatus(active) without a cache reload', async () => {
      const saved = await saveMemory({
        topic: 'staged-note',
        kind: 'decision',
        summary: 'Staged observation awaiting review',
        details: 'Held in stale status until promotion',
        status: 'stale',
        scopes: [{ kind: 'global', id: 'global' }],
        source: { package: 'mama-core', source_type: 'test' },
      });
      const memoryId = (saved as { id: string }).id;

      // Staged (excluded) -> the pre-filter hides it.
      const before = await vectorSearch(FIXED(), 5, 0.1, undefined, EXCLUDED);
      expect(before.map((d) => d.id)).not.toContain(memoryId);

      await promoteMemoryStatus({ memoryId, status: 'active' });

      // Promotion must sync the adapter status cache - no reloadVectorCache here.
      const after = await vectorSearch(FIXED(), 5, 0.1, undefined, EXCLUDED);
      expect(after.map((d) => d.id)).toContain(memoryId);
    });
  });
});
