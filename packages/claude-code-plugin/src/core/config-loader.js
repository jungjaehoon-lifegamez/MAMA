// Synced from `@jungjaehoon/mama-core` (2026-02-08)
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

const fs = require('fs');
const path = require('path');
const os = require('os');
const { info, warn, error: logError } = require('./debug-logger');

// Default configuration
const DEFAULT_CONFIG = {
  modelName: 'Xenova/multilingual-e5-small',
  embeddingDim: 384,
  cacheDir: path.join(os.homedir(), '.cache', 'huggingface', 'transformers'),
};

// Config file path
const CONFIG_DIR = path.join(os.homedir(), '.mama');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

// Cached configuration
let cachedConfig = null;

/**
 * Ensure config directory exists
 * @returns {void}
 */
function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    info(`[config] Created config directory: ${CONFIG_DIR}`);
  }
}

/**
 * Create default config file if it doesn't exist
 * @returns {void}
 */
function ensureConfigFile() {
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
 * @param {boolean} reload - Force reload from disk (default: false)
 * @returns {Object} Configuration object with modelName, embeddingDim, cacheDir
 */
function loadConfig(reload = false) {
  // Return cached config if available and not forcing reload
  if (cachedConfig && !reload) {
    return cachedConfig;
  }

  try {
    // Ensure config file exists
    ensureConfigFile();

    // Read and parse config file
    const configData = fs.readFileSync(CONFIG_PATH, 'utf8');
    const userConfig = JSON.parse(configData);

    // Merge with defaults (user config overrides)
    const config = {
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
    logError(`[config] Failed to load config file: ${error.message}`);
    logError('[config] Using default configuration');

    // Cache defaults on error
    cachedConfig = { ...DEFAULT_CONFIG };
    return cachedConfig;
  }
}

/**
 * Get current model name
 * @returns {string} Current model name
 */
function getModelName() {
  const config = loadConfig();
  return config.modelName;
}

/**
 * Get current embedding dimension
 * @returns {number} Current embedding dimension
 */
function getEmbeddingDim() {
  const config = loadConfig();
  return config.embeddingDim;
}

/**
 * Get current cache directory
 * @returns {string} Current cache directory
 */
function getCacheDir() {
  const config = loadConfig();
  return config.cacheDir;
}

/**
 * Update configuration and save to file
 *
 * Story M1.4 AC #3: Changing model via config triggers informative log + resets caches
 *
 * @param {Object} updates - Configuration updates
 * @param {string} updates.modelName - New model name
 * @param {number} updates.embeddingDim - New embedding dimension
 * @param {string} updates.cacheDir - New cache directory
 * @returns {boolean} Success status
 */
function updateConfig(updates) {
  try {
    ensureConfigFile();

    // Load current config
    const currentConfig = loadConfig();

    // Check if model is changing
    const modelChanged = updates.modelName && updates.modelName !== currentConfig.modelName;
    const dimChanged = updates.embeddingDim && updates.embeddingDim !== currentConfig.embeddingDim;

    // Merge updates
    const newConfig = {
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
    logError(`[config] Failed to update config: ${error.message}`);
    return false;
  }
}

/**
 * Get config file path
 * @returns {string} Config file path
 */
function getConfigPath() {
  return CONFIG_PATH;
}

module.exports = {
  loadConfig,
  getModelName,
  getEmbeddingDim,
  getCacheDir,
  updateConfig,
  getConfigPath,
  DEFAULT_CONFIG,
};
