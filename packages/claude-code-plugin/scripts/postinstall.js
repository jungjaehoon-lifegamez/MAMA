#!/usr/bin/env node
/**
 * MAMA Plugin Postinstall Script
 *
 * Story M3.4: Installation & Tier Detection
 *
 * Checks:
 * 1. Node.js version (>=18.0.0)
 * 2. Disk space (>=100MB)
 * 3. SQLite native module (better-sqlite3)
 * 4. Embedding support (@huggingface/transformers)
 * 5. Tier detection and reporting
 *
 * Exit codes:
 * 0 - Installation successful
 * 1 - Critical failure (Node version, disk space)
 *
 * Tier levels:
 * Tier 1 - Full features (SQLite + Transformers.js)
 * Tier 2 - Degraded (exact match only, no vector search)
 */

const fs = require('fs');
const path = require('path');

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

function log(color, message) {
  console.log(`${color}${message}${colors.reset}`);
}

function printBox(title, content, color = colors.green) {
  const width = 60;
  const border = '━'.repeat(width);

  console.log(`\n${color}┏${border}┓${colors.reset}`);
  console.log(`${color}┃${colors.bold} ${title.padEnd(width - 1)}${colors.reset}${color}┃${colors.reset}`);
  console.log(`${color}┣${border}┫${colors.reset}`);

  if (Array.isArray(content)) {
    content.forEach(line => {
      console.log(`${color}┃${colors.reset} ${line.padEnd(width - 1)} ${color}┃${colors.reset}`);
    });
  } else {
    console.log(`${color}┃${colors.reset} ${content.padEnd(width - 1)} ${color}┃${colors.reset}`);
  }

  console.log(`${color}┗${border}┛${colors.reset}\n`);
}

/**
 * Check Node.js version
 * AC1: engines.node >=18 check with descriptive errors
 */
function checkNodeVersion() {
  const requiredVersion = '18.0.0';
  const currentVersion = process.version.replace('v', '');

  log(colors.cyan, `🔍 Checking Node.js version...`);
  log(colors.cyan, `   Current: ${currentVersion}, Required: >=${requiredVersion}`);

  const [major, minor, patch] = currentVersion.split('.').map(Number);
  const [reqMajor, reqMinor, reqPatch] = requiredVersion.split('.').map(Number);

  if (major < reqMajor || (major === reqMajor && minor < reqMinor) || (major === reqMajor && minor === reqMinor && patch < reqPatch)) {
    log(colors.red, `\n❌ Node.js ${requiredVersion}+ required (found: ${process.version})`);
    log(colors.yellow, `\nFix options:`);
    log(colors.yellow, `  • Using nvm: nvm install 22 && nvm use 22`);
    log(colors.yellow, `  • Download: https://nodejs.org`);
    log(colors.yellow, `  • Package manager:`);
    log(colors.yellow, `    - macOS: brew install node@22`);
    log(colors.yellow, `    - Ubuntu: sudo apt install nodejs (via NodeSource)`);
    log(colors.yellow, `    - Windows: choco install nodejs-lts`);
    process.exit(1);
  }

  log(colors.green, '✅ Node.js version compatible\n');
  return true;
}

/**
 * Check disk space
 * AC4: Disk space checks with OS-specific instructions
 */
function checkDiskSpace() {
  log(colors.cyan, '🔍 Checking disk space...');

  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    if (!homeDir) {
      log(colors.yellow, '⚠️  Could not determine home directory, skipping disk check');
      return true;
    }

    const stats = fs.statfsSync(homeDir);
    const availableBytes = stats.bavail * stats.bsize;
    const availableMB = Math.round(availableBytes / (1024 * 1024));
    const requiredMB = 100;

    log(colors.cyan, `   Required: ${requiredMB}MB, Available: ${availableMB}MB`);

    if (availableMB < requiredMB) {
      log(colors.red, `\n❌ Insufficient disk space for database`);
      log(colors.yellow, `\nFix options by OS:`);
      log(colors.yellow, `  • macOS: ~/Library/Caches cleanup, brew cleanup`);
      log(colors.yellow, `  • Linux: sudo apt clean, clear ~/.cache`);
      log(colors.yellow, `  • Windows: Disk Cleanup, clear %TEMP%`);
      process.exit(1);
    }

    log(colors.green, `✅ Disk space sufficient (${availableMB}MB available)\n`);
    return true;
  } catch (error) {
    log(colors.yellow, `⚠️  Could not verify disk space: ${error.message}`);
    log(colors.yellow, `   Proceeding anyway...\n`);
    return true;
  }
}

/**
 * Check SQLite native module
 * AC2: Attempt to load better-sqlite3, enable Tier 2 on failure
 */
function checkSQLite() {
  log(colors.cyan, '🔍 Checking SQLite native module (better-sqlite3)...');

  try {
    const Database = require('better-sqlite3');

    // Quick smoke test: create in-memory DB
    const db = new Database(':memory:');
    db.exec('CREATE TABLE test (id INTEGER)');
    db.close();

    log(colors.green, '✅ SQLite native module working\n');
    return { available: true, tier: 1 };
  } catch (error) {
    log(colors.yellow, `⚠️  SQLite native module failed: ${error.message}`);
    log(colors.yellow, `\nFalling back to Tier 2 (degraded mode)`);
    log(colors.yellow, `\nTo fix (optional - for better performance):`);

    const platform = process.platform;
    if (platform === 'darwin') {
      log(colors.yellow, `  • macOS: xcode-select --install`);
      log(colors.yellow, `  • Then: npm rebuild better-sqlite3`);
    } else if (platform === 'linux') {
      log(colors.yellow, `  • Linux: sudo apt install build-essential python3`);
      log(colors.yellow, `  • Then: npm rebuild better-sqlite3`);
    } else if (platform === 'win32') {
      log(colors.yellow, `  • Windows: npm install --global windows-build-tools`);
      log(colors.yellow, `  • Then: npm rebuild better-sqlite3`);
    }

    log(colors.yellow, `\nTier 2 features:`);
    log(colors.yellow, `  - Exact match search only (no vector search)`);
    log(colors.yellow, `  - 40% accuracy (vs 80% in Tier 1)`);
    log(colors.yellow, `  - All data still saved and retrievable\n`);

    return { available: false, tier: 2, reason: 'SQLite native module unavailable' };
  }
}

/**
 * Check embedding support
 * AC2: Detect Transformers.js availability
 */
function checkEmbeddings() {
  log(colors.cyan, '🔍 Checking embedding support (@huggingface/transformers)...');

  try {
    require('@huggingface/transformers');
    log(colors.green, '✅ Embedding support available\n');
    return { available: true };
  } catch (error) {
    log(colors.yellow, `⚠️  Transformers.js not available: ${error.message}`);
    log(colors.yellow, `   Vector search will be disabled (Tier 2 mode)\n`);
    return { available: false, reason: 'Transformers.js unavailable' };
  }
}

/**
 * Detect final tier
 * AC3: Report detected tier
 */
function detectTier(sqliteCheck, embeddingsCheck) {
  if (sqliteCheck.available && embeddingsCheck.available) {
    return {
      tier: 1,
      name: 'Full Features',
      accuracy: '80%',
      features: [
        '✅ Vector search (semantic similarity)',
        '✅ Graph search (decision evolution)',
        '✅ Recency weighting',
        '✅ Multi-language support (Korean-English)',
        '✅ Auto-context injection'
      ],
      performance: {
        embedding: '~3ms',
        search: '~50ms',
        hookLatency: '~100ms'
      }
    };
  } else {
    const reasons = [];
    if (!sqliteCheck.available) reasons.push(sqliteCheck.reason);
    if (!embeddingsCheck.available) reasons.push(embeddingsCheck.reason);

    return {
      tier: 2,
      name: 'Degraded Mode',
      accuracy: '40%',
      features: [
        '⚠️  Exact match search only',
        '❌ No vector search',
        '❌ No semantic similarity',
        '✅ Graph search (decision evolution)',
        '✅ All data saved and retrievable'
      ],
      limitations: reasons,
      performance: {
        search: '~10ms (exact match)',
        hookLatency: '~50ms'
      }
    };
  }
}

/**
 * Print tier status
 * AC3: Successful install message with tier
 */
function printTierStatus(tierInfo) {
  const color = tierInfo.tier === 1 ? colors.green : colors.yellow;
  const icon = tierInfo.tier === 1 ? '✅' : '⚠️';

  printBox(
    `${icon} MAMA Plugin Installed Successfully`,
    [
      ``,
      `Tier: ${tierInfo.tier} (${tierInfo.name})`,
      `Accuracy: ${tierInfo.accuracy}`,
      ``,
      `Features:`,
      ...tierInfo.features.map(f => `  ${f}`),
      ``,
      `Performance:`,
      ...Object.entries(tierInfo.performance).map(([k, v]) => `  • ${k}: ${v}`)
    ],
    color
  );

  if (tierInfo.tier === 2) {
    log(colors.yellow, 'ℹ️  You\'re running in Tier 2 (degraded mode)');
    log(colors.yellow, '   This is fully functional but with reduced accuracy.');
    log(colors.yellow, '   See installation instructions above to upgrade to Tier 1.\n');
  }

  log(colors.cyan, 'Next steps:');
  log(colors.cyan, '  1. Restart Claude Code (plugin will auto-load)');
  log(colors.cyan, '  2. Try: /mama-list to see recent decisions');
  log(colors.cyan, '  3. Try: /mama-save to save your first decision');
  log(colors.cyan, '  4. Docs: See README.md for full guide\n');
}

/**
 * Save tier configuration
 */
function saveTierConfig(tierInfo) {
  const configDir = path.join(process.env.HOME || process.env.USERPROFILE, '.mama');
  const configPath = path.join(configDir, 'config.json');

  try {
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    let config = {};
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }

    config.tier = tierInfo.tier;
    config.tier_detected_at = new Date().toISOString();
    config.tier_name = tierInfo.name;

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    log(colors.green, `✅ Tier configuration saved to ${configPath}\n`);
  } catch (error) {
    log(colors.yellow, `⚠️  Could not save tier config: ${error.message}\n`);
  }
}

/**
 * Main installation flow
 */
function main() {
  console.log('\n' + '='.repeat(70));
  log(colors.blue + colors.bold, '🧠 MAMA Plugin - Installation & Compatibility Check');
  console.log('='.repeat(70) + '\n');

  try {
    // AC1: Node version check
    checkNodeVersion();

    // AC4: Disk space check
    checkDiskSpace();

    // AC2: SQLite check
    const sqliteCheck = checkSQLite();

    // AC2: Embeddings check
    const embeddingsCheck = checkEmbeddings();

    // AC3: Tier detection
    const tierInfo = detectTier(sqliteCheck, embeddingsCheck);

    // Save tier config
    saveTierConfig(tierInfo);

    // AC3: Print success message with tier
    printTierStatus(tierInfo);

  } catch (error) {
    log(colors.red, `\n❌ Installation failed: ${error.message}`);
    log(colors.red, `   Stack: ${error.stack}\n`);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

// Export for testing
module.exports = {
  checkNodeVersion,
  checkDiskSpace,
  checkSQLite,
  checkEmbeddings,
  detectTier
};
