import crypto from 'node:crypto';

import type { DatabaseAdapter } from '../db-manager.js';
import { canonicalizeJSON } from '../canonicalize.js';
import { HOST_EDGE_REASON_PREFIXES } from '../knowledge/graph-query.js';
import { appendLink, type LinkReceipt } from '../knowledge/links.js';
import type { RecordLink } from './judgment-types.js';
import type { MemoryScopeRef } from './types.js';
import { scanMemoryWriteInput, SecretMaterialRefusedError } from './secret-filter.js';
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
  // The reason is stored text, like a checkpoint's, so it passes the same secret scan.
  const scan = scanMemoryWriteInput({ reason: input.reason });
  if (!scan.clean) throw new SecretMaterialRefusedError(scan.matches);
  const to = isEdgeId(input.to)
    ? { kind: 'edge' as const, id: input.to }
    : { kind: 'memory' as const, id: input.to };
  const scopes = new Map<string, MemoryScopeRef>();
  const memoryEnds = [input.from, ...(to.kind === 'memory' ? [to.id] : [])];
  // A correction reads the corrected link, so its ends must be admitted too, down the chain when
  // it corrects a correction. A link names only an edge that already exists, so the chain ends.
  const endsOf = adapter.prepare(
    `SELECT subject_kind, subject_id, object_kind, object_id FROM twin_edges WHERE edge_id = ?`
  );
  let edgeIds = to.kind === 'edge' ? [to.id] : [];
  while (edgeIds.length > 0) {
    const next: string[] = [];
    for (const edgeId of edgeIds) {
      const ends = endsOf.get(edgeId) as
        | { subject_kind: string; subject_id: string; object_kind: string; object_id: string }
        | undefined;
      // An unknown edge is refused by appendLink, which names the caller's own id.
      if (!ends) continue;
      for (const [kind, id] of [
        [ends.subject_kind, ends.subject_id],
        [ends.object_kind, ends.object_id],
      ]) {
        if (kind === 'memory') memoryEnds.push(id!);
        else if (kind === 'edge') next.push(id!);
      }
    }
    edgeIds = next;
  }
  for (const scope of memoryEnds.flatMap((id) => boundScopesOf(adapter, id))) {
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
  correctedBy?: DecisionCorrection[];
  /** On an incoming amends edge: the values the amending record replaced on this decision. */
  replacedValues?: Record<string, unknown>;
}

export interface DecisionCorrection {
  edgeId: string;
  /** The record that states the correction. */
  from: string;
  reason: string | null;
  at: number;
  correctedBy?: DecisionCorrection[];
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

function legacySource(reason: string | null, createdBy: string | null): DecisionEdgeView['source'] {
  if (reason && HOST_EDGE_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix)))
    return 'host';
  if (createdBy === 'llm' || reason?.startsWith('Auto-detected from reasoning'))
    return 'agent_text';
  return 'user';
}

/** Links that contradict these edges, and the links that contradict those, in two queries per level. */
export function correctionsOf(
  adapter: Pick<DatabaseAdapter, 'prepare'>,
  edgeIds: readonly string[]
): Map<string, DecisionCorrection[]> {
  const byTarget = new Map<string, DecisionCorrection[]>();
  let frontier = [...edgeIds];
  while (frontier.length > 0) {
    const placeholders = frontier.map(() => '?').join(', ');
    const rows = adapter
      .prepare(
        `SELECT edge_id, subject_id, object_id, reason_text, created_at FROM twin_edges
          WHERE object_kind = 'edge' AND edge_type = 'contradicts' AND object_id IN (${placeholders})
          ORDER BY created_at, rowid`
      )
      .all(...frontier) as Array<{
      edge_id: string;
      subject_id: string;
      object_id: string;
      reason_text: string | null;
      created_at: number;
    }>;
    for (const row of rows) {
      const list = byTarget.get(row.object_id) ?? [];
      list.push({
        edgeId: row.edge_id,
        from: row.subject_id,
        reason: row.reason_text,
        at: row.created_at,
      });
      byTarget.set(row.object_id, list);
    }
    // A link names only an edge that already exists, so the chain has no cycle.
    frontier = rows.map((row) => row.edge_id);
  }
  const nest = (edgeId: string): DecisionCorrection[] | undefined =>
    byTarget.get(edgeId)?.map((correction) => {
      const further = nest(correction.edgeId);
      return further ? { ...correction, correctedBy: further } : correction;
    });
  const nested = new Map<string, DecisionCorrection[]>();
  for (const edgeId of edgeIds) {
    const list = nest(edgeId);
    if (list) nested.set(edgeId, list);
  }
  return nested;
}

function replacedValuesFor(
  payloadOf: { get: (id: string) => unknown },
  amendingId: string,
  targetId: string
): Record<string, unknown> | undefined {
  const row = payloadOf.get(amendingId) as { payload_json: string | null } | undefined;
  if (!row?.payload_json) return undefined;
  const payload = JSON.parse(row.payload_json) as {
    replacedValues?: Array<{ target: string; values: Record<string, unknown> }>;
  };
  return payload.replacedValues?.find((entry) => entry.target === targetId)?.values;
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
        ORDER BY created_at, rowid`
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
  const corrections = correctionsOf(
    adapter,
    twin.map((edge) => edge.edge_id)
  );
  const payloadOf = adapter.prepare('SELECT payload_json FROM decisions WHERE id = ?');
  for (const edge of twin) {
    const out = edge.subject_id === id;
    const otherId = out ? edge.object_id : edge.subject_id;
    const attrs = edge.relation_attrs_json
      ? (JSON.parse(edge.relation_attrs_json) as Record<string, unknown>)
      : {};
    const corrected = corrections.get(edge.edge_id);
    const replaced =
      !out && edge.edge_type === 'amends' ? replacedValuesFor(payloadOf, otherId, id) : undefined;
    edges.push({
      relation: edge.edge_type,
      direction: out ? 'out' : 'in',
      otherId,
      ...describe(otherId),
      reason: typeof attrs.reason === 'string' ? attrs.reason : edge.reason_text,
      source: edge.source === 'code' ? 'host' : 'agent',
      edgeId: edge.edge_id,
      ...(corrected ? { correctedBy: corrected } : {}),
      ...(replaced ? { replacedValues: replaced } : {}),
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
