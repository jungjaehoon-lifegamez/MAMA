#!/usr/bin/env node
/**
 * UserPromptSubmit Hook for MAMA Plugin
 *
 * Story M2.1: UserPromptSubmit Hook Implementation
 *
 * Injects relevant decision context automatically when user submits a prompt.
 * Reuses memory-inject.js logic with tier awareness and opt-out support.
 *
 * Environment Variables:
 * - USER_PROMPT: The user's prompt (required)
 * - MAMA_DISABLE_HOOKS: Set to "true" to disable hook (opt-out)
 * - MAMA_CONFIG_PATH: Path to config file (optional)
 *
 * Output: Formatted context to stdout (or nothing if disabled/no results)
 * Exit codes: 0 (success), 1 (error)
 *
 * @module userpromptsubmit-hook
 */

const path = require('path');

// Get paths relative to script location
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(PLUGIN_ROOT, 'src', 'core');

// Add core to require path
require('module').globalPaths.push(CORE_PATH);

const { info, warn, error: logError } = require(path.join(CORE_PATH, 'debug-logger'));
// Lazy load to avoid embedding model initialization before tier check
// const { injectDecisionContext } = require(path.join(CORE_PATH, 'memory-inject'));
const { loadConfig } = require(path.join(CORE_PATH, 'config-loader'));

// Configuration
const MAX_RUNTIME_MS = 1200; // p95 target: <1200ms (optimized with SessionStart pre-warming)
// Note: SIMILARITY_THRESHOLD (0.75) is used in memory-inject.js

/**
 * Check if session was pre-warmed by SessionStart hook
 *
 * @returns {Object} Warm status {isWarm, warmTime}
 */
function getWarmStatus() {
  const warmStatus = process.env.MAMA_WARM_STATUS;
  const warmTime = process.env.MAMA_WARM_TIME;
  const sessionStart = process.env.MAMA_SESSION_START;

  if (warmStatus === 'ready') {
    info(`[Hook] Session pre-warmed (${warmTime}ms at ${sessionStart})`);
    return { isWarm: true, warmTime: parseInt(warmTime, 10) || 0 };
  }

  return { isWarm: false, warmTime: 0 };
}

/**
 * Get tier information from config
 *
 * @returns {Object} Tier info {tier, vectorSearchEnabled, reason, isWarm}
 */
function getTierInfo() {
  // Check warm status from SessionStart hook
  const warmStatus = getWarmStatus();

  // Fast path for testing: completely skip MAMA (fastest)
  if (process.env.MAMA_FORCE_TIER_3 === 'true') {
    return {
      tier: 3,
      vectorSearchEnabled: false,
      reason: 'Tier 3 forced for testing (embeddings disabled)',
      isWarm: false,
    };
  }

  // Fast path for testing: skip embedding model loading
  if (process.env.MAMA_FORCE_TIER_2 === 'true') {
    return {
      tier: 2,
      vectorSearchEnabled: false,
      reason: 'Tier 2 forced for testing (fast mode)',
      isWarm: false,
    };
  }

  try {
    const config = loadConfig();

    // Tier 1: Full features (embeddings + vector search)
    // Tier 2: Degraded (no embeddings, keyword only)
    // Tier 3: Minimal (disabled)

    if (config.modelName && config.vectorSearchEnabled !== false) {
      const reason = warmStatus.isWarm
        ? `Full MAMA features (pre-warmed in ${warmStatus.warmTime}ms)`
        : 'Full MAMA features available';
      return {
        tier: 1,
        vectorSearchEnabled: true,
        reason,
        isWarm: warmStatus.isWarm,
      };
    } else if (!config.modelName) {
      return {
        tier: 2,
        vectorSearchEnabled: false,
        reason: 'Embeddings unavailable (Transformers.js not loaded)',
        isWarm: false,
      };
    } else {
      return {
        tier: 3,
        vectorSearchEnabled: false,
        reason: 'MAMA disabled in config',
        isWarm: false,
      };
    }
  } catch (error) {
    // Fail gracefully - assume Tier 2 (degraded mode)
    warn(`[Hook] Failed to load config, assuming Tier 2: ${error.message}`);
    return {
      tier: 2,
      vectorSearchEnabled: false,
      reason: 'Config load failed, degraded mode',
      isWarm: false,
    };
  }
}

/**
 * Format transparency line with tier info
 *
 * AC: Transparency line appended: `🔍 System Status: <Tier info>`
 *
 * @param {Object} tierInfo - Tier information
 * @param {number} latencyMs - Hook execution latency
 * @param {number} resultCount - Number of results found
 * @returns {string} Formatted transparency line
 */
function formatTransparencyLine(tierInfo, latencyMs, resultCount) {
  const tierBadge =
    {
      1: '🟢 Tier 1',
      2: '🟡 Tier 2',
      3: '🔴 Tier 3',
    }[tierInfo.tier] || '⚪ Unknown';

  const status = tierInfo.reason;
  const performance =
    latencyMs > MAX_RUNTIME_MS
      ? `⚠️ ${latencyMs}ms (exceeded ${MAX_RUNTIME_MS}ms target)`
      : `✓ ${latencyMs}ms`;

  return `\n\n---\n🔍 System Status: ${tierBadge} | ${status} | ${performance} | ${resultCount} decisions injected`;
}

/**
 * Read input from stdin
 */
async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
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
  if (process.env.MAMA_DISABLE_HOOKS === 'true') {
    // Opt-out: do nothing when hooks are disabled
    return;
  }

  // MAMA OS (Standalone) 환경에서는 스킵
  // MAMA OS는 자체 ContextInjector로 컨텍스트를 주입하므로 중복 방지
  if (process.env.MAMA_DAEMON === '1') {
    info('[Hook] MAMA OS detected, skipping (uses built-in context injection)');
    return;
  }

  const startTime = Date.now();

  try {
    // 1. Get user prompt from stdin (Claude Code hook format)
    let userPrompt;
    try {
      const inputData = await readStdin();
      userPrompt = inputData.userPrompt || inputData.prompt || process.env.USER_PROMPT;
    } catch (error) {
      // Fallback to environment variable (for manual testing)
      userPrompt = process.env.USER_PROMPT;
    }

    if (!userPrompt || userPrompt.trim() === '') {
      // Silent exit - no prompt to process
      process.exit(0);
    }

    // 3. Get tier information
    const tierInfo = getTierInfo();

    // 4. Skip on Tier 3 (disabled)
    if (tierInfo.tier === 3) {
      warn('[Hook] MAMA disabled (Tier 3), skipping injection');
      process.exit(0);
    }

    // 5. Tier 2: Skip injection (requires embeddings)
    if (tierInfo.tier === 2) {
      warn(`[Hook] Skipping injection (Tier 2): ${tierInfo.reason}`);

      const latencyMs = Date.now() - startTime;
      const transparencyLine = formatTransparencyLine(tierInfo, latencyMs, 0);

      const response = {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `🔍 MAMA: Embeddings unavailable (Tier 2)${transparencyLine}`,
        },
      };
      console.log(JSON.stringify(response));
      process.exit(0);
    }

    // 6. Check for checkpoint command (Pre-Checkpoint Verification)
    const isCheckpointCommand = /\/mama-checkpoint|checkpoint|save.*checkpoint/i.test(userPrompt);

    if (isCheckpointCommand) {
      info('[Hook] Checkpoint command detected - injecting verification reminder');

      const verificationReminder = `
💬 Creating a checkpoint

A checkpoint is a message to the next AI agent.
Being honest helps the next agent understand and continue your work.

## 😊 Easy to forget

**Before marking "done":**
- Did you include file paths? (e.g., db-manager.js:354)
- Did you run tests? (npm test)
- Did you re-read the AC? (you might have missed something)

**Be honest about incomplete work:**
- "Didn't finish this part"
- "Skipped this for now"
- "Forgot about this"

That's all okay. Just write it down.

## 💡 Good checkpoint examples

**What went well:**
- Built feature X (file.js:100-150)
- Tests passing (npm test)

**What's incomplete (be honest):**
- Missed AC item Y (file.js:200 needs attention)
- Didn't write tests (ran out of time)

**For the next agent:**
- Check this file at this line
- This feature needs testing

🙏 The next AI will appreciate your honesty.
`;

      const response = {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `⚠️ Checkpoint Verification Reminder${verificationReminder}`,
        },
      };
      console.log(JSON.stringify(response));
      process.exit(0);
    }

    // 7. Inject decision context
    info(`[Hook] Processing prompt: "${userPrompt.substring(0, 50)}..."`);

    let context = null;
    let resultCount = 0;

    try {
      // Lazy load memory-inject (only on Tier 1)
      const { injectDecisionContext } = require(path.join(CORE_PATH, 'memory-inject'));

      // Create a timeout promise that resolves to null (not rejects)
      // This prevents unhandled rejection when the main promise continues after timeout
      const timeoutPromise = new Promise((resolve) =>
        setTimeout(() => resolve({ timedOut: true }), MAX_RUNTIME_MS)
      );

      const result = await Promise.race([
        injectDecisionContext(userPrompt)
          .then((ctx) => ({ context: ctx, timedOut: false }))
          .catch((error) => {
            logError(`[Hook] Injection promise failed: ${error.message}`);
            return { context: null, timedOut: false };
          }),
        timeoutPromise,
      ]);

      if (result.timedOut) {
        warn(`[Hook] Injection exceeded ${MAX_RUNTIME_MS}ms, skipping`);
        context = null;
      } else {
        context = result.context;
        // Count results (rough estimate from context length)
        if (context) {
          // Extract number from "Top N relevant decisions" pattern
          const match = context.match(/Top (\d+) relevant/);
          resultCount = match ? parseInt(match[1], 10) : 1;
        }
      }
    } catch (error) {
      logError(`[Hook] Injection failed: ${error.message}`);
      // Graceful degradation - continue without context
      context = null;
    }

    // 7. Output results
    const latencyMs = Date.now() - startTime;

    if (context) {
      // AC: Top 3 relevant decisions (similarity >75%) injected
      const transparencyLine = formatTransparencyLine(tierInfo, latencyMs, resultCount);

      // Correct Claude Code JSON format with hookSpecificOutput
      const response = {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `💡 MAMA found ${resultCount} related decision${resultCount > 1 ? 's' : ''} (${latencyMs}ms)\n\n${context}${transparencyLine}`,
        },
      };
      console.log(JSON.stringify(response));

      info(`[Hook] Injected ${resultCount} decisions (${latencyMs}ms)`);
    } else {
      // No results - output transparency line only (optional)
      const transparencyLine = formatTransparencyLine(tierInfo, latencyMs, 0);

      const response = {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `🔍 MAMA: No related decisions found (${latencyMs}ms)${transparencyLine}`,
        },
      };
      console.log(JSON.stringify(response));

      info(`[Hook] No relevant decisions found (${latencyMs}ms)`);
    }

    process.exit(0);
  } catch (error) {
    logError(`[Hook] Fatal error: ${error.message}`);
    console.error(`❌ MAMA Hook Error: ${error.message}`);
    process.exit(1);
  }
}

// Handle process abort signals (from Claude Code's external timeout)
process.on('SIGTERM', () => {
  warn('[Hook] Received SIGTERM, exiting gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  warn('[Hook] Received SIGINT, exiting gracefully');
  process.exit(0);
});

// Handle uncaught errors and unhandled rejections
process.on('uncaughtException', (error) => {
  // AbortError is expected when Claude Code kills the hook due to timeout
  if (error.name === 'AbortError') {
    warn('[Hook] Process aborted by external timeout');
    process.exit(0);
  }
  logError(`[Hook] Uncaught exception: ${error.message}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  // AbortError is expected when Claude Code kills the hook due to timeout
  if (reason && reason.name === 'AbortError') {
    warn('[Hook] Promise aborted by external timeout');
    process.exit(0);
  }
  logError(`[Hook] Unhandled rejection: ${reason}`);
  process.exit(1);
});

// Run hook
if (require.main === module) {
  main().catch((error) => {
    // AbortError is expected when Claude Code kills the hook due to timeout
    if (error.name === 'AbortError') {
      warn('[Hook] Main aborted by external timeout');
      process.exit(0);
    }
    logError(`[Hook] Unhandled error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { main, getTierInfo, formatTransparencyLine };
