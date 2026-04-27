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

describe('embeddings Tier 3 mode', () => {
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

  it('blocks batch embeddings in Tier 3 mode with the same explicit error', async () => {
    process.env.MAMA_FORCE_TIER_3 = '1';
    vi.doMock('@huggingface/transformers', () => ({
      env: {},
      pipeline: async () => {
        throw new Error('transformers should not load in Tier 3 mode');
      },
    }));

    const { generateBatchEmbeddings } = await import('../../src/embeddings.js');

    await expect(generateBatchEmbeddings(['one', 'two'])).rejects.toThrow(/MAMA_FORCE_TIER_3/);
  });
});
