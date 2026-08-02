import { describe, expect, it } from 'vitest';

import type { MAMAConfig } from '../../../src/cli/config/types.js';
import {
  createCronBackendRunner,
  shouldStartClaudeTokenKeepAlive,
} from '../../../src/cli/runtime/scheduler-init.js';
import type { IModelRunner } from '../../../src/agent/model-runner.js';
import { vi } from 'vitest';

function runner(): IModelRunner {
  return {
    backendType: 'codex',
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

describe('TG-06: scheduler backend services', () => {
  it.each([
    ['claude', true],
    ['codex', false],
    ['cline', false],
  ] as const)('starts Claude token keepalive for %s: %s', (backend, expected) => {
    const config = { agent: { backend } } as MAMAConfig;
    expect(shouldStartClaudeTokenKeepAlive(config)).toBe(expected);
  });

  it('projects the production Codex cron runner to an exact bridge under read-only native access', () => {
    const createCodex = vi.fn(() => runner());
    createCronBackendRunner(
      {
        agent: { backend: 'codex', model: 'gpt-5.4', max_turns: 1, timeout: 1_000 },
      } as MAMAConfig,
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

  it('uses actual Cline Hub tool names in the cron system prompt', () => {
    const createCline = vi.fn(() => runner());
    createCronBackendRunner(
      {
        agent: {
          backend: 'cline',
          model: 'deepseek/deepseek-v4-flash',
          max_turns: 1,
          timeout: 1_000,
        },
      } as MAMAConfig,
      { createCline }
    );
    expect(createCline).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining('run_commands, read_files'),
        allowedTools: ['run_commands', 'read_files', 'apply_patch', 'editor', 'search_codebase'],
      })
    );
  });
});
