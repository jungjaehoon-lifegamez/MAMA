import { randomUUID } from 'node:crypto';
import { getAdapter, initDB } from '../db-manager.js';
import {
  ENTITY_KINDS,
  ENTITY_OBSERVATION_TYPES,
  ENTITY_SCOPE_KINDS,
  type EntityAlias,
  type EntityNode,
  type EntityObservation,
  type EntityTimelineEvent,
} from './types.js';

export interface EntityStoreAdapter {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export class EntityMergeError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'EntityMergeError';
  }
}

const MAX_MERGE_CHAIN_DEPTH = 8;
const OBSERVATION_CONTEXT_KEY_COLUMNS = [
  'workspace_context_key',
  'channel_context_key',
  'thread_context_key',
  'actor_context_key',
] as const;
const tableColumnCache = new WeakMap<EntityStoreAdapter, Map<string, Set<string>>>();

type CreateEntityNodeInput = Omit<EntityNode, 'created_at' | 'updated_at'>;
type AttachEntityAliasInput = Omit<EntityAlias, 'created_at'>;
type ObservationContextKeyColumn = (typeof OBSERVATION_CONTEXT_KEY_COLUMNS)[number];
type UpsertEntityObservationInput = Omit<EntityObservation, 'created_at'> &
  Partial<Record<ObservationContextKeyColumn, string | null>>;
type AppendEntityTimelineEventInput = {
  event: Omit<EntityTimelineEvent, 'id' | 'created_at'> & {
    id?: string;
    created_at?: number;
  };
  adapter?: EntityStoreAdapter;
};

export interface UpsertEntityObservationResult {
  id: string;
  created: boolean;
}

function now(): number {
  return Date.now();
}

function normalizeSourceLocator(value: string | null | undefined): string {
  // Write empty-string as the null sentinel so SQLite UNIQUE can collapse null-like locators; parseObservationRow maps it back to null on read.
  return value ?? '';
}

function normalizeContextKey(value: string | null | undefined): string {
  return value ?? '';
}

function sourceLocatorForInput(input: UpsertEntityObservationInput): string {
  return normalizeSourceLocator(input.source_locator);
}

function channelContextKey(input: UpsertEntityObservationInput): string {
  if (input.channel_context_key !== undefined) {
    return normalizeContextKey(input.channel_context_key);
  }
  if (input.scope_kind !== 'channel' || !input.scope_id) {
    return '';
  }
  return input.scope_id.startsWith(`${input.source_connector}:`)
    ? input.scope_id
    : `${input.source_connector}:${input.scope_id}`;
}

function actorContextKey(input: UpsertEntityObservationInput): string {
  if (input.actor_context_key !== undefined) {
    return normalizeContextKey(input.actor_context_key);
  }
  if (input.observation_type === 'author') {
    return input.surface_form;
  }
  return input.related_surface_forms.find((value) => value.trim().length > 0) ?? '';
}

function observationContextKeys(
  input: UpsertEntityObservationInput
): Record<ObservationContextKeyColumn, string> {
  return {
    workspace_context_key: normalizeContextKey(
      input.workspace_context_key ?? input.source_connector
    ),
    channel_context_key: channelContextKey(input),
    thread_context_key: normalizeContextKey(input.thread_context_key),
    actor_context_key: actorContextKey(input),
  };
}

function tableColumnNames(adapter: EntityStoreAdapter, tableName: string): Set<string> {
  let adapterCache = tableColumnCache.get(adapter);
  if (!adapterCache) {
    adapterCache = new Map<string, Set<string>>();
    tableColumnCache.set(adapter, adapterCache);
  }
  const cached = adapterCache.get(tableName);
  if (cached) {
    return cached;
  }
  const rows = adapter.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  const columns = new Set(rows.map((row) => row.name));
  adapterCache.set(tableName, columns);
  return columns;
}

export function clearEntityTableColumnCache(adapter: EntityStoreAdapter): void {
  tableColumnCache.delete(adapter);
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

function optionalStringFieldIfPresent(
  row: Record<string, unknown>,
  field: string
): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(row, field)) {
    return undefined;
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

  const sourceLocator = optionalStringFieldIfPresent(row, 'source_locator');
  if (sourceLocator === undefined) {
    throw new Error('Invalid entity observation row: source_locator must be present');
  }

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
    source_locator: sourceLocator && sourceLocator.length > 0 ? sourceLocator : null,
    source_raw_record_id: requireStringField(row, 'source_raw_record_id'),
    workspace_context_key: optionalStringFieldIfPresent(row, 'workspace_context_key'),
    channel_context_key: optionalStringFieldIfPresent(row, 'channel_context_key'),
    thread_context_key: optionalStringFieldIfPresent(row, 'thread_context_key'),
    actor_context_key: optionalStringFieldIfPresent(row, 'actor_context_key'),
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

export function getEntityNode(
  id: string,
  adapter: EntityStoreAdapter = getAdapter()
): EntityNode | null {
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
    scope_kind:
      typeof row.scope_kind === 'string' ? (row.scope_kind as EntityNode['scope_kind']) : null,
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
    scope_kind:
      typeof row.scope_kind === 'string' ? (row.scope_kind as EntityNode['scope_kind']) : null,
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

export function listEntityAliases(
  entityId: string,
  adapter: EntityStoreAdapter = getAdapter()
): EntityAlias[] {
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

function observationContextColumns(columns: Set<string>): ObservationContextKeyColumn[] {
  return OBSERVATION_CONTEXT_KEY_COLUMNS.filter((column) => columns.has(column));
}

function observationInsertValues(
  input: UpsertEntityObservationInput,
  normalizedSourceLocator: string,
  contextColumns: ObservationContextKeyColumn[],
  contextKeys: Record<ObservationContextKeyColumn, string>,
  createdAt: number
): { columns: string[]; values: unknown[] } {
  const columns = [
    'id',
    'observation_type',
    'entity_kind_hint',
    'surface_form',
    'normalized_form',
    'lang',
    'script',
    'context_summary',
    'related_surface_forms',
    'timestamp_observed',
    'scope_kind',
    'scope_id',
    'extractor_version',
    'embedding_model_version',
    'source_connector',
    'source_locator',
    'source_raw_record_id',
    ...contextColumns,
    'created_at',
  ];
  const values = [
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
    normalizedSourceLocator,
    input.source_raw_record_id,
    ...contextColumns.map((column) => contextKeys[column]),
    createdAt,
  ];

  return { columns, values };
}

function findExistingObservation(
  adapter: EntityStoreAdapter,
  input: UpsertEntityObservationInput,
  normalizedSourceLocator: string,
  contextColumns: ObservationContextKeyColumn[],
  contextKeys: Record<ObservationContextKeyColumn, string>
): Record<string, unknown> | undefined {
  const conditions = [
    'source_connector = ?',
    'source_locator = ?',
    'source_raw_record_id = ?',
    'observation_type = ?',
    ...contextColumns.map((column) => `COALESCE(${column}, '') = ?`),
  ];
  const params = [
    input.source_connector,
    normalizedSourceLocator,
    input.source_raw_record_id,
    input.observation_type,
    ...contextColumns.map((column) => contextKeys[column]),
  ];

  return adapter
    .prepare(
      `
        SELECT id FROM entity_observations
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `
    )
    .get(...params) as Record<string, unknown> | undefined;
}

function insertObservation(
  adapter: EntityStoreAdapter,
  input: UpsertEntityObservationInput,
  normalizedSourceLocator: string,
  contextColumns: ObservationContextKeyColumn[],
  contextKeys: Record<ObservationContextKeyColumn, string>,
  createdAt: number
): void {
  const insert = observationInsertValues(
    input,
    normalizedSourceLocator,
    contextColumns,
    contextKeys,
    createdAt
  );
  const placeholders = insert.columns.map(() => '?').join(', ');
  adapter
    .prepare(
      `
        INSERT INTO entity_observations (${insert.columns.join(', ')})
        VALUES (${placeholders})
      `
    )
    .run(...insert.values);
}

function updateObservation(
  adapter: EntityStoreAdapter,
  id: string,
  input: UpsertEntityObservationInput,
  normalizedSourceLocator: string,
  contextColumns: ObservationContextKeyColumn[],
  contextKeys: Record<ObservationContextKeyColumn, string>
): void {
  const assignments = [
    'entity_kind_hint = ?',
    'surface_form = ?',
    'normalized_form = ?',
    'lang = ?',
    'script = ?',
    'context_summary = ?',
    'related_surface_forms = ?',
    'timestamp_observed = ?',
    'scope_kind = ?',
    'scope_id = ?',
    'extractor_version = ?',
    'embedding_model_version = ?',
    'source_locator = ?',
    ...contextColumns.map((column) => `${column} = ?`),
  ];
  const values = [
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
    normalizedSourceLocator,
    ...contextColumns.map((column) => contextKeys[column]),
    id,
  ];

  adapter
    .prepare(
      `
        UPDATE entity_observations
        SET ${assignments.join(', ')}
        WHERE id = ?
      `
    )
    .run(...values);
}

function saveObservation(
  adapter: EntityStoreAdapter,
  input: UpsertEntityObservationInput
): UpsertEntityObservationResult {
  const columns = tableColumnNames(adapter, 'entity_observations');
  const contextColumns = observationContextColumns(columns);
  const contextKeys = observationContextKeys(input);
  const normalizedSourceLocator = sourceLocatorForInput(input);
  const existing = findExistingObservation(
    adapter,
    input,
    normalizedSourceLocator,
    contextColumns,
    contextKeys
  );
  if (existing) {
    const id = requireStringField(existing, 'id');
    updateObservation(adapter, id, input, normalizedSourceLocator, contextColumns, contextKeys);
    return { id, created: false };
  }

  insertObservation(adapter, input, normalizedSourceLocator, contextColumns, contextKeys, now());
  return { id: input.id, created: true };
}

export async function upsertEntityObservation(
  input: UpsertEntityObservationInput
): Promise<EntityObservation> {
  await initDB();
  const adapter = getAdapter();
  const result = saveObservation(adapter, input);
  const saved = adapter.prepare('SELECT * FROM entity_observations WHERE id = ?').get(result.id) as
    | Record<string, unknown>
    | undefined;
  if (!saved) {
    throw new Error(`Failed to load saved entity observation ${result.id}`);
  }

  return parseObservationRow(saved);
}

export async function upsertEntityObservations(
  inputs: UpsertEntityObservationInput[]
): Promise<UpsertEntityObservationResult[]> {
  await initDB();
  const adapter = getAdapter();
  const observations: UpsertEntityObservationResult[] = [];
  const upsertOne = (input: UpsertEntityObservationInput): void => {
    observations.push(saveObservation(adapter, input));
  };

  if ('transaction' in adapter && typeof adapter.transaction === 'function') {
    const txResult = adapter.transaction(() => {
      for (const input of inputs) {
        upsertOne(input);
      }
    }) as unknown;
    if (typeof txResult === 'function') {
      txResult();
    }
    return observations;
  }

  for (const input of inputs) {
    upsertOne(input);
  }
  return observations;
}

export async function appendEntityTimelineEvent(
  input: AppendEntityTimelineEventInput
): Promise<EntityTimelineEvent> {
  if (!input.adapter) {
    await initDB();
  }
  const adapter = input.adapter ?? getAdapter();
  const eventId = input.event.id ?? `et_${randomUUID()}`;
  const createdAt = input.event.created_at ?? now();

  adapter
    .prepare(
      `
        INSERT INTO entity_timeline_events (
          id, entity_id, event_type, role, valid_from, valid_to, observed_at,
          source_ref, summary, details, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      eventId,
      input.event.entity_id,
      input.event.event_type,
      input.event.role ?? null,
      input.event.valid_from ?? null,
      input.event.valid_to ?? null,
      input.event.observed_at ?? null,
      input.event.source_ref ?? null,
      input.event.summary,
      input.event.details ?? null,
      createdAt
    );

  return {
    id: eventId,
    entity_id: input.event.entity_id,
    event_type: input.event.event_type,
    role: input.event.role ?? null,
    valid_from: input.event.valid_from ?? null,
    valid_to: input.event.valid_to ?? null,
    observed_at: input.event.observed_at ?? null,
    source_ref: input.event.source_ref ?? null,
    summary: input.event.summary,
    details: input.event.details ?? null,
    created_at: createdAt,
  };
}

/**
 * Walks the `entity_nodes.merged_into` chain from the given id and returns the
 * terminal (unmerged) entity id. Detects cycles and caps depth. Read-only.
 *
 * Matches the read-time chain-walking approach described in the canonical
 * entity ontology implementation plan.
 */
export function resolveCanonicalEntityId(adapter: EntityStoreAdapter, id: string): string {
  const seen = new Set<string>();
  let current = id;
  for (let depth = 0; depth < MAX_MERGE_CHAIN_DEPTH; depth++) {
    if (seen.has(current)) {
      throw new EntityMergeError(
        'entity.merge_chain_cycle',
        `Cycle detected in merged_into chain starting at ${id}`
      );
    }
    seen.add(current);
    const row = adapter
      .prepare('SELECT merged_into FROM entity_nodes WHERE id = ?')
      .get(current) as { merged_into: string | null } | undefined;
    if (!row) {
      throw new EntityMergeError(
        'entity.node_not_found',
        `Entity node ${current} not found while resolving canonical id for ${id}`
      );
    }
    if (!row.merged_into) {
      return current;
    }
    current = row.merged_into;
  }
  throw new EntityMergeError(
    'entity.merge_chain_too_deep',
    `merged_into chain exceeds depth ${MAX_MERGE_CHAIN_DEPTH} starting at ${id}`
  );
}

export interface MergeEntityNodesInput {
  adapter: EntityStoreAdapter;
  source_id: string;
  target_id: string;
  actor_type: 'system' | 'user' | 'agent';
  actor_id: string;
  reason: string;
  candidate_id: string | null;
  evidence_json: string;
}

export interface MergeEntityNodesResult {
  merge_action_id: string;
  timeline_event_id: string;
  merged_at: number;
}

/**
 * Marks `source_id` as merged into `target_id`, emits a timeline event, and
 * inserts the entity_merge_actions audit row with both entity IDs populated.
 *
 * Intentionally NOT wrapped in its own transaction — the caller is expected
 * to wrap the call in `adapter.transaction(...)` so the candidate status
 * update and this merge land atomically (Policy B1, hard transaction).
 *
 * Validates: source != target, both exist, both active/unmerged, same kind,
 * same scope. Throws `EntityMergeError` with a stable `code` on any violation.
 */
export function mergeEntityNodes(input: MergeEntityNodesInput): MergeEntityNodesResult {
  const {
    adapter,
    source_id,
    target_id,
    actor_type,
    actor_id,
    reason,
    candidate_id,
    evidence_json,
  } = input;

  if (!source_id || !target_id) {
    throw new EntityMergeError('entity.merge_invalid_args', 'source_id and target_id are required');
  }
  if (source_id === target_id) {
    throw new EntityMergeError('entity.merge_self', 'Cannot merge an entity into itself');
  }

  const source = adapter.prepare('SELECT * FROM entity_nodes WHERE id = ?').get(source_id) as
    | EntityNode
    | undefined;
  if (!source) {
    throw new EntityMergeError(
      'entity.merge_source_not_found',
      `Source entity ${source_id} not found`
    );
  }

  const target = adapter.prepare('SELECT * FROM entity_nodes WHERE id = ?').get(target_id) as
    | EntityNode
    | undefined;
  if (!target) {
    throw new EntityMergeError(
      'entity.merge_target_not_found',
      `Target entity ${target_id} not found`
    );
  }

  if (source.status === 'merged' || source.merged_into) {
    throw new EntityMergeError(
      'entity.merge_source_already_merged',
      `Source entity ${source_id} is already merged`
    );
  }
  if (target.status === 'merged' || target.merged_into) {
    throw new EntityMergeError(
      'entity.merge_target_already_merged',
      `Target entity ${target_id} is already merged`
    );
  }
  if (source.status === 'archived' || target.status === 'archived') {
    throw new EntityMergeError('entity.merge_archived', 'Cannot merge archived entities');
  }
  if (source.kind !== target.kind) {
    throw new EntityMergeError(
      'entity.merge_kind_mismatch',
      `Cannot merge ${source.kind} into ${target.kind}`
    );
  }
  if (source.scope_kind !== target.scope_kind || source.scope_id !== target.scope_id) {
    throw new EntityMergeError(
      'entity.merge_scope_mismatch',
      `Cannot merge across scopes: ${source.scope_kind}/${source.scope_id ?? 'null'} vs ${target.scope_kind}/${target.scope_id ?? 'null'}`
    );
  }

  const mergedAt = now();
  const mergeActionId = `mact_${randomUUID()}`;
  const timelineEventId = `et_${randomUUID()}`;

  adapter
    .prepare(
      `UPDATE entity_nodes SET merged_into = ?, status = 'merged', updated_at = ? WHERE id = ?`
    )
    .run(target_id, mergedAt, source_id);

  adapter
    .prepare(
      `
        INSERT INTO entity_timeline_events (
          id, entity_id, event_type, role, observed_at, source_ref, summary, details, created_at
        )
        VALUES (?, ?, 'merged', NULL, ?, ?, ?, ?, ?)
      `
    )
    .run(
      timelineEventId,
      source_id,
      mergedAt,
      candidate_id,
      `Merged into ${target_id}`,
      JSON.stringify({ target_entity_id: target_id, reason, actor_id, actor_type }),
      mergedAt
    );

  adapter
    .prepare(
      `
        INSERT INTO entity_merge_actions (
          id, action_type, source_entity_id, target_entity_id, candidate_id,
          actor_type, actor_id, reason, evidence_json, created_at
        )
        VALUES (?, 'merge', ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      mergeActionId,
      source_id,
      target_id,
      candidate_id,
      actor_type,
      actor_id,
      reason,
      evidence_json,
      mergedAt
    );

  return {
    merge_action_id: mergeActionId,
    timeline_event_id: timelineEventId,
    merged_at: mergedAt,
  };
}
