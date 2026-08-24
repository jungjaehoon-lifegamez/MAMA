import { describe, expect, it, vi } from 'vitest';

import type { MAMAConfig } from '../../src/cli/config/types.js';
import type { IModelRunner } from '../../src/agent/model-runner.js';
import { createBackendModelRunner } from '../../src/agent/backend-model-runner-factory.js';

function config(backend: 'claude' | 'codex' | 'cline'): MAMAConfig {
  return {
    version: '1',
    agent: {
      backend,
      model: backend === 'cline' ? 'deepseek/deepseek-v4-flash' : 'test-model',
      max_turns: 10,
      timeout: 1_000,
      cline_command: '/test/cline',
      cline_provider: 'cline',
      cline_data_dir: '/test/cline-data',
      tools: { gateway: [], mcp: [] },
    },
    database: { path: '/test/mama.db' },
  } as MAMAConfig;
}

function runner(backendType: IModelRunner['backendType']): IModelRunner {
  return {
    backendType,
    prompt: vi.fn(),
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

describe('TG-03/TG-04/TG-06: backend model runner factory', () => {
  it.each(['claude', 'codex', 'cline'] as const)(
    'constructs the configured %s backend without consulting another provider',
    (backend) => {
      const expected = runner(backend);
      const createClaude = vi.fn(() => runner('claude'));
      const createCodex = vi.fn(() => runner('codex'));
      const createCline = vi.fn(() => runner('cline'));
      if (backend === 'claude') createClaude.mockReturnValue(expected);
      if (backend === 'codex') createCodex.mockReturnValue(expected);
      if (backend === 'cline') createCline.mockReturnValue(expected);

      const actual = createBackendModelRunner(
        config(backend),
        {
          sessionId: 'test',
          systemPrompt: 'system',
          allowedTools: ['Read'],
        },
        { createClaude, createCodex, createCline }
      );

      expect(actual).toBe(expected);
      expect(createClaude).toHaveBeenCalledTimes(backend === 'claude' ? 1 : 0);
      expect(createCodex).toHaveBeenCalledTimes(backend === 'codex' ? 1 : 0);
      expect(createCline).toHaveBeenCalledTimes(backend === 'cline' ? 1 : 0);
      if (backend === 'cline') {
        expect(createCline).toHaveBeenCalledWith(
          expect.objectContaining({ allowedTools: ['read_files'] })
        );
      }
      if (backend === 'codex') {
        expect(createCodex).toHaveBeenCalledWith(
          expect.objectContaining({
            sandbox: 'read-only',
            auxiliaryToolPolicy: expect.objectContaining({ allowedTools: ['Read'] }),
          })
        );
      }
    }
  );

  it('projects Codex setup/cron tools to an exact bridge under a read-only native sandbox', () => {
    const createCodex = vi.fn(() => runner('codex'));
    createBackendModelRunner(
      config('codex'),
      { allowedTools: ['Bash', 'Read', 'Write', 'Glob', 'Grep'] },
      { createCodex }
    );
    expect(createCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        sandbox: 'read-only',
        auxiliaryToolPolicy: expect.objectContaining({
          allowedTools: ['Bash', 'Read', 'Write', 'Glob', 'Grep'],
        }),
      })
    );
  });

  it('fails closed for a Codex tool policy the sandbox cannot represent', () => {
    expect(() =>
      createBackendModelRunner(config('codex'), { allowedTools: ['WebSearch'] })
    ).toThrow('Unsupported Codex auxiliary tool policy');
  });

  it.each(['claude', 'codex', 'cline'] as const)(
    'disables native setup tools for the %s backend',
    (backend) => {
      const createClaude = vi.fn(() => runner('claude'));
      const createCodex = vi.fn(() => runner('codex'));
      const createCline = vi.fn(() => runner('cline'));

      createBackendModelRunner(
        config(backend),
        { allowedTools: [], disableNativeTools: true },
        { createClaude, createCodex, createCline }
      );

      if (backend === 'claude') {
        expect(createClaude).toHaveBeenCalledWith(expect.objectContaining({ tools: '' }));
      } else if (backend === 'codex') {
        expect(createCodex).toHaveBeenCalledWith(
          expect.objectContaining({
            auxiliaryToolPolicy: expect.objectContaining({ allowedTools: [] }),
          })
        );
      } else {
        expect(createCline).toHaveBeenCalledWith(expect.objectContaining({ allowedTools: [] }));
      }
    }
  );

  it('threads the global agent.effort into the codex runner so every managed-config writer agrees', () => {
    const createCodex = vi.fn(() => runner('codex'));
    const configured = config('codex');
    configured.agent.effort = 'xhigh';

    createBackendModelRunner(configured, { allowedTools: ['Read'] }, { createCodex });

    expect(createCodex).toHaveBeenCalledWith(expect.objectContaining({ effort: 'xhigh' }));
  });

  it('leaves the codex runner effort unset when config omits it', () => {
    const createCodex = vi.fn(() => runner('codex'));

    createBackendModelRunner(config('codex'), { allowedTools: ['Read'] }, { createCodex });

    expect(createCodex.mock.calls[0][0]).toMatchObject({ effort: undefined });
  });
});
