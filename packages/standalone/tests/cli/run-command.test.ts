import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  stop: vi.fn<() => Promise<void>>(),
  resolveCline: vi.fn(() => '/resolved/cline'),
}));

vi.mock('../../src/cli/config/config-manager.js', () => ({
  configExists: vi.fn(() => true),
  initConfig: vi.fn(async () => ({
    agent: {
      backend: 'cline',
      model: 'deepseek/deepseek-v4-flash',
      timeout: 1_000,
      max_turns: 2,
      tools: { gateway: [], mcp: [] },
      cline_command: '/configured/cline',
      cline_provider: 'cline',
    },
  })),
}));

vi.mock('../../src/auth/index.js', () => ({
  OAuthManager: class OAuthManager {},
  getClaudeCodeAuthStatus: vi.fn(),
}));

vi.mock('../../src/cli/runtime/utilities.js', () => ({
  resolveClineCommandForStartup: mocks.resolveCline,
}));

vi.mock('../../src/agent/index.js', () => ({
  AgentLoop: class AgentLoop {
    constructor(_oauth: unknown, options: Record<string, unknown>) {
      mocks.options.push(options);
    }

    async run() {
      return {
        response: 'cline response',
        turns: 1,
        totalUsage: { input_tokens: 1, output_tokens: 1 },
      };
    }

    async stop() {
      await mocks.stop();
    }
  },
}));

import { runCommand } from '../../src/cli/commands/run.js';

describe('TG-03/TG-04: mama run Cline backend', () => {
  const originalCommand = process.env.MAMA_CLINE_COMMAND;

  afterEach(() => {
    vi.restoreAllMocks();
    mocks.options.length = 0;
    mocks.stop.mockReset();
    mocks.resolveCline.mockClear();
    if (originalCommand === undefined) delete process.env.MAMA_CLINE_COMMAND;
    else process.env.MAMA_CLINE_COMMAND = originalCommand;
  });

  it('resolves Cline, constructs the equivalent runtime, runs, and awaits stop', async () => {
    let releaseStop = () => {};
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    mocks.stop.mockImplementation(async () => await stopGate);
    const running = runCommand({ prompt: 'hello' });

    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledTimes(1));
    let finished = false;
    void running.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(mocks.resolveCline).toHaveBeenCalledWith('/configured/cline');
    expect(process.env.MAMA_CLINE_COMMAND).toBe('/resolved/cline');
    expect(mocks.options[0]).toMatchObject({
      backend: 'cline',
      model: 'deepseek/deepseek-v4-flash',
      useCodeAct: true,
      clineCommand: '/resolved/cline',
      clineProvider: 'cline',
    });

    releaseStop();
    await running;
    expect(finished).toBe(true);
  });
});
