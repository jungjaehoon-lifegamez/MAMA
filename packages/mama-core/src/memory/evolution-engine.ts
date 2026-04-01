import type { MemoryEdge, MemoryRecord, FactModality } from './types.js';

interface EvolutionInput {
  incoming: Pick<MemoryRecord, 'topic' | 'summary' | 'kind'> & {
    modality?: FactModality;
    entities?: string[];
  };
  existing: Array<
    Pick<MemoryRecord, 'id' | 'topic' | 'summary' | 'kind'> & {
      _semanticMatch?: boolean;
      modality?: FactModality;
      entities?: string[];
    }
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
 * Check if two facts share at least one entity.
 */
function hasSharedEntity(a?: string[], b?: string[]): boolean {
  if (!a?.length || !b?.length) return false;
  const setB = new Set(b);
  return a.some((e) => setB.has(e));
}

/**
 * Modality transition rules for supersedes detection.
 * When facts share an entity and modality transitions, the newer fact supersedes.
 *
 * plan → completed: plan was executed
 * past_habit → state: habit changed
 * past_habit → completed: resumed/changed habit
 * state → state: status updated
 * plan → plan: plan revised
 */
const SUPERSEDE_TRANSITIONS = new Set([
  'plan→completed',
  'past_habit→state',
  'past_habit→completed',
  'state→state',
  'plan→plan',
  'state→completed',
]);

/**
 * Resolve how an incoming memory relates to existing memories.
 *
 * Rules (priority order):
 *   1. Raw → Extracted: structured fact replaces raw conversation (same topic)
 *   2. Modality transition + shared entity: supersedes (plan→completed, state→state, etc.)
 *   3. Same topic + high summary overlap: supersedes (fact update)
 *   4. Same topic + low overlap: builds_on (independent facts under same topic)
 *   5. Cross-topic: no auto-edge (agent creates these explicitly)
 */
export function resolveMemoryEvolution(input: EvolutionInput): EvolutionResult {
  const edges: MemoryEdge[] = [];

  for (const existing of input.existing) {
    if (existing.topic === input.incoming.topic) {
      // Rule 1: Raw → Extracted supersede
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

      // Rule 2: Modality transition + shared entity → supersedes
      if (
        existing.modality &&
        input.incoming.modality &&
        hasSharedEntity(input.incoming.entities, existing.entities)
      ) {
        const transition = `${existing.modality}→${input.incoming.modality}`;
        if (SUPERSEDE_TRANSITIONS.has(transition)) {
          edges.push({
            from_id: 'incoming',
            to_id: existing.id,
            type: 'supersedes',
            reason: `Modality transition: ${transition}`,
          });
          continue;
        }
      }

      // Rule 3: Same fact update — supersede if summaries share meaningful overlap
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

      // Rule 4: Different content under same topic → independent facts
      edges.push({
        from_id: 'incoming',
        to_id: existing.id,
        type: 'builds_on',
        reason: `Related but distinct (${(overlap * 100).toFixed(0)}% overlap)`,
      });
      continue;
    }

    // Rule 5: Cross-topic — no auto-edge
    // Agent creates these explicitly via mama_save with reasoning
  }

  return { edges };
}
