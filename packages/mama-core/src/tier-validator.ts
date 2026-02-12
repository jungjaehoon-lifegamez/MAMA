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
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

export interface CheckResult {
  status: 'pass' | 'fail';
  details: string;
}

export interface NamedCheckResult extends CheckResult {
  name: string;
}

export interface TierValidation {
  tier: 1 | 2;
  checks: NamedCheckResult[];
}

/**
 * Validates Node.js version requirement
 */
export function checkNodeVersion(): CheckResult {
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
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'fail',
      details: `Error checking version: ${message}`,
    };
  }
}

/**
 * Validates SQLite (better-sqlite3) availability
 */
export function checkSQLite(): CheckResult {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');

    // Test instantiation with in-memory database
    const testDb = new Database(':memory:');
    testDb.close();

    return {
      status: 'pass',
      details: 'better-sqlite3 native module ready',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'fail',
      details: `better-sqlite3 not available: ${message}`,
    };
  }
}

/**
 * Validates embedding model availability
 */
export function checkEmbeddings(): CheckResult {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getModelName } = require('./embeddings');
    const modelName = getModelName() as string;

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
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'fail',
      details: `Error checking embeddings: ${message}`,
    };
  }
}

/**
 * Validates database file accessibility
 */
export function checkDatabase(): CheckResult {
  try {
    const dbPath = process.env.MAMA_DB_PATH || path.join(os.homedir(), '.claude', 'mama-memory.db');
    const dbDir = path.dirname(dbPath);

    // Check if directory exists or can be created
    if (!fs.existsSync(dbDir)) {
      try {
        fs.mkdirSync(dbDir, { recursive: true });
      } catch (mkdirErr) {
        const message = mkdirErr instanceof Error ? mkdirErr.message : String(mkdirErr);
        return {
          status: 'fail',
          details: `Cannot create database directory: ${message}`,
        };
      }
    }

    // Check write access
    try {
      fs.accessSync(dbDir, fs.constants.W_OK);
    } catch {
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
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'fail',
      details: `Error checking database: ${message}`,
    };
  }
}

/**
 * Validates MAMA tier status
 *
 * Performs all system checks and determines tier:
 * - Tier 1: All checks pass (full features)
 * - Tier 2: One or more checks fail (degraded mode)
 */
export async function validateTier(): Promise<TierValidation> {
  const checks: NamedCheckResult[] = [
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
 */
export function getTierDescription(tier: number): string {
  const descriptions: Record<number, string> = {
    1: 'Full Features - All systems operational',
    2: 'Degraded Mode - Some features unavailable',
  };

  return descriptions[tier] || 'Unknown Tier';
}

/**
 * Get tier status banner
 */
export function getTierBanner(validation: TierValidation): string {
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
