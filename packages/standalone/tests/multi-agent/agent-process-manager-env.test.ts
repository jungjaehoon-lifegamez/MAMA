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
let readFileSyncValue = '';
let writeFileSyncCalls: Array<{ path: string; data: string }> = [];

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
  readFileSync: vi.fn(() => readFileSyncValue),
  writeFileSync: vi.fn((path: string, data: string) => {
    writeFileSyncCalls.push({ path, data });
  }),
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
      useCodeAct?: boolean;
      backend?: 'claude' | 'codex' | 'codex-mcp';
      tool_permissions?: { allowed?: string[]; blocked?: string[] };
      gateway_tool_permissions?: { allowed?: string[]; blocked?: string[] };
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
      backend: opts.backend ?? 'claude',
      model: opts.model ?? 'claude-sonnet-4-6',
      can_delegate: opts.can_delegate,
      is_planning_agent: opts.is_planning_agent,
      isPlanningAgent: opts.isPlanningAgent,
      useCodeAct: opts.useCodeAct,
      tool_permissions: opts.tool_permissions,
      gateway_tool_permissions: opts.gateway_tool_permissions,
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
    readFileSyncValue = '';
    writeFileSyncCalls = [];
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

  describe('process lifecycle events', () => {
    it('emits process-created for newly created Claude pool processes', async () => {
      const config = makeConfig({
        developer: { tier: 1 },
      });
      manager = new AgentProcessManager(config);
      const listener = vi.fn();

      manager.on('process-created', listener);
      const process = await manager.getProcess('discord', 'channel-1', 'developer');

      expect(listener).toHaveBeenCalledWith({
        agentId: 'developer',
        process,
      });

      const reusedProcess = await manager.getProcess('discord', 'channel-1', 'developer');
      expect(reusedProcess).toBe(process);
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('STORY-CODE-ACT-GATEWAY-PERMISSIONS: Code-Act gateway allowlist separation', () => {
    it('filters CLI-only allowed tools out of generated Code-Act declarations', async () => {
      const config = makeConfig({
        dashboard: {
          tier: 2,
          useCodeAct: true,
          tool_permissions: {
            allowed: ['code_act', 'mama_search', 'report_publish', 'mcp__brave-search__*'],
          },
        },
      });
      manager = new AgentProcessManager(config);

      await manager.getProcess('discord', 'channel-1', 'dashboard');

      const args = spawnCalls[spawnCalls.length - 1]?.args ?? [];
      const systemPrompt = args[args.indexOf('--system-prompt') + 1];
      expect(systemPrompt).toContain('declare function mama_search');
      expect(systemPrompt).toContain('declare function report_publish');
      expect(systemPrompt).not.toContain('declare function code_act');
      expect(systemPrompt).not.toContain('declare function mcp__brave-search__');
    });

    it('removes blocked gateway tools from generated Code-Act declarations', async () => {
      const config = makeConfig({
        dashboard: {
          tier: 2,
          useCodeAct: true,
          gateway_tool_permissions: {
            allowed: ['*'],
            blocked: ['mama_save'],
          },
        },
      });
      manager = new AgentProcessManager(config);

      await manager.getProcess('discord', 'channel-1', 'dashboard');

      const args = spawnCalls[spawnCalls.length - 1]?.args ?? [];
      const systemPrompt = args[args.indexOf('--system-prompt') + 1];
      expect(systemPrompt).toContain('declare function mama_search');
      expect(systemPrompt).not.toContain('declare function mama_save');
    });

    it('honors deny-only gateway tool permissions for generated Code-Act declarations', async () => {
      const config = makeConfig({
        dashboard: {
          tier: 2,
          useCodeAct: true,
          gateway_tool_permissions: {
            blocked: ['mama_save'],
          },
        },
      });
      manager = new AgentProcessManager(config);

      await manager.getProcess('discord', 'channel-1', 'dashboard');

      const args = spawnCalls[spawnCalls.length - 1]?.args ?? [];
      const systemPrompt = args[args.indexOf('--system-prompt') + 1];
      expect(systemPrompt).toContain('declare function mama_search');
      expect(systemPrompt).not.toContain('declare function mama_save');
    });

    it('writes per-agent Code-Act MCP policy env for runtime enforcement', async () => {
      readFileSyncValue = JSON.stringify({
        mcpServers: {
          'code-act': {
            command: 'node',
            args: ['code-act-server.js'],
            env: { MAMA_SERVER_PORT: '3847' },
          },
        },
      });
      const config = makeConfig({
        dashboard: {
          tier: 2,
          useCodeAct: true,
          gateway_tool_permissions: {
            allowed: ['mama_search', 'report_publish', 'mcp__brave-search__*'],
            blocked: ['mama_save'],
          },
        },
      });
      manager = new AgentProcessManager(config);

      await manager.getProcess('discord', 'channel-1', 'dashboard');

      expect(writeFileSyncCalls).toHaveLength(1);
      expect(writeFileSyncCalls[0].path).toContain('code-act-only-mcp-config-dashboard.json');
      const written = JSON.parse(writeFileSyncCalls[0].data) as {
        mcpServers: {
          'code-act': {
            env: Record<string, string>;
          };
        };
      };
      expect(written.mcpServers['code-act'].env).toMatchObject({
        MAMA_SERVER_PORT: '3847',
        MAMA_CODE_ACT_AGENT_ID: 'dashboard',
        MAMA_CODE_ACT_ALLOWED_TOOLS: JSON.stringify(['mama_search', 'report_publish']),
        MAMA_CODE_ACT_BLOCKED_TOOLS: JSON.stringify(['mama_save']),
      });

      const args = spawnCalls[spawnCalls.length - 1]?.args ?? [];
      expect(args).toContain('--mcp-config');
      expect(args[args.indexOf('--mcp-config') + 1]).toContain(
        'code-act-only-mcp-config-dashboard.json'
      );
    });

    it('passes per-agent Code-Act MCP config through the Codex runtime path', async () => {
      readFileSyncValue = JSON.stringify({
        mcpServers: {
          'code-act': {
            command: 'node',
            args: ['code-act-server.js'],
            env: { MAMA_SERVER_PORT: '3847' },
          },
        },
      });
      const config = makeConfig({
        dashboard: {
          backend: 'codex-mcp',
          tier: 2,
          useCodeAct: true,
          gateway_tool_permissions: {
            allowed: ['mama_search', 'report_publish'],
            blocked: ['mama_save'],
          },
        },
      });
      manager = new AgentProcessManager(config, {}, { model: 'claude-sonnet-4-6' });

      const runner = await manager.getProcess('discord', 'channel-1', 'dashboard');
      const runtimeOptions = (
        runner as unknown as { wrapper: { options: { mcpConfigPath?: string } } }
      ).wrapper.options;

      expect(runtimeOptions.mcpConfigPath).toContain('code-act-only-mcp-config-dashboard.json');
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
