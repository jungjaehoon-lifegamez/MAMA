/**
 * Knowledge search: what the corpus can be asked for by meaning and by word.
 *
 * Both functions take the adapter they read through, so a caller cannot run a
 * search against a database it did not open.
 *
 * @module knowledge/search
 */

import type { DatabaseInstance, DecisionRecord } from '../db-manager.js';
import type { MemoryKindFilter } from '../memory/types.js';

/** Statuses default recall leaves out; history (`includeHistory`) shows them. */
export const RECALL_EXCLUDED_STATUSES = ['superseded', 'contradicted', 'stale'] as const;

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
 * @param kind - Optional memory kind pre-filter
 */
export async function vectorSearch(
  adapter: DatabaseInstance,
  queryEmbedding: Float32Array | number[],
  limit = 5,
  threshold = 0.7,
  topicPrefix?: string,
  excludeStatuses?: readonly string[],
  kind?: MemoryKindFilter
): Promise<DecisionRecord[]> {
  const results = await adapter.vectorSearch(
    queryEmbedding,
    limit * 3,
    topicPrefix,
    excludeStatuses,
    kind
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
  adapter: DatabaseInstance,
  query: string,
  limit = 10,
  kind?: MemoryKindFilter,
  exclude?: { statuses?: readonly string[]; amendments?: boolean }
): Promise<{ id: string; rank: number }[]> {
  // An absent FTS table is a real answer - no rows. A failing adapter is not,
  // so this lookup is left unguarded and its errors reach the caller.
  const tableCheck = adapter
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='decisions_fts'")
    .get() as { name: string } | undefined;
  if (!tableCheck) return [];

  // Query execution - let errors propagate to the caller
  const kinds = Array.isArray(kind) ? kind : kind === undefined ? [] : [kind];
  const kindClause = kinds.length === 0 ? '' : `AND d.kind IN (${kinds.map(() => '?').join(', ')})`;
  // Excluded rows are left out before LIMIT, so they cannot fill the pool ahead of rows that stay.
  const statuses = exclude?.statuses ?? [];
  const statusClause =
    statuses.length === 0
      ? ''
      : `AND (d.status IS NULL OR d.status NOT IN (${statuses.map(() => '?').join(', ')}))`;
  const amendmentClause = exclude?.amendments
    ? "AND json_extract(d.payload_json, '$.amended') IS NULL"
    : '';
  const stmt = adapter.prepare(`
    SELECT d.id, rank
    FROM decisions_fts
    JOIN decisions d ON decisions_fts.rowid = d.rowid
    WHERE decisions_fts MATCH ?
      ${kindClause}
      ${statusClause}
      ${amendmentClause}
    ORDER BY rank
    LIMIT ?
  `);
  return stmt.all(query, ...kinds, ...statuses, limit) as {
    id: string;
    rank: number;
  }[];
}
