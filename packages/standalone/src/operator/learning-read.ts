/**
 * Bounded truth read for learning injection. queryRelevantTruth has no LIMIT: without a
 * cap every turn would pay a full scan of the project's active decisions and ship them all
 * into the prompt filter. Keep the newest rows; log once per trip so the cost is visible.
 */
import type { MemoryScopeRef, MemoryTruthRow } from '@jungjaehoon/mama-core/memory/types';

export const LEARNING_READ_CAP = 200;

export type TruthReader = (params: {
  query: string;
  scopes: MemoryScopeRef[];
}) => Promise<MemoryTruthRow[]>;

export function cappedLearningReader(
  read: TruthReader,
  log: (line: string) => void,
  cap: number = LEARNING_READ_CAP
): (input: { scopes: MemoryScopeRef[]; query: string }) => Promise<MemoryTruthRow[]> {
  return async (input) => {
    const rows = await read({ query: input.query, scopes: input.scopes });
    if (rows.length <= cap) {
      return rows;
    }
    log(`[learning] read cap tripped: ${rows.length} rows in scope, keeping newest ${cap}`);
    return [...rows]
      .sort((a, b) => (b.updated_at ?? b.created_at ?? 0) - (a.updated_at ?? a.created_at ?? 0))
      .slice(0, cap);
  };
}
