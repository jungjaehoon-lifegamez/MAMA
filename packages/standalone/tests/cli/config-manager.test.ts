/**
 * Unit tests for ConfigManager
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as yaml from 'js-yaml';

import {
  expandPath,
  initConfig,
  loadConfig,
  saveConfig,
  createDefaultConfig,
  getDefaultMultiAgentConfig,
  validateConfig,
} from '../../src/cli/config/config-manager.js';
import { DEFAULT_CONFIG, DEFAULT_ROLES } from '../../src/cli/config/types.js';
import type { MAMAConfig } from '../../src/cli/config/types.js';

describe('ConfigManager', () => {
  let testDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    // Create temp directory with random suffix to avoid collisions
    testDir = join(tmpdir(), `mama-cfg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });

    // Save and override HOME
    originalHome = process.env.HOME;
    process.env.HOME = testDir;
  });

  afterEach(async () => {
    // Restore HOME
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }

    // Clean up
    await rm(testDir, { recursive: true, force: true });
  });

  describe('expandPath()', () => {
    it('should expand ~ to home directory', () => {
      const expanded = expandPath('~/.mama/config.yaml');
      expect(expanded).toBe(join(testDir, '.mama/config.yaml'));
    });

    it('should not modify paths without ~', () => {
      const path = '/absolute/path/to/file';
      expect(expandPath(path)).toBe(path);
    });

    it('should handle ~ in the middle of path', () => {
      // Only leading ~ should be expanded
      const path = '/path/to/~file';
      expect(expandPath(path)).toBe(path);
    });
  });

  describe('STORY-CONFIG-BUILTIN-AGENTS: saveConfig/loadConfig normalization - AC1, AC2', () => {
    it('should save and load config', async () => {
      const config: MAMAConfig = {
        version: 1,
        agent: {
          model: 'test-model',
          max_turns: 5,
          timeout: 60000,
        },
        database: {
          path: '~/.test/db.sqlite',
        },
        logging: {
          level: 'debug',
          file: '~/.test/logs/test.log',
        },
      };

      await saveConfig(config);
      const loaded = await loadConfig();

      expect(loaded.version).toBe(1);
      expect(loaded.agent.model).toBe('test-model');
      expect(loaded.agent.max_turns).toBe(5);
      expect(loaded.database.path).toBe('~/.test/db.sqlite');
      expect(loaded.logging.level).toBe('debug');
    });

    it('should throw error when config file not found', async () => {
      await expect(loadConfig()).rejects.toThrow(/not found/);
    });

    it('should merge with defaults for missing fields', async () => {
      // Create minimal config
      const mamaDir = join(testDir, '.mama');
      await mkdir(mamaDir, { recursive: true });
      const configPath = join(mamaDir, 'config.yaml');

      const minimalConfig = {
        version: 1,
        agent: { model: 'custom-model' },
        database: { path: '~/.test/db.sqlite' },
      };

      await writeFile(configPath, yaml.dump(minimalConfig));

      const loaded = await loadConfig();

      // Custom values
      expect(loaded.agent.model).toBe('custom-model');
      // Default values filled in
      expect(loaded.agent.max_turns).toBe(DEFAULT_CONFIG.agent.max_turns);
      expect(loaded.logging.level).toBe(DEFAULT_CONFIG.logging.level);
      expect(loaded.memory_policy).toEqual(DEFAULT_CONFIG.memory_policy);
    });

    it('should keep implicit memory policy disabled unless explicitly configured', async () => {
      const mamaDir = join(testDir, '.mama');
      await mkdir(mamaDir, { recursive: true });
      const configPath = join(mamaDir, 'config.yaml');

      const minimalConfig = {
        version: 1,
        agent: { model: 'custom-model' },
        database: { path: '~/.test/db.sqlite' },
      };

      await writeFile(configPath, yaml.dump(minimalConfig));

      const loaded = await loadConfig();

      expect(loaded.memory_policy).toEqual({
        implicit_recall: false,
        implicit_legacy_context_search: false,
      });
    });

    it('should allow env overrides for explicit message-router memory policy opt-ins', async () => {
      const mamaDir = join(testDir, '.mama');
      await mkdir(mamaDir, { recursive: true });
      const configPath = join(mamaDir, 'config.yaml');

      const minimalConfig = {
        version: 1,
        agent: { model: 'custom-model' },
        database: { path: '~/.test/db.sqlite' },
      };

      await writeFile(configPath, yaml.dump(minimalConfig));

      process.env.MAMA_MEMORY_POLICY_IMPLICIT_RECALL = ' TRUE ';
      process.env.MAMA_MEMORY_POLICY_IMPLICIT_LEGACY_CONTEXT_SEARCH = ' 1 ';

      try {
        const loaded = await initConfig();

        expect(loaded.memory_policy).toEqual({
          implicit_recall: true,
          implicit_legacy_context_search: true,
        });
      } finally {
        delete process.env.MAMA_MEMORY_POLICY_IMPLICIT_RECALL;
        delete process.env.MAMA_MEMORY_POLICY_IMPLICIT_LEGACY_CONTEXT_SEARCH;
      }
    });

    it('should reject string values for message-router memory policy toggles', async () => {
      const mamaDir = join(testDir, '.mama');
      await mkdir(mamaDir, { recursive: true });
      const configPath = join(mamaDir, 'config.yaml');

      const config = {
        version: 1,
        agent: { model: 'custom-model' },
        database: { path: '~/.test/db.sqlite' },
        memory_policy: {
          implicit_recall: 'false',
          implicit_legacy_context_search: 'true',
        },
      };

      await writeFile(configPath, yaml.dump(config));

      await expect(loadConfig()).rejects.toThrow(/memory_policy\.implicit_recall must be boolean/);
    });

    it('should normalize legacy developer agent permissions on load', async () => {
      const mamaDir = join(testDir, '.mama');
      await mkdir(mamaDir, { recursive: true });
      const configPath = join(mamaDir, 'config.yaml');

      const legacyConfig = {
        version: 1,
        agent: { model: 'custom-model' },
        database: { path: '~/.test/db.sqlite' },
        logging: { level: 'info', file: '~/.test/logs/test.log' },
        multi_agent: {
          enabled: true,
          agents: {
            developer: {
              name: 'DevBot',
              display_name: '🔧 DevBot',
              trigger_prefix: '!dev',
              persona_file: '~/.mama/personas/developer.md',
              tier: 2,
            },
          },
        },
      };

      await writeFile(configPath, yaml.dump(legacyConfig));

      const loaded = await loadConfig();

      expect(loaded.multi_agent?.agents?.developer?.tier).toBe(1);
      expect(loaded.multi_agent?.agents?.developer?.can_delegate).toBe(true);
      expect(loaded.multi_agent?.agents?.developer?.tool_permissions?.allowed).toContain('*');
      expect(loaded.multi_agent?.agents?.developer?.tool_permissions?.blocked).toEqual([]);
    });

    it('should merge current built-in agents into existing multi-agent configs on load', async () => {
      // AC: Existing configs keep custom agents while receiving current built-ins.
      const mamaDir = join(testDir, '.mama');
      await mkdir(mamaDir, { recursive: true });
      const configPath = join(mamaDir, 'config.yaml');

      const existingConfig = {
        version: 1,
        agent: { model: 'custom-model' },
        database: { path: '~/.test/db.sqlite' },
        logging: { level: 'info', file: '~/.test/logs/test.log' },
        wiki: { enabled: true },
        multi_agent: {
          enabled: true,
          agents: {
            custom: {
              name: 'Custom',
              display_name: 'Custom',
              trigger_prefix: '!custom',
              persona_file: '~/.mama/personas/custom.md',
              tier: 2,
              tool_permissions: { allowed: ['Read'], blocked: [] },
            },
          },
        },
      };

      await writeFile(configPath, yaml.dump(existingConfig));

      const loaded = await loadConfig();

      expect(loaded.multi_agent?.agents?.custom?.tool_permissions?.allowed).toEqual(['Read']);
      expect(loaded.multi_agent?.agents?.['os-agent']).toBeDefined();
      expect(loaded.multi_agent?.agents?.conductor).toBeDefined();
      expect(loaded.multi_agent?.agents?.memory).toBeDefined();
      expect(loaded.multi_agent?.agents).not.toHaveProperty('dashboard-agent');
      expect(loaded.multi_agent?.agents).not.toHaveProperty('wiki-agent');
    });

    it('should not backfill legacy self-paced agents when wiki is enabled', async () => {
      // AC: vNext removes legacy self-paced dashboard/wiki agents from default backfill.
      const mamaDir = join(testDir, '.mama');
      await mkdir(mamaDir, { recursive: true });
      const configPath = join(mamaDir, 'config.yaml');

      const existingConfig = {
        version: 1,
        agent: { model: 'custom-model' },
        database: { path: '~/.test/db.sqlite' },
        logging: { level: 'info', file: '~/.test/logs/test.log' },
        wiki: { enabled: true },
        multi_agent: {
          enabled: true,
          agents: {
            custom: {
              name: 'Custom',
              display_name: 'Custom',
              trigger_prefix: '!custom',
              persona_file: '~/.mama/personas/custom.md',
              tier: 2,
            },
          },
        },
      };

      await writeFile(configPath, yaml.dump(existingConfig));

      const loaded = await loadConfig();

      expect(loaded.multi_agent?.agents?.custom).toBeDefined();
      expect(loaded.multi_agent?.agents).not.toHaveProperty('dashboard-agent');
      expect(loaded.multi_agent?.agents?.['wiki-agent']).toBeUndefined();
    });

    it('should migrate legacy Code-Act system agent permissions on load', async () => {
      // AC: Existing dashboard/wiki agents separate CLI permissions from gateway permissions.
      const mamaDir = join(testDir, '.mama');
      await mkdir(mamaDir, { recursive: true });
      const configPath = join(mamaDir, 'config.yaml');

      const existingConfig = {
        version: 1,
        agent: { model: 'custom-model' },
        database: { path: '~/.test/db.sqlite' },
        logging: { level: 'info', file: '~/.test/logs/test.log' },
        multi_agent: {
          enabled: true,
          agents: {
            'dashboard-agent': {
              name: 'Dashboard Agent',
              display_name: 'Dashboard',
              trigger_prefix: '!dashboard',
              persona_file: '~/.mama/personas/dashboard.md',
              tier: 2,
              useCodeAct: true,
              tool_permissions: {
                allowed: ['mama_search', 'agent_notices', 'report_publish', 'code_act'],
                blocked: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
              },
            },
          },
        },
      };

      await writeFile(configPath, yaml.dump(existingConfig));

      const loaded = await loadConfig();
      const dashboard = loaded.multi_agent?.agents?.['dashboard-agent'];

      expect(dashboard?.tool_permissions?.allowed).toEqual(['Read', 'Grep', 'Glob', 'code_act']);
      expect(dashboard?.tool_permissions?.blocked).not.toContain('Read');
      expect(dashboard?.gateway_tool_permissions?.allowed).toEqual([
        'mama_search',
        'context_compile',
        'agent_notices',
        'report_publish',
      ]);
    });

    it('should upgrade old built-in Code-Act gateway allowlists with context_compile on load', async () => {
      // AC: Existing built-in system agents should receive newly required context_compile access.
      const mamaDir = join(testDir, '.mama');
      await mkdir(mamaDir, { recursive: true });
      const configPath = join(mamaDir, 'config.yaml');

      const existingConfig = {
        version: 1,
        agent: { model: 'custom-model' },
        database: { path: '~/.test/db.sqlite' },
        logging: { level: 'info', file: '~/.test/logs/test.log' },
        multi_agent: {
          enabled: true,
          agents: {
            'dashboard-agent': {
              name: 'Dashboard Agent',
              display_name: 'Dashboard',
              trigger_prefix: '!dashboard',
              persona_file: '~/.mama/personas/dashboard.md',
              tier: 2,
              useCodeAct: true,
              tool_permissions: {
                allowed: ['Read', 'Grep', 'Glob', 'code_act'],
                blocked: ['Bash', 'Write', 'Edit', 'Agent', 'WebSearch', 'WebFetch'],
              },
              gateway_tool_permissions: {
                allowed: ['mama_search', 'agent_notices', 'report_publish'],
                blocked: [],
              },
            },
            'wiki-agent': {
              name: 'Wiki Agent',
              display_name: 'Wiki',
              trigger_prefix: '!wiki',
              persona_file: '~/.mama/personas/wiki.md',
              tier: 2,
              useCodeAct: true,
              tool_permissions: {
                allowed: ['Read', 'Grep', 'Glob', 'code_act'],
                blocked: ['Bash', 'Write', 'Edit', 'Agent', 'WebSearch', 'WebFetch'],
              },
              gateway_tool_permissions: {
                allowed: [
                  'mama_search',
                  'agent_notices',
                  'case_list',
                  'case_assemble',
                  'obsidian',
                  'wiki_publish',
                ],
                blocked: [],
              },
            },
          },
        },
      };

      await writeFile(configPath, yaml.dump(existingConfig));

      const loaded = await loadConfig();

      // Assert exact array equality so the migration not only adds
      // context_compile but also preserves every previously allowed tool.
      expect(
        loaded.multi_agent?.agents?.['dashboard-agent']?.gateway_tool_permissions?.allowed
      ).toEqual(['mama_search', 'context_compile', 'agent_notices', 'report_publish']);
      expect(loaded.multi_agent?.agents?.['wiki-agent']?.gateway_tool_permissions?.allowed).toEqual(
        [
          'mama_search',
          'context_compile',
          'agent_notices',
          'case_list',
          'case_assemble',
          'obsidian',
          'wiki_publish',
        ]
      );
    });
  });

  describe('createDefaultConfig()', () => {
    it('should create default config file', async () => {
      const configPath = await createDefaultConfig();

      expect(existsSync(configPath)).toBe(true);

      const loaded = await loadConfig();
      expect(loaded.version).toBe(1);
      expect(loaded.agent.model).toBe(DEFAULT_CONFIG.agent.model);
    });

    it('should throw error if config exists and force is false', async () => {
      await createDefaultConfig();

      await expect(createDefaultConfig(false)).rejects.toThrow(/already exists/);
    });

    it('should overwrite config if force is true', async () => {
      await createDefaultConfig();
      await createDefaultConfig(true);

      const loaded = await loadConfig();
      expect(loaded.version).toBe(1);
    });

    it('should create logs directory', async () => {
      await createDefaultConfig();

      const logsDir = join(testDir, '.mama', 'logs');
      expect(existsSync(logsDir)).toBe(true);
    });
  });

  describe('getDefaultMultiAgentConfig()', () => {
    it('should include only current primary agents in the default system agent set', () => {
      // AC: Legacy self-paced dashboard/wiki agents are opt-in, not default config.
      const multiAgentConfig = getDefaultMultiAgentConfig();

      expect(multiAgentConfig.agents['os-agent']).toBeDefined();
      expect(multiAgentConfig.agents['os-agent']?.enabled).toBe(true);
      expect(multiAgentConfig.agents.conductor).toMatchObject({
        tier: 1,
        can_delegate: true,
      });
      expect(multiAgentConfig.agents.memory).toMatchObject({
        tier: 3,
        can_delegate: false,
        enabled: true,
      });
      expect(multiAgentConfig.agents).not.toHaveProperty('dashboard-agent');
      expect(multiAgentConfig.agents).not.toHaveProperty('wiki-agent');
    });

    it('should exclude legacy swarm and self-paced agents from the default agent set', () => {
      const multiAgentConfig = getDefaultMultiAgentConfig();

      expect(multiAgentConfig.agents.conductor).toBeDefined();
      expect(multiAgentConfig.agents).not.toHaveProperty('developer');
      expect(multiAgentConfig.agents).not.toHaveProperty('reviewer');
      expect(multiAgentConfig.agents).not.toHaveProperty('architect');
      expect(multiAgentConfig.agents).not.toHaveProperty('pm');
      expect(multiAgentConfig.agents).not.toHaveProperty('dashboard-agent');
      expect(multiAgentConfig.agents).not.toHaveProperty('wiki-agent');
    });
  });

  describe('validateConfig()', () => {
    it('should return empty array for valid config', () => {
      const errors = validateConfig(DEFAULT_CONFIG);
      expect(errors).toHaveLength(0);
    });

    it('should detect invalid version', () => {
      const config = { ...DEFAULT_CONFIG, version: 2 };
      const errors = validateConfig(config);
      expect(errors).toContain('Unsupported config version: 2');
    });

    it('should detect invalid max_turns', () => {
      const config = {
        ...DEFAULT_CONFIG,
        agent: { ...DEFAULT_CONFIG.agent, max_turns: 0 },
      };
      const errors = validateConfig(config);
      expect(errors.some((e) => e.includes('max_turns'))).toBe(true);
    });

    it('should detect invalid timeout', () => {
      const config = {
        ...DEFAULT_CONFIG,
        agent: { ...DEFAULT_CONFIG.agent, timeout: 100 },
      };
      const errors = validateConfig(config);
      expect(errors.some((e) => e.includes('timeout'))).toBe(true);
    });

    it('should accept Codex backends and reject unsupported Gemini backend values', () => {
      expect(
        validateConfig({
          ...DEFAULT_CONFIG,
          agent: { ...DEFAULT_CONFIG.agent, backend: 'codex' },
        })
      ).toHaveLength(0);
      expect(
        validateConfig({
          ...DEFAULT_CONFIG,
          agent: { ...DEFAULT_CONFIG.agent, backend: 'gemini' as 'claude' },
        })
      ).toContain('agent.backend must be "claude" or "codex"');
    });

    it('should reject the removed Codex transport selector', () => {
      expect(
        validateConfig({
          ...DEFAULT_CONFIG,
          agent: {
            ...DEFAULT_CONFIG.agent,
            codex_transport: 'mcp',
          } as typeof DEFAULT_CONFIG.agent,
        })
      ).toContain('agent.codex_transport was removed; Codex always uses app-server');
    });

    it('should detect invalid log level', () => {
      const config = {
        ...DEFAULT_CONFIG,
        logging: { ...DEFAULT_CONFIG.logging, level: 'invalid' as 'info' },
      };
      const errors = validateConfig(config);
      expect(errors.some((e) => e.includes('logging.level'))).toBe(true);
    });

    it('should detect invalid memory policy toggle types', () => {
      const config = {
        ...DEFAULT_CONFIG,
        memory_policy: {
          ...DEFAULT_CONFIG.memory_policy!,
        },
      };
      Object.assign(config.memory_policy, {
        implicit_recall: 'false',
        implicit_legacy_context_search: 'true',
      });

      const errors = validateConfig(config);

      expect(errors).toContain('memory_policy.implicit_recall must be boolean');
      expect(errors).toContain('memory_policy.implicit_legacy_context_search must be boolean');
    });
  });
});

describe('Story OPS-1 / S1-T1 B1: additive roles merge + prune-at-save', () => {
  // CRITICAL isolation (R2-B1): saveConfig resolves '~' via os.homedir(), which
  // honors $HOME on POSIX. Without this override these tests OVERWRITE the real
  // ~/.mama/config.yaml on every run (including pre-commit). Same pattern as
  // the ConfigManager describe above - that block's beforeEach does not apply here.
  let rolesTestDir: string;
  let rolesOriginalHome: string | undefined;

  beforeEach(async () => {
    rolesTestDir = join(
      tmpdir(),
      `mama-roles-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(rolesTestDir, { recursive: true });
    rolesOriginalHome = process.env.HOME;
    process.env.HOME = rolesTestDir;
  });

  afterEach(async () => {
    if (rolesOriginalHome !== undefined) {
      process.env.HOME = rolesOriginalHome;
    } else {
      delete process.env.HOME;
    }
    await rm(rolesTestDir, { recursive: true, force: true });
  });

  it('gains new default definitions while preserving user customizations (AC #1)', async () => {
    const config = {
      version: 1,
      agent: { model: 'test-model', max_turns: 5, timeout: 60000 },
      database: { path: '~/.test/db.sqlite' },
      logging: { level: 'debug', file: '~/.test/logs/test.log' },
      roles: {
        definitions: {
          chat_bot: {
            model: 'custom-model',
            allowedTools: ['mama_search'],
            blockedTools: ['Bash'],
            allowedPaths: [],
            systemControl: false,
            sensitiveAccess: false,
          },
        },
        sourceMapping: { telegram: 'chat_bot' },
      },
    } as unknown as MAMAConfig;

    await saveConfig(config);
    const loaded = await loadConfig();

    // Customization preserved
    expect(loaded.roles?.definitions.chat_bot?.model).toBe('custom-model');
    // New default definition gained (the B1 silent-death fix)
    expect(loaded.roles?.definitions.owner_console).toBeDefined();
    expect(loaded.roles?.definitions.owner_console?.allowedTools).toContain('kagemusha_tasks');
    // Default mappings still resolve
    expect(loaded.roles?.sourceMapping.viewer).toBe('os_agent');
  });

  it('enables only the outer Code-Act entry point on the default owner role', () => {
    const owner = DEFAULT_ROLES.definitions.owner_console;

    expect(owner.allowedTools).toContain('code_act');
    expect(owner.blockedTools).toEqual(['Bash', 'Write', 'save_integration_token', 'delegate']);
    expect(owner.systemControl).toBe(false);
    expect(owner.sensitiveAccess).toBe(false);
  });

  it('keeps a persisted custom owner allowlist fail-closed instead of inheriting code_act', async () => {
    const customOwner = {
      ...DEFAULT_ROLES.definitions.owner_console,
      allowedTools: ['mama_search'],
    };
    const config = {
      version: 1,
      agent: { model: 'test-model', max_turns: 5, timeout: 60000 },
      database: { path: '~/.test/db.sqlite' },
      logging: { level: 'debug', file: '~/.test/logs/test.log' },
      roles: {
        definitions: { owner_console: customOwner },
        sourceMapping: { telegram: 'chat_bot' },
      },
    } as unknown as MAMAConfig;

    await saveConfig(config);
    const loaded = await loadConfig();

    expect(loaded.roles?.definitions.owner_console?.allowedTools).toEqual(['mama_search']);
    expect(loaded.roles?.definitions.owner_console?.allowedTools).not.toContain('code_act');
    expect(loaded.roles?.definitions.owner_console?.blockedTools).toEqual(customOwner.blockedTools);
  });

  it('prunes default-identical role entries at save so defaults never freeze (R2-M1)', async () => {
    const base = {
      version: 1,
      agent: { model: 'test-model', max_turns: 5, timeout: 60000 },
      database: { path: '~/.test/db.sqlite' },
      logging: { level: 'debug', file: '~/.test/logs/test.log' },
    } as unknown as MAMAConfig;

    // Simulate a load->save round trip: loadConfig injects merged defaults.
    await saveConfig(base);
    const loaded = await loadConfig();
    expect(loaded.roles?.definitions.owner_console).toBeDefined();
    await saveConfig(loaded);

    // The persisted file must NOT contain the frozen default definitions.
    const { readFile } = await import('node:fs/promises');
    const { getConfigPath } = await import('../../src/cli/config/config-manager.js');
    const raw = await readFile(getConfigPath(), 'utf-8');
    expect(raw).not.toContain('owner_console');
    expect(raw).not.toContain('os_agent');
  });
});
