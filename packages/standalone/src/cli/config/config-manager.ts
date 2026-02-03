/**
 * Configuration Manager for MAMA Standalone
 *
 * Manages YAML configuration file at ~/.mama/config.yaml
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import * as yaml from 'js-yaml';

import type { MAMAConfig } from './types.js';
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
    throw new Error(
      `Failed to load configuration: ${error instanceof Error ? error.message : String(error)}`
    );
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
 */
/**
 * Merge user config with defaults
 * SECURITY: Type guards ensure safe defaults for optional fields
 */
function mergeWithDefaults(config: Partial<MAMAConfig>): MAMAConfig {
  return {
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
    // Role-based permissions - with safe defaults
    roles: config.roles ?? DEFAULT_CONFIG.roles,
    // Claude CLI mode (ToS compliance) - with safe default
    use_claude_cli: config.use_claude_cli ?? DEFAULT_CONFIG.use_claude_cli,
    // Optional gateway configs - with safe defaults
    discord: config.discord ?? DEFAULT_CONFIG.discord,
    slack: config.slack ?? DEFAULT_CONFIG.slack,
    telegram: config.telegram ?? DEFAULT_CONFIG.telegram,
    chatwork: config.chatwork ?? DEFAULT_CONFIG.chatwork,
    heartbeat: config.heartbeat ?? DEFAULT_CONFIG.heartbeat,
  };
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
