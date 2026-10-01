#!/usr/bin/env node
/**
 * SessionStart Hook for MAMA Plugin
 *
 * The plugin's only hook. At session start it installs the plugin's dependencies when needed
 * (plugin-deps.js), then shows the last checkpoint and the newest active decisions, so a session
 * starts from where the last one stopped. Everything else is pulled by the agent through the MCP
 * tools and the /mama commands.
 *
 * Claude Code adds `hookSpecificOutput.additionalContext` to the session's context.
 *
 * @module sessionstart-hook
 */

const path = require('path');
// Nothing that loads mama-core is required here: this hook installs it first (plugin-deps.js).
const { ensurePluginDependencies } = require('./plugin-deps.js');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(PLUGIN_ROOT, 'src', 'core');
const { getEnabledFeatures } = require(path.join(CORE_PATH, 'hook-features'));

const RECENT_DECISIONS = 5;

function info(message) {
  console.error(`[INFO] ${message}`);
}

function logError(message) {
  console.error(`[ERROR] ${message}`);
}

/**
 * Consume stdin so Claude Code's write does not fail; SessionStart needs nothing from it.
 * Reading stops after 1 s, and stdin is closed so an open pipe cannot hold the process.
 */
async function drainStdin() {
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 1000);
    process.stdin.on('data', () => {});
    process.stdin.on('end', () => {
      clearTimeout(timeout);
      resolve();
    });
    process.stdin.on('error', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  process.stdin.destroy();
}

/**
 * The last active checkpoint and the newest active decisions.
 *
 * Replaced, retired and contradicted decisions stay out, and so do records that only amend
 * another, as recall leaves them out. A few rows written before timestamps were epoch
 * milliseconds store `created_at` as text; SQLite sorts text above every number, so such a row
 * was always listed first with an unreadable age. Both forms are read as milliseconds.
 */
async function queryRecentContext() {
  const { initDB, getAdapter } = require('@jungjaehoon/mama-core/db-manager');
  const { usePluginDatabase } = require('./db-path.js');
  usePluginDatabase();
  await initDB();
  const adapter = getAdapter();

  const createdMs = `CASE WHEN typeof(created_at) = 'text'
      THEN CAST(strftime('%s', created_at) AS INTEGER) * 1000 ELSE created_at END`;
  const decisions = await adapter
    .prepare(
      `SELECT topic, decision, outcome, ${createdMs} AS created_ms
         FROM decisions
        WHERE COALESCE(status, 'active') = 'active'
          AND json_extract(payload_json, '$.amended') IS NULL
        ORDER BY created_ms DESC
        LIMIT ?`
    )
    .all(RECENT_DECISIONS);
  const checkpoint = await adapter
    .prepare(
      `SELECT timestamp, summary, next_steps
         FROM checkpoints
        WHERE status = 'active'
        ORDER BY timestamp DESC
        LIMIT 1`
    )
    .get();
  return { decisions, checkpoint };
}

function formatRecentContext(decisions, checkpoint, now = Date.now()) {
  let text = '';
  if (checkpoint) {
    text += `\n📍 **Last Checkpoint** (${formatAge(now - checkpoint.timestamp)}):\n`;
    text += `   ${truncate(checkpoint.summary, 80)}\n`;
    if (checkpoint.next_steps) {
      text += `   Next: ${truncate(checkpoint.next_steps, 60)}\n`;
    }
  }
  if (decisions.length > 0) {
    text += `\n🧠 **Recent Decisions** (${decisions.length}):\n`;
    decisions.forEach((d, index) => {
      const mark = d.outcome === 'success' ? '✅' : d.outcome === 'failed' ? '❌' : '⏳';
      text += `   ${index + 1}. ${mark} ${d.topic}: ${truncate(d.decision, 60)} (${formatAge(now - d.created_ms)})\n`;
    });
  }
  return text;
}

function formatAge(ms) {
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) {
    return `${days}d ago`;
  }
  if (hours > 0) {
    return `${hours}h ago`;
  }
  return `${minutes}m ago`;
}

function truncate(text, maxLen) {
  if (!text) {
    return '';
  }
  return text.length <= maxLen ? text : `${text.substring(0, maxLen - 3)}...`;
}

function respond(additionalContext) {
  console.log(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } })
  );
}

async function main() {
  if (getEnabledFeatures().size === 0) {
    info('[SessionStart] All hooks disabled');
    return 0;
  }
  await drainStdin();

  let installed;
  try {
    installed = ensurePluginDependencies();
  } catch (error) {
    logError(`[SessionStart] Dependency install failed: ${error.message}`);
    // Another session installing is not a failure, and running npm by hand beside it would
    // install twice into one folder; the steps are shown only for a failed install.
    if (error.code === 'MAMA_DEPS_BUSY') {
      respond(`⏳ MAMA: ${error.message}`);
      return 0;
    }
    const steps =
      error.code === undefined && process.env.CLAUDE_PLUGIN_DATA
        ? `\nThe next session start tries again. To install by hand:\n\`\`\`bash\ncd "${process.env.CLAUDE_PLUGIN_DATA}"\nnpm install --omit=dev\n\`\`\`\n`
        : '';
    respond(`⚠️ MAMA: Failed to install dependencies\n\nError: ${error.message}\n${steps}`);
    return 1;
  }
  if (installed === 'installed') {
    info('[SessionStart] Dependencies installed into CLAUDE_PLUGIN_DATA');
  }

  try {
    const { decisions, checkpoint } = await queryRecentContext();
    respond(
      `🧠 MAMA memory${formatRecentContext(decisions, checkpoint)}\n` +
        'Search with /mama:search, resume with /mama:resume, record with /mama:decision.'
    );
    return 0;
  } catch (error) {
    logError(`[SessionStart] ${error.message}`);
    respond(`⚠️ MAMA: memory unavailable - ${error.message}`);
    return 1;
  }
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      logError(`[SessionStart] ${error.message}`);
      process.exitCode = 1;
    }
  );
}

module.exports = { main, formatRecentContext, queryRecentContext };
