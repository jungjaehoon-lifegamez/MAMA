import type { DatabaseAdapter } from '../db-manager.js';
import type {
  ContextPacket,
  ContextPacketRecord,
  ContextRef,
  TrustedContextPacketLookupInput,
} from './types.js';
import type { MemoryScopeRef } from '../memory/types.js';

type ContextPacketAdapter = Pick<DatabaseAdapter, 'prepare'>;

function parseJson<T>(row: Record<string, unknown>, field: string): T {
  const value = row[field];
  if (typeof value !== 'string') {
    throw new Error(`Invalid context packet JSON field ${field}: expected string`);
  }
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid context packet JSON field ${field}: ${message}`);
  }
}

function stringField(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') {
    throw new Error(`Invalid context packet field ${field}: expected string`);
  }
  return value;
}

function numberField(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid context packet field ${field}: expected finite number`);
  }
  return Math.floor(value);
}

function mapPacketRow(row: Record<string, unknown>): ContextPacketRecord {
  return {
    packet_id: stringField(row, 'packet_id'),
    task: stringField(row, 'task'),
    packet_json: stringField(row, 'packet_json'),
    packet: parseJson<ContextPacket>(row, 'packet_json'),
    scope_json: stringField(row, 'scope_json'),
    scopes: parseJson<MemoryScopeRef[]>(row, 'scope_json'),
    scope_hash: stringField(row, 'scope_hash'),
    envelope_hash: stringField(row, 'envelope_hash'),
    model_run_id: stringField(row, 'model_run_id'),
    agent_id: stringField(row, 'agent_id'),
    input_snapshot_ref: stringField(row, 'input_snapshot_ref'),
    source_refs_json: stringField(row, 'source_refs_json'),
    source_refs: parseJson<ContextRef[]>(row, 'source_refs_json'),
    tenant_id: stringField(row, 'tenant_id'),
    project_id: stringField(row, 'project_id'),
    memory_scope_kind: stringField(row, 'memory_scope_kind') as MemoryScopeRef['kind'],
    memory_scope_id: stringField(row, 'memory_scope_id'),
    created_at: numberField(row, 'created_at'),
  };
}

function modelRunsTableExists(adapter: ContextPacketAdapter): boolean {
  const row = adapter
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_runs'")
    .get() as { name?: string } | undefined;
  return row?.name === 'model_runs';
}

function modelRunStatus(adapter: ContextPacketAdapter, modelRunId: string): string | null {
  if (!modelRunsTableExists(adapter)) {
    return null;
  }
  const row = adapter
    .prepare('SELECT status FROM model_runs WHERE model_run_id = ?')
    .get(modelRunId) as { status?: unknown } | undefined;
  return typeof row?.status === 'string' ? row.status : null;
}

function assertTrustedModelRunStatus(
  adapter: ContextPacketAdapter,
  packet: ContextPacketRecord,
  includeFailed: boolean
): void {
  if (!modelRunsTableExists(adapter)) {
    return;
  }

  const status = modelRunStatus(adapter, packet.model_run_id);
  if (!status) {
    throw new Error(`Context packet model run not found: ${packet.model_run_id}`);
  }
  if (status === 'committed') {
    return;
  }
  if (includeFailed && status === 'failed') {
    return;
  }
  throw new Error(
    `Context packet model run must be committed before trusted use: ${packet.model_run_id} (${status})`
  );
}

export function insertContextPacket(
  adapter: ContextPacketAdapter,
  packet: ContextPacketRecord
): ContextPacketRecord {
  adapter
    .prepare(
      `
        INSERT INTO context_packets (
          packet_id, task, packet_json, scope_json, scope_hash, envelope_hash, model_run_id,
          agent_id, input_snapshot_ref, source_refs_json, tenant_id, project_id,
          memory_scope_kind, memory_scope_id, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      packet.packet_id,
      packet.task,
      packet.packet_json,
      packet.scope_json,
      packet.scope_hash,
      packet.envelope_hash,
      packet.model_run_id,
      packet.agent_id,
      packet.input_snapshot_ref,
      packet.source_refs_json,
      packet.tenant_id,
      packet.project_id,
      packet.memory_scope_kind,
      packet.memory_scope_id,
      packet.created_at
    );

  const inserted = adapter
    .prepare('SELECT * FROM context_packets WHERE packet_id = ?')
    .get(packet.packet_id) as Record<string, unknown> | undefined;
  if (!inserted) {
    throw new Error(`Context packet insert failed: ${packet.packet_id}`);
  }
  return mapPacketRow(inserted);
}

export function getContextPacket(
  adapter: ContextPacketAdapter,
  packetId: string
): ContextPacketRecord | null {
  const row = adapter.prepare('SELECT * FROM context_packets WHERE packet_id = ?').get(packetId) as
    | Record<string, unknown>
    | undefined;
  return row ? mapPacketRow(row) : null;
}

export function listContextPacketsForModelRun(
  adapter: ContextPacketAdapter,
  modelRunId: string,
  limit = 50
): ContextPacketRecord[] {
  if (!Number.isFinite(limit) || limit <= 0) {
    return [];
  }
  const rows = adapter
    .prepare(
      `
        SELECT *
        FROM context_packets
        WHERE model_run_id = ?
        ORDER BY created_at DESC, packet_id DESC
        LIMIT ?
      `
    )
    .all(modelRunId, Math.floor(limit)) as Array<Record<string, unknown>>;
  return rows.map((row) => mapPacketRow(row));
}

export function getContextPacketForTrustedUse(
  adapter: ContextPacketAdapter,
  input: TrustedContextPacketLookupInput
): ContextPacketRecord | null {
  const packet = getContextPacket(adapter, input.packetId);
  if (!packet) {
    return null;
  }
  if (packet.envelope_hash !== input.envelopeHash) {
    throw new Error(
      `Context packet envelope mismatch for ${input.packetId}: expected ${input.envelopeHash}, got ${packet.envelope_hash}`
    );
  }
  if (input.modelRunId && packet.model_run_id !== input.modelRunId) {
    throw new Error(
      `Context packet model run mismatch for ${input.packetId}: expected ${input.modelRunId}, got ${packet.model_run_id}`
    );
  }
  assertTrustedModelRunStatus(adapter, packet, input.includeFailed === true);
  return packet;
}
