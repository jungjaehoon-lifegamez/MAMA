/**
 * Decision read queries.
 *
 * Every function here takes the adapter it reads through. None of them reaches
 * for a module-level connection, so a caller cannot run one of these against a
 * database it did not open. This is the same shape the rest of `search/` already
 * uses (`feedback-store.ts`, `ranker-rescore.ts`, `ranker-trainer.ts`).
 *
 * @module search/decision-queries
 */

import type {
  DatabaseAdapter,
  DecisionEdgeRow,
  DecisionRecord,
  SemanticEdgeItem,
  SemanticEdges,
} from '../db-manager.js';

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
 * Walk a topic's supersedes chain with a recursive CTE.
 *
 * @param adapter - Database to read through
 * @param topic - Decision topic to query
 * @param anchorId - Start from this decision instead of the topic's current head
 * @returns Decisions ordered by recency, each carrying its approved edges
 */
export async function queryDecisionGraph(
  adapter: DatabaseAdapter,
  topic: string,
  anchorId?: string
): Promise<DecisionRecord[]> {
  try {
    if (!anchorId) {
      const decisions = adapter
        .prepare(
          `
          WITH RECURSIVE decision_chain AS (
            SELECT * FROM decisions WHERE topic = ? AND superseded_by IS NULL
            UNION
            SELECT d.* FROM decisions d
            JOIN decision_chain dc ON d.id = dc.supersedes
          )
          SELECT * FROM decision_chain ORDER BY created_at DESC, id DESC
        `
        )
        .all(topic) as DecisionRecord[];
      const edgesStmt = adapter.prepare(`
        SELECT * FROM decision_edges
        WHERE from_id = ?
          AND (approved_by_user = 1 OR approved_by_user IS NULL)
      `);
      for (const decision of decisions) {
        decision.edges = edgesStmt.all(decision.id) as DecisionEdgeRow[];
        if (decision.refined_from && typeof decision.refined_from === 'string') {
          try {
            decision.refined_from = JSON.parse(decision.refined_from);
          } catch {
            decision.refined_from = [];
          }
        }
      }
      return decisions;
    }
    const stmt = adapter.prepare(`
      WITH RECURSIVE decision_chain AS (
        SELECT * FROM (
          SELECT * FROM decisions
          WHERE id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        )

        UNION ALL

        -- Recursive case: Get previous decisions
        SELECT d.* FROM decisions d
        JOIN decision_chain dc ON d.id = dc.supersedes
      )
      SELECT * FROM decision_chain
      ORDER BY created_at DESC
    `);
    const decisions = stmt.all(anchorId) as DecisionRecord[];

    // Join with decision_edges to include relationships
    // Prepare statement once outside loop for performance
    const edgesStmt = adapter.prepare(`
      SELECT * FROM decision_edges
      WHERE from_id = ?
        AND (approved_by_user = 1 OR approved_by_user IS NULL)
    `);
    for (const decision of decisions) {
      decision.edges = edgesStmt.all(decision.id) as DecisionEdgeRow[];

      // Parse refined_from JSON if exists
      if (decision.refined_from) {
        try {
          decision.refined_from =
            typeof decision.refined_from === 'string'
              ? JSON.parse(decision.refined_from)
              : decision.refined_from;
        } catch {
          decision.refined_from = [];
        }
      }
    }

    return decisions;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Decision graph query failed: ${message}`);
  }
}

/**
 * Outgoing and incoming semantic edges for a set of decisions.
 *
 * @param adapter - Database to read through
 * @param decisionIds - Decision IDs to query edges for
 * @returns Edges categorized by relationship and direction
 */
export async function querySemanticEdges(
  adapter: DatabaseAdapter,
  decisionIds: string[]
): Promise<SemanticEdges> {
  if (!decisionIds || decisionIds.length === 0) {
    return {
      refines: [],
      refined_by: [],
      contradicts: [],
      contradicted_by: [],
      // Story 2.1: Extended edge types
      builds_on: [],
      built_on_by: [],
      debates: [],
      debated_by: [],
      synthesizes: [],
      synthesized_by: [],
    };
  }

  try {
    // Build placeholders for IN clause
    const placeholders = decisionIds.map(() => '?').join(',');

    // Story 2.1: Include new edge types in query
    const edgeTypes = ['refines', 'contradicts', 'builds_on', 'debates', 'synthesizes'];
    const edgeTypePlaceholders = edgeTypes.map(() => '?').join(',');

    // Query outgoing edges (from_id = decision)
    const outgoingStmt = adapter.prepare(`
      SELECT e.*, d.topic, d.decision, d.confidence, d.created_at
      FROM decision_edges e
      JOIN decisions d ON e.to_id = d.id
      WHERE e.from_id IN (${placeholders})
        AND e.relationship IN (${edgeTypePlaceholders})
        AND (e.approved_by_user = 1 OR e.approved_by_user IS NULL)
      ORDER BY e.created_at DESC
    `);
    const outgoingEdges = outgoingStmt.all(...decisionIds, ...edgeTypes) as SemanticEdgeItem[];

    // Query incoming edges (to_id = decision)
    const incomingStmt = adapter.prepare(`
      SELECT e.*, d.topic, d.decision, d.confidence, d.created_at
      FROM decision_edges e
      JOIN decisions d ON e.from_id = d.id
      WHERE e.to_id IN (${placeholders})
        AND e.relationship IN (${edgeTypePlaceholders})
        AND (e.approved_by_user = 1 OR e.approved_by_user IS NULL)
      ORDER BY e.created_at DESC
    `);
    const incomingEdges = incomingStmt.all(...decisionIds, ...edgeTypes) as SemanticEdgeItem[];

    // Categorize edges (original + v1.3 extended)
    const refines = outgoingEdges.filter((e) => e.relationship === 'refines');
    const refined_by = incomingEdges.filter((e) => e.relationship === 'refines');
    const contradicts = outgoingEdges.filter((e) => e.relationship === 'contradicts');
    const contradicted_by = incomingEdges.filter((e) => e.relationship === 'contradicts');
    // Story 2.1: New edge type categories
    const builds_on = outgoingEdges.filter((e) => e.relationship === 'builds_on');
    const built_on_by = incomingEdges.filter((e) => e.relationship === 'builds_on');
    const debates = outgoingEdges.filter((e) => e.relationship === 'debates');
    const debated_by = incomingEdges.filter((e) => e.relationship === 'debates');
    const synthesizes = outgoingEdges.filter((e) => e.relationship === 'synthesizes');
    const synthesized_by = incomingEdges.filter((e) => e.relationship === 'synthesizes');

    return {
      refines,
      refined_by,
      contradicts,
      contradicted_by,
      builds_on,
      built_on_by,
      debates,
      debated_by,
      synthesizes,
      synthesized_by,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Semantic edges query failed: ${message}`);
  }
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
