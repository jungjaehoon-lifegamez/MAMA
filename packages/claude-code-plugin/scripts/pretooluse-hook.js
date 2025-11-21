#!/usr/bin/env node
/**
 * PreToolUse Hook for MAMA Plugin
 *
 * Story M2.2: PreToolUse Hook (Context before Read/Edit/Grep)
 *
 * Injects relevant decision context before Read/Edit/Grep operations.
 * Weights recency higher for file operations with rate limiting.
 *
 * Environment Variables:
 * - TOOL_NAME: Tool being invoked (read_file, ls, grep, apply_patch, etc.)
 * - FILE_PATH: File/directory path for the operation (optional)
 * - GREP_PATTERN: Search pattern for grep operations (optional)
 * - MAMA_DISABLE_HOOKS: Set to "true" to disable hook (opt-out)
 * - MAMA_CONFIG_PATH: Path to config file (optional)
 *
 * Output: Formatted context to stdout (or nothing if disabled/no results)
 * Exit codes: 0 (success), 1 (error)
 *
 * @module pretooluse-hook
 */

const path = require('path');
const fs = require('fs');

// Get paths relative to script location
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(PLUGIN_ROOT, 'src', 'core');

// Add core to require path
require('module').globalPaths.push(CORE_PATH);

const { info, warn, error: logError } = require(path.join(CORE_PATH, 'debug-logger'));
const { vectorSearch } = require(path.join(CORE_PATH, 'memory-store'));
const { formatContext } = require(path.join(CORE_PATH, 'decision-formatter'));
const { loadConfig } = require(path.join(CORE_PATH, 'config-loader'));

// Configuration
const MAX_RUNTIME_MS = 500; // Same as M2.1
const SIMILARITY_THRESHOLD = 0.70; // AC: Lower than M2.1 (70% vs 75%)
const TOKEN_BUDGET = 300; // Shorter than M2.1 for file operations
const RATE_LIMIT_MS = 1000; // AC: Rate limiting (min 1s between injections)
const RATE_LIMIT_FILE = path.join(PLUGIN_ROOT, '.pretooluse-last-run');

// Tools to trigger context injection
const SUPPORTED_TOOLS = ['read_file', 'ls', 'grep', 'apply_patch', 'Read', 'Edit', 'Grep', 'Glob'];

/**
 * Check rate limit
 * AC: Rate limiting to prevent spam on rapid file operations
 *
 * @returns {boolean} True if rate limit allows execution
 */
function checkRateLimit() {
  try {
    if (!fs.existsSync(RATE_LIMIT_FILE)) {
      return true;
    }

    const lastRun = parseInt(fs.readFileSync(RATE_LIMIT_FILE, 'utf8'), 10);
    const elapsed = Date.now() - lastRun;

    if (elapsed < RATE_LIMIT_MS) {
      info(`[Hook] Rate limited: ${elapsed}ms since last run (min ${RATE_LIMIT_MS}ms)`);
      return false;
    }

    return true;
  } catch (error) {
    // Fail open - allow execution if rate limit check fails
    warn(`[Hook] Rate limit check failed: ${error.message}`);
    return true;
  }
}

/**
 * Update rate limit timestamp
 */
function updateRateLimit() {
  try {
    fs.writeFileSync(RATE_LIMIT_FILE, Date.now().toString(), 'utf8');
  } catch (error) {
    // Non-fatal - just log
    warn(`[Hook] Failed to update rate limit: ${error.message}`);
  }
}

/**
 * Get tier information from config
 * Reuses M2.1 tier detection logic
 *
 * @returns {Object} Tier info {tier, vectorSearchEnabled, reason}
 */
function getTierInfo() {
  try {
    const config = loadConfig();

    if (config.modelName && config.vectorSearchEnabled !== false) {
      return {
        tier: 1,
        vectorSearchEnabled: true,
        reason: 'Full MAMA features available'
      };
    } else if (!config.embeddingModel) {
      return {
        tier: 2,
        vectorSearchEnabled: false,
        reason: 'Embeddings unavailable (Transformers.js not loaded)'
      };
    } else {
      return {
        tier: 3,
        vectorSearchEnabled: false,
        reason: 'MAMA disabled in config'
      };
    }
  } catch (error) {
    warn(`[Hook] Failed to load config, assuming Tier 2: ${error.message}`);
    return {
      tier: 2,
      vectorSearchEnabled: false,
      reason: 'Config load failed, degraded mode'
    };
  }
}

/**
 * Format transparency line with tier info
 * Reuses M2.1 formatting with PreToolUse context
 *
 * @param {Object} tierInfo - Tier information
 * @param {number} latencyMs - Hook execution latency
 * @param {number} resultCount - Number of results found
 * @param {string} toolName - Tool name
 * @returns {string} Formatted transparency line
 */
function formatTransparencyLine(tierInfo, latencyMs, resultCount, toolName) {
  const tierBadge = {
    1: '🟢 Tier 1',
    2: '🟡 Tier 2',
    3: '🔴 Tier 3'
  }[tierInfo.tier] || '⚪ Unknown';

  const status = tierInfo.reason;
  const performance = latencyMs > MAX_RUNTIME_MS
    ? `⚠️ ${latencyMs}ms (exceeded ${MAX_RUNTIME_MS}ms target)`
    : `✓ ${latencyMs}ms`;

  return `\n\n---\n🔍 PreToolUse [${toolName}]: ${tierBadge} | ${status} | ${performance} | ${resultCount} decisions`;
}

/**
 * Extract file path hints from decisions
 * AC: Include file hints if decision references paths
 *
 * @param {Array<Object>} decisions - Decision list
 * @param {string} targetPath - Current file path
 * @returns {Array<Object>} Decisions with file hints
 */
function extractFileHints(decisions, targetPath) {
  return decisions.map(decision => {
    const fileHints = [];

    // Check if decision mentions file paths
    const text = `${decision.decision} ${decision.reasoning || ''}`;
    const pathMatches = text.match(/[\w-]+\.(js|ts|md|json|yaml|py|go|rs)/g) || [];

    if (pathMatches.length > 0) {
      fileHints.push(...new Set(pathMatches)); // Deduplicate
    }

    // Check if target path is mentioned
    if (targetPath && text.includes(path.basename(targetPath))) {
      decision.relevantToFile = true;
    }

    return {
      ...decision,
      fileHints: fileHints.length > 0 ? fileHints : null
    };
  });
}

/**
 * Generate query from tool context
 * AC: Context-aware query generation
 *
 * @param {string} toolName - Tool name
 * @param {string} filePath - File path (optional)
 * @param {string} grepPattern - Grep pattern (optional)
 * @returns {string} Query text
 */
function generateQuery(toolName, filePath, grepPattern) {
  const parts = [];

  if (grepPattern) {
    parts.push(grepPattern);
  }

  if (filePath) {
    const basename = path.basename(filePath);
    const dirname = path.basename(path.dirname(filePath));
    parts.push(`${dirname}/${basename}`);
  }

  parts.push(toolName);

  return parts.join(' ');
}

/**
 * Read input from stdin
 */
async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        resolve(parsed);
      } catch (error) {
        reject(new Error(`Failed to parse stdin JSON: ${error.message}`));
      }
    });
    process.stdin.on('error', reject);
  });
}

/**
 * Main hook handler
 */
async function main() {
  const startTime = Date.now();

  try {
    // 1. Check opt-out flag
    if (process.env.MAMA_DISABLE_HOOKS === 'true') {
      info('[Hook] MAMA hooks disabled via MAMA_DISABLE_HOOKS');
      const response = { success: true, systemMessage: '', additionalContext: '' };
      console.log(JSON.stringify(response));
      process.exit(0);
    }

    // 2. Get tool information from stdin
    let toolName, filePath, grepPattern;
    try {
      const inputData = await readStdin();
      toolName = inputData.toolName || inputData.tool || process.env.TOOL_NAME || '';
      filePath = inputData.filePath || inputData.file_path || process.env.FILE_PATH;
      grepPattern = inputData.grepPattern || inputData.pattern || process.env.GREP_PATTERN;
    } catch (error) {
      // Fallback to environment variables
      toolName = process.env.TOOL_NAME || '';
      filePath = process.env.FILE_PATH;
      grepPattern = process.env.GREP_PATTERN;
    }

    if (!toolName || !SUPPORTED_TOOLS.includes(toolName)) {
      // Silent exit - tool not supported
      const response = { success: true, systemMessage: '', additionalContext: '' };
      console.log(JSON.stringify(response));
      process.exit(0);
    }

    // 3. Check rate limit
    if (!checkRateLimit()) {
      // Silent exit - rate limited
      process.exit(0);
    }

    // 4. Get tier information
    const tierInfo = getTierInfo();

    // 5. Skip on Tier 3 (disabled)
    if (tierInfo.tier === 3) {
      warn('[Hook] MAMA disabled (Tier 3), skipping injection');
      process.exit(0);
    }

    // 6. Tier 2 warning (degraded mode)
    if (tierInfo.tier === 2) {
      warn(`[Hook] Running in degraded mode (Tier 2): ${tierInfo.reason}`);
      // Continue with keyword search only
    }

    // 7. Generate query from context (variables already declared above)
    const query = generateQuery(toolName, filePath, grepPattern);

    info(`[Hook] PreToolUse [${toolName}]: "${query}"`);

    // 8. Inject decision context
    let context = null;
    let resultCount = 0;

    try {
      // AC: Hook runtime stays <500ms
      const result = await Promise.race([
        injectPreToolContext(query, filePath),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Hook timeout')), MAX_RUNTIME_MS)
        )
      ]);

      context = result.context;
      resultCount = result.count;

      // Update rate limit on successful execution
      updateRateLimit();

    } catch (error) {
      if (error.message === 'Hook timeout') {
        warn(`[Hook] Injection exceeded ${MAX_RUNTIME_MS}ms, skipping`);
      } else {
        logError(`[Hook] Injection failed: ${error.message}`);
      }
      context = null;
    }

    // 9. Output results
    const latencyMs = Date.now() - startTime;

    if (context) {
      const transparencyLine = formatTransparencyLine(tierInfo, latencyMs, resultCount, toolName);

      // Correct Claude Code JSON format with hookSpecificOutput
      const response = {
        decision: null,
        reason: "",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          systemMessage: `💡 MAMA: ${resultCount} decision${resultCount > 1 ? 's' : ''} related to ${toolName} (${latencyMs}ms)`,
          additionalContext: context + transparencyLine
        }
      };
      console.log(JSON.stringify(response));
      info(`[Hook] Injected ${resultCount} decisions (${latencyMs}ms)`);
    } else {
      // No results - output transparency line only
      const transparencyLine = formatTransparencyLine(tierInfo, latencyMs, 0, toolName);

      const response = {
        decision: null,
        reason: "",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          systemMessage: `🔍 MAMA: No decisions related to ${toolName} (${latencyMs}ms)`,
          additionalContext: transparencyLine
        }
      };
      console.log(JSON.stringify(response));
      info(`[Hook] No relevant decisions found (${latencyMs}ms)`);
    }

    process.exit(0);

  } catch (error) {
    logError(`[Hook] Fatal error: ${error.message}`);
    console.error(`❌ MAMA PreToolUse Hook Error: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Inject context for PreToolUse
 * AC: Relevance scoring with higher recency weight
 *
 * @param {string} query - Query text
 * @param {string} filePath - File path
 * @returns {Promise<Object>} {context, count}
 */
async function injectPreToolContext(query, filePath) {
  // 1. Generate query embedding
  const { generateEmbedding } = require(path.join(CORE_PATH, 'embeddings'));
  const queryEmbedding = await generateEmbedding(query);

  // 2. Vector search with lower threshold (70% vs 75%)
  let results = vectorSearch(queryEmbedding, 10, SIMILARITY_THRESHOLD);

  // 3. AC: Weight recency higher for file operations
  // Apply Gaussian decay: score = similarity * exp(-age_days / 30)
  const now = Date.now();
  results = results.map(r => {
    const ageDays = (now - r.created_at) / (1000 * 60 * 60 * 24);
    const recencyBoost = Math.exp(-ageDays / 30); // 30-day half-life
    return {
      ...r,
      adjustedScore: r.similarity * 0.7 + recencyBoost * 0.3 // 70% similarity, 30% recency
    };
  });

  // 4. Sort by adjusted score
  results.sort((a, b) => b.adjustedScore - a.adjustedScore);

  // 5. Take top 3
  results = results.slice(0, 3);

  if (results.length === 0) {
    return { context: null, count: 0 };
  }

  // 6. AC: Add file hints
  results = extractFileHints(results, filePath);

  // 7. Format context (shorter for file operations)
  const formattedContext = formatContext(results, {
    maxTokens: TOKEN_BUDGET,
    includeFileHints: true
  });

  return {
    context: formattedContext,
    count: results.length
  };
}

// Run hook
if (require.main === module) {
  main().catch(error => {
    logError(`[Hook] Unhandled error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { main, getTierInfo, formatTransparencyLine, checkRateLimit, generateQuery, extractFileHints };
