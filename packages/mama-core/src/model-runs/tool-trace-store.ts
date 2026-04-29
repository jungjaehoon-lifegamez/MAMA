import crypto from 'node:crypto';

import { getAdapter, initDB } from '../db-manager.js';
import type { DatabaseAdapter } from '../db-manager.js';
import type { AppendToolTraceInput, ToolTraceRecord } from './types.js';

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

function mapToolTraceRow(row: Record<string, unknown>): ToolTraceRecord {
  return {
    trace_id: requiredString(row.trace_id, 'trace_id'),
    model_run_id: requiredString(row.model_run_id, 'model_run_id'),
    gateway_call_id: nullableString(row.gateway_call_id),
    tool_name: requiredString(row.tool_name, 'tool_name'),
    input_summary: nullableString(row.input_summary),
    output_summary: nullableString(row.output_summary),
    execution_status: nullableString(row.execution_status),
    duration_ms: requiredNonNegativeInteger(row.duration_ms, 'duration_ms'),
    envelope_hash: nullableString(row.envelope_hash),
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
          output_summary, execution_status, duration_ms, envelope_hash, created_at
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
          output_summary, execution_status, duration_ms, envelope_hash, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      normalizeTimestamp(input.created_at)
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
          output_summary, execution_status, duration_ms, envelope_hash, created_at
        FROM tool_traces
        WHERE model_run_id = ?
        ORDER BY created_at DESC, rowid DESC
      `
    )
    .all(id) as Record<string, unknown>[];
  return rows.map(mapToolTraceRow);
}
