/**
 * Story ID: V19-Managed-Agent-Runtime-Sync
 * Acceptance Criteria:
 * - Concurrent config writes are serialized.
 * - Updating persona text without persona_file uses a safe default persona path.
 * - Gateway tool permission updates are preserved in runtime config.
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

  it('preserves the codex backend when creating agents', async () => {
    const persistedConfig: Record<string, unknown> = {
      multi_agent: { enabled: true, agents: {} },
    };
    const saveConfig = vi.fn(async (config: Record<string, unknown>) => {
      Object.assign(persistedConfig, config);
    });

    const codex = await createManagedAgentRuntime(
      { id: 'codex', name: 'Codex', model: 'gpt-5.4-mini', tier: 1, backend: 'codex' },
      {
        loadConfig: vi.fn().mockResolvedValue(persistedConfig),
        saveConfig,
        writePersonaFile: vi.fn(),
      }
    );
    const codexRuntime = await createManagedAgentRuntime(
      {
        id: 'codex-secondary',
        name: 'Codex Secondary',
        model: 'gpt-5.3-codex',
        tier: 1,
        backend: 'codex',
      },
      {
        loadConfig: vi.fn().mockResolvedValue(persistedConfig),
        saveConfig,
        writePersonaFile: vi.fn(),
      }
    );

    expect(codex.snapshot.backend).toBe('codex');
    expect(codexRuntime.snapshot.backend).toBe('codex');
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

  it('preserves gateway tool permission changes in agent config updates', async () => {
    const config = {
      multi_agent: {
        enabled: true,
        agents: {
          alpha: {
            name: 'Alpha',
            display_name: 'Alpha',
            trigger_prefix: '!alpha',
            tier: 2,
          },
        },
      },
    };

    const result = await updateManagedAgentRuntime(
      {
        agentId: 'alpha',
        changes: {
          gateway_tool_permissions: {
            allowed: ['mama_search'],
            blocked: ['mama_save'],
          },
        },
      },
      {
        loadConfig: vi.fn().mockResolvedValue(config),
        saveConfig: vi.fn().mockResolvedValue(undefined),
        writePersonaFile: vi.fn(),
      }
    );

    expect(result.snapshot).toMatchObject({
      gateway_tool_permissions: {
        allowed: ['mama_search'],
        blocked: ['mama_save'],
      },
    });
  });
});
