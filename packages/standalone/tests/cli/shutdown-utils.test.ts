import { describe, expect, it, vi } from 'vitest';

import { stopAgentLoops } from '../../src/cli/shutdown-utils.js';

describe('stopAgentLoops', () => {
  it('stops all provided loops including secondary loops', async () => {
    const mainLoop = { stop: vi.fn().mockResolvedValue(undefined) };
    const memoryLoop = { stop: vi.fn().mockResolvedValue(undefined) };

    await stopAgentLoops([mainLoop, memoryLoop]);

    expect(mainLoop.stop).toHaveBeenCalledTimes(1);
    expect(memoryLoop.stop).toHaveBeenCalledTimes(1);
  });

  it('ignores nullish loops', async () => {
    const mainLoop = { stop: vi.fn().mockResolvedValue(undefined) };

    await stopAgentLoops([mainLoop, null, undefined]);

    expect(mainLoop.stop).toHaveBeenCalledTimes(1);
  });
});
