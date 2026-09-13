import type { DatabaseAdapter } from '../db-manager.js';

/**
 * decision_edges + link_audit_log write boundary.
 *
 * Every mutation of the decision-edge graph goes through this module, so
 * `decision_edges` and `link_audit_log` each have exactly one writing module
 * inside `knowledge/` (the sibling judgments.ts owns the judgment-command
 * edge insert). Each function performs the edge change and its audit row
 * inside ONE adapter transaction - a link write and its audit row commit or
 * fail together.
 */

type EdgeWriter = Pick<DatabaseAdapter, 'prepare' | 'transaction'>;

export interface DecisionEdgeKey {
  fromId: string;
  toId: string;
  relationship: string;
}

export interface DecisionEdgeRow extends DecisionEdgeKey {
  reason: string | null;
  createdBy: string | null;
  approvedByUser: number | null;
  decisionId: string | null;
  evidence: string | null;
  createdAt: number | null;
}

export interface ProposedDecisionEdge extends DecisionEdgeKey {
  reason: string;
  decisionId: string | null;
  evidence: string | null;
}

export interface DecisionEdgeDeleteFailure {
  link: string;
  error: string;
}

/**
 * Insert-or-replace one decision edge row with explicit governance columns.
 * Used by the public createEdge API (createdBy 'llm', approvedByUser 1) and by
 * the backup-restore path (columns replayed from the backup file).
 */
export function upsertDecisionEdge(adapter: EdgeWriter, edge: DecisionEdgeRow): void {
  adapter
    .prepare(
      `INSERT OR REPLACE INTO decision_edges
       (from_id, to_id, relationship, reason, created_by, approved_by_user, decision_id, evidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      edge.fromId,
      edge.toId,
      edge.relationship,
      edge.reason,
      edge.createdBy,
      edge.approvedByUser,
      edge.decisionId,
      edge.evidence,
      edge.createdAt
    );
}

/**
 * Record a proposed edge pending user approval, plus its 'proposed' audit row.
 */
export function proposeDecisionEdge(adapter: EdgeWriter, edge: ProposedDecisionEdge): void {
  adapter.transaction(() => {
    adapter
      .prepare(
        `INSERT INTO decision_edges
         (from_id, to_id, relationship, reason, created_by, approved_by_user, decision_id, evidence, created_at)
         VALUES (?, ?, ?, ?, 'llm', 0, ?, ?, ?)`
      )
      .run(
        edge.fromId,
        edge.toId,
        edge.relationship,
        edge.reason,
        edge.decisionId,
        edge.evidence,
        Date.now()
      );

    adapter
      .prepare(
        `INSERT INTO link_audit_log (from_id, to_id, relationship, action, actor, reason, created_at)
         VALUES (?, ?, ?, 'proposed', 'llm', ?, ?)`
      )
      .run(edge.fromId, edge.toId, edge.relationship, edge.reason, Date.now());
  });
}

/**
 * Approve a pending edge, plus its 'approved' audit row.
 */
export function approveDecisionEdge(adapter: EdgeWriter, key: DecisionEdgeKey): void {
  adapter.transaction(() => {
    adapter
      .prepare(
        `UPDATE decision_edges
         SET approved_by_user = 1, approved_at = ?
         WHERE from_id = ? AND to_id = ? AND relationship = ?`
      )
      .run(Date.now(), key.fromId, key.toId, key.relationship);

    adapter
      .prepare(
        `INSERT INTO link_audit_log (from_id, to_id, relationship, action, actor, created_at)
         VALUES (?, ?, ?, 'approved', 'user', ?)`
      )
      .run(key.fromId, key.toId, key.relationship, Date.now());
  });
}

/**
 * Reject a proposed edge: the 'rejected' audit row is written before the edge
 * is deleted, in the same transaction.
 */
export function rejectDecisionEdge(
  adapter: EdgeWriter,
  key: DecisionEdgeKey,
  reason: string
): void {
  adapter.transaction(() => {
    adapter
      .prepare(
        `INSERT INTO link_audit_log (from_id, to_id, relationship, action, actor, reason, created_at)
         VALUES (?, ?, ?, 'rejected', 'user', ?, ?)`
      )
      .run(key.fromId, key.toId, key.relationship, reason, Date.now());

    adapter
      .prepare(
        `DELETE FROM decision_edges
         WHERE from_id = ? AND to_id = ? AND relationship = ?`
      )
      .run(key.fromId, key.toId, key.relationship);
  });
}

/**
 * Remove the auto-generated edge population (created_by='user' with no
 * proposal context) and record one 'deprecated' audit row per removed link.
 * `links` is the already-scanned target set; it only feeds the audit rows.
 */
export function deprecateAutoDecisionEdges(
  adapter: EdgeWriter,
  links: readonly DecisionEdgeKey[],
  reason: string
): void {
  adapter.transaction(() => {
    adapter
      .prepare(`DELETE FROM decision_edges WHERE created_by = 'user' AND decision_id IS NULL`)
      .run();

    const auditStmt = adapter.prepare(
      `INSERT INTO link_audit_log (from_id, to_id, relationship, action, actor, reason, created_at)
       VALUES (?, ?, ?, 'deprecated', 'system', ?, ?)`
    );
    const timestamp = Date.now();
    for (const link of links) {
      auditStmt.run(link.fromId, link.toId, link.relationship, reason, timestamp);
    }
  });
}

/**
 * Delete one batch of edges, writing a 'deprecated' audit row for each. A
 * per-link failure is collected and the batch continues, matching the cleanup
 * tool's accounting; a failure of the batch itself throws to the caller.
 */
export function deleteDecisionEdgesWithAudit(
  adapter: EdgeWriter,
  links: readonly DecisionEdgeKey[],
  reason: string
): { deleted: number; failures: DecisionEdgeDeleteFailure[] } {
  const deleteStmt = adapter.prepare(
    `DELETE FROM decision_edges
     WHERE from_id = ? AND to_id = ? AND relationship = ?`
  );
  const auditStmt = adapter.prepare(
    `INSERT INTO link_audit_log (from_id, to_id, relationship, action, actor, reason, created_at)
     VALUES (?, ?, ?, 'deprecated', 'system', ?, ?)`
  );

  let deleted = 0;
  const failures: DecisionEdgeDeleteFailure[] = [];
  const processLinks = () => {
    for (const link of links) {
      try {
        deleteStmt.run(link.fromId, link.toId, link.relationship);
        auditStmt.run(link.fromId, link.toId, link.relationship, reason, Date.now());
        deleted++;
      } catch (error) {
        failures.push({
          link: `${link.fromId}->${link.toId}`,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  // Use transaction if available, otherwise run directly
  if (adapter.transaction) {
    adapter.transaction(processLinks);
  } else {
    processLinks();
  }
  return { deleted, failures };
}
