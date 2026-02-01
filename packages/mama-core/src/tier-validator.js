/**
 * MAMA Tier Validator
 *
 * Centralized tier validation module for MAMA.
 * Validates system requirements and determines tier status (1 or 2).
 *
 * Tier 1: Full features (Node.js 18+, SQLite, Embeddings, Database)
 * Tier 2: Degraded mode (missing one or more requirements)
 *
 * @module tier-validator
 * @version 1.0
 * @date 2026-01-30
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { info: _info, warn: _warn, error: _logError } = require('./debug-logger');

/**
 * Validates Node.js version requirement
 *
 * @returns {Object} Check result { status: 'pass'|'fail', details: string }
 */
function checkNodeVersion() {
  try {
    const nodeVersion = process.versions.node;
    const majorVersion = parseInt(nodeVersion.split('.')[0], 10);

    if (majorVersion >= 18) {
      return {
        status: 'pass',
        details: `v${nodeVersion}`,
      };
    }

    return {
      status: 'fail',
      details: `v${nodeVersion} (requires 18+)`,
    };
  } catch (error) {
    return {
      status: 'fail',
      details: `Error checking version: ${error.message}`,
    };
  }
}

/**
 * Validates SQLite (better-sqlite3) availability
 *
 * Reuses logic from packages/mcp-server/scripts/postinstall.js
 *
 * @returns {Object} Check result { status: 'pass'|'fail', details: string }
 */
function checkSQLite() {
  try {
    // Try to require better-sqlite3
    const Database = require('better-sqlite3');

    // Test instantiation with in-memory database
    const testDb = new Database(':memory:');
    testDb.close();

    return {
      status: 'pass',
      details: 'better-sqlite3 native module ready',
    };
  } catch (error) {
    return {
      status: 'fail',
      details: `better-sqlite3 not available: ${error.message}`,
    };
  }
}

/**
 * Validates embedding model availability
 *
 * Checks if embedding model has been downloaded to cache directory.
 * Reuses logic from packages/mama-core/src/embeddings.js
 *
 * @returns {Object} Check result { status: 'pass'|'fail', details: string }
 */
function checkEmbeddings() {
  try {
    const { getModelName } = require('./embeddings');
    const modelName = getModelName();

    // Check if model is cached
    const cacheDir =
      process.env.HF_HOME ||
      process.env.TRANSFORMERS_CACHE ||
      path.join(os.homedir(), '.cache', 'huggingface', 'transformers');

    // Model cache structure: cache_dir/models--org--model/snapshots/hash/
    const modelPath = path.join(cacheDir, `models--${modelName.replace('/', '--')}`);

    if (fs.existsSync(modelPath)) {
      return {
        status: 'pass',
        details: `${modelName} (cached)`,
      };
    }

    return {
      status: 'fail',
      details: `${modelName} not cached (will download on first use)`,
    };
  } catch (error) {
    return {
      status: 'fail',
      details: `Error checking embeddings: ${error.message}`,
    };
  }
}

/**
 * Validates database file accessibility
 *
 * Tests write access to database location (~/.claude/mama-memory.db)
 *
 * @returns {Object} Check result { status: 'pass'|'fail', details: string }
 */
function checkDatabase() {
  try {
    const dbPath = process.env.MAMA_DB_PATH || path.join(os.homedir(), '.claude', 'mama-memory.db');

    const dbDir = path.dirname(dbPath);

    // Check if directory exists or can be created
    if (!fs.existsSync(dbDir)) {
      try {
        fs.mkdirSync(dbDir, { recursive: true });
      } catch (mkdirErr) {
        return {
          status: 'fail',
          details: `Cannot create database directory: ${mkdirErr.message}`,
        };
      }
    }

    // Check write access
    try {
      fs.accessSync(dbDir, fs.constants.W_OK);
    } catch (accessErr) {
      return {
        status: 'fail',
        details: `No write access to ${dbDir}`,
      };
    }

    return {
      status: 'pass',
      details: dbPath,
    };
  } catch (error) {
    return {
      status: 'fail',
      details: `Error checking database: ${error.message}`,
    };
  }
}

/**
 * Validates MAMA tier status
 *
 * Performs all system checks and determines tier:
 * - Tier 1: All checks pass (full features)
 * - Tier 2: One or more checks fail (degraded mode)
 *
 * @returns {Promise<Object>} Validation result
 * @returns {number} result.tier - 1 (full) or 2 (degraded)
 * @returns {Array} result.checks - Array of check results
 * @example
 * const { tier, checks } = await validateTier();
 * console.log(`MAMA Tier: ${tier}`);
 * checks.forEach(check => {
 *   console.log(`${check.name}: ${check.status} (${check.details})`);
 * });
 */
async function validateTier() {
  const checks = [
    {
      name: 'Node.js',
      ...checkNodeVersion(),
    },
    {
      name: 'SQLite',
      ...checkSQLite(),
    },
    {
      name: 'Embeddings',
      ...checkEmbeddings(),
    },
    {
      name: 'Database',
      ...checkDatabase(),
    },
  ];

  // Determine tier: all pass = tier 1, any fail = tier 2
  const tier = checks.every((c) => c.status === 'pass') ? 1 : 2;

  return {
    tier,
    checks,
  };
}

/**
 * Get user-friendly tier description
 *
 * @param {number} tier - Tier number (1 or 2)
 * @returns {string} Human-readable tier description
 * @example
 * const desc = getTierDescription(1);
 * console.log(desc); // "Full Features"
 */
function getTierDescription(tier) {
  const descriptions = {
    1: 'Full Features - All systems operational',
    2: 'Degraded Mode - Some features unavailable',
  };

  return descriptions[tier] || 'Unknown Tier';
}

/**
 * Get tier status banner
 *
 * Returns formatted banner showing tier and failed checks
 *
 * @param {Object} validation - Result from validateTier()
 * @returns {string} Formatted banner text
 */
function getTierBanner(validation) {
  const { tier, checks } = validation;
  const failedChecks = checks.filter((c) => c.status === 'fail');

  let banner = `\n┌─────────────────────────────────────────┐\n`;
  banner += `│ MAMA Tier ${tier}: ${getTierDescription(tier).split(' - ')[0]}\n`;

  if (failedChecks.length > 0) {
    banner += `│\n`;
    banner += `│ ⚠️  Issues detected:\n`;
    failedChecks.forEach((check) => {
      banner += `│ • ${check.name}: ${check.details}\n`;
    });
  } else {
    banner += `│ ✅ All systems operational\n`;
  }

  banner += `└─────────────────────────────────────────┘\n`;

  return banner;
}

// Export API
module.exports = {
  validateTier,
  getTierDescription,
  getTierBanner,
  // Internal checks (for testing)
  checkNodeVersion,
  checkSQLite,
  checkEmbeddings,
  checkDatabase,
};
