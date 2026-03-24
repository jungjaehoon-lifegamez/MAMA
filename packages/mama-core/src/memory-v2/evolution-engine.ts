import type { MemoryEdge, MemoryRecord } from './types.js';

interface EvolutionInput {
  incoming: Pick<MemoryRecord, 'topic' | 'summary'>;
  existing: Array<Pick<MemoryRecord, 'id' | 'topic' | 'summary'>>;
}

export interface EvolutionResult {
  edges: MemoryEdge[];
}

function hasSharedToken(left: string, right: string): boolean {
  const leftTokens = new Set(
    left
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter(Boolean)
  );
  const rightTokens = right
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);
  return rightTokens.some((token) => leftTokens.has(token));
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
