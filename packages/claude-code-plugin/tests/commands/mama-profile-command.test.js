import { describe, it, expect } from 'vitest';
import { mamaProfileCommand } from '../../src/commands/mama-profile.js';

describe('/mama-profile', () => {
  it('should return static, dynamic, and evidence sections', async () => {
    const result = await mamaProfileCommand({});

    expect(result.success).toBe(true);
    expect(result.message).toContain('Static Profile');
    expect(result.message).toContain('Dynamic Profile');
    expect(result.message).toContain('Evidence');
  });
});
