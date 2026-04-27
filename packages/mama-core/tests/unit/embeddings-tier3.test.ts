import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_FORCE_TIER_3 = process.env.MAMA_FORCE_TIER_3;

afterEach(() => {
  if (ORIGINAL_FORCE_TIER_3 === undefined) {
    delete process.env.MAMA_FORCE_TIER_3;
  } else {
    process.env.MAMA_FORCE_TIER_3 = ORIGINAL_FORCE_TIER_3;
  }
  vi.doUnmock('@huggingface/transformers');
  vi.resetModules();
});

describe('Story M1.4: Embeddings Tier 3 enforcement', () => {
  describe('AC #1: Tier 3 blocks model loading before inference', () => {
    it('fails loudly before loading the embedding model when MAMA_FORCE_TIER_3 is enabled', async () => {
      process.env.MAMA_FORCE_TIER_3 = 'true';
      vi.doMock('@huggingface/transformers', () => ({
        env: {},
        pipeline: async () => {
          throw new Error('transformers should not load in Tier 3 mode');
        },
      }));

      const { generateEmbedding } = await import('../../src/embeddings.js');

      await expect(generateEmbedding('use lexical fallback')).rejects.toThrow(
        /MAMA_FORCE_TIER_3=true/
      );
    });

    it('blocks batch embeddings with the same direct explicit error', async () => {
      process.env.MAMA_FORCE_TIER_3 = '1';
      vi.doMock('@huggingface/transformers', () => ({
        env: {},
        pipeline: async () => {
          throw new Error('transformers should not load in Tier 3 mode');
        },
      }));

      const { generateBatchEmbeddings } = await import('../../src/embeddings.js');

      await expect(generateBatchEmbeddings(['one', 'two'])).rejects.toThrow(
        /^Embedding generation disabled/
      );
    });
  });
});
