/**
 * Noise filter for memory ingestion.
 *
 * Rejects low-value content (greetings, internal prompts, very short text,
 * duplicates) before it reaches saveMemory / ingestMemory.
 *
 * Design principle: false positives (losing real info) are worse than
 * false negatives (saving some noise). Keep patterns conservative.
 */

import type { ExtractedMemoryUnit } from './types.js';

// ---- pattern constants (exported for tests) ----

/** Greeting patterns — only match when total length is short */
const GREETING_PATTERNS = [
  /^hi\b/i,
  /^hello\b/i,
  /^hey\b/i,
  /^안녕/,
  /^하이/,
  /^ㅎㅇ/,
  /^yo\b/i,
  /^sup\b/i,
  /^good\s*(morning|afternoon|evening)\b/i,
];

const GREETING_MAX_LENGTH = 50;

/** Internal prompt / tool-call tokens that should never be stored as memory */
const INTERNAL_PROMPT_TOKENS = [
  'INSTRUCTION:',
  'mama_search',
  'mama_save',
  'tool_call',
  'pendingResolve',
  '<task-notification>',
  '<system-reminder>',
  'hook success:',
  'hook_event_name',
];

/** Patterns that indicate meta-conversation (not actionable decisions) */
const META_PATTERNS = [
  /^user:\s*(?:hi|hello|hey|안녕|하이)\b/i,
  /^모니터링/,
  /^확인해/,
  /^테스트/,
  /^ㅇㅋ$/,
  /^ok$/i,
  /^yes$/i,
  /^네$/,
  /^좋아$/,
];

/** Minimum content length (after trimming) to be considered meaningful */
const MIN_CONTENT_LENGTH = 10;

// ---- public API ----

export interface NoiseCheckResult {
  isNoise: boolean;
  reason?: string;
}

/**
 * Check whether a single piece of text is noise.
 *
 * @param content         The raw text to evaluate.
 * @param existingSummaries  Optional set of already-stored summaries for exact-dup detection.
 */
export function isNoise(content: string, existingSummaries?: Set<string>): boolean {
  return checkNoise(content, existingSummaries).isNoise;
}

/**
 * Same as `isNoise` but returns the reason string (useful for logging / tests).
 */
export function checkNoise(content: string, existingSummaries?: Set<string>): NoiseCheckResult {
  const trimmed = content.trim();

  // 1. Very short content
  if (trimmed.length < MIN_CONTENT_LENGTH) {
    return { isNoise: true, reason: 'too_short' };
  }

  // 2. Greeting with short total length
  if (trimmed.length <= GREETING_MAX_LENGTH) {
    for (const pattern of GREETING_PATTERNS) {
      if (pattern.test(trimmed)) {
        return { isNoise: true, reason: 'greeting' };
      }
    }
  }

  // 3. Internal prompt / tool-call tokens
  for (const token of INTERNAL_PROMPT_TOKENS) {
    if (trimmed.includes(token)) {
      return { isNoise: true, reason: 'internal_prompt' };
    }
  }

  // 4. Meta-conversation (short commands, acknowledgements)
  if (trimmed.length <= GREETING_MAX_LENGTH) {
    for (const pattern of META_PATTERNS) {
      if (pattern.test(trimmed)) {
        return { isNoise: true, reason: 'meta_conversation' };
      }
    }
  }

  // 5. Exact duplicate summary
  if (existingSummaries && existingSummaries.size > 0) {
    if (existingSummaries.has(trimmed.toLowerCase())) {
      return { isNoise: true, reason: 'duplicate' };
    }
  }

  return { isNoise: false };
}

/**
 * Filter an array of extracted memory units, removing noise entries.
 *
 * @param units             Units produced by the extraction LLM.
 * @param existingSummaries Optional set of already-stored summaries for exact-dup detection.
 */
export function filterNoiseFromUnits(
  units: ExtractedMemoryUnit[],
  existingSummaries?: Set<string>
): ExtractedMemoryUnit[] {
  const seen = new Set<string>();
  return units.filter((unit) => {
    // 1. Intra-batch dedup first (cheapest check, prevents duplicate processing)
    const content = unit.summary || unit.details;
    const normalizedContent = content.trim().toLowerCase();
    if (seen.has(normalizedContent)) {
      return false;
    }
    seen.add(normalizedContent);

    // 2. Per-field noise check — keep if either summary or details has value
    const summaryNoisy = isNoise(unit.summary, existingSummaries);
    const detailsNoisy = isNoise(unit.details, existingSummaries);
    if (summaryNoisy && detailsNoisy) {
      return false;
    }

    return true;
  });
}
