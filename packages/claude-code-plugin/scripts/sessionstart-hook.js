#!/usr/bin/env node
/**
 * SessionStart Hook for MAMA Plugin
 *
 * Pre-warms the embedding model at session start to avoid cold-start latency
 * in subsequent UserPromptSubmit hooks.
 *
 * How it works:
 * 1. SessionStart hook runs once when Claude Code session begins
 * 2. Loads and initializes the Transformers.js embedding model
 * 3. Writes warm status to CLAUDE_ENV_FILE for session-wide availability
 * 4. Subsequent hooks benefit from Node.js module caching within same process
 *
 * Note: Each hook still runs in a separate process, but the model files
 * are cached on disk after first load, significantly reducing load time.
 *
 * Environment Variables:
 * - CLAUDE_ENV_FILE: File path for persisting env vars (provided by Claude Code)
 * - Feature flags: Hook activation is controlled via getEnabledFeatures() (see hook-features.js)
 *
 * @module sessionstart-hook
 */

const path = require('path');
const fs = require('fs');
// Nothing that loads mama-core is required here: this hook installs it first (plugin-deps.js).
const { ensurePluginDependencies } = require('./plugin-deps.js');

// Get paths relative to script location
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(PLUGIN_ROOT, 'src', 'core');
const { getEnabledFeatures } = require(path.join(CORE_PATH, 'hook-features'));

// Fallback logger (before dependencies are installed)
let info = (...args) => console.error('[INFO]', ...args);
let warn = (...args) => console.error('[WARN]', ...args);
let logError = (...args) => console.error('[ERROR]', ...args);

function upgradeLogger() {
  try {
    const logger = require('@jungjaehoon/mama-core/debug-logger');
    info = logger.info;
    warn = logger.warn;
    logError = logger.error;
  } catch {
    // Keep fallback logger
  }
}

// Configuration
const MAX_WARMUP_MS = 8000; // Allow up to 8s for initial model load

/**
 * Read input from stdin (Claude Code hook format)
 */
async function readStdin() {
  return new Promise((resolve, _reject) => {
    let data = '';

    // Set a timeout for stdin reading
    const timeout = setTimeout(() => {
      resolve({}); // Empty input is okay for SessionStart
    }, 1000);

    process.stdin.on('data', (chunk) => {
      clearTimeout(timeout);
      data += chunk;
    });

    process.stdin.on('end', () => {
      clearTimeout(timeout);
      try {
        const parsed = data ? JSON.parse(data) : {};
        resolve(parsed);
      } catch (error) {
        resolve({}); // Parsing failure is okay
      }
    });

    process.stdin.on('error', () => {
      clearTimeout(timeout);
      resolve({});
    });
  });
}

/**
 * Pre-warm the embedding model
 *
 * @returns {Promise<{success: boolean, latencyMs: number, error?: string}>}
 */
async function warmEmbeddingModel() {
  const startTime = Date.now();

  try {
    // Lazy load embeddings module
    const { generateEmbedding } = require('@jungjaehoon/mama-core/embeddings');

    // Generate a dummy embedding to force model load
    const warmupText = 'MAMA warmup initialization';
    const embedding = await generateEmbedding(warmupText);

    const latencyMs = Date.now() - startTime;

    if (embedding) {
      info(`[SessionStart] Embedding model warmed in ${latencyMs}ms`);
      return { success: true, latencyMs };
    } else {
      warn('[SessionStart] Embedding generation returned null');
      return { success: false, latencyMs, error: 'Embedding returned null' };
    }
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    logError(`[SessionStart] Embedding warmup failed: ${error.message}`);
    return { success: false, latencyMs, error: error.message };
  }
}

/**
 * Initialize database connection
 *
 * @returns {Promise<{success: boolean, latencyMs: number, error?: string}>}
 */
async function warmDatabase() {
  const startTime = Date.now();

  try {
    const { initDB } = require('@jungjaehoon/mama-core/db-manager');
    const { usePluginDatabase } = require('./db-path.js');
    usePluginDatabase();
    await initDB();

    const latencyMs = Date.now() - startTime;
    info(`[SessionStart] Database initialized in ${latencyMs}ms`);
    return { success: true, latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    logError(`[SessionStart] Database init failed: ${error.message}`);
    return { success: false, latencyMs, error: error.message };
  }
}

/**
 * Query recent decisions and last checkpoint
 *
 * @returns {Promise<{decisions: Array, checkpoint: Object|null}>}
 */
async function queryRecentContext() {
  try {
    const { getAdapter } = require('@jungjaehoon/mama-core/db-manager');
    const adapter = getAdapter();

    // Query recent 5 decisions (excluding checkpoints)
    const decisionsStmt = adapter.prepare(`
      SELECT id, topic, decision, reasoning, outcome, confidence, created_at
      FROM decisions
      ORDER BY created_at DESC
      LIMIT 5
    `);
    const decisions = await decisionsStmt.all();

    // Query last active checkpoint
    const checkpointStmt = adapter.prepare(`
      SELECT id, timestamp, summary, open_files, next_steps
      FROM checkpoints
      WHERE status = 'active'
      ORDER BY timestamp DESC
      LIMIT 1
    `);
    const checkpoint = await checkpointStmt.get();

    return { decisions, checkpoint };
  } catch (error) {
    warn(`[SessionStart] Failed to query recent context: ${error.message}`);
    return { decisions: [], checkpoint: null };
  }
}

/**
 * Format recent context for display
 *
 * @param {Array} decisions - Recent decisions
 * @param {Object|null} checkpoint - Last checkpoint
 * @returns {string} Formatted context string
 */
function formatRecentContext(decisions, checkpoint) {
  let contextText = '';

  // Format checkpoint if exists
  if (checkpoint) {
    const timeAgo = formatTimeAgo(Date.now() - checkpoint.timestamp);
    contextText += `\n📍 **Last Checkpoint** (${timeAgo}):\n`;
    contextText += `   ${truncate(checkpoint.summary, 80)}\n`;
    if (checkpoint.next_steps) {
      contextText += `   Next: ${truncate(checkpoint.next_steps, 60)}\n`;
    }
  }

  // Format recent decisions
  if (decisions && decisions.length > 0) {
    contextText += `\n🧠 **Recent Decisions** (${decisions.length}):\n`;
    decisions.forEach((d, idx) => {
      const timeAgo = formatTimeAgo(Date.now() - d.created_at);
      const outcomeEmoji = d.outcome === 'success' ? '✅' : d.outcome === 'failed' ? '❌' : '⏳';
      contextText += `   ${idx + 1}. ${outcomeEmoji} ${d.topic}: ${truncate(d.decision, 60)} (${timeAgo})\n`;
    });
  }

  return contextText;
}

/**
 * Format time difference to human-readable string
 *
 * @param {number} ms - Milliseconds ago
 * @returns {string} Formatted time string
 */
function formatTimeAgo(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ago`;
  }
  if (hours > 0) {
    return `${hours}h ago`;
  }
  if (minutes > 0) {
    return `${minutes}m ago`;
  }
  return `${seconds}s ago`;
}

/**
 * Truncate text to max length
 *
 * @param {string} text - Text to truncate
 * @param {number} maxLen - Maximum length
 * @returns {string} Truncated text
 */
function truncate(text, maxLen) {
  if (!text) {
    return '';
  }
  if (text.length <= maxLen) {
    return text;
  }
  return text.substring(0, maxLen - 3) + '...';
}

/**
 * Write warm status to CLAUDE_ENV_FILE
 *
 * @param {Object} status - Warmup status object
 */
function writeEnvStatus(status) {
  const envFile = process.env.CLAUDE_ENV_FILE;

  if (!envFile) {
    warn('[SessionStart] CLAUDE_ENV_FILE not available, skipping env write');
    return;
  }

  try {
    const envContent = [
      `MAMA_WARM_STATUS=${status.success ? 'ready' : 'failed'}`,
      `MAMA_WARM_TIME=${status.totalLatencyMs}`,
      `MAMA_SESSION_START=${Date.now()}`,
      '',
    ].join('\n');

    fs.appendFileSync(envFile, envContent);
    info(`[SessionStart] Wrote warm status to CLAUDE_ENV_FILE`);
  } catch (error) {
    warn(`[SessionStart] Failed to write env file: ${error.message}`);
  }
}

/**
 * Install mama-core where this session's hooks load it from (plugin-deps.js).
 *
 * @returns {{installed: boolean, error?: string, code?: string}}
 */
function ensureDependencies() {
  try {
    const status = ensurePluginDependencies();
    if (status === 'installed') {
      info('[SessionStart] Dependencies installed into CLAUDE_PLUGIN_DATA');
    }
    return { installed: status === 'installed' };
  } catch (error) {
    logError(`[SessionStart] Dependency install failed: ${error.message}`);
    return { installed: false, error: error.message, code: error.code };
  }
}

/**
 * Main hook handler
 */
async function main() {
  const features = getEnabledFeatures();
  if (features.size === 0) {
    info('[SessionStart] All hooks disabled');
    return 0;
  }

  // Check if this is a resume/compact event (not a fresh session start)
  // Claude Code triggers SessionStart on compact/resume - skip full warmup for these
  // Only skip if: (1) last warmup succeeded AND (2) timestamp is recent (within 30 min)
  const lastStart = Number(process.env.MAMA_SESSION_START);
  const isRecentStart = Number.isFinite(lastStart) && Date.now() - lastStart < 30 * 60 * 1000; // Within 30 min
  const isResumeOrCompact = process.env.MAMA_WARM_STATUS === 'ready' && isRecentStart;

  if (isResumeOrCompact) {
    // Already warmed up in this session - just output minimal status
    const response = {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `🔄 MAMA: Session resumed (already initialized)`,
      },
    };
    console.log(JSON.stringify(response));
    info('[SessionStart] Session already warm, skipping re-initialization');
    return 0;
  }

  const startTime = Date.now();
  info('[SessionStart] MAMA session initialization starting...');

  // Ensure dependencies are installed before proceeding
  const depResult = ensureDependencies();
  if (depResult.error) {
    // Another session installing is not a failure, and running npm by hand beside it would
    // install twice into one folder; the steps are shown only for a failed install.
    const busy = depResult.code === 'MAMA_DEPS_BUSY';
    const steps =
      depResult.code === undefined && process.env.CLAUDE_PLUGIN_DATA
        ? `
The next session start tries again. To install by hand:
\`\`\`bash
cd "${process.env.CLAUDE_PLUGIN_DATA}"
npm install --omit=dev
\`\`\`
`
        : '';
    const response = {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: busy
          ? `⏳ MAMA: ${depResult.error}`
          : `⚠️ MAMA: Failed to install dependencies

---
❌ **MAMA Dependency Installation Failed**

Error: ${depResult.error}
${steps}`,
      },
    };
    console.log(JSON.stringify(response));
    return busy ? 0 : 1;
  }

  // Upgrade to real logger now that dependencies are available
  upgradeLogger();

  if (depResult.installed) {
    const installLatency = Date.now() - startTime;
    info(`[SessionStart] Dependencies installed in ${installLatency}ms`);
  }

  try {
    // Read stdin (may be empty for SessionStart)
    await readStdin();
    // Reading may stop at its 1s timeout with stdin still open; the process ends on its own
    // (see the end of this file), so an open stdin would hold it.
    process.stdin.destroy();

    // Cleared once the race settles: the process ends on its own (see the end of this file),
    // so a pending timer would hold it open.
    let warmupTimer;
    const timeoutPromise = new Promise((resolve) => {
      warmupTimer = setTimeout(() => resolve({ timedOut: true }), MAX_WARMUP_MS);
    });

    // Run warmup tasks in parallel
    const warmupPromise = Promise.all([warmDatabase(), warmEmbeddingModel()]).then(
      ([dbResult, embeddingResult]) => ({
        timedOut: false,
        dbResult,
        embeddingResult,
      })
    );

    const result = await Promise.race([warmupPromise, timeoutPromise]);
    clearTimeout(warmupTimer);

    const totalLatencyMs = Date.now() - startTime;

    if (result.timedOut) {
      warn(`[SessionStart] Warmup timed out after ${MAX_WARMUP_MS}ms`);

      // Output response for Claude Code
      const response = {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: `⚠️ MAMA: Session warmup timed out (${totalLatencyMs}ms)`,
        },
      };
      console.log(JSON.stringify(response));

      writeEnvStatus({ success: false, totalLatencyMs });
      return 0;
    }

    const { dbResult, embeddingResult } = result;
    const success = dbResult.success && embeddingResult.success;

    // Write status to env file for other hooks
    writeEnvStatus({
      success,
      totalLatencyMs,
      dbLatencyMs: dbResult.latencyMs,
      embeddingLatencyMs: embeddingResult.latencyMs,
    });

    // Query recent context (decisions + checkpoint)
    const { decisions, checkpoint } = await queryRecentContext();
    const recentContextText = formatRecentContext(decisions, checkpoint);

    // Output response for Claude Code
    const statusEmoji = success ? '✅' : '⚠️';
    const statusText = success
      ? `Ready (DB: ${dbResult.latencyMs}ms, Embedding: ${embeddingResult.latencyMs}ms)`
      : `Partial (${embeddingResult.error || dbResult.error})`;

    const response = {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `${statusEmoji} MAMA: ${statusText}

---
🧠 MAMA Session initialized in ${totalLatencyMs}ms
${recentContextText}

🤖 **Greeting:** If the user opens with a greeting and no task, reply in their language. When a
   checkpoint is shown above, say what it was working on and, when one is shown, its next step;
   mention a relevant recent decision if one fits; then ask whether to continue or start something new.

💡 **Proactive Partner Mode:**
   Save important decisions without being asked.
   Example: "Let's use PostgreSQL" → save(topic="database_choice", ...)

📋 **Quick Start:**
   • Recent decisions: /mama:search (check context before starting)
   • Resume session: /mama:checkpoint (if continuing work)
`,
      },
    };
    console.log(JSON.stringify(response));

    info(`[SessionStart] MAMA session ready (${totalLatencyMs}ms)`);
    return 0;
  } catch (error) {
    logError(`[SessionStart] Fatal error: ${error.message}`);

    const response = {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `⚠️ MAMA: Session init failed - ${error.message}`,
      },
    };
    console.log(JSON.stringify(response));

    return 1;
  }
}

// Handle process signals
process.on('SIGTERM', () => {
  warn('[SessionStart] Received SIGTERM, exiting gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  warn('[SessionStart] Received SIGINT, exiting gracefully');
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  if (error.name === 'AbortError') {
    warn('[SessionStart] Process aborted by external timeout');
    process.exit(0);
  }
  logError(`[SessionStart] Uncaught exception: ${error.message}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  if (reason && reason.name === 'AbortError') {
    warn('[SessionStart] Promise aborted by external timeout');
    process.exit(0);
  }
  logError(`[SessionStart] Unhandled rejection: ${reason}`);
  process.exit(1);
});

// Run hook
if (require.main === module) {
  // The code is set, not passed to process.exit(): once the embedding model has loaded,
  // onnxruntime-node 1.21 aborts in its exit-time teardown on macOS (exit 134;
  // microsoft/onnxruntime#24579). Ending on its own, the process exits with the code.
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      if (error.name === 'AbortError') {
        warn('[SessionStart] Main aborted by external timeout');
        process.exitCode = 0;
        return;
      }
      logError(`[SessionStart] Unhandled error: ${error.message}`);
      process.exitCode = 1;
    }
  );
}

module.exports = { main, warmEmbeddingModel, warmDatabase };
