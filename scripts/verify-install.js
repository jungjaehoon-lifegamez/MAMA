#!/usr/bin/env node
/**
 * MAMA Installation Verification Script
 *
 * Verifies MAMA installation by checking:
 * - Node.js version (>= 18.0.0)
 * - SQLite availability (better-sqlite3)
 * - Embedding model cache
 * - Database file accessibility
 *
 * Exit codes:
 * - 0: All checks passed (Tier 1)
 * - 1: One or more checks failed (Tier 2)
 *
 * Usage:
 *   node scripts/verify-install.js
 *   npm run verify
 *
 * @version 1.0.0
 * @date 2026-01-30
 */

const { validateTier, getTierDescription } = require('../packages/mama-core/src/tier-validator');

/**
 * Format check result with emoji
 *
 * @param {Object} check - Check result from tier-validator
 * @returns {string} Formatted check line
 */
function formatCheck(check) {
  const icon = check.status === 'pass' ? '✅' : '❌';
  const status = check.status === 'pass' ? 'PASS' : 'FAIL';
  return `${icon} ${check.name.padEnd(12)} ${status.padEnd(6)} ${check.details}`;
}

/**
 * Main verification function
 */
async function verify() {
  console.log('🔍 MAMA Installation Verification\n');
  console.log('═'.repeat(60));
  console.log();

  let result;
  try {
    result = await validateTier();
  } catch (error) {
    console.error('❌ Verification failed:', error.message);
    console.error('\nStack trace:', error.stack);
    process.exit(1);
  }

  const { tier, checks } = result;

  // Display each check
  console.log('System Requirements:');
  console.log('─'.repeat(60));
  checks.forEach((check) => {
    console.log(formatCheck(check));
  });
  console.log();

  // Display tier status
  console.log('═'.repeat(60));
  if (tier === 1) {
    console.log('✅ Installation verified - Tier 1');
    console.log(`   ${getTierDescription(tier)}`);
    console.log();
    console.log('🎉 MAMA is ready to use!');
    console.log();
    console.log('Next steps:');
    console.log('  • Claude Code: /mama-save to save your first decision');
    console.log('  • Claude Desktop: Use mama_save tool');
    console.log('  • Graph Viewer: http://localhost:3847/viewer');
    console.log();
    process.exit(0);
  } else {
    console.log('⚠️  Installation issues detected - Tier 2');
    console.log(`   ${getTierDescription(tier)}`);
    console.log();
    console.log('MAMA will run in degraded mode:');
    console.log('  • Semantic search disabled (keyword search only)');
    console.log('  • Some features may be unavailable');
    console.log();
    console.log('To upgrade to Tier 1:');
    console.log('  1. Fix the failed checks above');
    console.log('  2. See: docs/guides/tier-2-remediation.md');
    console.log('  3. Run this script again to verify');
    console.log();
    process.exit(1);
  }
}

// Run verification
verify().catch((err) => {
  console.error('❌ Verification failed:', err.message);
  console.error('\nStack trace:', err.stack);
  process.exit(1);
});
