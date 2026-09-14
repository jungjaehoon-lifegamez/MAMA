#!/usr/bin/env node
/**
 * MAMA Plugin Postinstall Script
 *
 * Story M3.4: Installation & readiness reporting
 *
 * Checks:
 * 1. Node.js version (>=22.13.0)
 * 2. Disk space (>=100MB)
 * 3. SQLite support (node:sqlite)
 * 4. Embedding support (via @jungjaehoon/mama-core)
 * 5. Readiness reporting
 *
 * Either requirement 3 or 4 being absent makes the plugin unusable. There is no
 * degraded mode to fall back to, so the report says so rather than calling the
 * install successful.
 *
 * Exit codes:
 * 0 - the package is installed; the report says whether it can run
 * 1 - Critical failure (Node version, disk space)
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
  console.log(
    `${color}┃${colors.bold} ${title.padEnd(width - 1)}${colors.reset}${color}┃${colors.reset}`
  );
  console.log(`${color}┣${border}┫${colors.reset}`);

  if (Array.isArray(content)) {
    content.forEach((line) => {
      console.log(`${color}┃${colors.reset} ${line.padEnd(width - 1)} ${color}┃${colors.reset}`);
    });
  } else {
    console.log(`${color}┃${colors.reset} ${content.padEnd(width - 1)} ${color}┃${colors.reset}`);
  }

  console.log(`${color}┗${border}┛${colors.reset}\n`);
}

/**
 * Check Node.js version
 * AC1: engines.node >=22 check with descriptive errors
 */
function checkNodeVersion() {
  const requiredVersion = '22.13.0';
  const currentVersion = process.version.replace('v', '');

  log(colors.cyan, `🔍 Checking Node.js version...`);
  log(colors.cyan, `   Current: ${currentVersion}, Required: >=${requiredVersion}`);

  const [major, minor, patch] = currentVersion.split('.').map(Number);
  const [reqMajor, reqMinor, reqPatch] = requiredVersion.split('.').map(Number);

  if (
    major < reqMajor ||
    (major === reqMajor && minor < reqMinor) ||
    (major === reqMajor && minor === reqMinor && patch < reqPatch)
  ) {
    log(colors.red, `\n❌ Node.js ${requiredVersion}+ required (found: ${process.version})`);
    log(colors.yellow, `\nFix options:`);
    log(colors.yellow, `  • Using nvm: nvm install 22.13.0 && nvm use 22.13.0`);
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
 * Check SQLite support
 * AC2: Attempt to load node:sqlite; the database cannot open without it
 */
function checkSQLite() {
  log(colors.cyan, '🔍 Checking SQLite support (node:sqlite)...');

  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE test (id INTEGER)');
    db.close();

    log(colors.green, '✅ SQLite support available via node:sqlite\n');
    return { available: true, driver: 'node:sqlite' };
  } catch (nodeSqliteError) {
    const nodeSqliteMessage = String(
      nodeSqliteError instanceof Error ? nodeSqliteError.message : nodeSqliteError
    ).split('\n')[0];
    log(colors.red, `❌ SQLite support unavailable: node:sqlite failed (${nodeSqliteMessage})`);
    log(colors.red, `\nMAMA cannot open its database without it. Nothing will be saved or read.`);
    log(colors.red, `\nTo fix: use Node 22.13+, which has node:sqlite built in.\n`);

    return {
      available: false,
      reason: `node:sqlite unavailable (${nodeSqliteMessage})`,
      breaks: 'the database cannot be opened; no memory is saved or read',
      fix: 'use Node 22.13 or newer, which ships node:sqlite',
    };
  }
}

/**
 * Check embedding support
 * AC2: Detect embedding stack availability
 */
function checkEmbeddings() {
  log(colors.cyan, '🔍 Checking embedding support (via @jungjaehoon/mama-core)...');

  try {
    const mamaCoreEntry = require.resolve('@jungjaehoon/mama-core');
    const mamaCoreDir = path.dirname(mamaCoreEntry);
    require.resolve('@huggingface/transformers', { paths: [mamaCoreDir] });
    log(colors.green, '✅ Embedding support available\n');
    return { available: true };
  } catch (error) {
    const firstLine = String(error.message).split('\n')[0];
    log(colors.red, `❌ Embedding stack not available via mama-core: ${firstLine}`);
    log(colors.red, `   Every save and search will fail; there is no non-embedding search path.\n`);
    return {
      available: false,
      reason: `embedding stack unavailable via mama-core (${firstLine})`,
      breaks: 'every save and search throws; there is no exact-match fallback',
      fix: 'reinstall so @huggingface/transformers resolves from @jungjaehoon/mama-core',
    };
  }
}

/**
 * Assess whether this install can actually run.
 *
 * There is no degraded mode. If a requirement is missing, the corresponding
 * feature does not fall back to something weaker - it throws at first use. So
 * this reports readiness and what is missing, not a quality level.
 */
function assessReadiness(sqliteCheck, embeddingsCheck) {
  const missing = [];
  if (!sqliteCheck.available) {
    missing.push(sqliteCheck);
  }
  if (!embeddingsCheck.available) {
    missing.push(embeddingsCheck);
  }
  return { ready: missing.length === 0, missing };
}

/**
 * Print the readiness report
 * AC3: Say plainly whether this install can run
 */
function clip(line, width = 58) {
  return line.length <= width ? line : `${line.slice(0, width - 1)}\u2026`;
}

function printReadiness(readiness) {
  if (readiness.ready) {
    printBox(
      '\u2705 MAMA Plugin Installed',
      [
        ``,
        `Vector search over the local embedding model,`,
        `with FTS5 alongside it.`,
        ``,
        `First query loads the model (~1s).`,
        `Later queries reuse it (~89ms).`,
      ],
      colors.green
    );
    log(colors.cyan, 'Next steps:');
    log(colors.cyan, '  1. Restart Claude Code (plugin will auto-load)');
    log(colors.cyan, '  2. Try: /mama-list to see recent decisions');
    log(colors.cyan, '  3. Try: /mama-save to save your first decision\n');
    return;
  }

  printBox(
    '\u274c MAMA Plugin Installed But Not Usable',
    [
      ``,
      `The package is on disk, but a requirement is`,
      `missing. MAMA has no degraded mode: the affected`,
      `calls throw rather than returning less.`,
      ``,
      `Missing:`,
      ...readiness.missing.flatMap((item) => [
        clip(`  \u2022 ${item.reason}`),
        clip(`      breaks: ${item.breaks}`),
        clip(`      fix:    ${item.fix}`),
      ]),
    ],
    colors.red
  );
  log(colors.red, 'Fix the above and reinstall before using the plugin.\n');
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

    // AC3: Readiness
    const readiness = assessReadiness(sqliteCheck, embeddingsCheck);

    // AC3: Say plainly whether this install can run
    printReadiness(readiness);
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
  assessReadiness,
};
