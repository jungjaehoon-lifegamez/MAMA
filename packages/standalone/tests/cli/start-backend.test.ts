import { describe, expect, it } from 'vitest';

import { requireRuntimeBackend } from '../../src/cli/commands/start.js';

describe('start backend selection', () => {
  it('rejects unknown backends instead of silently running Claude', () => {
    expect(requireRuntimeBackend('codex')).toBe('codex');
    expect(requireRuntimeBackend('claude')).toBe('claude');
    expect(() => requireRuntimeBackend('unknown')).toThrow('Unsupported agent backend');
  });
});
