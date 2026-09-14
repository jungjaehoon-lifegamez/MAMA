import { describe, expect, it, vi } from 'vitest';
import { createEmbedder } from '../../src/embedding/embedder.js';
import { EmbeddingCache } from '../../src/embedding-cache.js';

/**
 * The model pipeline used to be three module globals, so one configuration
 * existed per process and a failed load poisoned every later caller. An
 * embedder now owns its pipeline and its cache.
 *
 * `@huggingface/transformers` is replaced with a deterministic stand-in: the
 * real model is the one thing these assertions must not depend on, and loading
 * it takes seconds. Everything below the import is the real implementation.
 */

const loads: string[] = [];

vi.mock('@huggingface/transformers', () => ({
  env: {},
  pipeline: async (_task: string, model: string) => {
    loads.push(model);
    if (model === 'broken-model') {
      throw new Error('model not found');
    }
    return async (text: string) => ({
      // A vector that depends on the input, so a wrong cache hit is visible.
      data: Float32Array.from([text.length, model.length, 1]),
    });
  },
}));

function embedderFor(modelName: string, cache?: EmbeddingCache) {
  return createEmbedder({
    modelName,
    dimension: 3,
    quantized: true,
    maxLength: 512,
    cacheDir: '/tmp/does-not-matter',
    ...(cache ? { cache } : {}),
  });
}

describe('Story PR4C: the embedder is an instance, not a module global', () => {
  describe('AC #1: two embedders are two models', () => {
    it('keeps their caches apart', async () => {
      loads.length = 0;
      const first = embedderFor('model-a');
      const second = embedderFor('model-bb');

      const fromFirst = await first.embed('same input');
      const fromSecond = await second.embed('same input');

      // Same text, different models: the second must not receive the first's vector.
      expect(Array.from(fromFirst)).not.toEqual(Array.from(fromSecond));
      expect(loads).toEqual(['model-a', 'model-bb']);
    });

    it('loads the model once and serves the rest from its cache', async () => {
      loads.length = 0;
      const embedder = embedderFor('model-a');

      await embedder.embed('first');
      await embedder.embed('first');
      await embedder.embed('second');

      expect(loads).toEqual(['model-a']);
      expect(embedder.cache.get('first')).toBeDefined();
    });
  });

  describe('AC #2: a failed load does not become a retry loop', () => {
    it('reports the original failure without loading again', async () => {
      loads.length = 0;
      const embedder = embedderFor('broken-model');

      await expect(embedder.embed('anything')).rejects.toThrow('model not found');
      await expect(embedder.embed('anything')).rejects.toThrow('model not found');

      expect(loads).toEqual(['broken-model']);
    });

    it('leaves a different embedder able to load', async () => {
      loads.length = 0;
      const broken = embedderFor('broken-model');
      const working = embedderFor('model-a');

      await expect(broken.embed('anything')).rejects.toThrow('model not found');
      await expect(working.embed('anything')).resolves.toBeInstanceOf(Float32Array);
    });
  });

  describe('AC #3: a supplied cache is the one used', () => {
    it('writes into the cache the caller passed', async () => {
      const shared = new EmbeddingCache();
      const embedder = embedderFor('model-a', shared);

      await embedder.embed('into the shared cache');

      expect(shared.get('into the shared cache')).toBeDefined();
      expect(embedder.cache).toBe(shared);
    });
  });

  describe('AC #4: a dimension mismatch is a failure, not a warning', () => {
    it('rejects a vector of the wrong width', async () => {
      const embedder = createEmbedder({
        modelName: 'model-a',
        dimension: 1024,
        quantized: true,
        maxLength: 512,
        cacheDir: '/tmp/does-not-matter',
      });

      await expect(embedder.embed('anything')).rejects.toThrow(/Expected 1024-dim, got 3-dim/);
    });
  });
});
