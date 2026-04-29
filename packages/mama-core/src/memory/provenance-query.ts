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
  const batchSize = options.scopes ? Math.max(limit * 5, 25) : limit;
  const statement = adapter.prepare(
    `
      SELECT id, agent_id, model_run_id, envelope_hash, gateway_call_id,
             source_refs_json, provenance_json, created_at
      FROM decisions
      WHERE ${column} = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `
  );
  const records: MemoryProvenanceRecord[] = [];
  let offset = 0;

  while (records.length < limit) {
    const rows = statement.all(value, batchSize, offset) as ProvenanceRow[];
    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      if (await isVisibleMemory(row.id, options)) {
        records.push(await toProvenanceRecord(row));
      }
      if (records.length >= limit) {
        break;
      }
    }

    offset += rows.length;
  }

  return records;
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
  if (!options.scopes) {
    return true;
  }

  await initDB();
  const adapter = getAdapter();
  const scopeIds = [];
  for (const scope of options.scopes) {
    const scopeId = resolveMemoryScopeId(scope.kind, scope.id);
    if (scopeId) {
      scopeIds.push(scopeId);
    }
  }

  const bindingCount = (
    adapter
      .prepare(
        `
          SELECT COUNT(*) as count
          FROM memory_scope_bindings
          WHERE memory_id = ?
        `
      )
      .get(memoryId) as { count: number }
  ).count;

  if (bindingCount === 0) {
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
