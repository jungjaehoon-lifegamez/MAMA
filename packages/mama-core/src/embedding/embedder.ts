/**
 * Embedder lifetime.
 *
 * `createEmbedder` returns one embedder holding its own pipeline and cache. Two
 * calls give two independent embedders, so a caller can run a different model
 * without disturbing anyone else's, and a cache entry can never be served to a
 * caller that asked a different model for it.
 *
 * `embeddings.ts` keeps one process-wide embedder for the callers that still
 * reach for a module-level function. Nothing here depends on that one existing.
 *
 * @module embedding/embedder
 */

import { EmbeddingCache } from '../embedding-cache.js';
import { info } from '../debug-logger.js';
import { logComplete, logLoading } from '../progress-indicator.js';

export type EmbeddingPipeline = (
  text: string | string[],
  options?: { pooling?: string; normalize?: boolean; truncation?: boolean; max_length?: number }
) => Promise<{ data: Float32Array }>;

export interface EmbedderOptions {
  modelName: string;
  /** Vectors this model must produce. A mismatch is a failed load, not a warning. */
  dimension: number;
  quantized: boolean;
  maxLength: number;
  cacheDir: string;
  /**
   * Cache to use. Callers that share one embedder with existing consumers pass
   * the cache those consumers already clear and read stats from; omit it and the
   * embedder owns a private one.
   */
  cache?: EmbeddingCache;
}

export interface Embedder {
  readonly modelName: string;
  readonly dimension: number;
  /** Embed one already-prefixed input. The caller owns the role prefix. */
  embed(modelInput: string): Promise<Float32Array>;
  /** Load the model without embedding anything, so a caller can pay that cost up front. */
  warm(): Promise<void>;
  cache: EmbeddingCache;
}

/**
 * Build an embedder. The model loads on first use, not here.
 *
 * A failed load is remembered: the second call reports the original failure
 * instead of spending another model download on the same broken configuration.
 */
export function createEmbedder(options: EmbedderOptions): Embedder {
  const cache = options.cache ?? new EmbeddingCache();
  let pipeline: EmbeddingPipeline | null = null;
  let loadFailure: Error | null = null;

  async function load(): Promise<EmbeddingPipeline> {
    if (pipeline) {
      return pipeline;
    }
    if (loadFailure) {
      throw loadFailure;
    }

    logLoading(`Loading embedding model: ${options.modelName}...`);
    const startedAt = Date.now();

    try {
      // Dynamic import keeps the ES-module-only package out of the CommonJS graph.
      const { pipeline: createPipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = options.cacheDir;
      info(`[embedder] Model cache directory: ${options.cacheDir}`);

      pipeline = (await createPipeline('feature-extraction', options.modelName, {
        dtype: options.quantized ? 'q8' : 'fp32',
      })) as EmbeddingPipeline;

      logComplete(
        `Embedding model ready (${Date.now() - startedAt}ms, ${options.dimension}-dim, ${
          options.quantized ? 'q8' : 'fp32'
        })`
      );
      return pipeline;
    } catch (error) {
      loadFailure = error instanceof Error ? error : new Error(String(error));
      throw loadFailure;
    }
  }

  return {
    modelName: options.modelName,
    dimension: options.dimension,
    cache,

    async warm(): Promise<void> {
      await load();
    },

    async embed(modelInput: string): Promise<Float32Array> {
      const cached = cache.get(modelInput);
      if (cached) {
        return cached;
      }

      const model = await load();
      const output = await model(modelInput, {
        pooling: 'mean',
        normalize: true,
        truncation: true,
        max_length: options.maxLength,
      });

      const vector = output.data;
      if (vector.length !== options.dimension) {
        throw new Error(`Expected ${options.dimension}-dim, got ${vector.length}-dim`);
      }

      cache.set(modelInput, vector);
      return vector;
    },
  };
}
