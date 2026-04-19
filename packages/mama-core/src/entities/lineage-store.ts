import { randomUUID } from 'node:crypto';
import { getAdapter, initDB } from '../db-manager.js';
import type { DatabaseAdapter } from '../db-manager.js';
import type { EntityIngestRun, EntityLineageLink } from './types.js';
import type { EntityStoreAdapter } from './store.js';

type CreateEntityIngestRunInput = Omit<
  EntityIngestRun,
  | 'status'
  | 'raw_count'
  | 'observation_count'
  | 'candidate_count'
  | 'reviewable_count'
  | 'audit_run_id'
  | 'audit_classification'
  | 'error_reason'
  | 'created_at'
  | 'completed_at'
> & {
  id?: string;
};

type AppendEntityLineageLinkInput = Omit<
  EntityLineageLink,
  'id' | 'status' | 'created_at' | 'superseded_at'
>;

interface CompleteEntityIngestRunInput {
  raw_count: number;
  observation_count: number;
  candidate_count: number;
  reviewable_count: number;
  audit_run_id?: string | null;
  audit_classification?: EntityIngestRun['audit_classification'];
}

interface AdoptLineageAfterMergeInput {
  adapter?: LineageMutationAdapter;
  source_entity_id: string;
  target_entity_id: string;
  candidate_id?: string | null;
  review_action_id?: string | null;
  confidence?: number;
  capture_mode?: EntityLineageLink['capture_mode'];
}

type LineageMutationAdapter = Pick<DatabaseAdapter, 'prepare'>;

export interface AppendEntityLineageLinkResult {
  link: EntityLineageLink;
  created: boolean;
}

function now(): number {
  return Date.now();
}

export function parseEntityIngestRunRow(row: Record<string, unknown>): EntityIngestRun {
  return {
    id: String(row.id),
    connector: String(row.connector),
    run_kind: row.run_kind as EntityIngestRun['run_kind'],
    status: row.status as EntityIngestRun['status'],
    scope_key: String(row.scope_key),
    source_window_start:
      typeof row.source_window_start === 'number' ? row.source_window_start : null,
    source_window_end: typeof row.source_window_end === 'number' ? row.source_window_end : null,
    raw_count: Number(row.raw_count ?? 0),
    observation_count: Number(row.observation_count ?? 0),
    candidate_count: Number(row.candidate_count ?? 0),
    reviewable_count: Number(row.reviewable_count ?? 0),
    audit_run_id: typeof row.audit_run_id === 'string' ? row.audit_run_id : null,
    audit_classification:
      typeof row.audit_classification === 'string'
        ? (row.audit_classification as EntityIngestRun['audit_classification'])
        : null,
    error_reason: typeof row.error_reason === 'string' ? row.error_reason : null,
    created_at: Number(row.created_at),
    completed_at: typeof row.completed_at === 'number' ? row.completed_at : null,
  };
}

function parseEntityLineageLinkRow(row: Record<string, unknown>): EntityLineageLink {
  return {
    id: String(row.id),
    canonical_entity_id: String(row.canonical_entity_id),
    entity_observation_id: String(row.entity_observation_id),
    source_entity_id: typeof row.source_entity_id === 'string' ? row.source_entity_id : null,
    contribution_kind: row.contribution_kind as EntityLineageLink['contribution_kind'],
    run_id: typeof row.run_id === 'string' ? row.run_id : null,
    candidate_id: typeof row.candidate_id === 'string' ? row.candidate_id : null,
    review_action_id: typeof row.review_action_id === 'string' ? row.review_action_id : null,
    status: row.status as EntityLineageLink['status'],
    capture_mode: row.capture_mode as EntityLineageLink['capture_mode'],
    confidence: Number(row.confidence),
    created_at: Number(row.created_at),
    superseded_at: typeof row.superseded_at === 'number' ? row.superseded_at : null,
  };
}

export async function createEntityIngestRun(
  input: CreateEntityIngestRunInput
): Promise<EntityIngestRun> {
  await initDB();
  const adapter = getAdapter();
  const createdAt = now();
  const id = input.id || `eir_${randomUUID()}`;

  adapter
    .prepare(
      `
        INSERT INTO entity_ingest_runs (
          id, connector, run_kind, status, scope_key, source_window_start, source_window_end,
          raw_count, observation_count, candidate_count, reviewable_count, audit_run_id,
          audit_classification, error_reason, created_at, completed_at
        ) VALUES (?, ?, ?, 'running', ?, ?, ?, 0, 0, 0, 0, NULL, NULL, NULL, ?, NULL)
      `
    )
    .run(
      id,
      input.connector,
      input.run_kind,
      input.scope_key,
      input.source_window_start,
      input.source_window_end,
      createdAt
    );

  const row = adapter.prepare(`SELECT * FROM entity_ingest_runs WHERE id = ?`).get(id) as Record<
    string,
    unknown
  >;
  return parseEntityIngestRunRow(row);
}

export async function completeEntityIngestRun(
  id: string,
  input: CompleteEntityIngestRunInput
): Promise<EntityIngestRun> {
  await initDB();
  const adapter = getAdapter();
  const completedAt = now();

  const completion = adapter
    .prepare(
      `
        UPDATE entity_ingest_runs
        SET status = 'complete',
            raw_count = ?,
            observation_count = ?,
            candidate_count = ?,
            reviewable_count = ?,
            audit_run_id = ?,
            audit_classification = ?,
            error_reason = NULL,
            completed_at = ?
        WHERE id = ?
      `
    )
    .run(
      input.raw_count,
      input.observation_count,
      input.candidate_count,
      input.reviewable_count,
      input.audit_run_id ?? null,
      input.audit_classification ?? null,
      completedAt,
      id
    );
  if (completion.changes !== 1) {
    throw new Error(`Entity ingest run not found: ${id}`);
  }

  const row = adapter.prepare(`SELECT * FROM entity_ingest_runs WHERE id = ?`).get(id) as Record<
    string,
    unknown
  >;
  return parseEntityIngestRunRow(row);
}

export async function failEntityIngestRun(
  id: string,
  errorReason: string
): Promise<EntityIngestRun> {
  await initDB();
  const adapter = getAdapter();
  const completedAt = now();

  const completion = adapter
    .prepare(
      `
        UPDATE entity_ingest_runs
        SET status = 'failed',
            error_reason = ?,
            completed_at = ?
        WHERE id = ?
      `
    )
    .run(errorReason, completedAt, id);
  if (completion.changes !== 1) {
    throw new Error(`Entity ingest run not found: ${id}`);
  }

  const row = adapter.prepare(`SELECT * FROM entity_ingest_runs WHERE id = ?`).get(id) as Record<
    string,
    unknown
  >;
  return parseEntityIngestRunRow(row);
}

export async function appendEntityLineageLink(
  input: AppendEntityLineageLinkInput
): Promise<AppendEntityLineageLinkResult> {
  await initDB();
  const adapter = getAdapter();

  const existing = adapter
    .prepare(
      `
        SELECT *
        FROM entity_lineage_links
        WHERE canonical_entity_id = ?
          AND entity_observation_id = ?
          AND status = 'active'
        LIMIT 1
      `
    )
    .get(input.canonical_entity_id, input.entity_observation_id) as
    | Record<string, unknown>
    | undefined;

  // Idempotent by (canonical_entity_id, entity_observation_id, status='active').
  // If an active row already exists for the pair, the existing row is returned
  // and the caller-provided metadata is ignored.
  if (existing) {
    return {
      link: parseEntityLineageLinkRow(existing),
      created: false,
    };
  }

  const id = `elin_${randomUUID()}`;
  const createdAt = now();

  adapter
    .prepare(
      `
        INSERT INTO entity_lineage_links (
          id, canonical_entity_id, entity_observation_id, source_entity_id,
          contribution_kind, run_id, candidate_id, review_action_id,
          status, capture_mode, confidence, created_at, superseded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)
      `
    )
    .run(
      id,
      input.canonical_entity_id,
      input.entity_observation_id,
      input.source_entity_id,
      input.contribution_kind,
      input.run_id,
      input.candidate_id,
      input.review_action_id,
      input.capture_mode,
      input.confidence,
      createdAt
    );

  const row = adapter.prepare(`SELECT * FROM entity_lineage_links WHERE id = ?`).get(id) as Record<
    string,
    unknown
  >;
  return {
    link: parseEntityLineageLinkRow(row),
    created: true,
  };
}

export async function supersedeEntityLineageForEntity(
  entityId: string
): Promise<number> {
  await initDB();
  const adapter = getAdapter();
  const supersededAt = now();
  const result = adapter
    .prepare(
      `
        UPDATE entity_lineage_links
        SET status = 'superseded',
            superseded_at = ?
        WHERE canonical_entity_id = ?
          AND status = 'active'
      `
    )
    .run(supersededAt, entityId);

  return Number(result.changes ?? 0);
}

export async function seedLineageForEntityMaterialization(input: {
  canonical_entity_id: string;
  entity_observation_id: string;
  run_id?: string | null;
  confidence?: number;
  capture_mode?: EntityLineageLink['capture_mode'];
}): Promise<EntityLineageLink> {
  const result = await appendEntityLineageLink({
    canonical_entity_id: input.canonical_entity_id,
    entity_observation_id: input.entity_observation_id,
    source_entity_id: null,
    contribution_kind: 'seed',
    run_id: input.run_id ?? null,
    candidate_id: null,
    review_action_id: null,
    capture_mode: input.capture_mode ?? 'direct',
    confidence: input.confidence ?? 1,
  });
  return result.link;
}

function runLineageTransaction<T>(adapter: LineageMutationAdapter, fn: () => T): T {
  const savepoint = `adopt_lineage_${randomUUID().replace(/-/g, '')}`;
  adapter.prepare(`SAVEPOINT ${savepoint}`).run();
  try {
    const result = fn();
    adapter.prepare(`RELEASE SAVEPOINT ${savepoint}`).run();
    return result;
  } catch (error) {
    try {
      adapter.prepare(`ROLLBACK TO SAVEPOINT ${savepoint}`).run();
    } catch {
      // Ignore rollback errors when the connection already unwound the savepoint.
    }
    try {
      adapter.prepare(`RELEASE SAVEPOINT ${savepoint}`).run();
    } catch {
      // Ignore cleanup failures after rollback.
    }
    throw error;
  }
}

export function adoptLineageAfterMerge(
  input: AdoptLineageAfterMergeInput
): Promise<EntityLineageLink[]> {
  if (!input.adapter) {
    return initDB().then(() =>
      runLineageTransaction(getAdapter(), () => adoptLineageAfterMergeWithAdapter(getAdapter(), input))
    );
  }

  return Promise.resolve(
    runLineageTransaction(input.adapter, () => adoptLineageAfterMergeWithAdapter(input.adapter!, input))
  );
}

function adoptLineageAfterMergeWithAdapter(
  adapter: LineageMutationAdapter,
  input: AdoptLineageAfterMergeInput
): EntityLineageLink[] {
  const createdAt = now();
  const supersededAt = now();
  const sourceRows = adapter
    .prepare(
      `
        SELECT *
        FROM entity_lineage_links
        WHERE canonical_entity_id = ?
          AND status = 'active'
        ORDER BY created_at ASC
      `
    )
    .all(input.source_entity_id) as Array<Record<string, unknown>>;

  adapter
    .prepare(
      `
        UPDATE entity_lineage_links
        SET status = 'superseded',
            superseded_at = ?
        WHERE canonical_entity_id = ?
          AND status = 'active'
      `
    )
    .run(supersededAt, input.source_entity_id);

  const adopted: EntityLineageLink[] = [];
  for (const row of sourceRows) {
    const observationId = String(row.entity_observation_id);
    const existing = adapter
      .prepare(
        `
          SELECT *
          FROM entity_lineage_links
          WHERE canonical_entity_id = ?
            AND entity_observation_id = ?
            AND status = 'active'
          LIMIT 1
        `
      )
      .get(input.target_entity_id, observationId) as Record<string, unknown> | undefined;

    if (existing) {
      adopted.push(parseEntityLineageLinkRow(existing));
      continue;
    }

    const id = `elin_${randomUUID()}`;
    adapter
      .prepare(
        `
          INSERT INTO entity_lineage_links (
            id, canonical_entity_id, entity_observation_id, source_entity_id,
            contribution_kind, run_id, candidate_id, review_action_id,
            status, capture_mode, confidence, created_at, superseded_at
          ) VALUES (?, ?, ?, ?, 'merge_adopt', ?, ?, ?, 'active', ?, ?, ?, NULL)
        `
      )
      .run(
        id,
        input.target_entity_id,
        observationId,
        input.source_entity_id,
        typeof row.run_id === 'string' ? row.run_id : null,
        input.candidate_id ?? null,
        input.review_action_id ?? null,
        input.capture_mode ?? 'direct',
        input.confidence ?? Number(row.confidence ?? 1),
        createdAt
      );

    const created = adapter
      .prepare(`SELECT * FROM entity_lineage_links WHERE id = ?`)
      .get(id) as Record<string, unknown>;
    adopted.push(parseEntityLineageLinkRow(created));
  }

  return adopted;
}

export async function listActiveEntityLineage(
  entityId: string,
  adapter?: EntityStoreAdapter
): Promise<EntityLineageLink[]> {
  if (!adapter) {
    await initDB();
  }
  const effectiveAdapter = adapter ?? getAdapter();
  const rows = effectiveAdapter
    .prepare(
      `
        SELECT *
        FROM entity_lineage_links
        WHERE canonical_entity_id = ?
          AND status = 'active'
        ORDER BY created_at ASC
      `
    )
    .all(entityId) as Array<Record<string, unknown>>;

  return rows.map(parseEntityLineageLinkRow);
}

export async function listEntityLineageHistory(
  entityId: string,
  adapter?: EntityStoreAdapter
): Promise<EntityLineageLink[]> {
  if (!adapter) {
    await initDB();
  }
  const effectiveAdapter = adapter ?? getAdapter();
  const rows = effectiveAdapter
    .prepare(
      `
        SELECT *
        FROM entity_lineage_links
        WHERE canonical_entity_id = ?
        ORDER BY created_at ASC
      `
    )
    .all(entityId) as Array<Record<string, unknown>>;

  return rows.map(parseEntityLineageLinkRow);
}
