/**
 * Utility functions for MAMA OpenClaw Plugin
 * Extracted for testability
 */

/**
 * Truncate text to specified length with ellipsis
 */
export function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  return text.substring(0, maxLen) + '...';
}

/**
 * Type guard for Record objects
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Safely get a string field from a record
 */
export function getStringField(obj: Record<string, unknown>, key: string): string | null {
  const val = obj[key];
  return typeof val === 'string' ? val : null;
}

/**
 * Safely extract error message from unknown error type
 * Always returns a string
 */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'string') {
    return err;
  }
  if (err === undefined) {
    return 'undefined';
  }
  if (err === null) {
    return 'null';
  }
  try {
    const result = JSON.stringify(err);
    return typeof result === 'string' ? result : String(err);
  } catch {
    return String(err);
  }
}

/**
 * Format reasoning with link extraction
 * Shows truncated reasoning + preserves builds_on/debates/synthesizes links
 */
export function formatReasoning(reasoning: string, maxLen: number = 80): string {
  if (!reasoning) return '';

  // Extract link patterns without accidentally consuming trailing prose.
  // - builds_on: single_id or debates: single_id
  // - synthesizes: [id1, id2, ...]
  const linkMatch = reasoning.match(/(builds_on|debates):\s*[\w_-]+|synthesizes:\s*\[[^\]]+\]/i);

  // Truncate main reasoning
  const truncated = reasoning.length > maxLen ? reasoning.substring(0, maxLen) + '...' : reasoning;

  // Add link info if found and not already in truncated part
  if (linkMatch && !truncated.includes(linkMatch[0])) {
    return `${truncated}\n  🔗 ${linkMatch[0]}`;
  }

  return truncated;
}

/**
 * Check if a checkpoint is recent (within threshold)
 */
export function isRecentCheckpoint(
  checkpointTimestamp: string,
  thresholdMs: number = 5 * 60 * 1000
): boolean {
  const checkpointTime = new Date(checkpointTimestamp).getTime();
  const now = Date.now();
  return now - checkpointTime < thresholdMs;
}
