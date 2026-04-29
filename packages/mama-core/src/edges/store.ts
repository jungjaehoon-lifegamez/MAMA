import { createHash, randomUUID } from 'node:crypto';

import { canonicalizeJSON } from '../canonicalize.js';
import type { DatabaseAdapter } from '../db-manager.js';
import {
  TWIN_EDGE_SOURCES,
  TWIN_EDGE_TYPES,
  TWIN_REF_KINDS,
  type InsertTwinEdgeInput,
  type TwinEdgeRecord,
  type TwinEdgeSource,
  type TwinEdgeSubjectRef,
  type TwinEdgeType,
  type TwinRef,
  type TwinRefKind,
} from './types.js';

type TwinEdgeReadAdapter = Pick<DatabaseAdapter, 'prepare'>;
type TwinEdgeAdapter = Pick<DatabaseAdapter, 'prepare' | 'transaction'>;

const EDGE_TYPE_SET = new Set<string>(TWIN_EDGE_TYPES);
const REF_KIND_SET = new Set<string>(TWIN_REF_KINDS);
const SOURCE_SET = new Set<string>(TWIN_EDGE_SOURCES);
const HUMAN_ACTOR_ROLES = new Set(['commander', 'configurator_elevated']);
const HUMAN_REASON_CLASSIFICATIONS = new Set([
  'factual_correction',
  'agent_inference_wrong',
  'privacy_redaction',
  'duplicate_merge',
  'state_override',
  'other',
]);

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function sha256Buffer(input: string): Buffer {
  return createHash('sha256').update(input, 'utf8').digest();
}

function generatedEdgeId(): string {
  return `edge_${randomUUID().replace(/-/g, '')}`;
}

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

function assertSubjectKindAllowed(ref: TwinRef): asserts ref is TwinEdgeSubjectRef {
  if (ref.kind === 'raw') {
    throw new Error('twin_edges.subject_ref.kind cannot be raw');
  }
}

function normalizeConfidence(value: unknown): number {
  if (value === undefined || value === null) {
    return 1;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
    return value;
  }
  throw new Error(`twin_edges.confidence must be between 0 and 1: ${String(value)}`);
}

function hasDeterministicRule(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).deterministic_rule === 'string' &&
    ((value as Record<string, unknown>).deterministic_rule as string).length > 0
  );
}

function validateSourceMetadata(input: InsertTwinEdgeInput, source: TwinEdgeSource): void {
  if (source === 'agent') {
    requireNonEmptyString(input.agent_id, 'agent_id');
    requireNonEmptyString(input.model_run_id, 'model_run_id');
    requireNonEmptyString(input.envelope_hash, 'envelope_hash');
    return;
  }

  if (source === 'human') {
    requireNonEmptyString(input.human_actor_id, 'human_actor_id');
    const role = requireNonEmptyString(input.human_actor_role, 'human_actor_role');
    if (!HUMAN_ACTOR_ROLES.has(role)) {
      throw new Error(`Unsupported twin_edges.human_actor_role: ${role}`);
    }
    if (input.authority_scope_json === undefined || input.authority_scope_json === null) {
      throw new Error('twin_edges.authority_scope_json is required for human edges');
    }
    const classification = requireNonEmptyString(
      input.reason_classification,
      'reason_classification'
    );
    if (!HUMAN_REASON_CLASSIFICATIONS.has(classification)) {
      throw new Error(`Unsupported twin_edges.reason_classification: ${classification}`);
    }
    return;
  }

  if (!nullableString(input.reason_text) && !hasDeterministicRule(input.relation_attrs)) {
    throw new Error(
      'twin_edges.reason_text or relation_attrs.deterministic_rule is required for code edges'
    );
  }
}

function jsonField(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  try {
    if (typeof value === 'string') {
      return canonicalizeJSON(JSON.parse(value) as unknown);
    }
    return canonicalizeJSON(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid twin_edges.${field}: ${message}`);
  }
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

function exists(adapter: TwinEdgeReadAdapter, table: string, column: string, id: string): boolean {
  const row = adapter
    .prepare(`SELECT 1 AS ok FROM ${table} WHERE ${column} = ? LIMIT 1`)
    .get(id) as { ok: number } | undefined;
  return Boolean(row?.ok);
}

function validateRefExists(adapter: TwinEdgeReadAdapter, ref: TwinRef, field: string): void {
  if (ref.kind === 'report') {
    throw new Error(`${field} ${ref.kind}:${ref.id} is not supported by twin_edges yet`);
  }

  const found =
    (ref.kind === 'memory' && exists(adapter, 'decisions', 'id', ref.id)) ||
    (ref.kind === 'case' && exists(adapter, 'case_truth', 'case_id', ref.id)) ||
    (ref.kind === 'entity' && exists(adapter, 'entity_nodes', 'id', ref.id)) ||
    (ref.kind === 'edge' && exists(adapter, 'twin_edges', 'edge_id', ref.id)) ||
    (ref.kind === 'raw' && exists(adapter, 'connector_event_index', 'event_index_id', ref.id));

  if (!found) {
    throw new Error(`${field} not found: ${ref.kind}:${ref.id}`);
  }
}

function contentHashInput(input: {
  edge_type: TwinEdgeType;
  subject_ref: TwinRef;
  object_ref: TwinRef;
  relation_attrs_json: string | null;
  confidence: number;
  source: TwinEdgeSource;
  agent_id: string | null;
  model_run_id: string | null;
  envelope_hash: string | null;
  human_actor_id: string | null;
  human_actor_role: string | null;
  authority_scope_json: string | null;
  reason_classification: string | null;
  reason_text: string | null;
  evidence_refs_json: string | null;
}): string {
  return canonicalizeJSON(input);
}

function deriveEdgeIdempotencyKey(requestIdempotencyKey: string, contentHash: Buffer): string {
  return `reqedge_${sha256Hex(
    canonicalizeJSON({
      request_idempotency_key: requestIdempotencyKey,
      content_hash: contentHash.toString('hex'),
    })
  ).slice(0, 40)}`;
}

function selectByIdempotency(
  adapter: TwinEdgeReadAdapter,
  modelRunId: string | null,
  edgeIdempotencyKey: string | null
): TwinEdgeRecord | null {
  if (!edgeIdempotencyKey) {
    return null;
  }
  if (!modelRunId) {
    const row = adapter
      .prepare(
        `
          SELECT *
          FROM twin_edges
          WHERE model_run_id IS NULL
            AND edge_idempotency_key = ?
          ORDER BY created_at ASC, edge_id ASC
          LIMIT 1
        `
      )
      .get(edgeIdempotencyKey) as Record<string, unknown> | undefined;
    return row ? mapTwinEdgeRow(row) : null;
  }
  const row = adapter
    .prepare(
      `
        SELECT *
        FROM twin_edges
        WHERE model_run_id = ?
          AND edge_idempotency_key = ?
        LIMIT 1
      `
    )
    .get(modelRunId, edgeIdempotencyKey) as Record<string, unknown> | undefined;
  return row ? mapTwinEdgeRow(row) : null;
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

export function insertTwinEdge(
  adapter: TwinEdgeAdapter,
  input: InsertTwinEdgeInput
): TwinEdgeRecord {
  const edgeType = normalizeEdgeType(input.edge_type);
  const subjectRef = normalizeRef(input.subject_ref, 'subject_ref');
  const objectRef = normalizeRef(input.object_ref, 'object_ref');
  assertSubjectKindAllowed(subjectRef);
  const source = normalizeSource(input.source);
  const confidence = normalizeConfidence(input.confidence);

  validateSourceMetadata(input, source);
  validateRefExists(adapter, subjectRef, 'subject_ref');
  validateRefExists(adapter, objectRef, 'object_ref');

  const relationAttrsJson = jsonField(input.relation_attrs, 'relation_attrs_json');
  const evidenceRefsJson = jsonField(input.evidence_refs, 'evidence_refs_json');
  const authorityScopeJson = jsonField(input.authority_scope_json, 'authority_scope_json');
  const agentId = nullableString(input.agent_id);
  const reasonText = nullableString(input.reason_text);
  const envelopeHash = nullableString(input.envelope_hash);
  const humanActorId = nullableString(input.human_actor_id);
  const humanActorRole = nullableString(input.human_actor_role);
  const reasonClassification = nullableString(input.reason_classification);
  const requestIdempotencyKey = nullableString(input.request_idempotency_key);
  const modelRunId = nullableString(input.model_run_id);

  const contentHash = sha256Buffer(
    contentHashInput({
      edge_type: edgeType,
      subject_ref: subjectRef,
      object_ref: objectRef,
      relation_attrs_json: relationAttrsJson,
      confidence,
      source,
      agent_id: agentId,
      model_run_id: modelRunId,
      envelope_hash: envelopeHash,
      human_actor_id: humanActorId,
      human_actor_role: humanActorRole,
      authority_scope_json: authorityScopeJson,
      reason_classification: reasonClassification,
      reason_text: reasonText,
      evidence_refs_json: evidenceRefsJson,
    })
  );
  const edgeIdempotencyKey =
    nullableString(input.edge_idempotency_key) ??
    (requestIdempotencyKey ? deriveEdgeIdempotencyKey(requestIdempotencyKey, contentHash) : null);

  const existing = selectByIdempotency(adapter, modelRunId, edgeIdempotencyKey);
  if (existing) {
    return existing;
  }

  const edgeId = nullableString(input.edge_id) ?? generatedEdgeId();
  const createdAt = Date.now();

  try {
    return adapter.transaction(() => {
      adapter
        .prepare(
          `
            INSERT INTO twin_edges (
              edge_id, edge_type, subject_kind, subject_id, object_kind, object_id,
              relation_attrs_json, confidence, source, agent_id, model_run_id, envelope_hash,
              human_actor_id, human_actor_role, authority_scope_json, reason_classification,
              reason_text, evidence_refs_json, request_idempotency_key, edge_idempotency_key,
              content_hash, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          edgeId,
          edgeType,
          subjectRef.kind,
          subjectRef.id,
          objectRef.kind,
          objectRef.id,
          relationAttrsJson,
          confidence,
          source,
          agentId,
          modelRunId,
          envelopeHash,
          humanActorId,
          humanActorRole,
          authorityScopeJson,
          reasonClassification,
          reasonText,
          evidenceRefsJson,
          requestIdempotencyKey,
          edgeIdempotencyKey,
          contentHash,
          createdAt
        );

      const inserted = getTwinEdge(adapter, edgeId);
      if (!inserted) {
        throw new Error(`Failed to load inserted twin edge: ${edgeId}`);
      }
      return inserted;
    });
  } catch (error) {
    const duplicate = selectByIdempotency(adapter, modelRunId, edgeIdempotencyKey);
    if (duplicate) {
      return duplicate;
    }
    throw error;
  }
}
