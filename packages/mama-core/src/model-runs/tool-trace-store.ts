import crypto from 'node:crypto';

import { getAdapter, initDB } from '../db-manager.js';
import type { DatabaseAdapter } from '../db-manager.js';
import type {
  AppendToolTraceInput,
  ToolTraceRecord,
  ToolTraceScope,
  ListToolTracesInput,
  ToolTracePage,
} from './types.js';

type ToolTraceAdapter = Pick<DatabaseAdapter, 'prepare'>;

function traceId(): string {
  return `tr_${crypto.randomUUID().replace(/-/g, '')}`;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `tool_traces.${field} must be a non-empty string: ${formatInvalidValue(value)}`
    );
  }
  return value;
}

function formatInvalidValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeTimestamp(value: unknown): number {
  if (value === undefined || value === null) {
    return Date.now();
  }
  return requiredInteger(value, 'created_at');
}

function normalizeDuration(value: unknown): number {
  if (value === undefined || value === null) {
    return 0;
  }
  return requiredNonNegativeInteger(value, 'duration_ms');
}

function requiredInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`tool_traces.${field} must be a finite number: ${formatInvalidValue(value)}`);
  }
  return Math.floor(value);
}

function requiredNonNegativeInteger(value: unknown, field: string): number {
  const normalized = requiredInteger(value, field);
  if (normalized < 0) {
    throw new Error(`tool_traces.${field} must be non-negative: ${formatInvalidValue(value)}`);
  }
  return normalized;
}

function nullableJsonObject(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`tool_traces.${field} must be a JSON object string`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`tool_traces.${field} contains malformed JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`tool_traces.${field} must contain a JSON object`);
  }
  return value;
}

function mapToolTraceRow(row: Record<string, unknown>): ToolTraceRecord {
  return {
    diagnostic_json: nullableJsonObject(row.diagnostic_json, 'diagnostic_json'),
    evidence_json: nullableJsonObject(row.evidence_json, 'evidence_json'),
    catalog_revision: nullableString(row.catalog_revision),
    owner_scope: nullableString(row.owner_scope),
    project_id: nullableString(row.project_id),
    channel_id: nullableString(row.channel_id),
    trace_id: requiredString(row.trace_id, 'trace_id'),
    model_run_id: requiredString(row.model_run_id, 'model_run_id'),
    gateway_call_id: nullableString(row.gateway_call_id),
    tool_name: requiredString(row.tool_name, 'tool_name'),
    input_summary: nullableString(row.input_summary),
    output_summary: nullableString(row.output_summary),
    execution_status: nullableString(row.execution_status),
    duration_ms: requiredNonNegativeInteger(row.duration_ms, 'duration_ms'),
    envelope_hash: nullableString(row.envelope_hash),
    failure_code: nullableString(row.failure_code),
    created_at: requiredInteger(row.created_at, 'created_at'),
  };
}

async function initializedAdapter(): Promise<DatabaseAdapter> {
  await initDB();
  return getAdapter();
}

function selectToolTrace(adapter: ToolTraceAdapter, id: string): ToolTraceRecord {
  const row = adapter
    .prepare(
      `
        SELECT
          trace_id, model_run_id, gateway_call_id, tool_name, input_summary,
          output_summary, execution_status, duration_ms, envelope_hash, failure_code,
          created_at, diagnostic_json, evidence_json, catalog_revision, owner_scope, project_id, channel_id
        FROM tool_traces
        WHERE trace_id = ?
      `
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error(`Tool trace not found: ${id}`);
  }
  return mapToolTraceRow(row);
}

export async function appendToolTrace(input: AppendToolTraceInput): Promise<ToolTraceRecord> {
  const adapter = await initializedAdapter();
  const id = nullableString(input.trace_id) ?? traceId();
  const modelRunId = requiredString(input.model_run_id, 'model_run_id');
  const toolName = requiredString(input.tool_name, 'tool_name');

  adapter
    .prepare(
      `
        INSERT INTO tool_traces (
          trace_id, model_run_id, gateway_call_id, tool_name, input_summary,
          output_summary, execution_status, duration_ms, envelope_hash, failure_code,
          created_at, diagnostic_json, evidence_json, catalog_revision, owner_scope, project_id, channel_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      id,
      modelRunId,
      nullableString(input.gateway_call_id),
      toolName,
      nullableString(input.input_summary),
      nullableString(input.output_summary),
      nullableString(input.execution_status),
      normalizeDuration(input.duration_ms),
      nullableString(input.envelope_hash),
      nullableString(input.failure_code),
      normalizeTimestamp(input.created_at),
      nullableJsonObject(input.diagnostic_json, 'diagnostic_json'),
      nullableJsonObject(input.evidence_json, 'evidence_json'),
      nullableString(input.catalog_revision),
      nullableString(input.owner_scope),
      nullableString(input.project_id),
      nullableString(input.channel_id)
    );

  return selectToolTrace(adapter, id);
}

export async function listToolTracesForRun(modelRunId: string): Promise<ToolTraceRecord[]> {
  const adapter = await initializedAdapter();
  const id = requiredString(modelRunId, 'model_run_id');
  const rows = adapter
    .prepare(
      `
        SELECT
          trace_id, model_run_id, gateway_call_id, tool_name, input_summary,
          output_summary, execution_status, duration_ms, envelope_hash, failure_code,
          created_at, diagnostic_json, evidence_json, catalog_revision, owner_scope, project_id, channel_id
        FROM tool_traces
        WHERE model_run_id = ?
        ORDER BY created_at DESC, rowid DESC
      `
    )
    .all(id) as Record<string, unknown>[];
  return rows.map(mapToolTraceRow);
}

function scopedWhere(scope: ToolTraceScope): { clauses: string[]; values: (string | number)[] } {
  const clauses = ['owner_scope = ?', 'project_id = ?'];
  const values: (string | number)[] = [
    requiredString(scope.owner_scope, 'owner_scope'),
    requiredString(scope.project_id, 'project_id'),
  ];
  if (scope.channel_id !== undefined) {
    clauses.push('channel_id = ?');
    values.push(requiredString(scope.channel_id, 'channel_id'));
  }
  return { clauses, values };
}

/** Access is exact host-derived scope; knowing a trace ID never grants access. */
export async function readToolTrace(
  traceId: string,
  scope: ToolTraceScope
): Promise<ToolTraceRecord | null> {
  const { clauses, values } = scopedWhere(scope);
  clauses.push('trace_id = ?');
  values.push(requiredString(traceId, 'trace_id'));
  const adapter = await initializedAdapter();
  const row = adapter
    .prepare(`SELECT * FROM tool_traces WHERE ${clauses.join(' AND ')}`)
    .get(...values) as Record<string, unknown> | undefined;
  return row ? mapToolTraceRow(row) : null;
}

/** Bounded metadata discovery; detailed evidence is read explicitly by trace ID. */
export async function listToolTraces(input: ListToolTracesInput): Promise<ToolTracePage> {
  const { clauses, values } = scopedWhere(input);
  if (input.evidence_only !== undefined && typeof input.evidence_only !== 'boolean') {
    throw new Error('tool_traces.evidence_only must be a boolean');
  }
  if (input.evidence_only === true) {
    clauses.push('evidence_json IS NOT NULL');
  }
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('tool_traces.limit must be an integer between 1 and 100');
  }
  for (const field of ['model_run_id', 'tool_name'] as const) {
    if (input[field] !== undefined) {
      clauses.push(`${field} = ?`);
      values.push(requiredString(input[field], field));
    }
  }
  if (input.cursor !== undefined) {
    let cursor: unknown;
    try {
      cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
    } catch {
      throw new Error('tool_traces.cursor is malformed');
    }
    if (!Array.isArray(cursor) || cursor.length !== 2) {
      throw new Error('tool_traces.cursor is malformed');
    }
    const [cursorCreatedAt, cursorTraceId] = cursor as [unknown, unknown];
    if (
      typeof cursorCreatedAt !== 'number' ||
      !Number.isSafeInteger(cursorCreatedAt) ||
      typeof cursorTraceId !== 'string' ||
      cursorTraceId.length === 0
    ) {
      throw new Error('tool_traces.cursor is malformed');
    }
    clauses.push('(created_at < ? OR (created_at = ? AND trace_id < ?))');
    values.push(cursorCreatedAt, cursorCreatedAt, cursorTraceId);
  }
  const adapter = await initializedAdapter();
  const rows = adapter
    .prepare(
      `SELECT trace_id, model_run_id, gateway_call_id, tool_name,
    input_summary, output_summary, execution_status, duration_ms, envelope_hash, failure_code,
    created_at, diagnostic_json, NULL AS evidence_json, catalog_revision, owner_scope, project_id, channel_id
    FROM tool_traces WHERE ${clauses.join(' AND ')}
    ORDER BY created_at DESC, trace_id DESC LIMIT ?`
    )
    .all(...values, limit + 1) as Record<string, unknown>[];
  const traces = rows.slice(0, limit).map(mapToolTraceRow);
  const last = traces.at(-1);
  const next_cursor =
    rows.length > limit && last
      ? Buffer.from(JSON.stringify([last.created_at, last.trace_id])).toString('base64url')
      : null;
  return { traces, next_cursor };
}
