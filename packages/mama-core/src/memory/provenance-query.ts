import { getAdapter, initDB } from '../db-manager.js';
import type { MemoryProvenanceRecord, MemoryScopeRef } from './types.js';
import { listMemoryEventsForMemory } from './event-store.js';

export interface MemoryProvenanceQueryOptions {
  scopes?: MemoryScopeRef[];
  includeLegacyUnscoped?: boolean;
  limit?: number;
}

type ProvenanceRow = {
  id: string;
  agent_id: string | null;
  model_run_id: string | null;
  envelope_hash: string | null;
  gateway_call_id: string | null;
  source_refs_json: string | null;
  provenance_json: string | null;
  created_at: number | string;
};

export async function getMemoryProvenance(
  memoryId: string,
  options: MemoryProvenanceQueryOptions = {}
): Promise<MemoryProvenanceRecord | null> {
  await initDB();
  const adapter = getAdapter();
  const row = adapter
    .prepare(
      `
        SELECT id, agent_id, model_run_id, envelope_hash, gateway_call_id,
               source_refs_json, provenance_json, created_at
        FROM decisions
        WHERE id = ?
      `
    )
    .get(memoryId) as ProvenanceRow | undefined;

  if (!row || !(await isVisibleMemory(row.id, options))) {
    return null;
  }
  return toProvenanceRecord(row);
}

export async function listMemoriesByEnvelopeHash(
  envelopeHash: string,
  options: MemoryProvenanceQueryOptions = {}
): Promise<MemoryProvenanceRecord[]> {
  return listMemoriesByColumn('envelope_hash', envelopeHash, options);
}

export async function listMemoriesByGatewayCallId(
  gatewayCallId: string,
  options: MemoryProvenanceQueryOptions = {}
): Promise<MemoryProvenanceRecord[]> {
  return listMemoriesByColumn('gateway_call_id', gatewayCallId, options);
}

export async function listMemoriesByModelRunId(
  modelRunId: string,
  options: MemoryProvenanceQueryOptions = {}
): Promise<MemoryProvenanceRecord[]> {
  return listMemoriesByColumn('model_run_id', modelRunId, options);
}

async function listMemoriesByColumn(
  column: 'envelope_hash' | 'gateway_call_id' | 'model_run_id',
  value: string,
  options: MemoryProvenanceQueryOptions
): Promise<MemoryProvenanceRecord[]> {
  await initDB();
  const adapter = getAdapter();
  const limit = normalizeLimit(options.limit);
  const visibility = buildVisibilityPredicate(options);
  const rows = adapter
    .prepare(
      `
        SELECT d.id, d.agent_id, d.model_run_id, d.envelope_hash, d.gateway_call_id,
               d.source_refs_json, d.provenance_json, d.created_at
        FROM decisions d
        WHERE d.${column} = ?${visibility.sql}
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT ?
      `
    )
    .all(value, ...visibility.params, limit) as ProvenanceRow[];

  const records: MemoryProvenanceRecord[] = [];
  for (const row of rows) {
    records.push(await toProvenanceRecord(row));
  }

  return records;
}

function buildVisibilityPredicate(options: MemoryProvenanceQueryOptions): {
  sql: string;
  params: string[];
} {
  if (!hasScopeFilter(options)) {
    return { sql: '', params: [] };
  }

  const scopeIds = resolveMemoryScopeIds(options.scopes);
  const legacyUnscopedPredicate = `
          NOT EXISTS (
            SELECT 1
            FROM memory_scope_bindings msb_legacy
            WHERE msb_legacy.memory_id = d.id
          )
        `;

  if (scopeIds.length === 0) {
    return options.includeLegacyUnscoped === true
      ? { sql: ` AND ${legacyUnscopedPredicate}`, params: [] }
      : { sql: ' AND 0 = 1', params: [] };
  }

  const placeholders = scopeIds.map(() => '?').join(', ');
  const scopedPredicate = `
        EXISTS (
          SELECT 1
          FROM memory_scope_bindings msb_scope
          WHERE msb_scope.memory_id = d.id
            AND msb_scope.scope_id IN (${placeholders})
        )
      `;

  if (options.includeLegacyUnscoped === true) {
    return {
      sql: ` AND (${scopedPredicate} OR ${legacyUnscopedPredicate})`,
      params: scopeIds,
    };
  }

  return { sql: ` AND ${scopedPredicate}`, params: scopeIds };
}

function hasScopeFilter(
  options: MemoryProvenanceQueryOptions
): options is MemoryProvenanceQueryOptions & { scopes: MemoryScopeRef[] } {
  return Array.isArray(options.scopes) && options.scopes.length > 0;
}

function resolveMemoryScopeIds(scopes: MemoryScopeRef[]): string[] {
  const scopeIds: string[] = [];
  for (const scope of scopes) {
    const scopeId = resolveMemoryScopeId(scope.kind, scope.id);
    if (scopeId) {
      scopeIds.push(scopeId);
    }
  }
  return scopeIds;
}

async function toProvenanceRecord(row: ProvenanceRow): Promise<MemoryProvenanceRecord> {
  const events = await listMemoryEventsForMemory(row.id);
  return {
    memory_id: row.id,
    agent_id: row.agent_id,
    model_run_id: row.model_run_id,
    envelope_hash: row.envelope_hash,
    gateway_call_id: row.gateway_call_id,
    source_refs: parseStringArray(row.source_refs_json),
    provenance: parseObject(row.provenance_json),
    latest_event: events[0],
  };
}

async function isVisibleMemory(
  memoryId: string,
  options: MemoryProvenanceQueryOptions
): Promise<boolean> {
  if (!hasScopeFilter(options)) {
    return true;
  }

  await initDB();
  const adapter = getAdapter();
  const scopeIds = resolveMemoryScopeIds(options.scopes);

  const bindingCount = adapter
    .prepare(
      `
          SELECT COUNT(*) as count
          FROM memory_scope_bindings
          WHERE memory_id = ?
        `
    )
    .get(memoryId) as { count: number };
  const count = bindingCount.count;

  if (count === 0) {
    return options.includeLegacyUnscoped === true;
  }
  if (scopeIds.length === 0) {
    return false;
  }

  const placeholders = scopeIds.map(() => '?').join(', ');
  const row = adapter
    .prepare(
      `
        SELECT 1 as visible
        FROM memory_scope_bindings
        WHERE memory_id = ? AND scope_id IN (${placeholders})
        LIMIT 1
      `
    )
    .get(memoryId, ...scopeIds) as { visible: number } | undefined;
  return row?.visible === 1;
}

function resolveMemoryScopeId(kind: string, externalId: string): string | null {
  const adapter = getAdapter();
  const row = adapter
    .prepare(
      `
        SELECT id
        FROM memory_scopes
        WHERE kind = ? AND external_id = ?
        LIMIT 1
      `
    )
    .get(kind, externalId) as { id: string } | undefined;
  return row?.id ?? null;
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) {
    return 50;
  }
  return Math.max(1, Math.min(200, Math.floor(limit as number)));
}

function parseStringArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
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
