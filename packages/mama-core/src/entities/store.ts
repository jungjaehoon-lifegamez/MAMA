import { getAdapter, initDB } from '../db-manager.js';
import type { EntityAlias, EntityNode, EntityObservation } from './types.js';

type CreateEntityNodeInput = Omit<EntityNode, 'created_at' | 'updated_at'>;
type AttachEntityAliasInput = Omit<EntityAlias, 'created_at'>;
type UpsertEntityObservationInput = Omit<EntityObservation, 'created_at'>;

function now(): number {
  return Date.now();
}

function parseObservationRow(row: Record<string, unknown>): EntityObservation {
  return {
    id: String(row.id),
    entity_kind_hint:
      typeof row.entity_kind_hint === 'string'
        ? (row.entity_kind_hint as EntityObservation['entity_kind_hint'])
        : null,
    surface_form: String(row.surface_form),
    normalized_form: String(row.normalized_form),
    lang: typeof row.lang === 'string' ? row.lang : null,
    script: typeof row.script === 'string' ? row.script : null,
    context_summary: typeof row.context_summary === 'string' ? row.context_summary : null,
    related_surface_forms:
      typeof row.related_surface_forms === 'string'
        ? (JSON.parse(row.related_surface_forms) as string[])
        : [],
    timestamp_observed: typeof row.timestamp_observed === 'number' ? row.timestamp_observed : null,
    scope_kind: row.scope_kind as EntityObservation['scope_kind'],
    scope_id: typeof row.scope_id === 'string' ? row.scope_id : null,
    extractor_version: String(row.extractor_version),
    embedding_model_version:
      typeof row.embedding_model_version === 'string' ? row.embedding_model_version : null,
    source_connector: String(row.source_connector),
    source_raw_db_ref: typeof row.source_raw_db_ref === 'string' ? row.source_raw_db_ref : null,
    source_raw_record_id: String(row.source_raw_record_id),
    created_at: Number(row.created_at),
  };
}

export async function createEntityNode(input: CreateEntityNodeInput): Promise<EntityNode> {
  await initDB();
  const adapter = getAdapter();
  const createdAt = now();

  adapter
    .prepare(
      `
        INSERT INTO entity_nodes (
          id, kind, preferred_label, status, scope_kind, scope_id, merged_into, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.id,
      input.kind,
      input.preferred_label,
      input.status,
      input.scope_kind,
      input.scope_id,
      input.merged_into,
      createdAt,
      createdAt
    );

  return {
    ...input,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

export function getEntityNode(id: string): EntityNode | null {
  const adapter = getAdapter();
  const row = adapter.prepare('SELECT * FROM entity_nodes WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) {
    return null;
  }

  return {
    id: String(row.id),
    kind: row.kind as EntityNode['kind'],
    preferred_label: String(row.preferred_label),
    status: row.status as EntityNode['status'],
    scope_kind: row.scope_kind as EntityNode['scope_kind'],
    scope_id: typeof row.scope_id === 'string' ? row.scope_id : null,
    merged_into: typeof row.merged_into === 'string' ? row.merged_into : null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export function listEntityNodes(): EntityNode[] {
  const adapter = getAdapter();
  const rows = adapter
    .prepare('SELECT * FROM entity_nodes ORDER BY created_at DESC')
    .all() as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    kind: row.kind as EntityNode['kind'],
    preferred_label: String(row.preferred_label),
    status: row.status as EntityNode['status'],
    scope_kind: row.scope_kind as EntityNode['scope_kind'],
    scope_id: typeof row.scope_id === 'string' ? row.scope_id : null,
    merged_into: typeof row.merged_into === 'string' ? row.merged_into : null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  }));
}

export async function attachEntityAlias(input: AttachEntityAliasInput): Promise<EntityAlias> {
  await initDB();
  const adapter = getAdapter();
  const createdAt = now();

  adapter
    .prepare(
      `
        INSERT INTO entity_aliases (
          id, entity_id, label, normalized_label, lang, script, label_type,
          source_type, source_ref, confidence, status, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.id,
      input.entity_id,
      input.label,
      input.normalized_label,
      input.lang,
      input.script,
      input.label_type,
      input.source_type,
      input.source_ref,
      input.confidence,
      input.status,
      createdAt
    );

  return {
    ...input,
    created_at: createdAt,
  };
}

export function listEntityAliases(entityId: string): EntityAlias[] {
  const adapter = getAdapter();
  const rows = adapter
    .prepare('SELECT * FROM entity_aliases WHERE entity_id = ? ORDER BY created_at ASC')
    .all(entityId) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
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
  }));
}

export async function upsertEntityObservation(
  input: UpsertEntityObservationInput
): Promise<EntityObservation> {
  await initDB();
  const adapter = getAdapter();
  const existing = adapter
    .prepare(
      `
        SELECT * FROM entity_observations
        WHERE source_connector = ? AND source_raw_record_id = ?
      `
    )
    .get(input.source_connector, input.source_raw_record_id) as Record<string, unknown> | undefined;

  if (existing) {
    const observationId = String(existing.id);
    adapter
      .prepare(
        `
          UPDATE entity_observations
          SET
            entity_kind_hint = ?,
            surface_form = ?,
            normalized_form = ?,
            lang = ?,
            script = ?,
            context_summary = ?,
            related_surface_forms = ?,
            timestamp_observed = ?,
            scope_kind = ?,
            scope_id = ?,
            extractor_version = ?,
            embedding_model_version = ?,
            source_raw_db_ref = ?
          WHERE id = ?
        `
      )
      .run(
        input.entity_kind_hint,
        input.surface_form,
        input.normalized_form,
        input.lang,
        input.script,
        input.context_summary,
        JSON.stringify(input.related_surface_forms),
        input.timestamp_observed,
        input.scope_kind,
        input.scope_id,
        input.extractor_version,
        input.embedding_model_version,
        input.source_raw_db_ref,
        observationId
      );

    const updated = adapter
      .prepare('SELECT * FROM entity_observations WHERE id = ?')
      .get(observationId) as Record<string, unknown>;
    return parseObservationRow(updated);
  }

  const createdAt = now();
  adapter
    .prepare(
      `
        INSERT INTO entity_observations (
          id, entity_kind_hint, surface_form, normalized_form, lang, script,
          context_summary, related_surface_forms, timestamp_observed, scope_kind, scope_id,
          extractor_version, embedding_model_version, source_connector, source_raw_db_ref,
          source_raw_record_id, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.id,
      input.entity_kind_hint,
      input.surface_form,
      input.normalized_form,
      input.lang,
      input.script,
      input.context_summary,
      JSON.stringify(input.related_surface_forms),
      input.timestamp_observed,
      input.scope_kind,
      input.scope_id,
      input.extractor_version,
      input.embedding_model_version,
      input.source_connector,
      input.source_raw_db_ref,
      input.source_raw_record_id,
      createdAt
    );

  return {
    ...input,
    created_at: createdAt,
  };
}
