import { describe, expect, it } from 'vitest';
import { resolveEmbeddingRole } from '../../src/embedding-server/index.js';

describe('M5: HTTP embed role resolution (backward compatible)', () => {
  it('absent role defaults to passage', () => {
    expect(resolveEmbeddingRole(undefined)).toBe('passage');
  });
  it('explicit query is honored', () => {
    expect(resolveEmbeddingRole('query')).toBe('query');
  });
  it('unknown value falls back to passage', () => {
    expect(resolveEmbeddingRole('garbage')).toBe('passage');
  });
});
