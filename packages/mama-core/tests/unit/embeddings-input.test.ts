import { describe, expect, it } from 'vitest';

import { EMBEDDING_MAX_TOKENISH_SEGMENTS, prepareEmbeddingText } from '../../src/embeddings.js';

describe('STORY-M1.4: Embedding input limits - AC1', () => {
  it('keeps short embedding text unchanged', () => {
    expect(prepareEmbeddingText('short memory text')).toBe('short memory text');
  });

  it('truncates long segmented embedding text before model inference', () => {
    const input = Array.from(
      { length: EMBEDDING_MAX_TOKENISH_SEGMENTS + 80 },
      (_, index) => `token${index}`
    ).join(' ');
    const prepared = prepareEmbeddingText(input);

    expect(prepared.split(/\s+/)).toHaveLength(EMBEDDING_MAX_TOKENISH_SEGMENTS);
  });
});
