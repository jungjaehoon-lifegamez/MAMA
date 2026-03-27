import type { MemoryEdge, MemoryRecord } from './types.js';

interface EvolutionInput {
  incoming: Pick<MemoryRecord, 'topic' | 'summary'>;
  existing: Array<Pick<MemoryRecord, 'id' | 'topic' | 'summary'>>;
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
]);

const MIN_TOKEN_LENGTH = 3;
const MIN_SHARED_TOKENS = 2;

function hasSharedToken(left: string, right: string): boolean {
  const leftTokens = new Set(
    left
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length >= MIN_TOKEN_LENGTH && !STOP_WORDS.has(t))
  );
  const rightTokens = right
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= MIN_TOKEN_LENGTH && !STOP_WORDS.has(t));
  let shared = 0;
  for (const token of rightTokens) {
    if (leftTokens.has(token)) {
      shared++;
      if (shared >= MIN_SHARED_TOKENS) return true;
    }
  }
  return false;
}

export function resolveMemoryEvolution(input: EvolutionInput): EvolutionResult {
  const edges: MemoryEdge[] = [];

  for (const existing of input.existing) {
    if (existing.topic === input.incoming.topic) {
      edges.push({
        from_id: 'incoming',
        to_id: existing.id,
        type: 'supersedes',
        reason: 'Same topic indicates latest replacement',
      });
      continue;
    }

    if (hasSharedToken(existing.summary, input.incoming.summary)) {
      edges.push({
        from_id: 'incoming',
        to_id: existing.id,
        type: 'builds_on',
        reason: 'Shared summary keywords indicate related context',
      });
    }
  }

  return { edges };
}
