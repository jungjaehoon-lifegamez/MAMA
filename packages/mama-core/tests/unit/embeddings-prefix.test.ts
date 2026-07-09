import { afterEach, describe, expect, it, vi } from 'vitest';

const captured: string[] = [];

function mockPipeline(dim: number) {
  vi.doMock('@huggingface/transformers', () => ({
    env: {},
    pipeline: async () => async (text: string | string[]) => {
      const list = Array.isArray(text) ? text : [text];
      for (const t of list) captured.push(t);
      const data = new Float32Array(dim * list.length).fill(0.01);
      return { data };
    },
  }));
}

afterEach(() => {
  vi.doUnmock('@huggingface/transformers');
  vi.resetModules();
  captured.length = 0;
});

describe('M5: e5 role prefixes', () => {
  it('prepends "passage: " by default and "query: " on request', async () => {
    mockPipeline(1024);
    const mod = await import('../../src/embeddings.js');
    mod.embeddingCache.clear();
    await mod.generateEmbedding('hello world'); // default
    await mod.generateEmbedding('hello world', 'query'); // query
    expect(captured).toContain('passage: hello world');
    expect(captured).toContain('query: hello world');
  });

  it('cache is role-aware: same text, different roles -> two model calls', async () => {
    mockPipeline(1024);
    const mod = await import('../../src/embeddings.js');
    mod.embeddingCache.clear();
    await mod.generateEmbedding('same text', 'passage');
    await mod.generateEmbedding('same text', 'query');
    await mod.generateEmbedding('same text', 'passage'); // cache hit, no new call
    expect(captured).toEqual(['passage: same text', 'query: same text']);
  });

  it('generateEnhancedEmbedding forwards role to the model input', async () => {
    mockPipeline(1024);
    const mod = await import('../../src/embeddings.js');
    mod.embeddingCache.clear();
    await mod.generateEnhancedEmbedding({ topic: 't', decision: 'd' }, 'passage');
    expect(captured.some((c) => c.startsWith('passage: Topic: t'))).toBe(true);
  });

  it('batch prefixes every text', async () => {
    mockPipeline(1024);
    const mod = await import('../../src/embeddings.js');
    mod.embeddingCache.clear();
    await mod.generateBatchEmbeddings(['a', 'b'], 'query');
    expect(captured).toEqual(['query: a', 'query: b']);
  });
});
