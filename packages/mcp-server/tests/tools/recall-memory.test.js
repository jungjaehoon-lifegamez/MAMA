import { describe, it, expect } from 'vitest';
import { execute } from '../../src/tools/recall-memory.js';

describe('mama_recall tool', () => {
  it('should return a recall bundle shape', async () => {
    const result = await execute({ query: 'auth', limit: 5 });
    expect(result).toHaveProperty('success');
  });
});
