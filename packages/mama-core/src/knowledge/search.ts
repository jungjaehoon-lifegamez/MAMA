/**
 * Knowledge search: what the corpus can be asked for by meaning and by word.
 *
 * Both functions take the adapter they read through, so a caller cannot run a
 * search against a database it did not open.
 *
 * @module knowledge/search
 */

import type { DatabaseAdapter, DecisionRecord } from '../db-manager.js';

/**
 * Brute-force cosine similarity search over stored embeddings.
 *
 * Errors are not swallowed: an empty array means the corpus held nothing above
 * `threshold`, never that the search failed.
 *
 * @param adapter - Database to read through
 * @param queryEmbedding - Query embedding (1024-dim)
 * @param limit - Max results to return
 * @param threshold - Minimum similarity
 * @param topicPrefix - Optional topic prefix pre-filter
 * @param excludeStatuses - Optional decision statuses to pre-filter out
 */
export async function vectorSearch(
  adapter: DatabaseAdapter,
  queryEmbedding: Float32Array | number[],
  limit = 5,
  threshold = 0.7,
  topicPrefix?: string,
  excludeStatuses?: readonly string[]
): Promise<DecisionRecord[]> {
  const results = await adapter.vectorSearch(
    queryEmbedding,
    limit * 3,
    topicPrefix,
    excludeStatuses
  );

  if (!results || results.length === 0) {
    return [];
  }

  const stmt = adapter.prepare(`SELECT * FROM decisions WHERE rowid = ?`);
  const decisions: (DecisionRecord & { similarity: number; distance: number })[] = [];

  for (const row of results) {
    const decision = stmt.get(row.rowid) as DecisionRecord | undefined;

    if (!decision) {
      continue;
    }

    const similarity = row.similarity ?? Math.max(0, 1.0 - (row.distance ?? 1));
    const distance = row.distance ?? Math.max(0, 1.0 - similarity);

    if (similarity >= threshold) {
      decisions.push({
        ...decision,
        distance,
        similarity,
      });
    }

    if (decisions.length >= limit) {
      break;
    }
  }

  return decisions;
}

/**
 * FTS5 keyword search on the decisions table.
 *
 * @param adapter - Database to read through
 * @param query - FTS5 MATCH expression
 * @param limit - Max rows to return
 * @returns Matching decision IDs with BM25 rank scores
 */
export async function fts5Search(
  adapter: DatabaseAdapter,
  query: string,
  limit = 10
): Promise<{ id: string; rank: number }[]> {
  // Check if FTS5 table exists (swallow errors - table may not exist yet)
  let tableCheck: { name: string } | undefined;
  try {
    tableCheck = adapter
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='decisions_fts'")
      .get() as { name: string } | undefined;
  } catch {
    return [];
  }
  if (!tableCheck) return [];

  // Query execution - let errors propagate to the caller
  const stmt = adapter.prepare(`
    SELECT d.id, rank
    FROM decisions_fts
    JOIN decisions d ON decisions_fts.rowid = d.rowid
    WHERE decisions_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `);
  return stmt.all(query, limit) as { id: string; rank: number }[];
}
