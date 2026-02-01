/**
 * MAMA Progress Indicator
 *
 * Text-based progress feedback for long-running operations.
 * Helps first-time users understand what's happening during initialization.
 *
 * Features:
 * - Logs to stderr (no stdout pollution)
 * - Emoji indicators: ⏳ (loading), ✅ (done), ❌ (error)
 * - Concise messages (<50 chars)
 *
 * @module progress-indicator
 * @version 1.0
 * @date 2026-01-30
 */

/**
 * Log progress message to stderr
 *
 * Format: [MAMA] emoji message
 * Example: [MAMA] ⏳ Downloading embedding model (120MB)...
 *
 * @param {string} message - Progress message (without emoji or prefix)
 * @param {string} [emoji='⏳'] - Emoji indicator (⏳, ✅, ❌, 🔍, etc.)
 * @returns {void}
 */
function logProgress(message, emoji = '⏳') {
  // Ensure message is a string
  if (typeof message !== 'string') {
    return;
  }

  // Log to stderr to avoid stdout pollution
  // stderr is used for progress/diagnostic output
  console.error(`[MAMA] ${emoji} ${message}`);
}

/**
 * Log completion message
 *
 * @param {string} message - Completion message
 * @returns {void}
 */
function logComplete(message) {
  logProgress(message, '✅');
}

/**
 * Log error message
 *
 * @param {string} message - Error message
 * @returns {void}
 */
function logError(message) {
  logProgress(message, '❌');
}

/**
 * Log info message
 *
 * @param {string} message - Info message
 * @returns {void}
 */
function logInfo(message) {
  logProgress(message, 'ℹ️');
}

/**
 * Log loading message
 *
 * @param {string} message - Loading message
 * @returns {void}
 */
function logLoading(message) {
  logProgress(message, '⏳');
}

/**
 * Log searching message
 *
 * @param {string} message - Searching message
 * @returns {void}
 */
function logSearching(message) {
  logProgress(message, '🔍');
}

// Note: Removed auto-registered SIGINT/SIGTERM handlers that called process.exit(0)
// This was causing issues with host cleanup in parent processes.
// If graceful shutdown is needed, the host application should handle it.

// Export API
module.exports = {
  logProgress,
  logComplete,
  logError,
  logInfo,
  logLoading,
  logSearching,
};
