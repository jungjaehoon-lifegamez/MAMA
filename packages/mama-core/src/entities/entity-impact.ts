import { getAdapter, initDB } from '../db-manager.js';
import { detectSourceLocatorKind, type SourceLocatorKind } from './source-locator.js';
import type { EntityIngestRun, EntityLineageLink, EntityNode } from './types.js';

interface InspectorDetail {
  entity: EntityNode;
  history_incomplete: boolean;
}

interface InspectorLineageRow extends EntityLineageLink {
  source_connector: string;
  source_raw_record_id: string;
  source_locator: string | null;
  source_locator_kind: SourceLocatorKind;
  surface_form: string;
}

interface InspectorLineageResult {
  rows: InspectorLineageRow[];
  history_incomplete: boolean;
}

interface ImpactMemoryRow {
  id: string;
  topic: string;
  summary: string;
  created_at: number;
}

interface ImpactAuditRunRow {
  id: string;
  classification: string | null;
  status: string;
  created_at: number;
  completed_at: number | null;
}

interface EntityImpactResult {
  related_memories: ImpactMemoryRow[];
  ingest_runs: EntityIngestRun[];
  audit_runs: ImpactAuditRunRow[];
}

function mapEntityNode(row: Record<string, unknown>): EntityNode {
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

function mapIngestRun(row: Record<string, unknown>): EntityIngestRun {
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

export async function getEntityInspectorDetail(entityId: string): Promise<InspectorDetail> {
  await initDB();
  const adapter = getAdapter();
  const row = adapter.prepare(`SELECT * FROM entity_nodes WHERE id = ?`).get(entityId) as
    | Record<string, unknown>
    | undefined;
  if (!row) {
    throw new Error(`Entity not found: ${entityId}`);
  }

  const lineageCount = adapter
    .prepare(
      `
        SELECT COUNT(*) AS total
        FROM entity_lineage_links
        WHERE canonical_entity_id = ?
          AND status = 'active'
      `
    )
    .get(entityId) as { total: number };

  return {
    entity: mapEntityNode(row),
    history_incomplete: lineageCount.total === 0,
  };
}

export async function listEntityLineageForInspector(
  entityId: string,
  limit = 50
): Promise<InspectorLineageResult> {
  await initDB();
  const adapter = getAdapter();
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const rows = adapter
    .prepare(
      `
        SELECT
          l.*,
          o.source_connector,
          o.source_raw_record_id,
          o.source_locator,
          o.surface_form
        FROM entity_lineage_links l
        JOIN entity_observations o ON o.id = l.entity_observation_id
        WHERE l.canonical_entity_id = ?
          AND l.status = 'active'
        ORDER BY l.created_at ASC
        LIMIT ?
      `
    )
    .all(entityId, safeLimit) as Array<Record<string, unknown>>;

  return {
    rows: rows.map((row) => ({
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
      source_connector: String(row.source_connector),
      source_raw_record_id: String(row.source_raw_record_id),
      source_locator: typeof row.source_locator === 'string' ? row.source_locator : null,
      source_locator_kind: detectSourceLocatorKind(
        typeof row.source_locator === 'string' ? row.source_locator : null
      ),
      surface_form: String(row.surface_form),
    })),
    history_incomplete: rows.length === 0,
  };
}

export async function getEntityImpact(entityId: string): Promise<EntityImpactResult> {
  await initDB();
  const adapter = getAdapter();

  const relatedMemories = adapter
    .prepare(
      `
        SELECT DISTINCT d.id, d.topic, d.summary, d.created_at
        FROM entity_lineage_links l
        JOIN decision_entity_sources des ON des.entity_observation_id = l.entity_observation_id
        JOIN decisions d ON d.id = des.decision_id
        WHERE l.canonical_entity_id = ?
          AND l.status = 'active'
        ORDER BY d.created_at DESC
      `
    )
    .all(entityId) as Array<{
    id: string;
    topic: string;
    summary: string | null;
    created_at: number;
  }>;

  const ingestRuns = adapter
    .prepare(
      `
        SELECT DISTINCT ir.*
        FROM entity_lineage_links l
        JOIN entity_ingest_runs ir ON ir.id = l.run_id
        WHERE l.canonical_entity_id = ?
          AND l.status = 'active'
        ORDER BY ir.created_at DESC
      `
    )
    .all(entityId) as Array<Record<string, unknown>>;

  const auditRuns = adapter
    .prepare(
      `
        SELECT DISTINCT ar.id, ar.classification, ar.status, ar.created_at, ar.completed_at
        FROM entity_lineage_links l
        JOIN entity_ingest_runs ir ON ir.id = l.run_id
        JOIN entity_audit_runs ar ON ar.id = ir.audit_run_id
        WHERE l.canonical_entity_id = ?
          AND l.status = 'active'
        ORDER BY ar.created_at DESC
        LIMIT 10
      `
    )
    .all(entityId) as Array<{
    id: string;
    classification: string | null;
    status: string;
    created_at: number;
    completed_at: number | null;
  }>;

  return {
    related_memories: relatedMemories.map((row) => ({
      id: row.id,
      topic: row.topic,
      summary: row.summary ?? row.topic,
      created_at: row.created_at,
    })),
    ingest_runs: ingestRuns.map(mapIngestRun),
    audit_runs: auditRuns,
  };
}

export async function getEntityIngestRun(runId: string): Promise<EntityIngestRun | null> {
  await initDB();
  const adapter = getAdapter();
  const row = adapter.prepare(`SELECT * FROM entity_ingest_runs WHERE id = ?`).get(runId) as
    | Record<string, unknown>
    | undefined;
  return row ? mapIngestRun(row) : null;
}
