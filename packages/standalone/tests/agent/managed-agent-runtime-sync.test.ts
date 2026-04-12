import { describe, it, expect, vi } from 'vitest';
import { createManagedAgentRuntime } from '../../src/agent/managed-agent-runtime-sync.js';

describe('managed-agent-runtime-sync', () => {
  it('serializes concurrent config mutations so no agent config is lost', async () => {
    let persistedConfig: Record<string, unknown> = {
      multi_agent: { enabled: true, agents: {} },
    };

    const loadConfig = vi.fn(async () => JSON.parse(JSON.stringify(persistedConfig)));
    const saveConfig = vi.fn(async (config: Record<string, unknown>) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      persistedConfig = config;
    });

    await Promise.all([
      createManagedAgentRuntime(
        { id: 'alpha', name: 'Alpha', model: 'sonnet', tier: 1 },
        {
          loadConfig,
          saveConfig,
          writePersonaFile: vi.fn(),
        }
      ),
      createManagedAgentRuntime(
        { id: 'beta', name: 'Beta', model: 'sonnet', tier: 1 },
        {
          loadConfig,
          saveConfig,
          writePersonaFile: vi.fn(),
        }
      ),
    ]);

    const agents = ((persistedConfig.multi_agent as Record<string, unknown>).agents ??
      {}) as Record<string, unknown>;
    expect(Object.keys(agents).sort()).toEqual(['alpha', 'beta']);
  });
});
