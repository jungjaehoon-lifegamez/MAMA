import { getAdapter, initDB } from '../db-manager.js';
import { listMemoryEventsForMemory } from './event-store.js';
import type { MemoryEventRecord, MemoryScopeRef } from './types.js';

export interface MemoryProvenanceAuditRecord {
  memory_id: string;
  topic: string;
  summary: string;
  envelope_hash: string | null;
  model_run_id: string | null;
  gateway_call_id: string | null;
  tool_name: string | null;
  latest_event?: MemoryEventRecord;
  scope_refs: MemoryScopeRef[];
  legacy_caveats: string[];
}

export interface MemoryProvenanceAuditListOptions {
  envelope_hash?: string;
  model_run_id?: string;
  gateway_call_id?: string;
  limit?: number;
}

type AuditRow = {
  id: string;
  topic: string;
  decision: string | null;
  summary?: string | null;
  envelope_hash: string | null;
  model_run_id: string | null;
  gateway_call_id: string | null;
  provenance_json: string | null;
};

export async function getMemoryProvenanceAudit(
  memoryId: string
): Promise<MemoryProvenanceAuditRecord | null> {
  await initDB();
  const adapter = getAdapter();
  const row = adapter
    .prepare(
      `
        SELECT id, topic, decision, summary, envelope_hash, model_run_id, gateway_call_id,
               provenance_json
        FROM decisions
        WHERE id = ?
      `
    )
    .get(memoryId) as AuditRow | undefined;

  return row ? toAuditRecord(row) : null;
}

export async function listMemoryProvenanceAudit(
  options: MemoryProvenanceAuditListOptions
): Promise<MemoryProvenanceAuditRecord[]> {
  await initDB();
  const adapter = getAdapter();
  const filter = buildAuditFilter(options);
  const rows = adapter
    .prepare(
      `
        SELECT id, topic, decision, summary, envelope_hash, model_run_id, gateway_call_id,
               provenance_json
        FROM decisions
        WHERE ${filter.sql}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `
    )
    .all(...filter.params, normalizeLimit(options.limit)) as AuditRow[];

  const records: MemoryProvenanceAuditRecord[] = [];
  for (const row of rows) {
    records.push(await toAuditRecord(row));
  }
  return records;
}

function buildAuditFilter(options: MemoryProvenanceAuditListOptions): {
  sql: string;
  params: string[];
} {
  const filters: string[] = [];
  const params: string[] = [];

  for (const column of ['envelope_hash', 'model_run_id', 'gateway_call_id'] as const) {
    const value = options[column];
    if (value !== undefined) {
      filters.push(`${column} = ?`);
      params.push(value);
    }
  }

  if (filters.length !== 1) {
    throw new Error('Exactly one provenance audit filter is required.');
  }

  return { sql: filters[0], params };
}

async function toAuditRecord(row: AuditRow): Promise<MemoryProvenanceAuditRecord> {
  const events = await listMemoryEventsForMemory(row.id);
  const scopeRefs = listScopeRefs(row.id);
  const provenance = parseObject(row.provenance_json);
  const legacyCaveats: string[] = [];
  if (provenance.source_type === 'legacy') {
    legacyCaveats.push('legacy_provenance_backfill');
  }
  if (scopeRefs.length === 0) {
    legacyCaveats.push('unscoped_memory');
  }

  return {
    memory_id: row.id,
    topic: row.topic,
    summary: row.summary ?? row.decision ?? '',
    envelope_hash: row.envelope_hash,
    model_run_id: row.model_run_id,
    gateway_call_id: row.gateway_call_id,
    tool_name: typeof provenance.tool_name === 'string' ? provenance.tool_name : null,
    latest_event: events[0],
    scope_refs: scopeRefs,
    legacy_caveats: legacyCaveats,
  };
}

function listScopeRefs(memoryId: string): MemoryScopeRef[] {
  const adapter = getAdapter();
  const rows = adapter
    .prepare(
      `
        SELECT ms.kind, ms.external_id
        FROM memory_scope_bindings msb
        JOIN memory_scopes ms ON ms.id = msb.scope_id
        WHERE msb.memory_id = ?
        ORDER BY msb.is_primary DESC, ms.kind ASC, ms.external_id ASC
      `
    )
    .all(memoryId) as Array<{ kind: MemoryScopeRef['kind']; external_id: string }>;
  return rows.map((row) => ({ kind: row.kind, id: row.external_id }));
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) {
    return 50;
  }
  return Math.max(1, Math.min(200, Math.floor(limit as number)));
}

function parseObject(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
