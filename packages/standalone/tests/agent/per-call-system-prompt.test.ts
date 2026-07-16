// packages/standalone/tests/agent/per-call-system-prompt.test.ts
import { describe, it, expect, vi } from 'vitest';
import { PersistentCLIAdapter } from '../../src/agent/persistent-cli-adapter.js';

const stubPool = (adapter: PersistentCLIAdapter) => {
  const getProcess = vi.fn().mockResolvedValue({
    isAlive: () => true,
    sendMessage: vi.fn().mockResolvedValue({ response: 'ok', toolUseBlocks: [] }),
  });
  (adapter as unknown as { processPool: { getProcess: unknown } }).processPool = {
    getProcess,
  };
  return getProcess;
};

describe('Story BOUNDARY-3: per-call system prompt', () => {
  describe('AC #1: systemPrompt travels per prompt() call without mutating shared adapter state', () => {
    it('routes options.systemPrompt to getProcess for this call only', async () => {
      const adapter = new PersistentCLIAdapter({ systemPrompt: 'SPAWN-DEFAULT' });
      const getProcess = stubPool(adapter);

      await adapter.prompt('hello', undefined, {
        systemPrompt: 'PER-CALL-PROMPT',
      });

      expect(getProcess).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ systemPrompt: 'PER-CALL-PROMPT' })
      );
      expect(adapter.getOptions().systemPrompt).toBe('SPAWN-DEFAULT');
    });

    it('falls back to the constructor systemPrompt when no per-call value given', async () => {
      const adapter = new PersistentCLIAdapter({ systemPrompt: 'SPAWN-DEFAULT' });
      const getProcess = stubPool(adapter);

      await adapter.prompt('hello');

      expect(getProcess).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ systemPrompt: 'SPAWN-DEFAULT' })
      );
    });
  });
});
