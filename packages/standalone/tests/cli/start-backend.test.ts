import { describe, expect, it } from 'vitest';

import { requireRuntimeBackend } from '../../src/cli/commands/start.js';

describe('start backend selection', () => {
  it('rejects unknown backends instead of silently running Claude', () => {
    expect(requireRuntimeBackend('codex')).toBe('codex');
    expect(requireRuntimeBackend('claude')).toBe('claude');
    expect(requireRuntimeBackend('cline')).toBe('cline');
    expect(() => requireRuntimeBackend('unknown')).toThrow('Unsupported agent backend');
  });

  it('allows Cline Hub sessions to run the conductor while retaining the Codex lifecycle gate', async () => {
    const startModule = (await import('../../src/cli/commands/start.js')) as Record<
      string,
      unknown
    >;
    const assertConductorBackendSupported = startModule.assertConductorBackendSupported as (
      enabled: boolean,
      backend: 'claude' | 'codex' | 'cline'
    ) => void;

    expect(() => assertConductorBackendSupported(true, 'cline')).not.toThrow();
    expect(() => assertConductorBackendSupported(true, 'codex')).toThrow(
      'conductor.enabled requires the claude or cline backend'
    );
  });
});
