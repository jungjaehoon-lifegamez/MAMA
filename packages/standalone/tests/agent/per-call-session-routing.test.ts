import { describe, it, expect, vi } from 'vitest';
import { PersistentCLIAdapter } from '../../src/agent/persistent-cli-adapter.js';

const makeProcess = () => ({
  isAlive: () => true,
  sendMessage: vi.fn().mockResolvedValue({
    response: 'ok',
    toolUseBlocks: [],
    usage: { input_tokens: 0, output_tokens: 0 },
  }),
});

describe('per-call session routing (no shared mutation)', () => {
  it('routes concurrent prompts to their own sessions without cross-talk', async () => {
    const adapter = new PersistentCLIAdapter({ sessionId: 'constructor-key' });
    const processes = new Map<string, ReturnType<typeof makeProcess>>();
    const getProcess = vi.fn(async (key: string) => {
      if (!processes.has(key)) processes.set(key, makeProcess());
      return processes.get(key)!;
    });
    (adapter as unknown as { processPool: { getProcess: unknown } }).processPool = {
      getProcess,
    };

    await Promise.all([
      adapter.prompt('for-A', undefined, { sessionId: 'session-A' } as never),
      adapter.prompt('for-B', undefined, { sessionId: 'session-B' } as never),
    ]);

    expect(processes.get('session-A')!.sendMessage).toHaveBeenCalledWith('for-A', undefined);
    expect(processes.get('session-B')!.sendMessage).toHaveBeenCalledWith('for-B', undefined);
    // Shared adapter state must be untouched by per-call routing.
    expect(adapter.getOptions().sessionId).toBe('constructor-key');
  });

  it('falls back to the constructor channel key when no per-call sessionId given', async () => {
    const adapter = new PersistentCLIAdapter({ sessionId: 'constructor-key' });
    const getProcess = vi.fn().mockResolvedValue(makeProcess());
    (adapter as unknown as { processPool: { getProcess: unknown } }).processPool = {
      getProcess,
    };
    await adapter.prompt('hello');
    expect(getProcess).toHaveBeenCalledWith('constructor-key', expect.any(Object));
  });
});
