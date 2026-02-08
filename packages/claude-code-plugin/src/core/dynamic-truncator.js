/**
 * Truncate content to fit within a character/token budget.
 * Ensures injected context doesn't overwhelm Claude's context window.
 *
 * @module dynamic-truncator
 */

/**
 * Truncate a single content string to fit within a character budget.
 *
 * @param {string} content - String to truncate
 * @param {Object} options - Configuration options
 * @param {number} options.maxChars - Maximum characters (default: 8000, ~2000 tokens)
 * @param {number} options.maxTokensEstimate - If set, uses ~4 chars/token estimate
 * @param {string} options.suffix - Text to append when truncated (default: '\n\n[Content truncated. See full file.]')
 * @returns {Object} { result: string, truncated: boolean, originalLength: number }
 */
function truncate(content, options = {}) {
  const {
    maxChars = 8000,
    maxTokensEstimate = null,
    suffix = '\n\n[Content truncated. See full file.]',
  } = options;

  if (!content || typeof content !== 'string') {
    return {
      result: '',
      truncated: false,
      originalLength: 0,
    };
  }

  const originalLength = content.length;

  // Calculate effective max chars from token estimate if provided
  let effectiveMaxChars = maxChars;
  if (maxTokensEstimate && maxTokensEstimate > 0) {
    effectiveMaxChars = Math.floor(maxTokensEstimate * 4);
  }

  // If content fits, return as-is
  if (originalLength <= effectiveMaxChars) {
    return {
      result: content,
      truncated: false,
      originalLength,
    };
  }

  // Truncate at last newline before limit (don't cut mid-line)
  let truncateAt = effectiveMaxChars;
  const lastNewline = content.lastIndexOf('\n', effectiveMaxChars);
  if (lastNewline > 0 && lastNewline > effectiveMaxChars - 200) {
    truncateAt = lastNewline;
  }

  const truncated = content.substring(0, truncateAt).trimEnd();
  const result = truncated + suffix;

  return {
    result,
    truncated: true,
    originalLength,
  };
}

/**
 * Truncate multiple entries to fit within a total character budget.
 *
 * Strategy: Allocate budget proportionally by priority.
 * - Priority 0 gets full allocation first
 * - Then priority 1, then 2, etc.
 * - If remaining budget after high-priority items, distribute to lower priority
 *
 * @param {Array<Object>} entries - Array of entries to truncate
 *   Each entry: { content: string, path: string, priority: number }
 * @param {Object} options - Configuration options
 * @param {number} options.maxTotalChars - Total character budget (default: 12000)
 * @param {string} options.suffix - Per-entry truncation suffix
 * @returns {Array<Object>} Array of truncated entries
 *   Each entry: { content: string, path: string, truncated: boolean }
 */
function truncateMultiple(entries, options = {}) {
  const { maxTotalChars = 12000, suffix = '\n\n[Content truncated. See full file.]' } = options;

  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }

  // Sort by priority (ascending: 0 first, then 1, 2, etc.)
  const sorted = [...entries].sort((a, b) => (a.priority || 0) - (b.priority || 0));

  const result = [];
  let remainingBudget = maxTotalChars;

  // Process each priority level
  for (const entry of sorted) {
    if (remainingBudget <= 0) {
      result.push({
        content: '',
        path: entry.path,
        truncated: true,
      });
      continue;
    }

    // Allocate budget for this entry
    const entryBudget = Math.max(500, remainingBudget);
    const truncated = truncate(entry.content, {
      maxChars: entryBudget,
      suffix,
    });

    result.push({
      content: truncated.result,
      path: entry.path,
      truncated: truncated.truncated,
    });

    remainingBudget -= truncated.result.length;
  }

  return result;
}

module.exports = {
  truncate,
  truncateMultiple,
};
