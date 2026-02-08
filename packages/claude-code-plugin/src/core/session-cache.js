/**
 * Session-Scoped Cache for MAMA Hooks
 *
 * Uses CLAUDE_ENV_FILE for cross-hook persistence within a single Claude Code session.
 * Content-hash deduplication prevents duplicate injections across multiple hook invocations.
 *
 * Features:
 * - Base64-encoded JSON storage in environment variables
 * - Content hash tracking (djb2 algorithm, no crypto dependency)
 * - Fallback to in-memory Map if CLAUDE_ENV_FILE not available
 * - Synchronous operations (required for hook performance)
 *
 * @module session-cache
 */

const fs = require('fs');

// In-memory fallback cache (used when CLAUDE_ENV_FILE not set)
const memoryCache = new Map();
const contentHashes = new Set();

/**
 * Simple djb2 hash function (no crypto dependency)
 * Used for content deduplication
 *
 * @param {string} content - Content to hash
 * @returns {string} Hash string
 */
function createContentHash(content) {
  if (!content || typeof content !== 'string') {
    throw new Error('Content must be a non-empty string');
  }

  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = (hash << 5) + hash + content.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }

  return Math.abs(hash).toString(16);
}

/**
 * Check if content hash has been seen in this session
 *
 * @param {string} hash - Content hash
 * @returns {boolean} True if hash already seen
 */
function hasContentHash(hash) {
  if (!hash || typeof hash !== 'string') {
    return false;
  }

  return contentHashes.has(hash);
}

/**
 * Add content hash to seen set
 *
 * @param {string} hash - Content hash
 */
function addContentHash(hash) {
  if (!hash || typeof hash !== 'string') {
    throw new Error('Hash must be a non-empty string');
  }

  contentHashes.add(hash);
}

/**
 * Initialize cache by writing initial cache vars to CLAUDE_ENV_FILE
 * Called once per session (typically in SessionStart hook)
 *
 * @param {string} envFile - Path to CLAUDE_ENV_FILE
 * @returns {boolean} Success status
 */
function initCache(envFile) {
  if (!envFile || typeof envFile !== 'string') {
    return false;
  }

  try {
    // Check if file exists and is writable
    if (!fs.existsSync(envFile)) {
      // Create empty file if it doesn't exist
      fs.writeFileSync(envFile, '', 'utf8');
    }

    // Initialize empty cache variables
    const initVars = [
      'export MAMA_CACHE_AGENTS=""',
      'export MAMA_CACHE_RULES=""',
      'export MAMA_CACHE_CONTRACTS=""',
    ];

    // Append to file (don't overwrite)
    fs.appendFileSync(envFile, '\n' + initVars.join('\n') + '\n', 'utf8');

    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Get cache value from process.env (inherited from CLAUDE_ENV_FILE)
 * Cache is stored as base64-encoded JSON
 *
 * @param {string} key - Cache key (e.g., 'AGENTS', 'RULES')
 * @returns {Object|null} Parsed cache data or null
 */
function getCache(key) {
  if (!key || typeof key !== 'string') {
    return null;
  }

  try {
    const envKey = `MAMA_CACHE_${key.toUpperCase()}`;

    // Try to get from process.env first (inherited from CLAUDE_ENV_FILE)
    let value = process.env[envKey];

    // Fallback to memory cache
    if (!value) {
      value = memoryCache.get(envKey);
    }

    if (!value) {
      return null;
    }

    // Decode base64 and parse JSON
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch (error) {
    return null;
  }
}

/**
 * Set cache value and write to CLAUDE_ENV_FILE
 * Cache is stored as base64-encoded JSON
 *
 * @param {string} key - Cache key (e.g., 'AGENTS', 'RULES')
 * @param {Object} data - Data to cache
 * @param {string} envFile - Path to CLAUDE_ENV_FILE (optional)
 * @returns {boolean} Success status
 */
function setCache(key, data, envFile) {
  if (!key || typeof key !== 'string') {
    return false;
  }

  if (!data || typeof data !== 'object') {
    return false;
  }

  try {
    const envKey = `MAMA_CACHE_${key.toUpperCase()}`;

    // Encode data as base64 JSON
    const encoded = Buffer.from(JSON.stringify(data)).toString('base64');

    // Store in memory cache
    memoryCache.set(envKey, encoded);

    // If CLAUDE_ENV_FILE provided, update or append to it
    if (envFile && typeof envFile === 'string') {
      const exportLine = `export ${envKey}="${encoded}"`;

      // Read existing file content to avoid duplicates
      let fileContent = '';
      if (fs.existsSync(envFile)) {
        fileContent = fs.readFileSync(envFile, 'utf8');
      }

      // Check if the key already exists
      const keyPattern = new RegExp(`^export ${envKey}=.*$`, 'm');
      if (keyPattern.test(fileContent)) {
        // Replace existing line
        fileContent = fileContent.replace(keyPattern, exportLine);
        fs.writeFileSync(envFile, fileContent, 'utf8');
      } else {
        // Append new line
        fs.appendFileSync(envFile, exportLine + '\n', 'utf8');
      }
    }

    return true;
  } catch (error) {
    console.warn(
      `[SessionCache] Failed to set cache for key=${key}:`,
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}

/**
 * Clear all session cache (memory and env vars)
 * Note: Cannot clear env vars already exported, only clears in-memory state
 */
function clearCache() {
  memoryCache.clear();
  contentHashes.clear();
}

module.exports = {
  initCache,
  getCache,
  setCache,
  hasContentHash,
  addContentHash,
  createContentHash,
  clearCache,
};
