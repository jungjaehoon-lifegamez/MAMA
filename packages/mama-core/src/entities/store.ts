import { getAdapter, initDB } from '../db-manager.js';
import {
  ENTITY_KINDS,
  ENTITY_OBSERVATION_TYPES,
  ENTITY_SCOPE_KINDS,
  type EntityAlias,
  type EntityNode,
  type EntityObservation,
} from './types.js';

type CreateEntityNodeInput = Omit<EntityNode, 'created_at' | 'updated_at'>;
type AttachEntityAliasInput = Omit<EntityAlias, 'created_at'>;
type UpsertEntityObservationInput = Omit<EntityObservation, 'created_at'>;

function now(): number {
  return Date.now();
}

function normalizeSourceRawDbRef(value: string | null): string {
  return value ?? '';
}

function requireStringField(row: Record<string, unknown>, field: string): string {
  if (typeof row[field] !== 'string' || row[field].length === 0) {
    throw new Error(`Invalid entity observation row: ${field} must be a non-empty string`);
  }
  return row[field] as string;
}

function optionalStringField(row: Record<string, unknown>, field: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(row, field)) {
    throw new Error(`Invalid entity observation row: ${field} must be present`);
  }
  if (row[field] === null) {
    return null;
  }
  if (typeof row[field] !== 'string') {
    throw new Error(`Invalid entity observation row: ${field} must be a string or null`);
  }
  return row[field] as string;
}

function optionalNumberField(row: Record<string, unknown>, field: string): number | null {
  if (!Object.prototype.hasOwnProperty.call(row, field)) {
    throw new Error(`Invalid entity observation row: ${field} must be present`);
  }
  if (row[field] === null) {
    return null;
  }
  if (typeof row[field] !== 'number') {
    throw new Error(`Invalid entity observation row: ${field} must be a number or null`);
  }
  return row[field] as number;
}

export function parseObservationRow(row: Record<string, unknown>): EntityObservation {
  const id = requireStringField(row, 'id');
  const observationType = requireStringField(row, 'observation_type');
  if (
    !ENTITY_OBSERVATION_TYPES.includes(observationType as EntityObservation['observation_type'])
  ) {
    throw new Error(`Invalid entity observation row: observation_type=${observationType}`);
  }
  const entityKindHint = optionalStringField(row, 'entity_kind_hint');
  if (
    entityKindHint !== null &&
    !ENTITY_KINDS.includes(entityKindHint as (typeof ENTITY_KINDS)[number])
  ) {
    throw new Error(`Invalid entity observation row: entity_kind_hint=${entityKindHint}`);
  }
  const scopeKind = optionalStringField(row, 'scope_kind');
  if (scopeKind === null) {
    throw new Error('Invalid entity observation row: scope_kind must not be null');
  }
  if (!ENTITY_SCOPE_KINDS.includes(scopeKind as EntityObservation['scope_kind'])) {
    throw new Error(`Invalid entity observation row: scope_kind=${scopeKind}`);
  }
  const createdAt = row.created_at;
  if (typeof createdAt !== 'number') {
    throw new Error('Invalid entity observation row: created_at must be a number');
  }

  let relatedSurfaceForms: string[] = [];
  if (typeof row.related_surface_forms === 'string') {
    try {
      const parsed = JSON.parse(row.related_surface_forms);
      if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
        throw new Error('parsed value is not a string[]');
      }
      relatedSurfaceForms = parsed as string[];
    } catch (error) {
      throw new Error(
        `Invalid entity observation row: related_surface_forms must be valid JSON string[] (${error instanceof Error ? error.message : String(error)})`
      );
    }
  } else if (row.related_surface_forms !== undefined && row.related_surface_forms !== null) {
    throw new Error(
      'Invalid entity observation row: related_surface_forms must be a JSON string or null'
    );
  }

  const sourceRawDbRef = optionalStringField(row, 'source_raw_db_ref');

  return {
    id,
    observation_type: observationType as EntityObservation['observation_type'],
    entity_kind_hint: entityKindHint as EntityObservation['entity_kind_hint'] | null,
    surface_form: requireStringField(row, 'surface_form'),
    normalized_form: requireStringField(row, 'normalized_form'),
    lang: optionalStringField(row, 'lang'),
    script: optionalStringField(row, 'script'),
    context_summary: optionalStringField(row, 'context_summary'),
    related_surface_forms: relatedSurfaceForms,
    timestamp_observed: optionalNumberField(row, 'timestamp_observed'),
    scope_kind: scopeKind as EntityObservation['scope_kind'],
    scope_id: optionalStringField(row, 'scope_id'),
    extractor_version: requireStringField(row, 'extractor_version'),
    embedding_model_version: optionalStringField(row, 'embedding_model_version'),
    source_connector: requireStringField(row, 'source_connector'),
    source_raw_db_ref: sourceRawDbRef && sourceRawDbRef.length > 0 ? sourceRawDbRef : null,
    source_raw_record_id: requireStringField(row, 'source_raw_record_id'),
    created_at: createdAt,
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
  const createdAt = now();
  const normalizedRawDbRef = normalizeSourceRawDbRef(input.source_raw_db_ref);
  adapter
    .prepare(
      `
        INSERT INTO entity_observations (
          id, observation_type, entity_kind_hint, surface_form, normalized_form, lang, script,
          context_summary, related_surface_forms, timestamp_observed, scope_kind, scope_id,
          extractor_version, embedding_model_version, source_connector, source_raw_db_ref,
          source_raw_record_id, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_connector, source_raw_db_ref, source_raw_record_id, observation_type)
        DO UPDATE SET
          entity_kind_hint = excluded.entity_kind_hint,
          surface_form = excluded.surface_form,
          normalized_form = excluded.normalized_form,
          lang = excluded.lang,
          script = excluded.script,
          context_summary = excluded.context_summary,
          related_surface_forms = excluded.related_surface_forms,
          timestamp_observed = excluded.timestamp_observed,
          scope_kind = excluded.scope_kind,
          scope_id = excluded.scope_id,
          extractor_version = excluded.extractor_version,
          embedding_model_version = excluded.embedding_model_version,
          created_at = entity_observations.created_at
      `
    )
    .run(
      input.id,
      input.observation_type,
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
      normalizedRawDbRef,
      input.source_raw_record_id,
      createdAt
    );

  const saved = adapter
    .prepare(
      `
        SELECT * FROM entity_observations
        WHERE source_connector = ? AND source_raw_db_ref = ? AND source_raw_record_id = ? AND observation_type = ?
      `
    )
    .get(
      input.source_connector,
      normalizedRawDbRef,
      input.source_raw_record_id,
      input.observation_type
    ) as Record<string, unknown>;

  return parseObservationRow(saved);
}

export async function upsertEntityObservations(
  inputs: UpsertEntityObservationInput[]
): Promise<EntityObservation[]> {
  await initDB();
  const adapter = getAdapter();
  const observations: EntityObservation[] = [];
  const runBatch =
    'transaction' in adapter && typeof adapter.transaction === 'function'
      ? adapter.transaction(() => {
          for (const input of inputs) {
            const createdAt = now();
            const normalizedRawDbRef = normalizeSourceRawDbRef(input.source_raw_db_ref);
            adapter
              .prepare(
                `
                  INSERT INTO entity_observations (
                    id, observation_type, entity_kind_hint, surface_form, normalized_form, lang, script,
                    context_summary, related_surface_forms, timestamp_observed, scope_kind, scope_id,
                    extractor_version, embedding_model_version, source_connector, source_raw_db_ref,
                    source_raw_record_id, created_at
                  )
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(source_connector, source_raw_db_ref, source_raw_record_id, observation_type)
                  DO UPDATE SET
                    entity_kind_hint = excluded.entity_kind_hint,
                    surface_form = excluded.surface_form,
                    normalized_form = excluded.normalized_form,
                    lang = excluded.lang,
                    script = excluded.script,
                    context_summary = excluded.context_summary,
                    related_surface_forms = excluded.related_surface_forms,
                    timestamp_observed = excluded.timestamp_observed,
                    scope_kind = excluded.scope_kind,
                    scope_id = excluded.scope_id,
                    extractor_version = excluded.extractor_version,
                    embedding_model_version = excluded.embedding_model_version,
                    created_at = entity_observations.created_at
                `
              )
              .run(
                input.id,
                input.observation_type,
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
                normalizedRawDbRef,
                input.source_raw_record_id,
                createdAt
              );

            const saved = adapter
              .prepare(
                `
                  SELECT * FROM entity_observations
                  WHERE source_connector = ? AND source_raw_db_ref = ? AND source_raw_record_id = ? AND observation_type = ?
                `
              )
              .get(
                input.source_connector,
                normalizedRawDbRef,
                input.source_raw_record_id,
                input.observation_type
              ) as Record<string, unknown>;
            observations.push(parseObservationRow(saved));
          }
        })
      : null;

  if (runBatch) {
    const txResult = runBatch as unknown;
    if (typeof txResult === 'function') {
      txResult();
    }
    return observations;
  }

  for (const input of inputs) {
    observations.push(await upsertEntityObservation(input));
  }
  return observations;
}
