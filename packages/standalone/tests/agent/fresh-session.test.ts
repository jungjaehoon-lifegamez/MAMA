import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../src/agent/agent-loop.js';

describe('Story BOUNDARY-6: stateless reports/anchor', () => {
  describe('AC #1: freshSession resets the pool session instead of reusing it', () => {
    it('resets the pool session instead of reusing it', async () => {
      const loop = new AgentLoop({} as never, { toolsConfig: { gateway: ['*'], mcp: [] } });
      const resetSession = vi.fn().mockReturnValue('fresh-id');
      const getSession = vi
        .fn()
        .mockReturnValue({ sessionId: 'stale-id', isNew: false, busy: false });
      (loop as unknown as { sessionPool: unknown }).sessionPool = {
        resetSession,
        getSession,
        releaseSession: () => {},
        // Called unconditionally after every turn (agent-loop.ts:1293-1297) -
        // omitting it makes a CORRECT implementation fail this test.
        updateTokens: () => ({ totalTokens: 0, nearThreshold: false }),
      };
      (loop as unknown as { agent: unknown }).agent = {
        prompt: vi.fn().mockResolvedValue({
          response: 'ok',
          toolUseBlocks: [],
          usage: { input_tokens: 0, output_tokens: 0 },
        }),
      };

      await loop.runWithContent([{ type: 'text', text: 'report' }], {
        source: 'operator',
        channelId: 'report',
        modelRunId: 'test-run',
        freshSession: true,
      });

      expect(resetSession).toHaveBeenCalledTimes(1);
      expect(getSession).not.toHaveBeenCalled();
    });
  });
});
