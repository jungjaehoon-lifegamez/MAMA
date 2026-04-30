import { createHash, randomUUID } from 'node:crypto';

import { canonicalizeJSON } from '../canonicalize.js';
import { assertTwinRefsVisible } from '../edges/ref-validation.js';
import { mapTwinEdgeRow } from '../edges/store.js';
import {
  TWIN_REF_KINDS,
  type TwinEdgeRecord,
  type TwinRef,
  type TwinVisibility,
} from '../edges/types.js';
import { normalizeEntityLabel } from '../entities/normalization.js';
import { getEntityNode } from '../entities/store.js';
import type { EntityAlias } from '../entities/types.js';
import { AgentGraphValidationError } from './errors.js';
import type {
  AgentGraphAdapter,
  AttachEntityAliasWithEdgeInput,
  AttachEntityAliasWithEdgeResult,
} from './types.js';

const TWIN_REF_KIND_SET = new Set<string>(TWIN_REF_KINDS);

function stableAliasId(input: AttachEntityAliasWithEdgeInput, normalizedLabel: string): string {
  const replayKey = replayIdempotencyKey(input);
  if (replayKey) {
    const hash = createHash('sha256')
      .update(`${input.entity_id}\0${normalizedLabel}\0${replayKey}`, 'utf8')
      .digest('hex')
      .slice(0, 32);
    return `alias_${hash}`;
  }
  return `alias_${randomUUID().replace(/-/g, '')}`;
}

function replayIdempotencyKey(input: AttachEntityAliasWithEdgeInput): string | undefined {
  return input.edge_idempotency_key ?? input.request_idempotency_key;
}

function loadAlias(adapter: AgentGraphAdapter, aliasId: string): EntityAlias {
  const row = adapter.prepare('SELECT * FROM entity_aliases WHERE id = ?').get(aliasId) as
    | Record<string, unknown>
    | undefined;
  if (!row) {
    throw new Error(`Entity alias was not written: ${aliasId}`);
  }
  return {
    id: String(row.id),
    entity_id: String(row.entity_id),
    label: String(row.label),
    normalized_label: String(row.normalized_label),
    lang: typeof row.lang === 'string' ? row.lang : null,
    script: typeof row.script === 'string' ? row.script : null,
    label_type: row.label_type as EntityAlias['label_type'],
    source_type: String(row.source_type),
    source_ref: typeof row.source_ref === 'string' ? row.source_ref : null,
    confidence: typeof row.confidence === 'number' ? row.confidence : null,
    status: row.status as EntityAlias['status'],
    created_at: Number(row.created_at),
  };
}

function normalizeConfidence(value: number | null | undefined): number {
  if (value === undefined || value === null) {
    return 1;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
    return value;
  }
  throw new AgentGraphValidationError(`confidence must be between 0 and 1: ${String(value)}`);
}

function selectExistingAliasEdge(
  adapter: AgentGraphAdapter,
  modelRunId: string,
  edgeIdempotencyKey: string | undefined
): TwinEdgeRecord | null {
  if (!edgeIdempotencyKey) {
    return null;
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

function normalizeSourceRefs(sourceRefs: readonly TwinRef[] | undefined): TwinRef[] {
  if (!sourceRefs || sourceRefs.length === 0) {
    return [];
  }
  const refs: TwinRef[] = [];
  const seen = new Set<string>();
  for (const ref of sourceRefs) {
    if (
      !ref ||
      typeof ref !== 'object' ||
      typeof ref.kind !== 'string' ||
      typeof ref.id !== 'string' ||
      ref.id.trim().length === 0 ||
      !TWIN_REF_KIND_SET.has(ref.kind)
    ) {
      throw new AgentGraphValidationError('source_refs must be TwinRef objects with kind and id.');
    }
    const normalized = { kind: ref.kind, id: ref.id.trim() } as TwinRef;
    const key = `${normalized.kind}:${normalized.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push(normalized);
    }
  }
  return refs.sort((left, right) =>
    `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`)
  );
}

function expectedRelationAttrs(
  alias: EntityAlias,
  sourceRefs: readonly TwinRef[]
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {
    alias_id: alias.id,
    label: alias.label,
    normalized_label: alias.normalized_label,
    lang: alias.lang,
    script: alias.script,
    label_type: alias.label_type,
  };
  if (sourceRefs.length > 0) {
    attrs.source_refs = sourceRefs.map((ref) => ({ kind: ref.kind, id: ref.id }));
  }
  return attrs;
}

function assertAliasReplayMatches(
  alias: EntityAlias,
  input: AttachEntityAliasWithEdgeInput,
  normalized: ReturnType<typeof normalizeEntityLabel>,
  confidence: number
): void {
  const expectedScript = input.script ?? normalized.script;
  const expectedLabelType = input.label_type ?? 'alt';
  const expectedSourceRef = input.source_ref ?? null;
  const matches =
    alias.entity_id === input.entity_id &&
    alias.label === input.label &&
    alias.normalized_label === normalized.normalized &&
    alias.lang === (input.lang ?? null) &&
    alias.script === expectedScript &&
    alias.label_type === expectedLabelType &&
    alias.source_type === input.source_type &&
    alias.source_ref === expectedSourceRef &&
    alias.confidence === confidence &&
    alias.status === 'active';
  if (!matches) {
    throw new AgentGraphValidationError(
      `Conflicting entity alias replay for request idempotency key: ${replayIdempotencyKey(input)}`
    );
  }
}

function assertAliasEdgeReplayMatches(
  edge: TwinEdgeRecord,
  input: AttachEntityAliasWithEdgeInput,
  alias: EntityAlias,
  confidence: number,
  edgeIdempotencyKey: string | undefined,
  sourceRefs: readonly TwinRef[]
): void {
  const matches =
    edge.edge_type === 'alias_of' &&
    edge.subject_ref.kind === 'entity' &&
    edge.subject_ref.id === input.entity_id &&
    edge.object_ref.kind === 'entity' &&
    edge.object_ref.id === input.entity_id &&
    edge.relation_attrs_json === canonicalizeJSON(expectedRelationAttrs(alias, sourceRefs)) &&
    edge.confidence === confidence &&
    edge.source === 'agent' &&
    edge.agent_id === input.agent_id &&
    edge.model_run_id === input.model_run_id &&
    edge.envelope_hash === input.envelope_hash &&
    edge.request_idempotency_key === (input.request_idempotency_key ?? null) &&
    edge.edge_idempotency_key === (edgeIdempotencyKey ?? null);
  if (!matches) {
    throw new AgentGraphValidationError(
      `Conflicting alias edge replay for request idempotency key: ${replayIdempotencyKey(input)}`
    );
  }
}

function insertAliasEdge(
  adapter: AgentGraphAdapter,
  input: AttachEntityAliasWithEdgeInput,
  alias: EntityAlias,
  confidence: number,
  sourceRefs: readonly TwinRef[]
): TwinEdgeRecord {
  const edgeIdempotencyKey = replayIdempotencyKey(input);
  const existing = selectExistingAliasEdge(adapter, input.model_run_id, edgeIdempotencyKey);

  const edgeId = `edge_${randomUUID().replace(/-/g, '')}`;
  const relationAttrs = expectedRelationAttrs(alias, sourceRefs);
  const relationAttrsJson = canonicalizeJSON(relationAttrs);
  if (existing) {
    assertAliasEdgeReplayMatches(
      existing,
      input,
      alias,
      confidence,
      edgeIdempotencyKey,
      sourceRefs
    );
    return existing;
  }

  const contentHash = createHash('sha256')
    .update(
      canonicalizeJSON({
        edge_type: 'alias_of',
        subject_ref: { kind: 'entity', id: input.entity_id },
        object_ref: { kind: 'entity', id: input.entity_id },
        relation_attrs_json: relationAttrsJson,
        confidence,
        source: 'agent',
        agent_id: input.agent_id,
        model_run_id: input.model_run_id,
        envelope_hash: input.envelope_hash,
      }),
      'utf8'
    )
    .digest();

  adapter
    .prepare(
      `
        INSERT INTO twin_edges (
          edge_id, edge_type, subject_kind, subject_id, object_kind, object_id,
          relation_attrs_json, confidence, source, agent_id, model_run_id, envelope_hash,
          request_idempotency_key, edge_idempotency_key, content_hash, created_at
        )
        VALUES (?, 'alias_of', 'entity', ?, 'entity', ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      edgeId,
      input.entity_id,
      input.entity_id,
      relationAttrsJson,
      confidence,
      input.agent_id,
      input.model_run_id,
      input.envelope_hash,
      input.request_idempotency_key ?? null,
      edgeIdempotencyKey ?? null,
      contentHash,
      Date.now()
    );

  const row = adapter.prepare('SELECT * FROM twin_edges WHERE edge_id = ?').get(edgeId) as
    | Record<string, unknown>
    | undefined;
  if (!row) {
    throw new Error(`Entity alias edge was not written: ${edgeId}`);
  }
  return mapTwinEdgeRow(row);
}

export function attachEntityAliasWithEdge(
  adapter: AgentGraphAdapter,
  input: AttachEntityAliasWithEdgeInput
): AttachEntityAliasWithEdgeResult {
  const entity = getEntityNode(input.entity_id, adapter);
  if (!entity || entity.status !== 'active') {
    throw new AgentGraphValidationError(`Active entity not found: ${input.entity_id}`);
  }
  const visibility: TwinVisibility = {
    scopes: input.scopes,
    connectors: input.connectors,
    projectRefs: input.project_refs,
    tenantId: input.tenant_id,
  };
  const sourceRefs = normalizeSourceRefs(input.source_refs);
  if (sourceRefs.length === 0) {
    throw new AgentGraphValidationError('source_refs must include at least one visible source.');
  }
  try {
    assertTwinRefsVisible(
      adapter,
      [{ kind: 'entity', id: input.entity_id }, ...sourceRefs],
      visibility
    );
  } catch (error) {
    throw new AgentGraphValidationError(error instanceof Error ? error.message : String(error));
  }

  let normalized: ReturnType<typeof normalizeEntityLabel>;
  try {
    normalized = normalizeEntityLabel(input.label);
  } catch (error) {
    throw new AgentGraphValidationError(error instanceof Error ? error.message : String(error));
  }
  const confidence = normalizeConfidence(input.confidence);
  const aliasId = stableAliasId(input, normalized.normalized);
  const createdAt = Date.now();

  return adapter.transaction(() => {
    adapter
      .prepare(
        `
          INSERT OR IGNORE INTO entity_aliases (
            id, entity_id, label, normalized_label, lang, script, label_type,
            source_type, source_ref, confidence, status, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
        `
      )
      .run(
        aliasId,
        input.entity_id,
        input.label,
        normalized.normalized,
        input.lang ?? null,
        input.script ?? normalized.script,
        input.label_type ?? 'alt',
        input.source_type,
        input.source_ref ?? null,
        confidence,
        createdAt
      );

    const alias = loadAlias(adapter, aliasId);
    assertAliasReplayMatches(alias, input, normalized, confidence);
    const edge = insertAliasEdge(adapter, input, alias, confidence, sourceRefs);

    return { alias, edge };
  });
}
