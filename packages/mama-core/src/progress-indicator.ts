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
 */

/**
 * Log progress message to stderr
 *
 * Format: [MAMA] emoji message
 * Example: [MAMA] ⏳ Downloading embedding model (120MB)...
 *
 * @param message - Progress message (without emoji or prefix)
 * @param emoji - Emoji indicator (⏳, ✅, ❌, 🔍, etc.)
 */
export function logProgress(message: string, emoji = '⏳'): void {
  // Ensure message is a string - warn in development if not
  if (typeof message !== 'string') {
    if (process.env.NODE_ENV === 'development' || process.env.MAMA_DEBUG) {
      console.error(`[MAMA] ⚠️ logProgress expected string, got ${typeof message}`);
    }
    return;
  }

  // Log to stderr to avoid stdout pollution
  // stderr is used for progress/diagnostic output
  console.error(`[MAMA] ${emoji} ${message}`);
}

/**
 * Log completion message
 */
export function logComplete(message: string): void {
  logProgress(message, '✅');
}

/**
 * Log failure/error message (user-facing progress indicator)
 *
 * Note: Named logFailed to avoid confusion with debug-logger's logError
 * which is used for internal debugging. This is for user-facing progress.
 */
export function logFailed(message: string): void {
  logProgress(message, '❌');
}

// Alias for backward compatibility
export const logError = logFailed;

/**
 * Log loading message
 */
export function logLoading(message: string): void {
  logProgress(message, '⏳');
}

/**
 * Log searching message
 */
export function logSearching(message: string): void {
  logProgress(message, '🔍');
}

// Note: Removed auto-registered SIGINT/SIGTERM handlers that called process.exit(0)
// This was causing issues with host cleanup in parent processes.
// If graceful shutdown is needed, the host application should handle it.
