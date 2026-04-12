/**
 * Story ID: V19-Managed-Agent-Runtime-Sync
 * Acceptance Criteria:
 * - Concurrent config writes are serialized.
 * - Updating persona text without persona_file uses a safe default persona path.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createManagedAgentRuntime,
  updateManagedAgentRuntime,
} from '../../src/agent/managed-agent-runtime-sync.js';

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

  it('uses a default persona path when updating system text without persona_file', async () => {
    const config = {
      multi_agent: {
        enabled: true,
        agents: {
          alpha: {
            name: 'Alpha',
            display_name: 'Alpha',
            trigger_prefix: '!alpha',
            tier: 1,
          },
        },
      },
    };
    const writePersonaFile = vi.fn();

    const result = await updateManagedAgentRuntime(
      {
        agentId: 'alpha',
        changes: { system: 'Updated persona' },
      },
      {
        loadConfig: vi.fn().mockResolvedValue(config),
        saveConfig: vi.fn().mockResolvedValue(undefined),
        writePersonaFile,
      }
    );

    expect(result.snapshot).toMatchObject({
      persona_file: '~/.mama/personas/alpha.md',
    });
    expect(writePersonaFile).toHaveBeenCalledWith('~/.mama/personas/alpha.md', 'Updated persona');
  });
});
