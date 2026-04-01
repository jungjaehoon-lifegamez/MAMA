import type { MemoryEdge, MemoryRecord } from './types.js';

interface EvolutionInput {
  incoming: Pick<MemoryRecord, 'topic' | 'summary' | 'kind'>;
  existing: Array<
    Pick<MemoryRecord, 'id' | 'topic' | 'summary' | 'kind'> & { _semanticMatch?: boolean }
  >;
}

export interface EvolutionResult {
  edges: MemoryEdge[];
}

const STOP_WORDS = new Set([
  'the',
  'is',
  'a',
  'an',
  'to',
  'in',
  'on',
  'of',
  'for',
  'and',
  'or',
  'but',
  'it',
  'we',
  'i',
  'this',
  'that',
  'with',
  'as',
  'at',
  'by',
  'from',
  'be',
  'are',
  'was',
  'were',
  'been',
  'has',
  'have',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'can',
  'could',
  'should',
  'not',
  'no',
  'so',
  'if',
  'up',
  'out',
  'all',
  'its',
  'user',
  'assistant',
]);

const MIN_TOKEN_LENGTH = 3;

function summaryOverlapRatio(left: string, right: string): number {
  const tokenize = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((t) => t.length >= MIN_TOKEN_LENGTH && !STOP_WORDS.has(t))
    );
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (leftTokens.size === 0 && rightTokens.size === 0) {
    return left.toLowerCase().trim() === right.toLowerCase().trim() ? 1 : 0;
  }
  const smaller = leftTokens.size <= rightTokens.size ? leftTokens : rightTokens;
  const larger = leftTokens.size > rightTokens.size ? leftTokens : rightTokens;
  let shared = 0;
  for (const t of smaller) {
    if (larger.has(t)) shared++;
  }
  return shared / Math.max(smaller.size, 1);
}

/**
 * Resolve how an incoming memory relates to existing memories.
 *
 * Supersede rules (conservative — avoid information loss):
 *   1. Raw → Extracted: structured fact replaces raw conversation (same topic, raw kind)
 *   2. Same fact update: same topic + high summary overlap (≥0.6) between two extracted facts
 *
 * Everything else → builds_on (preserves independent facts under same topic)
 */
export function resolveMemoryEvolution(input: EvolutionInput): EvolutionResult {
  const edges: MemoryEdge[] = [];

  for (const existing of input.existing) {
    if (existing.topic === input.incoming.topic) {
      // Rule 1: Raw → Extracted supersede (ingestConversation saves raw first, then extracted)
      // Raw records have kind='fact' but summary starts with conversation text (role prefixes)
      const existingIsRaw =
        existing.kind === 'fact' && /^(user:|assistant:)/i.test(existing.summary.trim());

      if (existingIsRaw) {
        edges.push({
          from_id: 'incoming',
          to_id: existing.id,
          type: 'supersedes',
          reason: 'Structured extraction replaces raw conversation',
        });
        continue;
      }

      // Rule 2: Same fact update — supersede if summaries share meaningful overlap.
      // Threshold 0.3 balances: "Use SQLite" → "Switch to PostgreSQL" (same topic, genuine update)
      // vs "User's cat Luna" / "User's wedding plan" (same topic, independent facts).
      const overlap = summaryOverlapRatio(existing.summary, input.incoming.summary);
      if (overlap >= 0.3) {
        edges.push({
          from_id: 'incoming',
          to_id: existing.id,
          type: 'supersedes',
          reason: `Updated fact (${(overlap * 100).toFixed(0)}% overlap)`,
        });
        continue;
      }

      // Different content under same topic → independent facts, link as builds_on
      edges.push({
        from_id: 'incoming',
        to_id: existing.id,
        type: 'builds_on',
        reason: `Related but distinct (${(overlap * 100).toFixed(0)}% overlap)`,
      });
      continue;
    }

    // Cross-topic semantic edges removed: they produced 87% noise at scale
    // (353/405 builds_on edges were semantic-only, connecting unrelated facts).
    // Cross-topic relationships should be created explicitly by the agent
    // via reasoning="builds_on: <id>" in /mama:decision or by extraction LLM.
  }

  return { edges };
}
