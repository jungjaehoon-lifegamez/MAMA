import { describe, expect, it, vi } from 'vitest';

import type { IModelRunner } from '../../src/agent/model-runner.js';
import type { MAMAConfig } from '../../src/cli/config/types.js';
import { createSetupModelRunner } from '../../src/setup/setup-websocket.js';

describe('TG-03/TG-04: setup model runner', () => {
  it('passes the restricted setup tool policy to the configured backend factory', () => {
    const expected = { backendType: 'codex' } as IModelRunner;
    const createRunner = vi.fn(() => expected);
    const config = {
      agent: { backend: 'codex', model: 'gpt-5.4', max_turns: 1, timeout: 1_000 },
    } as MAMAConfig;

    expect(createSetupModelRunner(config, 'setup-1', createRunner)).toBe(expected);
    expect(createRunner).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        sessionId: 'setup-1',
        allowedTools: [],
        disableNativeTools: true,
        systemPrompt: expect.stringContaining('MAMA Setup Host Actions'),
      })
    );
  });
});
