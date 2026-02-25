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
// ============================================================================
// Sync Config Cache (STORY-002)
// ============================================================================

let _cachedConfig: MAMAConfig | null = null;

/**
 * Initialize config: load from disk, apply env overrides, and cache.
 * Call once at startup (e.g., in mama start).
 */
export async function initConfig(): Promise<MAMAConfig> {
  const config = await loadConfig();
  _cachedConfig = applyEnvOverrides(config);
  return _cachedConfig;
}

/**
 * Get the cached config synchronously.
 * Throws if initConfig() hasn't been called, catching initialization order bugs early.
 */
export function getConfig(): MAMAConfig {
  if (!_cachedConfig) {
    throw new Error('Config not initialized. Call initConfig() at startup.');
  }
  return _cachedConfig;
}

/**
 * Override config values at runtime (shallow merge into cache).
 * Does NOT persist to disk — use saveConfig() for that.
 */
export function overrideConfig(overrides: Partial<MAMAConfig>): MAMAConfig {
  const base = getConfig();
  _cachedConfig = {
    ...base,
    ...overrides,
    prompt: overrides.prompt ? { ...base.prompt!, ...overrides.prompt } : base.prompt,
    timeouts: overrides.timeouts ? { ...base.timeouts!, ...overrides.timeouts } : base.timeouts,
    gateway_tuning: overrides.gateway_tuning
      ? { ...base.gateway_tuning!, ...overrides.gateway_tuning }
      : base.gateway_tuning,
    io: overrides.io ? { ...base.io!, ...overrides.io } : base.io,
    metrics: overrides.metrics ? { ...base.metrics!, ...overrides.metrics } : base.metrics,
    token_budget: overrides.token_budget
      ? { ...base.token_budget!, ...overrides.token_budget }
      : base.token_budget,
    agent: overrides.agent ? { ...base.agent, ...overrides.agent } : base.agent,
    database: overrides.database ? { ...base.database, ...overrides.database } : base.database,
    logging: overrides.logging ? { ...base.logging, ...overrides.logging } : base.logging,
  };
  return _cachedConfig;
}

/**
 * Reset cached config (for testing).
 * @param useDefaults - If true, set cache to DEFAULT_CONFIG instead of null.
 */
export function resetConfigCache(useDefaults = false): void {
  _cachedConfig = useDefaults ? { ...DEFAULT_CONFIG } : null;
}

/**
 * ENV_MAP: MAMA_* environment variables → config paths.
 * Format: MAMA_{SECTION}_{FIELD} → config.section.field
 * Values are parsed as numbers where the target type is number.
 */
const envMap: Array<{
  env: string;
  path: [keyof MAMAConfig, string];
  type: 'number' | 'boolean';
}> = [
  // Prompt
  { env: 'MAMA_PROMPT_WARN_CHARS', path: ['prompt', 'warn_chars'], type: 'number' },
  { env: 'MAMA_PROMPT_TRUNCATE_CHARS', path: ['prompt', 'truncate_chars'], type: 'number' },
  { env: 'MAMA_PROMPT_HARD_LIMIT_CHARS', path: ['prompt', 'hard_limit_chars'], type: 'number' },
  { env: 'MAMA_PROMPT_SKILL_MAX_CHARS', path: ['prompt', 'skill_max_chars'], type: 'number' },
  // Prompt (token-based)
  { env: 'MAMA_PROMPT_WARN_TOKENS', path: ['prompt', 'warn_tokens'], type: 'number' },
  { env: 'MAMA_PROMPT_TRUNCATE_TOKENS', path: ['prompt', 'truncate_tokens'], type: 'number' },
  { env: 'MAMA_PROMPT_HARD_LIMIT_TOKENS', path: ['prompt', 'hard_limit_tokens'], type: 'number' },
  { env: 'MAMA_PROMPT_SKILL_MAX_TOKENS', path: ['prompt', 'skill_max_tokens'], type: 'number' },
  // Timeouts
  { env: 'MAMA_TIMEOUT_REQUEST_MS', path: ['timeouts', 'request_ms'], type: 'number' },
  { env: 'MAMA_TIMEOUT_CODEX_REQUEST_MS', path: ['timeouts', 'codex_request_ms'], type: 'number' },
  { env: 'MAMA_TIMEOUT_INITIALIZE_MS', path: ['timeouts', 'initialize_ms'], type: 'number' },
  { env: 'MAMA_TIMEOUT_SESSION_MS', path: ['timeouts', 'session_ms'], type: 'number' },
  {
    env: 'MAMA_TIMEOUT_SESSION_CLEANUP_MS',
    path: ['timeouts', 'session_cleanup_ms'],
    type: 'number',
  },
  { env: 'MAMA_TIMEOUT_AGENT_MS', path: ['timeouts', 'agent_ms'], type: 'number' },
  { env: 'MAMA_TIMEOUT_ULTRAWORK_MS', path: ['timeouts', 'ultrawork_ms'], type: 'number' },
  { env: 'MAMA_TIMEOUT_BUSY_RETRY_MS', path: ['timeouts', 'busy_retry_ms'], type: 'number' },
  // Gateway
  { env: 'MAMA_GATEWAY_DEDUP_TTL_MS', path: ['gateway_tuning', 'dedup_ttl_ms'], type: 'number' },
  {
    env: 'MAMA_GATEWAY_MENTION_TTL_MS',
    path: ['gateway_tuning', 'mention_ttl_ms'],
    type: 'number',
  },
  {
    env: 'MAMA_GATEWAY_MESSAGE_TTL_MS',
    path: ['gateway_tuning', 'message_ttl_ms'],
    type: 'number',
  },
  {
    env: 'MAMA_GATEWAY_CLEANUP_INTERVAL_MS',
    path: ['gateway_tuning', 'cleanup_interval_ms'],
    type: 'number',
  },
  {
    env: 'MAMA_GATEWAY_HEARTBEAT_INTERVAL_MS',
    path: ['gateway_tuning', 'heartbeat_interval_ms'],
    type: 'number',
  },
  // IO
  { env: 'MAMA_IO_MAX_READ_BYTES', path: ['io', 'max_read_bytes'], type: 'number' },
  {
    env: 'MAMA_IO_MAX_DYNAMIC_CONTEXT_CHARS',
    path: ['io', 'max_dynamic_context_chars'],
    type: 'number',
  },
  {
    env: 'MAMA_IO_CONTEXT_THRESHOLD_TOKENS',
    path: ['io', 'context_threshold_tokens'],
    type: 'number',
  },
  { env: 'MAMA_IO_MAX_CONTEXT_TOKENS', path: ['io', 'max_context_tokens'], type: 'number' },
  // Metrics
  { env: 'MAMA_METRICS_ENABLED', path: ['metrics', 'enabled'], type: 'boolean' },
  { env: 'MAMA_METRICS_RETENTION_DAYS', path: ['metrics', 'retention_days'], type: 'number' },
  // Token Budget
  { env: 'MAMA_TOKEN_BUDGET_DAILY_LIMIT', path: ['token_budget', 'daily_limit'], type: 'number' },
  {
    env: 'MAMA_TOKEN_BUDGET_ALERT_THRESHOLD',
    path: ['token_budget', 'alert_threshold'],
    type: 'number',
  },
];

/**
 * Apply MAMA_* environment variable overrides to config.
 * Env vars take precedence over config.yaml values.
 */
function applyEnvOverrides(config: MAMAConfig): MAMAConfig {
  const result = { ...config };

  for (const { env, path, type } of envMap) {
    const value = process.env[env];
    if (value === undefined) {
      continue;
    }

    const [section, field] = path;
    const sectionObj = result[section];
    if (sectionObj && typeof sectionObj === 'object') {
      const parsed = type === 'boolean' ? value === 'true' || value === '1' : Number(value);
      if (type === 'number' && isNaN(parsed as number)) {
        continue;
      }
      (result as Record<string, Record<string, unknown>>)[section] = {
        ...(sectionObj as Record<string, unknown>),
        [field]: parsed,
      };
    }
  }

  return result;
}

/**
 * Error thrown when config validation fails.
 * Contains all validation errors and resolution guidance.
 */
export class ConfigValidationError extends Error {
  constructor(
    public readonly errors: string[],
    public readonly configPath: string
  ) {
    const header = `Invalid configuration (${configPath}):\n`;
    const body = errors.map((e) => `  - ${e}`).join('\n');
    const footer = `\nFix config.yaml or run 'mama init --force' to regenerate.`;
    super(header + body + footer);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Validate required config fields (fail-fast policy).
 * Called after mergeWithDefaults() — if a field is still missing after merge,
 * the user's config.yaml is genuinely missing it.
 */
function validateRequiredFields(config: MAMAConfig, configPath: string): void {
  const errors: string[] = [];

  if (!config.agent.backend) {
    errors.push("agent.backend is required. Valid: 'claude' | 'codex-mcp'");
  }
  if (!config.agent.model) {
    errors.push("agent.model is required. Example: 'claude-sonnet-4-6'");
  }

  // Validate role definitions have models
  if (config.roles?.definitions) {
    for (const [name, role] of Object.entries(config.roles.definitions)) {
      if (!role.model) {
        errors.push(`roles.definitions.${name}.model is required`);
      }
    }
  }

  // Validate enabled multi-agent agents have backend+model
  if (config.multi_agent?.agents) {
    for (const [id, agent] of Object.entries(config.multi_agent.agents)) {
      if (agent.enabled === false) continue;
      // Agents inherit from global config, so only error if neither agent nor global has it
      const effectiveBackend = agent.backend ?? config.agent.backend;
      const effectiveModel = agent.model ?? config.agent.model;
      if (!effectiveBackend) {
        errors.push(`multi_agent.agents.${id}: no backend. Set in agent config or agent.backend`);
      }
      if (!effectiveModel) {
        errors.push(`multi_agent.agents.${id}: no model. Set in agent config or agent.model`);
      }
    }
  }

  if (errors.length > 0) {
    throw new ConfigValidationError(errors, configPath);
  }
}

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
    const merged = mergeWithDefaults(config);

    // Fail-fast: validate required fields after merge
    validateRequiredFields(merged, configPath);

    return merged;
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
    prompt: config.prompt ? { ...DEFAULT_CONFIG.prompt!, ...config.prompt } : DEFAULT_CONFIG.prompt,
    timeouts: config.timeouts
      ? { ...DEFAULT_CONFIG.timeouts!, ...config.timeouts }
      : DEFAULT_CONFIG.timeouts,
    gateway_tuning: config.gateway_tuning
      ? { ...DEFAULT_CONFIG.gateway_tuning!, ...config.gateway_tuning }
      : DEFAULT_CONFIG.gateway_tuning,
    io: config.io ? { ...DEFAULT_CONFIG.io!, ...config.io } : DEFAULT_CONFIG.io,
    metrics: config.metrics
      ? { ...DEFAULT_CONFIG.metrics!, ...config.metrics }
      : DEFAULT_CONFIG.metrics,
    token_budget: config.token_budget
      ? { ...DEFAULT_CONFIG.token_budget!, ...config.token_budget }
      : DEFAULT_CONFIG.token_budget,
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
  const agentEntries = multiAgentConfig.agents as Record<string, Omit<AgentPersonaConfig, 'id'>>;
  if (agentEntries['sisyphus'] && !agentEntries['conductor']) {
    const { sisyphus: sisyphusEntry, ...rest } = agentEntries;
    const migratedAgents = {
      ...rest,
      conductor: {
        ...sisyphusEntry,
        name: 'Conductor',
        display_name: '🎯 Conductor',
        trigger_prefix: '!conductor',
        persona_file: '~/.mama/personas/conductor.md',
        tier: 1,
        can_delegate: true,
      },
    };
    const migratedDefaultAgent =
      multiAgentConfig.default_agent === 'sisyphus' ? 'conductor' : multiAgentConfig.default_agent;
    multiAgentConfig = {
      ...multiAgentConfig,
      default_agent: migratedDefaultAgent,
      agents: migratedAgents as typeof multiAgentConfig.agents,
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
    default_agent: 'conductor',
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

  // 1. Provision personas directory with builtin templates (file-level: copies missing files only)
  if (!existsSync(personasDir)) {
    mkdirSync(personasDir, { recursive: true });
  }
  if (existsSync(templatesDir)) {
    const copied: string[] = [];
    for (const file of readdirSync(templatesDir)) {
      if (file.endsWith('.md') && !existsSync(join(personasDir, file))) {
        copyFileSync(join(templatesDir, file), join(personasDir, file));
        copied.push(file);
      }
    }
    if (copied.length > 0) {
      console.log(`✓ Persona templates installed: ${copied.join(', ')}`);
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
