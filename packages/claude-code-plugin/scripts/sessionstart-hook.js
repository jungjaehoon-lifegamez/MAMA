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
 * - MAMA_DISABLE_HOOKS: Set to "true" to disable hook
 *
 * @module sessionstart-hook
 */

const path = require('path');
const fs = require('fs');

// Get paths relative to script location
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(PLUGIN_ROOT, 'src', 'core');
const { getEnabledFeatures } = require(path.join(CORE_PATH, 'hook-features'));

// Add core to require path
require('module').globalPaths.push(CORE_PATH);

const { info, warn, error: logError } = require('@jungjaehoon/mama-core/debug-logger');

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
    const { initDB } = require('@jungjaehoon/mama-core/memory-store');
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
    const { getAdapter } = require('@jungjaehoon/mama-core/memory-store');
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
 * Check and install missing dependencies
 *
 * @returns {Promise<{installed: boolean, error?: string}>}
 */
async function ensureDependencies() {
  const nodeModulesPath = path.join(PLUGIN_ROOT, 'node_modules');
  const betterSqlitePath = path.join(nodeModulesPath, 'better-sqlite3');

  // Check if critical dependencies exist
  if (fs.existsSync(betterSqlitePath)) {
    return { installed: false }; // Already installed
  }

  info('[SessionStart] Dependencies missing, running npm install...');

  try {
    const { execSync } = require('child_process');

    // Run npm install in plugin root
    execSync('npm install', {
      cwd: PLUGIN_ROOT,
      stdio: 'pipe', // Suppress output
      timeout: 120000, // 2 minute timeout
    });

    info('[SessionStart] Dependencies installed successfully');
    return { installed: true };
  } catch (error) {
    logError(`[SessionStart] npm install failed: ${error.message}`);
    return { installed: false, error: error.message };
  }
}

/**
 * Main hook handler
 */
async function main() {
  const features = getEnabledFeatures();
  if (features.size === 0) {
    info('[SessionStart] All hooks disabled');
    process.exit(0);
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
    process.exit(0);
  }

  const startTime = Date.now();
  info('[SessionStart] MAMA session initialization starting...');

  // Ensure dependencies are installed before proceeding
  const depResult = await ensureDependencies();
  if (depResult.error) {
    // Dependencies failed to install - output error and exit
    const response = {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `⚠️ MAMA: Failed to install dependencies

---
❌ **MAMA Dependency Installation Failed**

Error: ${depResult.error}

**Manual fix required:**
\`\`\`bash
cd ${PLUGIN_ROOT}
npm install
\`\`\`

Then restart Claude Code.
`,
      },
    };
    console.log(JSON.stringify(response));
    process.exit(1);
  }

  if (depResult.installed) {
    // Dependencies were just installed - notify user
    const installLatency = Date.now() - startTime;
    info(`[SessionStart] Dependencies installed in ${installLatency}ms`);
  }

  try {
    // Read stdin (may be empty for SessionStart)
    await readStdin();

    // Create a timeout promise
    const timeoutPromise = new Promise((resolve) =>
      setTimeout(() => resolve({ timedOut: true }), MAX_WARMUP_MS)
    );

    // Run warmup tasks in parallel
    const warmupPromise = Promise.all([warmDatabase(), warmEmbeddingModel()]).then(
      ([dbResult, embeddingResult]) => ({
        timedOut: false,
        dbResult,
        embeddingResult,
      })
    );

    const result = await Promise.race([warmupPromise, timeoutPromise]);

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
      process.exit(0);
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

🤖 **PROACTIVE GREETING INSTRUCTION:**
   If the user's first message is a simple greeting ("hi", "hello", "hey") or lacks specific task instructions,
   YOU MUST proactively initiate a contextual conversation:

   1. Greet the user warmly in their language
   2. Summarize what was being worked on from the last checkpoint (if exists)
   3. Highlight 1-2 recent key decisions that might be relevant
   4. Ask if they want to continue previous work or start something new
   5. Suggest specific next steps based on checkpoint's next_steps

   Example response to "hi":
   "Hello! 👋 Last time you were working on the MAMA Mobile v1.5 security review.
   Recently you made decisions about public PR security policies and SessionStart guidance improvements.
   Would you like to continue your previous work, or start something new?"

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
    process.exit(0);
  } catch (error) {
    logError(`[SessionStart] Fatal error: ${error.message}`);

    const response = {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `⚠️ MAMA: Session init failed - ${error.message}`,
      },
    };
    console.log(JSON.stringify(response));

    process.exit(1);
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
  main().catch((error) => {
    if (error.name === 'AbortError') {
      warn('[SessionStart] Main aborted by external timeout');
      process.exit(0);
    }
    logError(`[SessionStart] Unhandled error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { main, warmEmbeddingModel, warmDatabase };
