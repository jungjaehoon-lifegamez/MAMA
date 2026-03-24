import { describe, it, expect } from 'vitest';
import { execute } from '../../src/tools/ingest-memory.js';

describe('mama_ingest tool', () => {
  it('should reject missing content', async () => {
    const result = await execute({});
    expect(result.success).toBe(false);
  });
});
