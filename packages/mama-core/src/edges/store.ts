import type { DatabaseAdapter } from '../db-manager.js';
import {
  TWIN_EDGE_SOURCES,
  TWIN_EDGE_TYPES,
  TWIN_REF_KINDS,
  type TwinEdgeRecord,
  type TwinEdgeSource,
  type TwinEdgeType,
  type TwinRef,
  type TwinRefKind,
} from './types.js';

type TwinEdgeReadAdapter = Pick<DatabaseAdapter, 'prepare'>;

const EDGE_TYPE_SET = new Set<string>(TWIN_EDGE_TYPES);
const REF_KIND_SET = new Set<string>(TWIN_REF_KINDS);
const SOURCE_SET = new Set<string>(TWIN_EDGE_SOURCES);

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`twin_edges.${field} must be a non-empty string`);
  }
  return value;
}

function normalizeEdgeType(value: unknown): TwinEdgeType {
  if (typeof value === 'string' && EDGE_TYPE_SET.has(value)) {
    return value as TwinEdgeType;
  }
  throw new Error(`Unsupported twin edge type: ${String(value)}`);
}

function normalizeSource(value: unknown): TwinEdgeSource {
  if (typeof value === 'string' && SOURCE_SET.has(value)) {
    return value as TwinEdgeSource;
  }
  throw new Error(`Unsupported twin edge source: ${String(value)}`);
}

function normalizeRef(ref: TwinRef, field: string): TwinRef {
  if (!ref || typeof ref !== 'object') {
    throw new Error(`${field} must be a TwinRef`);
  }
  if (!REF_KIND_SET.has(ref.kind)) {
    throw new Error(`${field}.kind is unsupported: ${String(ref.kind)}`);
  }
  return {
    kind: ref.kind,
    id: requireNonEmptyString(ref.id, `${field}.id`),
  } as TwinRef;
}

function parseJsonField(value: unknown, field: string, edgeId: string): unknown | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value);
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid twin_edges.${field} for ${edgeId}: ${message}`);
  }
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  throw new Error('twin_edges.content_hash must be a 32-byte Buffer');
}

export function mapTwinEdgeRow(row: Record<string, unknown>): TwinEdgeRecord {
  const edgeId = String(row.edge_id);
  return {
    edge_id: edgeId,
    edge_type: normalizeEdgeType(row.edge_type),
    subject_ref: {
      kind: String(row.subject_kind) as TwinRefKind,
      id: String(row.subject_id),
    } as TwinRef,
    object_ref: {
      kind: String(row.object_kind) as TwinRefKind,
      id: String(row.object_id),
    } as TwinRef,
    relation_attrs_json: nullableString(row.relation_attrs_json),
    relation_attrs: parseJsonField(row.relation_attrs_json, 'relation_attrs_json', edgeId),
    confidence: Number(row.confidence),
    source: normalizeSource(row.source),
    agent_id: nullableString(row.agent_id),
    model_run_id: nullableString(row.model_run_id),
    envelope_hash: nullableString(row.envelope_hash),
    human_actor_id: nullableString(row.human_actor_id),
    human_actor_role: nullableString(row.human_actor_role),
    authority_scope_json: nullableString(row.authority_scope_json),
    authority_scope: parseJsonField(row.authority_scope_json, 'authority_scope_json', edgeId),
    reason_classification: nullableString(row.reason_classification),
    reason_text: nullableString(row.reason_text),
    evidence_refs_json: nullableString(row.evidence_refs_json),
    evidence_refs: parseJsonField(row.evidence_refs_json, 'evidence_refs_json', edgeId),
    request_idempotency_key: nullableString(row.request_idempotency_key),
    edge_idempotency_key: nullableString(row.edge_idempotency_key),
    content_hash: toBuffer(row.content_hash),
    created_at: Number(row.created_at),
  };
}

export function getTwinEdge(adapter: TwinEdgeReadAdapter, edgeId: string): TwinEdgeRecord | null {
  const row = adapter.prepare('SELECT * FROM twin_edges WHERE edge_id = ?').get(edgeId) as
    | Record<string, unknown>
    | undefined;
  return row ? mapTwinEdgeRow(row) : null;
}

export function listTwinEdgesForRefs(
  adapter: TwinEdgeReadAdapter,
  refs: readonly TwinRef[]
): TwinEdgeRecord[] {
  const normalizedRefs = refs.map((ref, index) => normalizeRef(ref, `refs[${index}]`));
  if (normalizedRefs.length === 0) {
    return [];
  }
  const clauses: string[] = [];
  const params: string[] = [];
  for (const ref of normalizedRefs) {
    clauses.push('(subject_kind = ? AND subject_id = ?)');
    params.push(ref.kind, ref.id);
    clauses.push('(object_kind = ? AND object_id = ?)');
    params.push(ref.kind, ref.id);
  }
  const rows = adapter
    .prepare(
      `
        SELECT *
        FROM twin_edges
        WHERE ${clauses.join(' OR ')}
        ORDER BY created_at ASC, edge_id ASC
      `
    )
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapTwinEdgeRow);
}
