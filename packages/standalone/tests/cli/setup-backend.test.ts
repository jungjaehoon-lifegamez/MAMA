import { describe, expect, it, vi } from 'vitest';

import type { MAMAConfig } from '../../src/cli/config/types.js';
import { checkSetupBackend } from '../../src/cli/commands/setup.js';

function config(backend: 'claude' | 'codex' | 'cline'): MAMAConfig {
  return {
    agent: {
      backend,
      model: 'test',
      max_turns: 1,
      timeout: 1_000,
      tools: {},
    },
  } as MAMAConfig;
}

describe('TG-03/TG-04: setup backend preflight', () => {
  it('checks Cline credentials without consulting Claude auth', async () => {
    const getClaudeStatus = vi.fn();
    const result = await checkSetupBackend(config('cline'), {
      getClaudeStatus,
      hasClineCredential: vi.fn().mockResolvedValue(true),
      exists: vi.fn(),
    });
    expect(result.ok).toBe(true);
    expect(getClaudeStatus).not.toHaveBeenCalled();
  });

  it('uses CLINE_COMMAND when no config or MAMA-specific command is set', async () => {
    const previousMama = process.env.MAMA_CLINE_COMMAND;
    const previousLegacy = process.env.CLINE_COMMAND;
    delete process.env.MAMA_CLINE_COMMAND;
    process.env.CLINE_COMMAND = '/opt/legacy/cline';
    const hasClineCredential = vi.fn().mockResolvedValue(true);
    try {
      await checkSetupBackend(config('cline'), {
        getClaudeStatus: vi.fn(),
        hasClineCredential,
        exists: vi.fn(),
      });
      expect(hasClineCredential).toHaveBeenCalledWith(
        expect.objectContaining({ command: '/opt/legacy/cline' })
      );
    } finally {
      if (previousMama === undefined) delete process.env.MAMA_CLINE_COMMAND;
      else process.env.MAMA_CLINE_COMMAND = previousMama;
      if (previousLegacy === undefined) delete process.env.CLINE_COMMAND;
      else process.env.CLINE_COMMAND = previousLegacy;
    }
  });

  it('checks Codex auth files without consulting Claude auth', async () => {
    const getClaudeStatus = vi.fn();
    const result = await checkSetupBackend(config('codex'), {
      getClaudeStatus,
      hasClineCredential: vi.fn(),
      exists: vi.fn(() => true),
    });
    expect(result.ok).toBe(true);
    expect(getClaudeStatus).not.toHaveBeenCalled();
  });
});
