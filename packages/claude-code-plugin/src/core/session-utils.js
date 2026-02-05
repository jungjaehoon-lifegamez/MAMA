/**
 * Session State Utilities
 *
 * Shared session management functions for hook scripts.
 * Manages per-session long/short output modes to reduce noise.
 *
 * @module session-utils
 */

const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const SESSION_STATE_FILE = path.join(PLUGIN_ROOT, '.hook-session-state.json');

/**
 * Get the current session ID from environment or fallback to date
 * @returns {string} Session identifier
 */
function getSessionId() {
  return (
    process.env.MAMA_SESSION_ID ||
    process.env.CLAUDE_SESSION_ID ||
    process.env.SESSION_ID ||
    new Date().toISOString().slice(0, 10)
  );
}

/**
 * Load session state from file
 * @returns {Object} Session state object
 */
function loadSessionState() {
  try {
    if (fs.existsSync(SESSION_STATE_FILE)) {
      const raw = fs.readFileSync(SESSION_STATE_FILE, 'utf8');
      return JSON.parse(raw || '{}');
    }
  } catch (_err) {
    // Ignore state read errors
  }
  return {};
}

/**
 * Save session state to file
 * @param {Object} state - Session state to save
 */
function saveSessionState(state) {
  try {
    fs.writeFileSync(SESSION_STATE_FILE, JSON.stringify(state), 'utf8');
  } catch (_err) {
    // Ignore state write errors
  }
}

/**
 * Check if long output should be shown for a hook
 * Returns true only on first invocation per session per hook
 * @param {string} hookName - Name of the hook (e.g., 'pre', 'post')
 * @returns {{showLong: boolean, state: Object}} Whether to show long output and current state
 */
function shouldShowLong(hookName) {
  const sessionId = getSessionId();
  const state = loadSessionState();
  if (state.sessionId !== sessionId) {
    state.sessionId = sessionId;
    state.seen = {};
  }
  const seen = state.seen || {};
  const showLong = !seen[hookName];
  return { showLong, state };
}

/**
 * Mark a hook as seen for the current session
 * @param {Object} state - Current session state
 * @param {string} hookName - Name of the hook to mark as seen
 */
function markSeen(state, hookName) {
  if (!state.seen) {
    state.seen = {};
  }
  state.seen[hookName] = true;
  saveSessionState(state);
}

module.exports = {
  getSessionId,
  loadSessionState,
  saveSessionState,
  shouldShowLong,
  markSeen,
  SESSION_STATE_FILE,
};
