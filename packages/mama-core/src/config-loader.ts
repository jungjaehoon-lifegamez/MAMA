/**
 * MAMA Configuration Loader
 *
 * Story M1.4: Configurable embedding model selection
 * Priority: P1 (Core Feature)
 *
 * Loads user configuration from ~/.mama/config.json with sensible defaults.
 * Supports:
 * - Model selection (default: multilingual-e5-small)
 * - Embedding dimensions
 * - Cache directory configuration
 *
 * @module config-loader
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { info, warn, error as logError } from './debug-logger.js';

export interface MAMAConfig {
  modelName: string;
  embeddingDim: number;
  cacheDir: string;
  [key: string]: unknown;
}

// Default configuration
export const DEFAULT_CONFIG: MAMAConfig = {
  modelName: 'Xenova/multilingual-e5-small',
  embeddingDim: 384,
  cacheDir: path.join(os.homedir(), '.cache', 'huggingface', 'transformers'),
};

// Config file path
const CONFIG_DIR = path.join(os.homedir(), '.mama');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

// Cached configuration
let cachedConfig: MAMAConfig | null = null;

/**
 * Ensure config directory exists
 */
function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    info(`[config] Created config directory: ${CONFIG_DIR}`);
  }
}

/**
 * Create default config file if it doesn't exist
 */
function ensureConfigFile(): void {
  if (!fs.existsSync(CONFIG_PATH)) {
    ensureConfigDir();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
    info(`[config] Created default config file: ${CONFIG_PATH}`);
    info(`[config] Model: ${DEFAULT_CONFIG.modelName} (${DEFAULT_CONFIG.embeddingDim}-dim)`);
  }
}

/**
 * Load MAMA configuration from ~/.mama/config.json
 *
 * Story M1.4 AC #1: Config parser loads ~/.mama/config.json
 *
 * @param reload - Force reload from disk (default: false)
 * @returns Configuration object with modelName, embeddingDim, cacheDir
 */
export function loadConfig(reload = false): MAMAConfig {
  // Return cached config if available and not forcing reload
  if (cachedConfig && !reload) {
    return cachedConfig;
  }

  try {
    // Ensure config file exists
    ensureConfigFile();

    // Read and parse config file
    const configData = fs.readFileSync(CONFIG_PATH, 'utf8');
    const userConfig = JSON.parse(configData) as Partial<MAMAConfig>;

    // Merge with defaults (user config overrides)
    const config: MAMAConfig = {
      ...DEFAULT_CONFIG,
      ...userConfig,
    };

    // Validate configuration
    if (!config.modelName || typeof config.modelName !== 'string') {
      warn('[config] Invalid modelName, using default:', DEFAULT_CONFIG.modelName);
      config.modelName = DEFAULT_CONFIG.modelName;
    }

    if (!Number.isInteger(config.embeddingDim) || config.embeddingDim <= 0) {
      warn('[config] Invalid embeddingDim, using default:', DEFAULT_CONFIG.embeddingDim);
      config.embeddingDim = DEFAULT_CONFIG.embeddingDim;
    }

    if (!config.cacheDir || typeof config.cacheDir !== 'string') {
      warn('[config] Invalid cacheDir, using default:', DEFAULT_CONFIG.cacheDir);
      config.cacheDir = DEFAULT_CONFIG.cacheDir;
    }

    // Cache the loaded config
    cachedConfig = config;

    // Log loaded configuration
    if (reload) {
      info(`[config] Configuration reloaded from ${CONFIG_PATH}`);
      info(`[config] Model: ${config.modelName} (${config.embeddingDim}-dim)`);
      info(`[config] Cache: ${config.cacheDir}`);
    }

    return config;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`[config] Failed to load config file: ${message}`);
    logError('[config] Using default configuration');

    // Cache defaults on error
    cachedConfig = { ...DEFAULT_CONFIG };
    return cachedConfig;
  }
}

/**
 * Get current model name
 */
export function getModelName(): string {
  const config = loadConfig();
  return config.modelName;
}

/**
 * Get current embedding dimension
 */
export function getEmbeddingDim(): number {
  const config = loadConfig();
  return config.embeddingDim;
}

/**
 * Get current cache directory
 */
export function getCacheDir(): string {
  const config = loadConfig();
  return config.cacheDir;
}

export interface ConfigUpdates {
  modelName?: string;
  embeddingDim?: number;
  cacheDir?: string;
}

/**
 * Update configuration and save to file
 *
 * Story M1.4 AC #3: Changing model via config triggers informative log + resets caches
 *
 * @param updates - Configuration updates
 * @returns Success status
 */
export function updateConfig(updates: ConfigUpdates): boolean {
  try {
    ensureConfigFile();

    // Load current config
    const currentConfig = loadConfig();

    // Check if model is changing
    const modelChanged = updates.modelName && updates.modelName !== currentConfig.modelName;
    const dimChanged = updates.embeddingDim && updates.embeddingDim !== currentConfig.embeddingDim;

    // Merge updates
    const newConfig: MAMAConfig = {
      ...currentConfig,
      ...updates,
    };

    // Save to file
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2), 'utf8');

    // Update cache
    cachedConfig = newConfig;

    // Story M1.4 AC #3: Informative log when model changes
    if (modelChanged || dimChanged) {
      info('[config] ⚠️  Embedding model configuration changed');
      info(`[config] Old: ${currentConfig.modelName} (${currentConfig.embeddingDim}-dim)`);
      info(`[config] New: ${newConfig.modelName} (${newConfig.embeddingDim}-dim)`);
      info('[config] ⚡ Model cache will be reset on next embedding generation');
      info('[config] ⚡ Existing embeddings in database remain unchanged');
    }

    info(`[config] Configuration saved to ${CONFIG_PATH}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`[config] Failed to update config: ${message}`);
    return false;
  }
}

/**
 * Get config file path
 */
export function getConfigPath(): string {
  return CONFIG_PATH;
}
