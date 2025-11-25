/**
 * Time Formatter - Human-Readable Time Formatting
 *
 * Converts Unix timestamps to human-readable relative time format
 * Examples: "2d ago", "3h ago", "just now"
 *
 * Used by list_decisions and recall_decision tools
 *
 * @module time-formatter
 * @date 2025-11-20
 */

const { warn } = require('./debug-logger');

/**
 * Format Unix timestamp (milliseconds) to human-readable relative time
 *
 * AC #2: Format created_at as human-readable ("2d ago", "3h ago", etc.)
 *
 * @param {number|string} timestamp - Unix timestamp in milliseconds OR ISO 8601 string
 * @returns {string} Human-readable time string
 *
 * @example
 * formatTimeAgo(Date.now() - 3600000) // "1h ago"
 * formatTimeAgo(Date.now() - 172800000) // "2d ago"
 * formatTimeAgo("2025-11-20T10:30:00Z") // "2d ago" (if today is 2025-11-22)
 */
function formatTimeAgo(timestamp) {
  try {
    // Handle null/undefined
    if (!timestamp) {
      warn('[time-formatter] Timestamp is null or undefined, returning "unknown"');
      return 'unknown';
    }

    // Parse ISO 8601 string to timestamp (if string provided)
    let timestampMs;
    if (typeof timestamp === 'string') {
      timestampMs = new Date(timestamp).getTime();
      if (isNaN(timestampMs)) {
        warn(`[time-formatter] Invalid ISO 8601 string: ${timestamp}`);
        return 'unknown';
      }
    } else {
      timestampMs = timestamp;
    }

    const now = Date.now();
    const diff = now - timestampMs;

    // Handle future timestamps (shouldn't happen, but be defensive)
    if (diff < 0) {
      warn(`[time-formatter] Future timestamp detected: ${timestamp}`);
      return 'just now';
    }

    // Calculate time units
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const weeks = Math.floor(days / 7);
    const months = Math.floor(days / 30);
    const years = Math.floor(days / 365);

    // Return human-readable format
    if (seconds < 60) {
      return 'just now';
    }
    if (minutes < 60) {
      return `${minutes}m ago`;
    }
    if (hours < 24) {
      return `${hours}h ago`;
    }
    if (days < 7) {
      return `${days}d ago`;
    }
    if (weeks < 4) {
      return `${weeks}w ago`;
    }
    if (months < 12) {
      return `${months}mo ago`;
    }
    return `${years}y ago`;
  } catch (error) {
    warn(`[time-formatter] Error formatting timestamp ${timestamp}: ${error.message}`);
    return 'unknown';
  }
}

module.exports = {
  formatTimeAgo,
};
