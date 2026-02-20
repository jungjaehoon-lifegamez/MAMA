/**
 * Tests for AgentProcessManager env var propagation based on agent tier.
 *
 * Verifies that:
 * - Tier 1 agents get MAMA_HOOK_FEATURES='rules,agents' (keywords handled by native PromptEnhancer)
 * - Tier 2+ agents get MAMA_DISABLE_HOOKS='true'
 * - PersistentProcessPool path (single process per agent)
 * - Single-agent mode (PersistentCLIAdapter) gets MAMA_HOOK_FEATURES
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { ChildProcess } from 'child_process';
import type { AgentPersonaConfig, MultiAgentConfig } from '../../src/multi-agent/types.js';

// Track all spawn calls
let spawnCalls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];

// Mock child_process.spawn BEFORE importing modules that use it
vi.mock('child_process', () => {
  return {
    spawn: vi.fn(
      (command: string, args: string[], options: Record<string, unknown>): ChildProcess => {
        spawnCalls.push({ command, args, options });

        // Return a mock ChildProcess that won't actually run anything
        const mockProcess = {
          pid: 12345,
          killed: false,
          stdin: {
            writable: true,
            write: vi.fn((_data: string, cb?: (err?: Error) => void) => {
              if (cb) cb();
              return true;
            }),
            end: vi.fn(),
            on: vi.fn(),
          },
          stdout: {
            on: vi.fn(),
          },
          stderr: {
            on: vi.fn(),
          },
          on: vi.fn(),
          kill: vi.fn(),
        } as unknown as ChildProcess;

        return mockProcess;
      }
    ),
    execFile: vi.fn(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback?: (error: Error | null, stdout: string, stderr: string) => void
      ): ChildProcess => {
        if (typeof _options === 'function') {
          (_options as unknown as typeof callback)?.(null, '', '');
        } else if (callback) {
          callback(null, '', '');
        }

        return {
          pid: 12345,
          killed: false,
          stdin: null,
          stdout: null,
          stderr: null,
          on: vi.fn(),
          kill: vi.fn(),
        } as unknown as ChildProcess;
      }
    ),
    ChildProcess: vi.fn(),
  };
});

// Mock fs/promises and fs to prevent persona file loading errors
vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('# Test Persona\nYou are a test agent.'),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

// Now import modules that depend on mocked child_process
import { AgentProcessManager } from '../../src/multi-agent/agent-process-manager.js';
import { PersistentCLIAdapter } from '../../src/agent/persistent-cli-adapter.js';

/**
 * Helper: Create a minimal MultiAgentConfig
 */
function makeConfig(
  agents: Record<
    string,
    {
      tier?: 1 | 2 | 3;
      model?: string;
      can_delegate?: boolean;
      is_planning_agent?: boolean;
      isPlanningAgent?: boolean;
    }
  >
): MultiAgentConfig {
  const configAgents: MultiAgentConfig['agents'] = {};

  for (const [id, opts] of Object.entries(agents)) {
    configAgents[id] = {
      name: id,
      display_name: `🤖 ${id}`,
      trigger_prefix: `!${id}`,
      persona_file: `~/.mama/personas/${id}.md`,
      tier: opts.tier ?? 1,
      backend: 'claude',
      model: opts.model ?? 'claude-sonnet-4-6',
      can_delegate: opts.can_delegate,
      is_planning_agent: opts.is_planning_agent,
      isPlanningAgent: opts.isPlanningAgent,
      auto_respond_keywords: [],
    };
  }

  return {
    enabled: true,
    agents: configAgents,
    loop_prevention: {
      max_chain_length: 10,
      global_cooldown_ms: 2000,
      chain_window_ms: 60000,
    },
  };
}

/**
 * Extract the env from the most recent spawn call
 */
function getLastSpawnEnv(): Record<string, string> | undefined {
  if (spawnCalls.length === 0) return undefined;
  const lastCall = spawnCalls[spawnCalls.length - 1];
  return lastCall.options.env as Record<string, string> | undefined;
}

describe('AgentProcessManager env vars by tier', () => {
  /**
   * Story ID: MA-ENV-001
   * Acceptance Criteria:
   * - Tier 1 agents set MAMA_HOOK_FEATURES='rules,agents'.
   * - Tier 2+ agents set MAMA_DISABLE_HOOKS='true'.
   * - Pool size 1 and >1 paths are covered.
   * - Single-agent mode sets MAMA_HOOK_FEATURES.
   */
  let manager: AgentProcessManager;

  beforeAll(() => {
    process.env.MAMA_FORCE_TIER_3 = 'true';
  });

  beforeEach(() => {
    spawnCalls = [];
  });

  afterEach(() => {
    manager?.stopAll();
  });

  describe('env vars by tier', () => {
    it('should pass MAMA_HOOK_FEATURES for Tier 1 agent', async () => {
      const config = makeConfig({
        developer: { tier: 1 },
      });
      manager = new AgentProcessManager(config);

      await manager.getProcess('discord', 'channel-1', 'developer');

      const env = getLastSpawnEnv();
      expect(env).toBeDefined();
      expect(env!['MAMA_HOOK_FEATURES']).toBe('rules,agents');
      expect(env!['MAMA_DISABLE_HOOKS']).toBeUndefined();
    });

    it('should pass MAMA_DISABLE_HOOKS for Tier 2 agent', async () => {
      const config = makeConfig({
        reviewer: { tier: 2 },
      });
      manager = new AgentProcessManager(config);

      await manager.getProcess('discord', 'channel-1', 'reviewer');

      const env = getLastSpawnEnv();
      expect(env).toBeDefined();
      expect(env!['MAMA_DISABLE_HOOKS']).toBe('true');
      expect(env!['MAMA_HOOK_FEATURES']).toBeUndefined();
    });

    it('should pass MAMA_DISABLE_HOOKS for Tier 3 agent', async () => {
      const config = makeConfig({
        tester: { tier: 3 },
      });
      manager = new AgentProcessManager(config);

      await manager.getProcess('discord', 'channel-1', 'tester');

      const env = getLastSpawnEnv();
      expect(env).toBeDefined();
      expect(env!['MAMA_DISABLE_HOOKS']).toBe('true');
      expect(env!['MAMA_HOOK_FEATURES']).toBeUndefined();
    });
  });

  describe('default tier behavior', () => {
    it('should default to Tier 1 (MAMA_HOOK_FEATURES) when tier is not specified', async () => {
      // Agent without explicit tier → defaults to tier 1 in getProcess (line: agentConfig?.tier ?? 1)
      const config = makeConfig({
        agent_no_tier: {},
      });
      manager = new AgentProcessManager(config);

      await manager.getProcess('discord', 'channel-1', 'agent_no_tier');

      const env = getLastSpawnEnv();
      expect(env).toBeDefined();
      expect(env!['MAMA_HOOK_FEATURES']).toBe('rules,agents');
      expect(env!['MAMA_DISABLE_HOOKS']).toBeUndefined();
    });
  });

  describe('env vars include process.env', () => {
    it('should merge agent env with process.env', async () => {
      const config = makeConfig({
        developer: { tier: 1 },
      });
      manager = new AgentProcessManager(config);

      await manager.getProcess('discord', 'channel-1', 'developer');

      const env = getLastSpawnEnv();
      expect(env).toBeDefined();
      // Should contain process.env entries (at least PATH)
      expect(env!['PATH']).toBeDefined();
      // Plus agent-specific env
      expect(env!['MAMA_HOOK_FEATURES']).toBe('rules,agents');
    });
  });

  // Story: BMAD-SEL-001 — BMAD prompt block injection selection logic
  // AC: Conductor/planning agents get BMAD block; non-planning agents do not
  describe('BMAD prompt injection selector', () => {
    const selectBmadInjection = (
      agentId: string,
      agentConfig: Omit<AgentPersonaConfig, 'id'>
    ): boolean => {
      const selector = manager as unknown as {
        shouldInjectBmadBlock: (id: string, config: Omit<AgentPersonaConfig, 'id'>) => boolean;
      };
      return selector.shouldInjectBmadBlock(agentId, agentConfig);
    };

    it('should enable BMAD when is_planning_agent is true', () => {
      const config = makeConfig({
        planner: { tier: 2, is_planning_agent: true },
      });
      manager = new AgentProcessManager(config);

      expect(selectBmadInjection('planner', config.agents.planner)).toBe(true);
    });

    it('should disable BMAD when explicit planning flag is false', () => {
      const config = makeConfig({
        conductor: { tier: 1, can_delegate: true, is_planning_agent: false },
      });
      manager = new AgentProcessManager(config);

      expect(selectBmadInjection('conductor', config.agents.conductor)).toBe(false);
    });

    it('should disable BMAD when explicit camelCase planning flag is false', () => {
      const config = makeConfig({
        conductor: { tier: 1, can_delegate: true, isPlanningAgent: false },
      });
      manager = new AgentProcessManager(config);

      expect(selectBmadInjection('conductor', config.agents.conductor)).toBe(false);
    });

    it('should enable BMAD for tier 1 delegator', () => {
      const config = makeConfig({
        lead: { tier: 1, can_delegate: true },
      });
      manager = new AgentProcessManager(config);

      expect(selectBmadInjection('lead', config.agents.lead)).toBe(true);
    });
  });
});

describe('PersistentCLIAdapter (single-agent mode) env vars', () => {
  afterEach(() => {
    spawnCalls = [];
  });

  it('should pass MAMA_HOOK_FEATURES when creating process', async () => {
    spawnCalls = [];
    const adapter = new PersistentCLIAdapter({
      sessionId: 'test-session',
    });

    // prompt() will call getProcess() which calls start() which calls spawn()
    // The promise will hang waiting for stdout response, so we need to race with a timeout
    const promptPromise = adapter.prompt('hello').catch(() => {
      // Expected: will timeout or error since spawn is mocked
    });

    // Give the spawn a moment to execute
    await new Promise((resolve) => setTimeout(resolve, 600));

    // Check the spawn was called with correct env
    expect(spawnCalls.length).toBeGreaterThan(0);
    const env = getLastSpawnEnv();
    expect(env).toBeDefined();
    expect(env!['MAMA_HOOK_FEATURES']).toBe('rules,agents');
    expect(env!['MAMA_DISABLE_HOOKS']).toBeUndefined();

    // Clean up
    adapter.stopAll();
    await promptPromise;
  });
});
