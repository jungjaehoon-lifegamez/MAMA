#!/usr/bin/env node
/**
 * Core Module Sync Check Script
 *
 * Story 8.1: Detects drift between plugin and MCP server core modules
 *
 * Compares files in:
 * - packages/claude-code-plugin/src/core/
 * - packages/mcp-server/src/mama/
 *
 * Usage:
 *   node scripts/sync-check.js [--verbose] [--json]
 *
 * Exit codes:
 *   0 - All shared modules are in sync
 *   1 - Drift detected (modules differ)
 *   2 - Error during execution
 *
 * @module sync-check
 * @version 1.0.0
 * @date 2025-11-25
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Configuration
const PLUGIN_CORE = path.resolve(__dirname, '../packages/claude-code-plugin/src/core');
const SERVER_MAMA = path.resolve(__dirname, '../packages/mcp-server/src/mama');

// Parse arguments
const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose') || args.includes('-v');
const JSON_OUTPUT = args.includes('--json');

/**
 * Calculate MD5 hash of file content
 * @param {string} filePath - Path to file
 * @returns {string|null} MD5 hash or null if file doesn't exist
 */
function getFileHash(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return crypto.createHash('md5').update(content).digest('hex');
  } catch (error) {
    return null;
  }
}

/**
 * Get file size
 * @param {string} filePath - Path to file
 * @returns {number|null} File size in bytes or null
 */
function getFileSize(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return stats.size;
  } catch (error) {
    return null;
  }
}

/**
 * Compare two files and calculate similarity
 * @param {string} file1 - First file path
 * @param {string} file2 - Second file path
 * @returns {Object} Comparison result
 */
function compareFiles(file1, file2) {
  const content1 = fs.existsSync(file1) ? fs.readFileSync(file1, 'utf8') : null;
  const content2 = fs.existsSync(file2) ? fs.readFileSync(file2, 'utf8') : null;

  if (!content1 && !content2) {
    return { status: 'both_missing', similarity: 0 };
  }
  if (!content1) {
    return { status: 'missing_plugin', similarity: 0 };
  }
  if (!content2) {
    return { status: 'missing_server', similarity: 0 };
  }

  const hash1 = crypto.createHash('md5').update(content1).digest('hex');
  const hash2 = crypto.createHash('md5').update(content2).digest('hex');

  if (hash1 === hash2) {
    return { status: 'identical', similarity: 100 };
  }

  // Calculate line-based similarity
  const lines1 = content1.split('\n');
  const lines2 = content2.split('\n');
  const set1 = new Set(lines1.map((l) => l.trim()).filter((l) => l.length > 0));
  const set2 = new Set(lines2.map((l) => l.trim()).filter((l) => l.length > 0));

  const intersection = [...set1].filter((x) => set2.has(x)).length;
  const union = new Set([...set1, ...set2]).size;
  const similarity = union > 0 ? Math.round((intersection / union) * 100) : 0;

  return { status: 'modified', similarity };
}

/**
 * Main sync check function
 */
function runSyncCheck() {
  const results = {
    timestamp: new Date().toISOString(),
    pluginPath: PLUGIN_CORE,
    serverPath: SERVER_MAMA,
    modules: [],
    summary: {
      total: 0,
      identical: 0,
      modified: 0,
      pluginOnly: 0,
      serverOnly: 0,
      avgSimilarity: 0,
    },
  };

  // Get all module files
  const pluginFiles = fs.existsSync(PLUGIN_CORE)
    ? fs.readdirSync(PLUGIN_CORE).filter((f) => f.endsWith('.js'))
    : [];

  const serverFiles = fs.existsSync(SERVER_MAMA)
    ? fs.readdirSync(SERVER_MAMA).filter((f) => f.endsWith('.js'))
    : [];

  // Combine unique module names
  const allModules = new Set([...pluginFiles, ...serverFiles]);
  results.summary.total = allModules.size;

  let totalSimilarity = 0;
  let comparedCount = 0;

  for (const moduleName of [...allModules].sort()) {
    const pluginPath = path.join(PLUGIN_CORE, moduleName);
    const serverPath = path.join(SERVER_MAMA, moduleName);

    const pluginExists = fs.existsSync(pluginPath);
    const serverExists = fs.existsSync(serverPath);

    const comparison = compareFiles(pluginPath, serverPath);

    const moduleResult = {
      name: moduleName,
      pluginExists,
      serverExists,
      status: comparison.status,
      similarity: comparison.similarity,
    };

    if (pluginExists) {
      moduleResult.pluginSize = getFileSize(pluginPath);
      moduleResult.pluginHash = getFileHash(pluginPath);
    }
    if (serverExists) {
      moduleResult.serverSize = getFileSize(serverPath);
      moduleResult.serverHash = getFileHash(serverPath);
    }

    results.modules.push(moduleResult);

    // Update summary
    switch (comparison.status) {
      case 'identical':
        results.summary.identical++;
        totalSimilarity += 100;
        comparedCount++;
        break;
      case 'modified':
        results.summary.modified++;
        totalSimilarity += comparison.similarity;
        comparedCount++;
        break;
      case 'missing_server':
        results.summary.pluginOnly++;
        break;
      case 'missing_plugin':
        results.summary.serverOnly++;
        break;
    }
  }

  results.summary.avgSimilarity =
    comparedCount > 0 ? Math.round(totalSimilarity / comparedCount) : 0;

  return results;
}

/**
 * Format results for console output
 */
function formatConsoleOutput(results) {
  const lines = [];

  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('  MAMA Core Module Sync Check');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');
  lines.push(`  Plugin:  ${results.pluginPath}`);
  lines.push(`  Server:  ${results.serverPath}`);
  lines.push(`  Time:    ${results.timestamp}`);
  lines.push('');
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push('  Module Comparison Results');
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push('');

  // Group modules by status
  const identical = results.modules.filter((m) => m.status === 'identical');
  const modified = results.modules.filter((m) => m.status === 'modified');
  const pluginOnly = results.modules.filter((m) => m.status === 'missing_server');
  const serverOnly = results.modules.filter((m) => m.status === 'missing_plugin');

  // Identical modules
  if (identical.length > 0) {
    lines.push(`  ✅ IDENTICAL (${identical.length}):`);
    for (const m of identical) {
      lines.push(`     • ${m.name}`);
    }
    lines.push('');
  }

  // Modified modules (with drift)
  if (modified.length > 0) {
    lines.push(`  ⚠️  MODIFIED (${modified.length}) - Drift Detected:`);
    for (const m of modified.sort((a, b) => a.similarity - b.similarity)) {
      const bar =
        '█'.repeat(Math.floor(m.similarity / 10)) + '░'.repeat(10 - Math.floor(m.similarity / 10));
      lines.push(`     • ${m.name.padEnd(25)} [${bar}] ${m.similarity}%`);
    }
    lines.push('');
  }

  // Plugin-only modules
  if (pluginOnly.length > 0) {
    lines.push(`  📦 PLUGIN ONLY (${pluginOnly.length}):`);
    for (const m of pluginOnly) {
      lines.push(`     • ${m.name}`);
    }
    lines.push('');
  }

  // Server-only modules
  if (serverOnly.length > 0) {
    lines.push(`  🖥️  SERVER ONLY (${serverOnly.length}):`);
    for (const m of serverOnly) {
      lines.push(`     • ${m.name}`);
    }
    lines.push('');
  }

  // Summary
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push('  Summary');
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push('');
  lines.push(`  Total Modules:     ${results.summary.total}`);
  lines.push(
    `  Identical:         ${results.summary.identical} (${Math.round((results.summary.identical / results.summary.total) * 100)}%)`
  );
  lines.push(`  Modified:          ${results.summary.modified}`);
  lines.push(`  Plugin Only:       ${results.summary.pluginOnly}`);
  lines.push(`  Server Only:       ${results.summary.serverOnly}`);
  lines.push(`  Avg Similarity:    ${results.summary.avgSimilarity}%`);
  lines.push('');

  // Drift status
  const hasDrift = results.summary.modified > 0;
  if (hasDrift) {
    lines.push('  ❌ DRIFT DETECTED - Some modules have diverged');
    lines.push('');
    lines.push('  Recommended actions:');
    lines.push('  1. Review modified modules for intentional differences');
    lines.push('  2. Sync changes if they should be shared');
    lines.push('  3. Document intentional divergences in CLAUDE.md');
  } else {
    lines.push('  ✅ NO DRIFT - All shared modules are in sync');
  }
  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');

  return lines.join('\n');
}

/**
 * Main entry point
 */
function main() {
  try {
    const results = runSyncCheck();

    if (JSON_OUTPUT) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log(formatConsoleOutput(results));
    }

    // Exit with appropriate code
    const hasDrift = results.summary.modified > 0;
    process.exit(hasDrift ? 1 : 0);
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    if (VERBOSE) {
      console.error(error.stack);
    }
    process.exit(2);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

module.exports = { runSyncCheck, compareFiles };
