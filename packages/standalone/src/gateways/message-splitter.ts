/**
 * Message splitter for messenger platforms
 *
 * Splits long messages into chunks that fit within platform limits
 * while preserving readability (splitting at newlines or spaces).
 */

/**
 * Default maximum message length (Discord limit)
 */
export const DEFAULT_MAX_LENGTH = 2000;

/**
 * Options for message splitting
 */
export interface SplitOptions {
  /** Maximum length per chunk (default: 2000) */
  maxLength?: number;
  /** Preferred split points (default: ['\n', ' ']) */
  splitPoints?: string[];
  /** Suffix to add to split chunks (default: none) */
  chunkSuffix?: string;
  /** Prefix to add to continuation chunks (default: none) */
  continuationPrefix?: string;
}

/**
 * Split a message into chunks that fit within the maximum length
 *
 * @param text - Text to split
 * @param options - Split options
 * @returns Array of text chunks
 */
export function splitMessage(text: string, options: SplitOptions = {}): string[] {
  const {
    maxLength = DEFAULT_MAX_LENGTH,
    splitPoints = ['\n', ' '],
    chunkSuffix = '',
    continuationPrefix = '',
  } = options;

  // Adjust max length for suffix/prefix
  const effectiveMax = maxLength - chunkSuffix.length;
  const firstChunkMax = effectiveMax;
  const continuationMax = effectiveMax - continuationPrefix.length;

  // If text fits, return as single chunk
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  let isFirst = true;

  while (remaining.length > 0) {
    const currentMax = isFirst ? firstChunkMax : continuationMax;

    if (remaining.length <= currentMax) {
      // Last chunk
      const prefix = isFirst ? '' : continuationPrefix;
      chunks.push(prefix + remaining);
      break;
    }

    // Find best split point
    let splitIndex = findBestSplitPoint(remaining, currentMax, splitPoints);

    // Add chunk
    const prefix = isFirst ? '' : continuationPrefix;
    const chunk = prefix + remaining.slice(0, splitIndex).trimEnd();
    chunks.push(chunk + chunkSuffix);

    // Move to next chunk
    remaining = remaining.slice(splitIndex).trimStart();
    isFirst = false;
  }

  return chunks;
}

/**
 * Find the best point to split the text
 *
 * @param text - Text to split
 * @param maxLength - Maximum length for this chunk
 * @param splitPoints - Preferred split characters
 * @returns Index to split at
 */
function findBestSplitPoint(text: string, maxLength: number, splitPoints: string[]): number {
  // Try each split point in order of preference
  for (const splitChar of splitPoints) {
    const lastIndex = text.lastIndexOf(splitChar, maxLength);

    // Only use if it's not too close to the start (at least 50% of maxLength)
    if (lastIndex >= maxLength / 2) {
      return lastIndex + splitChar.length;
    }
  }

  // No good split point found, just cut at maxLength
  return maxLength;
}

/**
 * Split message for Discord (2000 char limit)
 */
export function splitForDiscord(text: string): string[] {
  return splitMessage(text, { maxLength: 2000 });
}

/**
 * Split message for Slack (40000 char limit for regular messages)
 * Note: Slack has different limits for different contexts
 */
export function splitForSlack(text: string): string[] {
  return splitMessage(text, { maxLength: 40000 });
}

/**
 * Estimate number of chunks a message will be split into
 */
export function estimateChunks(text: string, maxLength: number = DEFAULT_MAX_LENGTH): number {
  if (text.length <= maxLength) return 1;
  return Math.ceil(text.length / maxLength);
}

/**
 * Truncate text with ellipsis if too long
 */
export function truncateWithEllipsis(
  text: string,
  maxLength: number,
  ellipsis: string = '...'
): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - ellipsis.length) + ellipsis;
}

/**
 * Split text into code blocks if it contains code
 * Preserves code block formatting
 */
export function splitWithCodeBlocks(
  text: string,
  maxLength: number = DEFAULT_MAX_LENGTH
): string[] {
  // If no code blocks or fits in one message, use simple split
  if (!text.includes('```') || text.length <= maxLength) {
    return splitMessage(text, { maxLength });
  }

  const chunks: string[] = [];
  const codeBlockRegex = /```[\s\S]*?```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    // Text before code block
    const beforeCode = text.slice(lastIndex, match.index);
    if (beforeCode.trim()) {
      chunks.push(...splitMessage(beforeCode, { maxLength }));
    }

    // Code block itself
    const codeBlock = match[0];
    if (codeBlock.length <= maxLength) {
      chunks.push(codeBlock);
    } else {
      // Split long code blocks
      chunks.push(...splitMessage(codeBlock, { maxLength, splitPoints: ['\n'] }));
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last code block
  const remaining = text.slice(lastIndex);
  if (remaining.trim()) {
    chunks.push(...splitMessage(remaining, { maxLength }));
  }

  return chunks;
}
