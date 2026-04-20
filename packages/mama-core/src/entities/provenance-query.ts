import { getAdapter, initDB } from '../db-manager.js';
import { detectSourceLocatorKind, type SourceLocatorKind } from './source-locator.js';
import type {
  MemoryKind,
  MemoryRecord,
  MemoryScopeKind,
  MemoryScopeRef,
  MemoryStatus,
} from '../memory/types.js';

interface DecisionRow {
  id: string;
  topic: string;
  decision: string;
  reasoning: string | null;
  confidence: number | null;
  created_at: number;
  updated_at: number | null;
  trust_context: string | null;
  kind: string | null;
  status: string | null;
  summary: string | null;
  event_date: string | null;
}

interface ScopeRow {
  memory_id: string;
  kind: string;
  external_id: string;
}

interface ObservationRow {
  id: string;
  observation_type: string;
  entity_kind_hint: string | null;
  surface_form: string;
  normalized_form: string;
  lang: string | null;
  script: string | null;
  context_summary: string | null;
  scope_kind: string;
  scope_id: string | null;
  extractor_version: string;
  embedding_model_version: string | null;
  source_connector: string;
  source_locator: string | null;
  source_raw_record_id: string;
  created_at: number;
}

interface MemoryEventRow {
  event_type: 'provenance.empty_batch' | 'provenance.link_write_failed';
  reason: string | null;
  created_at: number;
}

export interface ProvenanceObservationSummary {
  id: string;
  observation_type: string;
  entity_kind_hint: string | null;
  surface_form: string;
  normalized_form: string;
  lang: string | null;
  script: string | null;
  context_summary: string | null;
  scope_kind: string;
  scope_id: string | null;
  extractor_version: string;
  embedding_model_version: string | null;
  source_connector: string;
  source_locator: string | null;
  source_locator_kind: SourceLocatorKind;
  source_raw_record_id: string;
  created_at: number;
}

export interface MemoryProvenanceResult {
  status: 'legacy' | 'manual' | 'dropped' | 'resolved';
  memory: MemoryRecord;
  observations: ProvenanceObservationSummary[];
  audit: {
    event_type: 'provenance.empty_batch' | 'provenance.link_write_failed';
    reason: string | null;
    created_at: number;
  } | null;
}

function parseSource(trustContext: string | null): MemoryRecord['source'] {
  if (typeof trustContext !== 'string' || trustContext.length === 0) {
    return { package: 'mama-core', source_type: 'db' };
  }
  try {
    const parsed = JSON.parse(trustContext) as { source?: MemoryRecord['source'] };
    if (parsed?.source && typeof parsed.source === 'object') {
      return parsed.source;
    }
  } catch {
    // ignore malformed trust_context
  }
  return { package: 'mama-core', source_type: 'db' };
}

function mapMemoryRecord(row: DecisionRow, scopes: MemoryScopeRef[]): MemoryRecord {
  return {
    id: row.id,
    topic: row.topic,
    kind: ((row.kind as MemoryKind | null) ?? 'decision') as MemoryKind,
    summary: row.summary ?? row.decision,
    details: row.reasoning ?? row.decision,
    confidence: row.confidence ?? 0.5,
    status: ((row.status as MemoryStatus | null) ?? 'active') as MemoryStatus,
    scopes,
    source: parseSource(row.trust_context),
    created_at: row.created_at,
    updated_at: row.updated_at ?? row.created_at,
    event_date: row.event_date,
  };
}

function loadScopes(memoryId: string): MemoryScopeRef[] {
  const adapter = getAdapter();
  const rows = adapter
    .prepare(
      `
        SELECT msb.memory_id, ms.kind, ms.external_id
        FROM memory_scope_bindings msb
        JOIN memory_scopes ms ON ms.id = msb.scope_id
        WHERE msb.memory_id = ?
        ORDER BY msb.is_primary DESC
      `
    )
    .all(memoryId) as ScopeRow[];

  return rows.map((row) => ({
    kind: row.kind as MemoryScopeKind,
    id: row.external_id,
  }));
}

function loadObservations(memoryId: string): ProvenanceObservationSummary[] {
  const adapter = getAdapter();
  const rows = adapter
    .prepare(
      `
        SELECT
          o.id,
          o.observation_type,
          o.entity_kind_hint,
          o.surface_form,
          o.normalized_form,
          o.lang,
          o.script,
          o.context_summary,
          o.scope_kind,
          o.scope_id,
          o.extractor_version,
          o.embedding_model_version,
          o.source_connector,
          o.source_locator,
          o.source_raw_record_id,
          o.created_at
        FROM decision_entity_sources des
        JOIN entity_observations o ON o.id = des.entity_observation_id
        WHERE des.decision_id = ?
        ORDER BY des.created_at ASC, o.created_at ASC
      `
    )
    .all(memoryId) as ObservationRow[];

  return rows.map((row) => ({
    id: row.id,
    observation_type: row.observation_type,
    entity_kind_hint: row.entity_kind_hint,
    surface_form: row.surface_form,
    normalized_form: row.normalized_form,
    lang: row.lang,
    script: row.script,
    context_summary: row.context_summary,
    scope_kind: row.scope_kind,
    scope_id: row.scope_id,
    extractor_version: row.extractor_version,
    embedding_model_version: row.embedding_model_version,
    source_connector: row.source_connector,
    source_locator: row.source_locator,
    source_locator_kind: detectSourceLocatorKind(row.source_locator),
    source_raw_record_id: row.source_raw_record_id,
    created_at: row.created_at,
  }));
}

function loadProvenanceAudit(memoryId: string): MemoryProvenanceResult['audit'] {
  const adapter = getAdapter();
  const row = adapter
    .prepare(
      `
        SELECT event_type, reason, created_at
        FROM memory_events
        WHERE memory_id = ?
          AND event_type IN ('provenance.empty_batch', 'provenance.link_write_failed')
        ORDER BY created_at DESC
        LIMIT 1
      `
    )
    .get(memoryId) as MemoryEventRow | undefined;

  if (!row) {
    return null;
  }

  return {
    event_type: row.event_type,
    reason: row.reason,
    created_at: row.created_at,
  };
}

export async function queryProvenanceForMemory(memoryId: string): Promise<MemoryProvenanceResult> {
  await initDB();
  const adapter = getAdapter();
  const row = adapter
    .prepare(
      `
        SELECT
          id,
          topic,
          decision,
          reasoning,
          confidence,
          created_at,
          updated_at,
          trust_context,
          kind,
          status,
          summary,
          event_date
        FROM decisions
        WHERE id = ?
      `
    )
    .get(memoryId) as DecisionRow | undefined;

  if (!row) {
    throw new Error(`Decision not found: ${memoryId}`);
  }

  const scopes = loadScopes(memoryId);
  const memory = mapMemoryRecord(row, scopes);
  const observations = loadObservations(memoryId);
  const audit = loadProvenanceAudit(memoryId);

  let status: MemoryProvenanceResult['status'] = 'legacy';
  if (observations.length > 0) {
    status = 'resolved';
  } else if (audit?.event_type === 'provenance.link_write_failed') {
    status = 'dropped';
  } else if (audit?.event_type === 'provenance.empty_batch') {
    status = 'manual';
  }

  return {
    status,
    memory,
    observations,
    audit,
  };
}
