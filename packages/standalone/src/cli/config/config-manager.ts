/**
 * Configuration Manager for MAMA Standalone
 *
 * Manages YAML configuration file at ~/.mama/config.yaml
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as yaml from 'js-yaml';

import type { MAMAConfig, MultiAgentConfig, AgentPersonaConfig } from './types.js';
import { DEFAULT_CONFIG, MAMA_PATHS } from './types.js';

/**
 * Expand ~ to home directory
 */
export function expandPath(path: string): string {
  if (path.startsWith('~')) {
    return path.replace('~', homedir());
  }
  return path;
}

/**
 * Get the full path to config file
 */
export function getConfigPath(): string {
  return expandPath(MAMA_PATHS.CONFIG);
}

/**
 * Get the MAMA home directory
 */
export function getMAMAHome(): string {
  return expandPath(MAMA_PATHS.HOME);
}

/**
 * Check if config file exists
 */
export function configExists(): boolean {
  return existsSync(getConfigPath());
}

/**
 * Load configuration from file
 *
 * @returns Configuration object
 * @throws Error if config file doesn't exist or is invalid
 */
export async function loadConfig(): Promise<MAMAConfig> {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    throw new Error(`Configuration file not found: ${configPath}\nRun 'mama init' to create it.`);
  }

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = yaml.load(content) as MAMAConfig;

    // Validate required fields
    if (!config.version || !config.agent || !config.database) {
      throw new Error('Invalid configuration: missing required fields');
    }

    // Merge with defaults for any missing optional fields
    return mergeWithDefaults(config);
  } catch (error) {
    if (error instanceof Error && error.message.includes('missing required')) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('unidentified alias')) {
      throw new Error(
        `Failed to load configuration: ${message}\n` +
          'Hint: YAML cron expressions starting with "*" must be quoted. ' +
          'Use: cron: "*/10 * * * *" (or "0 * * * *").'
      );
    }

    throw new Error(`Failed to load configuration: ${message}`);
  }
}

/**
 * Save configuration to file
 *
 * @param config - Configuration object to save
 */
export async function saveConfig(config: MAMAConfig): Promise<void> {
  const configPath = getConfigPath();
  const configDir = dirname(configPath);

  // Ensure directory exists
  if (!existsSync(configDir)) {
    await mkdir(configDir, { recursive: true });
  }

  const content = yaml.dump(config, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
  });

  // Add header comment
  const fileContent = `# MAMA Standalone Configuration
# Generated: ${new Date().toISOString()}
# Documentation: https://github.com/jungjaehoon-lifegamez/MAMA

${content}`;

  await writeFile(configPath, fileContent, 'utf-8');
}

/**
 * Create default configuration file
 *
 * @param overwrite - Whether to overwrite existing config
 * @returns Path to created config file
 * @throws Error if config exists and overwrite is false
 */
export async function createDefaultConfig(overwrite = false): Promise<string> {
  const configPath = getConfigPath();

  if (existsSync(configPath) && !overwrite) {
    throw new Error(`Configuration file already exists: ${configPath}\nUse --force to overwrite.`);
  }

  // Ensure logs directory exists
  const logsDir = expandPath(MAMA_PATHS.LOGS);
  if (!existsSync(logsDir)) {
    await mkdir(logsDir, { recursive: true });
  }

  await saveConfig(DEFAULT_CONFIG);
  return configPath;
}

/**
 * Merge user config with defaults
 * SECURITY: Type guards ensure safe defaults for optional fields
 */
function mergeWithDefaults(config: Partial<MAMAConfig>): MAMAConfig {
  const multiAgent = normalizeLegacyMultiAgentConfig(config.multi_agent);

  return {
    // Preserve all user-defined fields (scheduling, custom sections, etc.)
    ...config,
    // Deep-merge known structured fields with defaults
    version: config.version ?? DEFAULT_CONFIG.version,
    agent: {
      ...DEFAULT_CONFIG.agent,
      ...config.agent,
    },
    database: {
      ...DEFAULT_CONFIG.database,
      ...config.database,
    },
    logging: {
      ...DEFAULT_CONFIG.logging,
      ...config.logging,
    },
    roles: config.roles ?? DEFAULT_CONFIG.roles,
    use_claude_cli: config.use_claude_cli ?? DEFAULT_CONFIG.use_claude_cli,
    discord: config.discord ?? DEFAULT_CONFIG.discord,
    slack: config.slack ?? DEFAULT_CONFIG.slack,
    telegram: config.telegram ?? DEFAULT_CONFIG.telegram,
    chatwork: config.chatwork ?? DEFAULT_CONFIG.chatwork,
    heartbeat: config.heartbeat ?? DEFAULT_CONFIG.heartbeat,
    multi_agent: multiAgent,
  };
}

/**
 * Normalize legacy multi-agent defaults for existing installations.
 *
 * Existing users may still have historical team profiles where "developer"
 * used to run as advisory tier with read-only tooling. For the current
 * default workflow, this profile is expected to orchestrate edits and
 * delegate work, so we gently upgrade missing permission metadata.
 */
function normalizeLegacyMultiAgentConfig(
  multiAgentConfig?: MultiAgentConfig
): MultiAgentConfig | undefined {
  if (!multiAgentConfig?.agents) {
    return multiAgentConfig;
  }

  // Migrate sisyphus → conductor (renamed in v0.9.0)
  const agents = multiAgentConfig.agents as Record<string, Omit<AgentPersonaConfig, 'id'>>;
  if (agents['sisyphus'] && !agents['conductor']) {
    const sisyphus = agents['sisyphus'];
    delete agents['sisyphus'];
    agents['conductor'] = {
      ...sisyphus,
      display_name: '🎯 Conductor',
      trigger_prefix: '!conductor',
      persona_file: '~/.mama/personas/conductor.md',
      tier: 1,
      can_delegate: true,
    };
  }

  const developer = multiAgentConfig.agents.developer;
  if (!developer) {
    return multiAgentConfig;
  }

  const hasExplicitPermissionOverrides =
    developer.tool_permissions !== undefined || developer.can_delegate !== undefined;

  if (!hasExplicitPermissionOverrides && (developer.tier === 2 || developer.tier === undefined)) {
    return {
      ...multiAgentConfig,
      agents: {
        ...multiAgentConfig.agents,
        developer: {
          ...developer,
          tier: 1,
          can_delegate: true,
          tool_permissions: {
            allowed: ['*'],
            blocked: [],
          },
        },
      },
    };
  }

  const needsAutoTierUpgrade =
    developer.can_delegate === true &&
    (developer.tier === undefined || developer.tier < 1 || developer.tier > 1);
  if (needsAutoTierUpgrade) {
    return {
      ...multiAgentConfig,
      agents: {
        ...multiAgentConfig.agents,
        developer: {
          ...developer,
          tier: 1,
        },
      },
    };
  }

  return multiAgentConfig;
}

/**
 * Validate configuration
 *
 * @param config - Configuration to validate
 * @returns Array of validation errors (empty if valid)
 */
export function validateConfig(config: MAMAConfig): string[] {
  const errors: string[] = [];

  if (config.version !== 1) {
    errors.push(`Unsupported config version: ${config.version}`);
  }

  if (!config.agent.model) {
    errors.push('agent.model is required');
  }

  if (config.agent.backend && !['claude', 'codex-mcp'].includes(config.agent.backend)) {
    errors.push('agent.backend must be "claude" or "codex-mcp"');
  }

  if (config.agent.max_turns < 1 || config.agent.max_turns > 100) {
    errors.push('agent.max_turns must be between 1 and 100');
  }

  if (config.agent.timeout < 1000) {
    errors.push('agent.timeout must be at least 1000ms');
  }

  if (!config.database.path) {
    errors.push('database.path is required');
  }

  const validLogLevels = ['debug', 'info', 'warn', 'error'];
  if (!validLogLevels.includes(config.logging.level)) {
    errors.push(`logging.level must be one of: ${validLogLevels.join(', ')}`);
  }

  return errors;
}

/**
 * Get the default multi-agent configuration (disabled by default)
 */
export function getDefaultMultiAgentConfig(): MultiAgentConfig {
  return {
    enabled: false,
    free_chat: true,
    agents: {
      conductor: {
        name: 'Conductor',
        display_name: '🎯 Conductor',
        trigger_prefix: '!conductor',
        persona_file: '~/.mama/personas/conductor.md',
        tier: 1,
        can_delegate: true,
      },
      developer: {
        name: 'DevBot',
        display_name: '🔧 DevBot',
        trigger_prefix: '!dev',
        persona_file: '~/.mama/personas/developer.md',
        tier: 1,
        can_delegate: true,
        tool_permissions: {
          allowed: ['*'],
          blocked: [],
        },
      },
      reviewer: {
        name: 'Reviewer',
        display_name: '📝 Reviewer',
        trigger_prefix: '!review',
        persona_file: '~/.mama/personas/reviewer.md',
        tier: 3,
      },
      architect: {
        name: 'Architect',
        display_name: '🏛️ Architect',
        trigger_prefix: '!arch',
        persona_file: '~/.mama/personas/architect.md',
        tier: 2,
      },
      pm: {
        name: 'PM',
        display_name: '📋 PM',
        trigger_prefix: '!pm',
        persona_file: '~/.mama/personas/pm.md',
        tier: 2,
      },
    },
    loop_prevention: {
      max_chain_length: 5,
      global_cooldown_ms: 1000,
      chain_window_ms: 60000,
    },
    workflow: {
      enabled: true,
    },
    council: {
      enabled: true,
    },
  };
}

/**
 * Provision default persona templates and multi-agent config on first start.
 *
 * - Copies builtin persona .md files from templates/personas/ to ~/.mama/personas/
 *   only if the personas directory does not yet exist.
 * - Injects a default (disabled) multi_agent section into config.yaml
 *   only if one is not already present.
 */
export async function provisionDefaults(): Promise<void> {
  const mamaHome = getMAMAHome();
  const personasDir = join(mamaHome, 'personas');

  // Resolve templates dir relative to this file's compiled location
  // In dist: dist/cli/config/config-manager.js → ../../../templates/personas
  const templatesDir = resolve(__dirname, '../../../templates/personas');

  // 1. Provision personas directory with builtin templates
  if (!existsSync(personasDir)) {
    mkdirSync(personasDir, { recursive: true });
    if (existsSync(templatesDir)) {
      for (const file of readdirSync(templatesDir)) {
        if (file.endsWith('.md')) {
          copyFileSync(join(templatesDir, file), join(personasDir, file));
        }
      }
      console.log('✓ Default persona templates installed');
    }
  }

  // 2. Inject default multi_agent config if missing
  if (configExists()) {
    const config = await loadConfig();
    if (!config.multi_agent) {
      config.multi_agent = getDefaultMultiAgentConfig();
      await saveConfig(config);
      console.log('✓ Multi-agent config initialized (disabled)');
    }
  }
}
