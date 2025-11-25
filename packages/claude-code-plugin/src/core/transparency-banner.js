/**
 * Transparency Banner Module
 *
 * Story M2.4: Transparency Banner
 *
 * Provides unified transparency/status reporting across all MAMA hooks.
 * Implements FR25-29: Tier status display, feature degradation visibility,
 * fix instructions, impact quantification, and state transition logging.
 *
 * @module transparency-banner
 */

const path = require('path');
const fs = require('fs');
const { info, warn } = require('./debug-logger');

// Tier transition log file
const PLUGIN_ROOT = path.resolve(__dirname, '../..');
const TIER_LOG_FILE = path.join(PLUGIN_ROOT, '.mama-tier-transitions.log');

/**
 * Feature status matrix
 * FR26: Shows which features are active/degraded
 */
const FEATURE_STATUS = {
  tier1: {
    vectorSearch: true,
    graphTraversal: true,
    keywordFallback: true,
    semanticSimilarity: true,
    accuracyDrop: 0,
  },
  tier2: {
    vectorSearch: false,
    graphTraversal: true,
    keywordFallback: true,
    semanticSimilarity: false,
    accuracyDrop: 30, // FR28: 30% accuracy drop without embeddings
  },
  tier3: {
    vectorSearch: false,
    graphTraversal: false,
    keywordFallback: false,
    semanticSimilarity: false,
    accuracyDrop: 100, // FR28: 100% - MAMA disabled
  },
};

/**
 * Fix instructions for degraded states
 * FR27: Provides actionable fix instructions
 */
const FIX_INSTRUCTIONS = {
  tier2: {
    title: 'Embedding Model Unavailable',
    steps: [
      '1. Install Transformers.js: npm install @xenova/transformers',
      '2. Configure model in ~/.mama/config.json:',
      '   { "embeddingModel": "Xenova/multilingual-e5-small" }',
      '3. Restart Claude Code to reload configuration',
    ],
    impact: 'Without embeddings, MAMA falls back to keyword search (30% less accurate)',
  },
  tier3: {
    title: 'MAMA Disabled',
    steps: [
      '1. Check MAMA_DISABLE_HOOKS environment variable',
      '2. Verify config.json exists: ~/.mama/config.json',
      '3. Enable vector search in config:',
      '   { "vectorSearchEnabled": true }',
      '4. Restart Claude Code',
    ],
    impact: 'MAMA features are completely disabled',
  },
};

/**
 * Log tier state transition
 * FR29: Logs all state transitions with timestamps
 *
 * @param {number} oldTier - Previous tier
 * @param {number} newTier - New tier
 * @param {string} reason - Reason for transition
 */
function logTierTransition(oldTier, newTier, reason) {
  try {
    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      transition: `Tier ${oldTier} → Tier ${newTier}`,
      reason,
      feature_impact: FEATURE_STATUS[`tier${newTier}`],
    };

    const logLine = JSON.stringify(entry) + '\n';
    fs.appendFileSync(TIER_LOG_FILE, logLine, 'utf8');

    if (oldTier !== newTier) {
      if (newTier > oldTier) {
        warn(`[Transparency] Tier degradation: ${oldTier} → ${newTier} (${reason})`);
      } else {
        info(`[Transparency] Tier upgrade: ${oldTier} → ${newTier} (${reason})`);
      }
    }
  } catch (error) {
    warn(`[Transparency] Failed to log tier transition: ${error.message}`);
  }
}

/**
 * Get last logged tier from transition log
 *
 * @returns {number|null} Last tier or null if no history
 */
function getLastLoggedTier() {
  try {
    if (!fs.existsSync(TIER_LOG_FILE)) {
      return null;
    }

    const content = fs.readFileSync(TIER_LOG_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);

    if (lines.length === 0) {
      return null;
    }

    const lastEntry = JSON.parse(lines[lines.length - 1]);
    const match = lastEntry.transition.match(/Tier \d+ → Tier (\d+)/);
    return match ? parseInt(match[1], 10) : null;
  } catch (error) {
    return null;
  }
}

/**
 * Format feature status line
 * FR26: Shows which features are active/degraded
 *
 * @param {number} tier - Current tier
 * @returns {string} Feature status string
 */
function formatFeatureStatus(tier) {
  const features = FEATURE_STATUS[`tier${tier}`];

  const status = [];
  status.push(`Vector Search: ${features.vectorSearch ? '✓' : '✗'}`);
  status.push(`Graph: ${features.graphTraversal ? '✓' : '✗'}`);
  status.push(`Keyword: ${features.keywordFallback ? '✓' : '✗'}`);

  return status.join(' | ');
}

/**
 * Format fix instructions
 * FR27: Provides fix instructions when features degraded
 *
 * @param {number} tier - Current tier
 * @returns {string} Fix instructions or empty string
 */
function formatFixInstructions(tier) {
  if (tier === 1) {
    return ''; // No fixes needed
  }

  const fix = FIX_INSTRUCTIONS[`tier${tier}`];
  if (!fix) {
    return '';
  }

  let output = `\n\n📋 ${fix.title}\n`;
  output += fix.steps.join('\n');
  output += `\n⚠️  Impact: ${fix.impact}`;

  return output;
}

/**
 * Format transparency banner
 * FR25-29: Unified transparency reporting
 *
 * @param {Object} tierInfo - Tier information {tier, vectorSearchEnabled, reason}
 * @param {number} latencyMs - Hook execution latency
 * @param {number} resultCount - Number of results found
 * @param {string} hookName - Hook name (UserPromptSubmit, PreToolUse, PostToolUse)
 * @param {Object} options - Optional parameters
 * @param {boolean} options.showFixInstructions - Include fix instructions (default: true)
 * @param {boolean} options.logTransition - Log tier transition (default: true)
 * @returns {string} Formatted banner
 */
function formatTransparencyBanner(tierInfo, latencyMs, resultCount, hookName, options = {}) {
  const { showFixInstructions = true, logTransition = true } = options;

  // FR25: Tier badge
  const tierBadge =
    {
      1: '🟢 Tier 1',
      2: '🟡 Tier 2',
      3: '🔴 Tier 3',
    }[tierInfo.tier] || '⚪ Unknown';

  // FR29: Log tier transitions
  if (logTransition) {
    const lastTier = getLastLoggedTier();
    if (lastTier !== null && lastTier !== tierInfo.tier) {
      logTierTransition(lastTier, tierInfo.tier, tierInfo.reason);
    } else if (lastTier === null) {
      // First run - log initial state
      logTierTransition(tierInfo.tier, tierInfo.tier, 'Initial state');
    }
  }

  // FR26: Feature status
  const featureStatus = formatFeatureStatus(tierInfo.tier);

  // FR28: Degradation impact
  const features = FEATURE_STATUS[`tier${tierInfo.tier}`];
  const impactStr =
    features.accuracyDrop > 0 ? ` | ⚠️ ${features.accuracyDrop}% accuracy drop` : '';

  // Performance indicator
  const MAX_RUNTIME_MS = 500;
  const performance =
    latencyMs > MAX_RUNTIME_MS
      ? `⚠️ ${latencyMs}ms (exceeded ${MAX_RUNTIME_MS}ms target)`
      : `✓ ${latencyMs}ms`;

  // Build banner
  let banner = `\n\n---\n🔍 MAMA [${hookName}]: ${tierBadge}`;
  banner += `\n📊 ${featureStatus}${impactStr}`;
  banner += `\n⏱️  ${performance} | ${resultCount} decisions`;
  banner += `\n💡 ${tierInfo.reason}`;

  // FR27: Fix instructions for degraded states
  if (showFixInstructions && tierInfo.tier > 1) {
    banner += formatFixInstructions(tierInfo.tier);
  }

  banner += '\n---';

  return banner;
}

/**
 * Get feature status for current tier
 *
 * @param {number} tier - Current tier
 * @returns {Object} Feature status
 */
function getFeatureStatus(tier) {
  return FEATURE_STATUS[`tier${tier}`] || FEATURE_STATUS.tier3;
}

/**
 * Get fix instructions for current tier
 *
 * @param {number} tier - Current tier
 * @returns {Object|null} Fix instructions or null if tier 1
 */
function getFixInstructions(tier) {
  return FIX_INSTRUCTIONS[`tier${tier}`] || null;
}

/**
 * Get tier transition history
 *
 * @param {number} limit - Maximum number of entries to return
 * @returns {Array<Object>} Transition history
 */
function getTierTransitionHistory(limit = 10) {
  try {
    if (!fs.existsSync(TIER_LOG_FILE)) {
      return [];
    }

    const content = fs.readFileSync(TIER_LOG_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);

    return lines
      .slice(-limit)
      .map((line) => JSON.parse(line))
      .reverse();
  } catch (error) {
    warn(`[Transparency] Failed to read tier history: ${error.message}`);
    return [];
  }
}

module.exports = {
  formatTransparencyBanner,
  formatFeatureStatus,
  formatFixInstructions,
  logTierTransition,
  getFeatureStatus,
  getFixInstructions,
  getTierTransitionHistory,
  FEATURE_STATUS,
  FIX_INSTRUCTIONS,
};
