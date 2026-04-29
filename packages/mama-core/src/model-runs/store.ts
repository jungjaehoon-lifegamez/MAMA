import crypto from 'node:crypto';

import { getAdapter, initDB } from '../db-manager.js';
import type { DatabaseAdapter } from '../db-manager.js';
import { MODEL_RUN_STATUSES } from './types.js';
import type { BeginModelRunInput, ModelRunRecord, ModelRunStatus } from './types.js';

type ModelRunAdapter = Pick<DatabaseAdapter, 'prepare'>;
type NormalizedBeginModelRunInput = Pick<
  ModelRunRecord,
  | 'model_run_id'
  | 'model_id'
  | 'model_provider'
  | 'prompt_version'
  | 'tool_manifest_version'
  | 'output_schema_version'
  | 'agent_id'
  | 'instance_id'
  | 'envelope_hash'
  | 'parent_model_run_id'
  | 'input_snapshot_ref'
  | 'input_refs_json'
  | 'status'
  | 'error_summary'
  | 'token_count'
  | 'cost_estimate'
  | 'created_at'
>;

const BEGIN_REPLAY_FIELDS = [
  'model_id',
  'model_provider',
  'prompt_version',
  'tool_manifest_version',
  'output_schema_version',
  'agent_id',
  'instance_id',
  'envelope_hash',
  'parent_model_run_id',
  'input_snapshot_ref',
  'input_refs_json',
  'status',
  'error_summary',
  'token_count',
  'cost_estimate',
  'created_at',
] as const satisfies ReadonlyArray<keyof NormalizedBeginModelRunInput>;

function modelRunId(): string {
  return `mr_${crypto.randomUUID().replace(/-/g, '')}`;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function formatInvalidValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`model_runs.${field} must be a non-empty string: ${formatInvalidValue(value)}`);
  }
  return value;
}

function normalizeTimestamp(value: unknown): number {
  if (value === undefined) {
    return Date.now();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  throw new Error(`model_runs.created_at must be a finite number: ${formatInvalidValue(value)}`);
}

function requireTimestamp(value: unknown, field: string, modelRunId: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid model_runs.${field} for ${modelRunId}: ${formatInvalidValue(value)}`);
  }
  return Math.floor(value);
}

function normalizeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
}

function normalizeCost(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function requireInputRefsObject(value: unknown, field: string): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`model_runs.${field} must be a JSON object`);
}

function normalizeInputRefsJson(input: BeginModelRunInput): string | null {
  if (typeof input.input_refs_json === 'string') {
    try {
      requireInputRefsObject(JSON.parse(input.input_refs_json) as unknown, 'input_refs_json');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid model_runs.input_refs_json: ${message}`);
    }
    return input.input_refs_json;
  }
  if (input.input_refs === null || input.input_refs === undefined) {
    return null;
  }
  const inputRefs = requireInputRefsObject(input.input_refs, 'input_refs');
  try {
    return JSON.stringify(inputRefs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid model_runs.input_refs: ${message}`);
  }
}

function parseInputRefs(row: { model_run_id: string; input_refs_json: unknown }): {
  input_refs_json: string | null;
  input_refs: Record<string, unknown> | null;
} {
  const inputRefsJson = nullableString(row.input_refs_json);
  if (!inputRefsJson) {
    return { input_refs_json: null, input_refs: null };
  }
  try {
    const parsed = JSON.parse(inputRefsJson) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        input_refs_json: inputRefsJson,
        input_refs: parsed as Record<string, unknown>,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid model_runs.input_refs_json for ${row.model_run_id}: ${message}`);
  }
  throw new Error(`Invalid model_runs.input_refs_json for ${row.model_run_id}: expected object`);
}

const MODEL_RUN_STATUS_SET = new Set<string>(MODEL_RUN_STATUSES);

function requireModelRunStatus(value: unknown, modelRunId: string): ModelRunStatus {
  if (typeof value === 'string' && MODEL_RUN_STATUS_SET.has(value)) {
    return value as ModelRunStatus;
  }
  throw new Error(`Invalid model_runs.status for ${modelRunId}: ${formatInvalidValue(value)}`);
}

function mapModelRunRow(row: Record<string, unknown>): ModelRunRecord {
  const model_run_id = requireString(row.model_run_id, 'model_run_id');
  const inputRefs = parseInputRefs({ model_run_id, input_refs_json: row.input_refs_json });
  return {
    model_run_id,
    model_id: nullableString(row.model_id),
    model_provider: nullableString(row.model_provider),
    prompt_version: nullableString(row.prompt_version),
    tool_manifest_version: nullableString(row.tool_manifest_version),
    output_schema_version: nullableString(row.output_schema_version),
    agent_id: nullableString(row.agent_id),
    instance_id: nullableString(row.instance_id),
    envelope_hash: nullableString(row.envelope_hash),
    parent_model_run_id: nullableString(row.parent_model_run_id),
    input_snapshot_ref: nullableString(row.input_snapshot_ref),
    input_refs_json: inputRefs.input_refs_json,
    input_refs: inputRefs.input_refs,
    completion_summary: nullableString(row.completion_summary),
    status: requireModelRunStatus(row.status, model_run_id),
    error_summary: nullableString(row.error_summary),
    token_count: normalizeNumber(row.token_count, 0),
    cost_estimate: normalizeCost(row.cost_estimate),
    created_at: requireTimestamp(row.created_at, 'created_at', model_run_id),
    completed_at:
      typeof row.completed_at === 'number' && Number.isFinite(row.completed_at)
        ? Math.floor(row.completed_at)
        : null,
  };
}

async function initializedAdapter(): Promise<DatabaseAdapter> {
  await initDB();
  return getAdapter();
}

function selectModelRun(adapter: ModelRunAdapter, id: string): ModelRunRecord | null {
  const row = adapter
    .prepare(
      `
        SELECT
          model_run_id, model_id, model_provider, prompt_version, tool_manifest_version,
          output_schema_version, agent_id, instance_id, envelope_hash, parent_model_run_id,
          input_snapshot_ref, input_refs_json, completion_summary, status, error_summary,
          token_count, cost_estimate, created_at, completed_at
        FROM model_runs
        WHERE model_run_id = ?
      `
    )
    .get(id) as Record<string, unknown> | undefined;
  return row ? mapModelRunRow(row) : null;
}

function requireModelRun(adapter: ModelRunAdapter, id: string): ModelRunRecord {
  const run = selectModelRun(adapter, id);
  if (!run) {
    throw new Error(`Model run not found: ${id}`);
  }
  return run;
}

function normalizeBeginModelRunInput(
  id: string,
  input: BeginModelRunInput,
  createdAt: number,
  status: ModelRunStatus,
  inputRefsJson: string | null
): NormalizedBeginModelRunInput {
  return {
    model_run_id: id,
    model_id: nullableString(input.model_id),
    model_provider: nullableString(input.model_provider),
    prompt_version: nullableString(input.prompt_version),
    tool_manifest_version: nullableString(input.tool_manifest_version),
    output_schema_version: nullableString(input.output_schema_version),
    agent_id: nullableString(input.agent_id),
    instance_id: nullableString(input.instance_id),
    envelope_hash: nullableString(input.envelope_hash),
    parent_model_run_id: nullableString(input.parent_model_run_id),
    input_snapshot_ref: nullableString(input.input_snapshot_ref),
    input_refs_json: inputRefsJson,
    status,
    error_summary: nullableString(input.error_summary),
    token_count: normalizeNumber(input.token_count, 0),
    cost_estimate: normalizeCost(input.cost_estimate),
    created_at: createdAt,
  };
}

function assertReplayHasIdempotencyDiscriminator(expected: NormalizedBeginModelRunInput): void {
  if (expected.envelope_hash || expected.input_refs_json) {
    return;
  }
  throw new Error(
    `Model run already exists and replay is missing an idempotency discriminator: ${expected.model_run_id}`
  );
}

function assertExistingModelRunMatchesInput(
  existing: ModelRunRecord,
  expected: NormalizedBeginModelRunInput
): void {
  assertReplayHasIdempotencyDiscriminator(expected);
  for (const field of BEGIN_REPLAY_FIELDS) {
    if (existing[field] !== expected[field]) {
      throw new Error(`Model run already exists with different ${field}: ${existing.model_run_id}`);
    }
  }
}

function isDuplicateModelRunError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed: model_runs\.model_run_id|PRIMARY KEY constraint failed/i.test(
    message
  );
}

function resolveExistingCommittedRun(
  existing: ModelRunRecord,
  summary: string | null
): ModelRunRecord {
  if (existing.status === 'committed') {
    if (existing.completion_summary === summary) {
      return existing;
    }
    throw new Error(
      `Model run already committed with different completion_summary: ${existing.model_run_id}`
    );
  }
  if (existing.status === 'failed') {
    throw new Error(`Model run already failed: ${existing.model_run_id}`);
  }
  throw new Error(`Cannot commit model run in ${existing.status} status: ${existing.model_run_id}`);
}

function resolveExistingFailedRun(
  existing: ModelRunRecord,
  errorSummary: string | null
): ModelRunRecord {
  if (existing.status === 'failed') {
    if (existing.error_summary === errorSummary) {
      return existing;
    }
    throw new Error(
      `Model run already failed with different error_summary: ${existing.model_run_id}`
    );
  }
  if (existing.status === 'committed') {
    throw new Error(`Model run already committed: ${existing.model_run_id}`);
  }
  throw new Error(`Cannot fail model run in ${existing.status} status: ${existing.model_run_id}`);
}

export function beginModelRunInAdapter(
  adapter: ModelRunAdapter,
  input: BeginModelRunInput
): ModelRunRecord {
  const id = nullableString(input.model_run_id) ?? modelRunId();
  const createdAt = normalizeTimestamp(input.created_at);
  const status = input.status ?? 'running';
  const inputRefsJson = normalizeInputRefsJson(input);
  const expected = normalizeBeginModelRunInput(id, input, createdAt, status, inputRefsJson);

  const existing = selectModelRun(adapter, id);
  if (existing) {
    assertExistingModelRunMatchesInput(existing, expected);
    return existing;
  }

  try {
    adapter
      .prepare(
        `
          INSERT INTO model_runs (
            model_run_id, model_id, model_provider, prompt_version, tool_manifest_version,
            output_schema_version, agent_id, instance_id, envelope_hash, parent_model_run_id,
            input_snapshot_ref, input_refs_json, completion_summary, status, error_summary,
            token_count, cost_estimate, created_at, completed_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        id,
        nullableString(input.model_id),
        nullableString(input.model_provider),
        nullableString(input.prompt_version),
        nullableString(input.tool_manifest_version),
        nullableString(input.output_schema_version),
        nullableString(input.agent_id),
        nullableString(input.instance_id),
        nullableString(input.envelope_hash),
        nullableString(input.parent_model_run_id),
        nullableString(input.input_snapshot_ref),
        inputRefsJson,
        null,
        status,
        nullableString(input.error_summary),
        normalizeNumber(input.token_count, 0),
        normalizeCost(input.cost_estimate),
        createdAt,
        null
      );
  } catch (error) {
    if (!isDuplicateModelRunError(error)) {
      throw error;
    }
    const duplicate = selectModelRun(adapter, id);
    if (duplicate) {
      assertExistingModelRunMatchesInput(duplicate, expected);
      return duplicate;
    }
    throw error;
  }

  return requireModelRun(adapter, id);
}

export function commitModelRunInAdapter(
  adapter: ModelRunAdapter,
  modelRunId: string,
  summary?: string
): ModelRunRecord {
  const summaryValue = nullableString(summary);
  const existing = requireModelRun(adapter, modelRunId);
  if (existing.status !== 'running') {
    return resolveExistingCommittedRun(existing, summaryValue);
  }

  const completedAt = Date.now();
  const result = adapter
    .prepare(
      `
        UPDATE model_runs
        SET status = 'committed',
            completion_summary = ?,
            error_summary = NULL,
            completed_at = ?
        WHERE model_run_id = ? AND status = 'running'
      `
    )
    .run(summaryValue, completedAt, modelRunId);

  if (result.changes === 0) {
    return resolveExistingCommittedRun(requireModelRun(adapter, modelRunId), summaryValue);
  }

  return requireModelRun(adapter, modelRunId);
}

export function failModelRunInAdapter(
  adapter: ModelRunAdapter,
  modelRunId: string,
  errorSummary: string
): ModelRunRecord {
  const errorSummaryValue = nullableString(errorSummary);
  const existing = requireModelRun(adapter, modelRunId);
  if (existing.status !== 'running') {
    return resolveExistingFailedRun(existing, errorSummaryValue);
  }

  const completedAt = Date.now();
  const result = adapter
    .prepare(
      `
        UPDATE model_runs
        SET status = 'failed',
            completion_summary = NULL,
            error_summary = ?,
            completed_at = ?
        WHERE model_run_id = ? AND status = 'running'
      `
    )
    .run(errorSummaryValue, completedAt, modelRunId);

  if (result.changes === 0) {
    return resolveExistingFailedRun(requireModelRun(adapter, modelRunId), errorSummaryValue);
  }

  return requireModelRun(adapter, modelRunId);
}

export function getModelRunInAdapter(
  adapter: ModelRunAdapter,
  modelRunId: string
): ModelRunRecord | null {
  return selectModelRun(adapter, modelRunId);
}

export async function beginModelRun(input: BeginModelRunInput): Promise<ModelRunRecord> {
  const adapter = await initializedAdapter();
  return beginModelRunInAdapter(adapter, input);
}

export async function commitModelRun(
  modelRunId: string,
  summary?: string
): Promise<ModelRunRecord> {
  const adapter = await initializedAdapter();
  return commitModelRunInAdapter(adapter, modelRunId, summary);
}

export async function failModelRun(
  modelRunId: string,
  errorSummary: string
): Promise<ModelRunRecord> {
  const adapter = await initializedAdapter();
  return failModelRunInAdapter(adapter, modelRunId, errorSummary);
}

export async function getModelRun(modelRunId: string): Promise<ModelRunRecord | null> {
  const adapter = await initializedAdapter();
  return getModelRunInAdapter(adapter, modelRunId);
}
