/**
 * Fact Extractor — Extracts structured facts from conversations using Haiku.
 *
 * Given raw conversation text, uses Haiku to identify architecture decisions,
 * technical choices, and lessons learned. Returns structured facts ready for
 * mama.save().
 */

import type { HaikuClient } from './haiku-client.js';
import { warn } from './debug-logger.js';

const MIN_CONTENT_LENGTH = 50;
const MAX_CONTENT_LENGTH = 10_000;

const EXTRACTION_PROMPT = `You are a fact extractor for a developer's memory system.
Given a conversation between a user and an AI assistant, extract ONLY:
- Architecture decisions (database, framework, language choices)
- Technical choices (API design, config changes, deployment strategy)
- Important constraints or requirements discovered
- Lessons learned (what worked, what failed, why)

DO NOT extract:
- Greetings, thanks, casual chat
- Questions without answers
- Temporary debugging steps
- Code snippets (the code itself is in the repo)

For each fact, classify as:
- static: true if this is a long-term preference/choice (tech stack, coding style, role)
- static: false if this is about current work (this PR, this sprint, this bug)

Return a JSON array of objects with these fields: topic, decision, reasoning, is_static, confidence
Return empty array [] if nothing worth saving.
Return ONLY the JSON array, no other text.`;

export interface ExtractedFact {
  topic: string;
  decision: string;
  reasoning: string;
  is_static: boolean;
  confidence: number;
}

/**
 * Extract structured facts from conversation content.
 * Returns empty array on any error (graceful degradation).
 */
export async function extractFacts(content: string, haiku: HaikuClient): Promise<ExtractedFact[]> {
  if (content.length < MIN_CONTENT_LENGTH) {
    return [];
  }

  const truncated =
    content.length > MAX_CONTENT_LENGTH
      ? content.slice(0, MAX_CONTENT_LENGTH) + '\n... (truncated)'
      : content;

  try {
    const response = await haiku.complete(EXTRACTION_PROMPT, truncated);
    return parseExtractedFacts(response);
  } catch (error) {
    warn(
      `[FactExtractor] Extraction failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }
}

/**
 * Parse Haiku's JSON response into typed facts.
 * Handles malformed JSON, missing fields, and unexpected shapes.
 */
function parseExtractedFacts(response: string): ExtractedFact[] {
  try {
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter(
        (item: unknown): item is Record<string, unknown> =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Record<string, unknown>).topic === 'string' &&
          typeof (item as Record<string, unknown>).decision === 'string'
      )
      .map((item) => ({
        topic: String(item.topic).toLowerCase().replace(/\s+/g, '_'),
        decision: String(item.decision),
        reasoning: String(item.reasoning || ''),
        is_static: Boolean(item.is_static),
        confidence: typeof item.confidence === 'number' ? item.confidence : 0.5,
      }));
  } catch {
    warn('[FactExtractor] Failed to parse Haiku response as JSON');
    return [];
  }
}
