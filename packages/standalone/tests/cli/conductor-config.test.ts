import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/cli/config/types.js';

describe('conductor config', () => {
  it('exists, default-off, with lifecycle budgets', () => {
    expect(DEFAULT_CONFIG.conductor).toEqual({
      enabled: false,
      tickMs: 30_000,
      maxAgeMs: 21_600_000,
      maxTurns: 400,
      maxTokens: 150_000,
    });
  });
});
