/**
 * Knowledge graph queries: how a topic got to where it is, and what else it
 * argues with.
 *
 * Both functions take the adapter they read through, so a caller cannot walk a
 * graph in a database it did not open.
 *
 * @module knowledge/graph-query
 */

import type {
  DatabaseAdapter,
  DecisionEdgeRow,
  DecisionRecord,
  SemanticEdgeItem,
  SemanticEdges,
} from '../db-manager.js';

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
