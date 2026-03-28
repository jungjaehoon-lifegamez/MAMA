import { describe, expect, it, vi } from 'vitest';

import { stopAgentLoops } from '../../src/cli/shutdown-utils.js';

describe('Story: stopAgentLoops', () => {
  describe('AC #1: stops all provided loops', () => {
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

  describe('AC #2: continues when one stop fails', () => {
    it('continues stopping other loops when one stop rejects', async () => {
      const badLoop = { stop: vi.fn().mockRejectedValue(new Error('boom')) };
      const goodLoop = { stop: vi.fn().mockResolvedValue(undefined) };

      await expect(stopAgentLoops([badLoop, goodLoop])).resolves.toBeUndefined();

      expect(badLoop.stop).toHaveBeenCalledTimes(1);
      expect(goodLoop.stop).toHaveBeenCalledTimes(1);
    });
  });
});
