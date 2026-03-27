import { describe, it, expect, vi } from 'vitest';
import { PersistentCLIAdapter } from '../../src/agent/persistent-cli-adapter.js';

describe('PersistentCLIAdapter tool restrictions', () => {
  it('should forward per-request allowed/disallowed tools to the process pool', async () => {
    const adapter = new PersistentCLIAdapter({ sessionId: 'telegram:7026976631' });
    const getProcess = vi.fn().mockResolvedValue({
      sendMessage: vi.fn().mockResolvedValue({
        response: 'ok',
        usage: { input_tokens: 1, output_tokens: 1 },
        session_id: 'test-session',
        toolUseBlocks: [],
      }),
    });

    (adapter as unknown as { processPool: { getProcess: typeof getProcess } }).processPool = {
      getProcess,
    };

    await adapter.prompt('hello', undefined, {
      allowedTools: ['mama_search', 'Read', 'telegram_send'],
      disallowedTools: ['Bash', 'Write'],
    });

    expect(getProcess).toHaveBeenCalledWith(
      'telegram:7026976631',
      expect.objectContaining({
        allowedTools: ['mama_search', 'Read', 'telegram_send'],
        disallowedTools: ['Bash', 'Write'],
      })
    );
  });
});
