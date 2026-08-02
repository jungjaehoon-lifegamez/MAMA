import { describe, expect, it } from 'vitest';

import { shouldUseClaudeImagePreanalysis } from '../../src/gateways/image-analyzer.js';

describe('TG-03/TG-04: inbound image backend routing', () => {
  it.each([
    ['claude', true],
    ['codex', false],
    ['cline', false],
  ] as const)('uses Claude vision preanalysis for %s: %s', (backend, expected) => {
    expect(shouldUseClaudeImagePreanalysis(backend)).toBe(expected);
  });
});
