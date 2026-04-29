import { createHash, randomUUID } from 'node:crypto';

import { canonicalizeJSON } from '../canonicalize.js';
import { assertTwinRefsVisibleToScopes } from '../edges/ref-validation.js';
import { mapTwinEdgeRow } from '../edges/store.js';
import type { TwinEdgeRecord } from '../edges/types.js';
import { normalizeEntityLabel } from '../entities/normalization.js';
import { getEntityNode } from '../entities/store.js';
import type { EntityAlias } from '../entities/types.js';
import { AgentGraphValidationError } from './errors.js';
import type {
  AgentGraphAdapter,
  AttachEntityAliasWithEdgeInput,
  AttachEntityAliasWithEdgeResult,
} from './types.js';

function stableAliasId(input: AttachEntityAliasWithEdgeInput, normalizedLabel: string): string {
  if (input.edge_idempotency_key) {
    const hash = createHash('sha256')
      .update(`${input.entity_id}\0${normalizedLabel}\0${input.edge_idempotency_key}`, 'utf8')
      .digest('hex')
      .slice(0, 32);
    return `alias_${hash}`;
  }
  return `alias_${randomUUID().replace(/-/g, '')}`;
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

function insertAliasEdge(
  adapter: AgentGraphAdapter,
  input: AttachEntityAliasWithEdgeInput,
  alias: EntityAlias,
  confidence: number
): TwinEdgeRecord {
  const existing = selectExistingAliasEdge(adapter, input.model_run_id, input.edge_idempotency_key);
  if (existing) {
    return existing;
  }

  const edgeId = `edge_${randomUUID().replace(/-/g, '')}`;
  const relationAttrs = {
    alias_id: alias.id,
    label: alias.label,
    normalized_label: alias.normalized_label,
    lang: alias.lang,
    script: alias.script,
    label_type: alias.label_type,
  };
  const relationAttrsJson = canonicalizeJSON(relationAttrs);
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
          edge_idempotency_key, content_hash, created_at
        )
        VALUES (?, 'alias_of', 'entity', ?, 'entity', ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?)
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
      input.edge_idempotency_key ?? null,
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
  try {
    assertTwinRefsVisibleToScopes(adapter, [{ kind: 'entity', id: input.entity_id }], input.scopes);
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
    const edge = insertAliasEdge(adapter, input, alias, confidence);

    return { alias, edge };
  });
}
