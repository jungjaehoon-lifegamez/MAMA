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

// Add core to require path
require('module').globalPaths.push(CORE_PATH);

const { info, warn, error: logError } = require(path.join(CORE_PATH, 'debug-logger'));

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
    const { generateEmbedding } = require(path.join(CORE_PATH, 'embeddings'));

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
    const { initDB } = require(path.join(CORE_PATH, 'memory-store'));
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
 * Main hook handler
 */
async function main() {
  if (process.env.MAMA_DISABLE_HOOKS === 'true') {
    info('[SessionStart] MAMA hooks disabled, skipping warmup');
    return;
  }

  const startTime = Date.now();
  info('[SessionStart] MAMA session initialization starting...');

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
        decision: null,
        reason: '',
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          systemMessage: `MAMA: Session warmup timed out (${totalLatencyMs}ms)`,
          additionalContext: '',
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

    // Output response for Claude Code
    const statusEmoji = success ? '✅' : '⚠️';
    const statusText = success
      ? `Ready (DB: ${dbResult.latencyMs}ms, Embedding: ${embeddingResult.latencyMs}ms)`
      : `Partial (${embeddingResult.error || dbResult.error})`;

    const response = {
      decision: null,
      reason: '',
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        systemMessage: `${statusEmoji} MAMA: ${statusText}`,
        additionalContext: `\n---\n🧠 MAMA Session initialized in ${totalLatencyMs}ms`,
      },
    };
    console.log(JSON.stringify(response));

    info(`[SessionStart] MAMA session ready (${totalLatencyMs}ms)`);
    process.exit(0);
  } catch (error) {
    logError(`[SessionStart] Fatal error: ${error.message}`);

    const response = {
      decision: null,
      reason: '',
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        systemMessage: `MAMA: Session init failed - ${error.message}`,
        additionalContext: '',
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
