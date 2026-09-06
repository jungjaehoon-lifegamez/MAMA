import { describe, expect, it } from 'vitest';

import type { MAMAConfig } from '../../../src/cli/config/types.js';
import { shouldStartClaudeTokenKeepAlive } from '../../../src/cli/runtime/scheduler-init.js';

describe('TG-06: scheduler backend services', () => {
  it.each([
    ['claude', true],
    ['codex', false],
    ['cline', false],
  ] as const)('starts Claude token keepalive for %s: %s', (backend, expected) => {
    const config = { agent: { backend } } as MAMAConfig;
    expect(shouldStartClaudeTokenKeepAlive(config)).toBe(expected);
  });
});
