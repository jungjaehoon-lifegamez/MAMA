import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/cli/config/types.js';
import { resolveConductorConfig } from '../../src/cli/commands/start.js';

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

  it('a partial user config inherits every unspecified default', () => {
    // The documented enable path is `{"conductor": {"enabled": true}}` - it
    // must not zero out the budgets.
    const resolved = resolveConductorConfig({ conductor: { enabled: true } as never });
    expect(resolved).toEqual({ ...DEFAULT_CONFIG.conductor!, enabled: true });
  });

  it('no conductor block at all resolves to the defaults', () => {
    expect(resolveConductorConfig({})).toEqual(DEFAULT_CONFIG.conductor);
  });

  it('rejects a hot-loop tickMs loudly instead of spinning the event loop', () => {
    expect(() => resolveConductorConfig({ conductor: { tickMs: 0 } as never })).toThrow(
      /conductor\.tickMs/
    );
    expect(() => resolveConductorConfig({ conductor: { tickMs: Number.NaN } as never })).toThrow(
      /conductor\.tickMs/
    );
  });

  it('rejects non-positive budgets loudly', () => {
    expect(() => resolveConductorConfig({ conductor: { maxTurns: 0 } as never })).toThrow(
      /conductor\.maxTurns/
    );
    expect(() => resolveConductorConfig({ conductor: { maxTokens: -1 } as never })).toThrow(
      /conductor\.maxTokens/
    );
  });
});
