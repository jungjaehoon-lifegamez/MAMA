import { describe, it, expect } from 'vitest';
import { envelopeExpired } from '../../src/envelope/run-guard.js';
import { AgentLoop } from '../../src/agent/agent-loop.js';

describe('Story BOUNDARY-4: envelope run guard', () => {
  describe('AC #1: envelopeExpired is fail-closed with margin support', () => {
    const base = Date.parse('2026-07-16T00:00:00Z');
    const env = { expires_at: '2026-07-16T00:05:00Z' };

    it('false while valid', () => {
      expect(envelopeExpired(env, base)).toBe(false);
    });

    it('true once expires_at has passed', () => {
      expect(envelopeExpired(env, base + 5 * 60_000 + 1)).toBe(true);
    });

    it('true within the safety margin before expiry', () => {
      expect(envelopeExpired(env, base + 5 * 60_000 - 10_000, 30_000)).toBe(true);
    });

    it('treats unparseable expires_at as expired (fail loud, never permissive)', () => {
      expect(envelopeExpired({ expires_at: 'not-a-timestamp' }, base)).toBe(true);
    });
  });

  describe('AC #2: expired envelopes abort operator runs and never abort chat', () => {
    const expiredEnvelope = { expires_at: '2020-01-01T00:00:00Z', instance_id: 'env-test' };

    const makeLoop = (): AgentLoop => {
      const loop = new AgentLoop({} as never, { toolsConfig: { gateway: ['*'], mcp: [] } });
      (loop as unknown as { agent: unknown }).agent = {
        // usage is REQUIRED: agent-loop.ts:1271 reads response.usage.input_tokens
        // unconditionally - omitting it TypeErrors the chat-lane test.
        prompt: async () => ({
          response: 'hi',
          toolUseBlocks: [],
          usage: { input_tokens: 0, output_tokens: 0 },
        }),
      };
      return loop;
    };

    // modelRunId is REQUIRED in the options: shouldBeginModelRun (agent-loop.ts:1497)
    // is true for gateway mode without one, and beginRuntimeModelRun would then hit
    // initializeMAMAApi -> initDB() against the developer's REAL default DB
    // (~/.claude/mama-memory.db). Passing a modelRunId short-circuits that path.
    it('aborts an operator-lane run with ENVELOPE_EXPIRED', async () => {
      await expect(
        makeLoop().runWithContent([{ type: 'text', text: 'gather' }], {
          source: 'operator',
          channelId: 'report',
          modelRunId: 'test-run',
          envelope: expiredEnvelope as never,
        })
      ).rejects.toMatchObject({ code: 'ENVELOPE_EXPIRED' });
    });

    it('does NOT abort an interactive chat run (logs loudly instead)', async () => {
      const result = await makeLoop().runWithContent([{ type: 'text', text: 'hi' }], {
        source: 'telegram',
        channelId: 'chat-1',
        modelRunId: 'test-run',
        envelope: expiredEnvelope as never,
      });
      expect(result.response).toBe('hi');
    });
  });
});
