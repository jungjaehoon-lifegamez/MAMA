/**
 * Fact Extractor — Extracts structured facts from conversations.
 *
 * Always-on memory agent that watches every conversation turn and
 * extracts meaningful decisions, preferences, and lessons learned.
 * Maintains topic consistency by feeding existing topics from DB.
 */

import type { HaikuClient } from './haiku-client.js';
import { warn } from './debug-logger.js';

const MIN_CONTENT_LENGTH = 50;
const MAX_CONTENT_LENGTH = 10_000;

const EXTRACTION_PROMPT = `You are an always-on memory agent for a developer's knowledge base.
Your job: watch every conversation turn and extract facts worth remembering long-term.

## What to extract
- Architecture decisions (database, framework, language, infra choices)
- Technical choices (API design, config, deployment, tooling)
- User preferences and working style (coding style, workflow, role)
- Constraints or requirements discovered
- Lessons learned (what worked, what failed, why)

## What to SKIP (return [])
- Greetings, thanks, casual chat
- Questions without clear answers/decisions
- Temporary debugging steps
- Code review comments without decisions
- Anything too vague to be actionable

## Topic naming rules (CRITICAL)
- Use lowercase snake_case: auth_strategy, database_choice, deployment_config
- Be specific but not too granular: auth_strategy (good), jwt_refresh_token_rotation_policy (too specific)
- REUSE existing topics when the conversation is about the same subject — this creates an evolution chain
- If the user changes a previous decision on the same subject, use the EXACT same topic so the system can track the change

## Fields
- topic: snake_case identifier (MUST reuse existing topic if same subject)
- decision: what was decided, in one clear sentence
- reasoning: why (brief)
- is_static: true = long-term preference/identity (tech stack, coding style, role); false = project-specific work
- confidence: 0.0-1.0 how certain this decision is

Return a JSON array. Return [] if nothing worth saving.
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
 * Feeds existing topics from DB to ensure topic consistency.
 * Returns empty array on any error (graceful degradation).
 */
export async function extractFacts(
  content: string,
  haiku: HaikuClient,
  existingTopics?: string[]
): Promise<ExtractedFact[]> {
  if (content.length < MIN_CONTENT_LENGTH) {
    return [];
  }

  const truncated =
    content.length > MAX_CONTENT_LENGTH
      ? content.slice(0, MAX_CONTENT_LENGTH) + '\n... (truncated)'
      : content;

  // Build user message with existing topics context
  let userMessage = truncated;
  if (existingTopics && existingTopics.length > 0) {
    const topicList = existingTopics.slice(0, 50).join(', ');
    userMessage = `[Existing topics in memory: ${topicList}]\n\nConversation:\n${truncated}`;
  }

  try {
    const response = await haiku.complete(EXTRACTION_PROMPT, userMessage);
    return parseExtractedFacts(response);
  } catch (error) {
    warn(
      `[FactExtractor] Extraction failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }
}

/**
 * Parse LLM's JSON response into typed facts.
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
    warn('[FactExtractor] Failed to parse LLM response as JSON');
    return [];
  }
}
