import { describe, it, expect } from 'vitest';
import { execute } from '../../src/tools/profile.js';

describe('mama_profile v2', () => {
  it('should return static, dynamic, and evidence fields', async () => {
    const result = await execute({ limit: 10 });
    expect(result.success).toBe(true);
    expect(result.profile).toHaveProperty('static');
    expect(result.profile).toHaveProperty('dynamic');
    expect(result.profile).toHaveProperty('evidence');
  });
});
