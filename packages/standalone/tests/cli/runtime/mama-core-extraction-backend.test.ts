import { describe, expect, it, vi } from 'vitest';

import type { IModelRunner } from '../../../src/agent/model-runner.js';
import { createBackendExtractionSession } from '../../../src/cli/runtime/mama-core-init.js';

function clineRunner(): IModelRunner {
  return {
    backendType: 'cline',
    prompt: vi.fn().mockResolvedValue({ response: '{"memories":[]}', usage: {} }),
    setSessionId: vi.fn(),
    setSystemPrompt: vi.fn(),
    isHealthy: vi.fn(() => true),
    getMetrics: vi.fn(() => ({
      requestCount: 0,
      failureCount: 0,
      avgLatencyMs: 0,
      lastRequestAt: null,
    })),
    stop: vi.fn(),
  };
}

describe('TG-03/TG-04: conversation extraction backend', () => {
  it('uses and stops the injected Cline runner without constructing Claude', async () => {
    const runner = clineRunner();
    const createRunner = vi.fn(() => runner);
    const session = createBackendExtractionSession(createRunner, JSON.parse);

    await expect(session.extractParsed('extract')).resolves.toEqual({ memories: [] });
    await expect(session.extractRaw('raw')).resolves.toBe('{"memories":[]}');
    expect(createRunner).toHaveBeenCalledOnce();
    expect(runner.prompt).toHaveBeenCalledTimes(2);

    await session.stop();
    expect(runner.stop).toHaveBeenCalledOnce();
  });

  it('awaits one idempotent backend stop and rejects extraction after shutdown starts', async () => {
    let releaseStop!: () => void;
    const runner = clineRunner();
    vi.mocked(runner.stop).mockImplementation(
      () => new Promise<void>((resolve) => (releaseStop = resolve))
    );
    const session = createBackendExtractionSession(() => runner, JSON.parse);
    await session.extractRaw('prime');

    const firstStop = session.stop();
    const secondStop = session.stop();
    await expect(session.extractRaw('late')).rejects.toThrow('stopping');
    expect(runner.stop).toHaveBeenCalledOnce();
    releaseStop();
    await Promise.all([firstStop, secondStop]);
  });
});
