import crypto from 'node:crypto';

import type { DatabaseAdapter } from '../db-manager.js';
import { canonicalizeJSON } from '../canonicalize.js';
import { appendLink, type LinkReceipt } from '../knowledge/links.js';
import type { RecordLink } from './judgment-types.js';
import type { MemoryScopeRef } from './types.js';
import { boundScopesOf, unsignedWriteAccess } from './write-adapters.js';

/**
 * Decision links for the direct memory API (the Claude Code MCP): one decision linked to another,
 * or to a link it corrects, with the reason the caller judged. Nothing is edited.
 */
export interface DecisionLinkInput {
  from: string;
  /** A decision id, or the id of a link this one contradicts. */
  to: string;
  relation: RecordLink['relation'];
  reason: string;
}

function isEdgeId(id: string): boolean {
  return id.startsWith('link_') || id.startsWith('edge_');
}

export function appendDecisionLink(
  adapter: Pick<DatabaseAdapter, 'prepare' | 'transaction' | 'transactionImmediate'>,
  input: DecisionLinkInput
): LinkReceipt {
  const to = isEdgeId(input.to)
    ? { kind: 'edge' as const, id: input.to }
    : { kind: 'memory' as const, id: input.to };
  const scopes = new Map<string, MemoryScopeRef>();
  for (const scope of [
    ...boundScopesOf(adapter, input.from),
    ...(to.kind === 'memory' ? boundScopesOf(adapter, to.id) : []),
  ]) {
    scopes.set(`${scope.kind}\0${scope.id}`, scope);
  }
  // The same statement retried is the same link; a different reason is a different statement.
  const commandId = `link:${crypto
    .createHash('sha256')
    .update(canonicalizeJSON(input))
    .digest('hex')
    .slice(0, 24)}`;
  return appendLink(
    adapter,
    {
      commandId,
      from: { kind: 'memory', id: input.from },
      to,
      relation: input.relation,
      reason: input.reason,
    },
    unsignedWriteAccess([...scopes.values()])
  );
}

export interface DecisionEdgeView {
  relation: string;
  direction: 'out' | 'in';
  otherId: string;
  otherTopic: string | null;
  otherSummary: string | null;
  reason: string | null;
  /** agent: stated through a link; agent_text: parsed from reasoning text; host: written by code. */
  source: 'agent' | 'agent_text' | 'host' | 'user';
  edgeId?: string;
  correctedBy?: Array<{ edgeId: string; reason: string | null; at: number }>;
}

export interface DecisionWithEdges {
  id: string;
  topic: string;
  decision: string;
  reasoning: string | null;
  outcome: string | null;
  status: string | null;
  createdAt: number;
  supersedes: string | null;
  supersededBy: string | null;
  edges: DecisionEdgeView[];
}

const HOST_REASON_PREFIXES = ['Semantically similar', 'Updated fact', 'Related but distinct'];

function legacySource(reason: string | null, createdBy: string | null): DecisionEdgeView['source'] {
  if (reason && HOST_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix))) return 'host';
  if (createdBy === 'llm' || reason?.startsWith('Auto-detected from reasoning'))
    return 'agent_text';
  return 'user';
}

/** One decision with every edge in and out, each with its reason and who wrote it. */
export function readDecisionWithEdges(
  adapter: Pick<DatabaseAdapter, 'prepare'>,
  id: string
): DecisionWithEdges | null {
  const row = adapter
    .prepare(
      `SELECT id, topic, decision, reasoning, outcome, status, created_at, supersedes, superseded_by
         FROM decisions WHERE id = ?`
    )
    .get(id) as
    | {
        id: string;
        topic: string;
        decision: string;
        reasoning: string | null;
        outcome: string | null;
        status: string | null;
        created_at: number;
        supersedes: string | null;
        superseded_by: string | null;
      }
    | undefined;
  if (!row) return null;
  const other = adapter.prepare('SELECT topic, decision FROM decisions WHERE id = ?');
  const describe = (otherId: string) => {
    const found = other.get(otherId) as { topic: string; decision: string } | undefined;
    return {
      otherTopic: found?.topic ?? null,
      otherSummary: found ? found.decision.split('\n')[0]!.slice(0, 200) : null,
    };
  };
  const edges: DecisionEdgeView[] = [];
  const twin = adapter
    .prepare(
      `SELECT edge_id, edge_type, subject_id, object_id, reason_text, relation_attrs_json, source
         FROM twin_edges
        WHERE edge_type <> 'derived_from'
          AND ((subject_kind = 'memory' AND subject_id = ? AND object_kind = 'memory')
            OR (object_kind = 'memory' AND object_id = ? AND subject_kind = 'memory'))
        ORDER BY created_at, edge_id`
    )
    .all(id, id) as Array<{
    edge_id: string;
    edge_type: string;
    subject_id: string;
    object_id: string;
    reason_text: string | null;
    relation_attrs_json: string | null;
    source: string;
  }>;
  const corrections = adapter.prepare(
    `SELECT edge_id, reason_text, created_at FROM twin_edges
      WHERE object_kind = 'edge' AND object_id = ? AND edge_type = 'contradicts'
      ORDER BY created_at, edge_id`
  );
  for (const edge of twin) {
    const out = edge.subject_id === id;
    const otherId = out ? edge.object_id : edge.subject_id;
    const attrs = edge.relation_attrs_json
      ? (JSON.parse(edge.relation_attrs_json) as Record<string, unknown>)
      : {};
    const corrected = (
      corrections.all(edge.edge_id) as Array<{
        edge_id: string;
        reason_text: string | null;
        created_at: number;
      }>
    ).map((correction) => ({
      edgeId: correction.edge_id,
      reason: correction.reason_text,
      at: correction.created_at,
    }));
    edges.push({
      relation: edge.edge_type,
      direction: out ? 'out' : 'in',
      otherId,
      ...describe(otherId),
      reason: typeof attrs.reason === 'string' ? attrs.reason : edge.reason_text,
      source: edge.source === 'code' ? 'host' : 'agent',
      edgeId: edge.edge_id,
      ...(corrected.length > 0 ? { correctedBy: corrected } : {}),
    });
  }
  const legacy = adapter
    .prepare(
      `SELECT from_id, to_id, relationship, reason, created_by FROM decision_edges
        WHERE from_id = ? OR to_id = ?
        ORDER BY created_at`
    )
    .all(id, id) as Array<{
    from_id: string;
    to_id: string;
    relationship: string;
    reason: string | null;
    created_by: string | null;
  }>;
  for (const edge of legacy) {
    const out = edge.from_id === id;
    const otherId = out ? edge.to_id : edge.from_id;
    edges.push({
      relation: edge.relationship,
      direction: out ? 'out' : 'in',
      otherId,
      ...describe(otherId),
      reason: edge.reason,
      source: legacySource(edge.reason, edge.created_by),
    });
  }
  return {
    id: row.id,
    topic: row.topic,
    decision: row.decision,
    reasoning: row.reasoning,
    outcome: row.outcome,
    status: row.status,
    createdAt: row.created_at,
    supersedes: row.supersedes,
    supersededBy: row.superseded_by,
    edges,
  };
}
