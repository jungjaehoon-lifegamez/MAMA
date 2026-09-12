export const MODEL_RUN_STATUSES = ['running', 'committed', 'failed', 'legacy'] as const;
export type ModelRunStatus = (typeof MODEL_RUN_STATUSES)[number];

export interface BeginModelRunInput {
  model_run_id?: string;
  model_id?: string | null;
  model_provider?: string | null;
  prompt_version?: string | null;
  tool_manifest_version?: string | null;
  output_schema_version?: string | null;
  agent_id?: string | null;
  instance_id?: string | null;
  envelope_hash?: string | null;
  parent_model_run_id?: string | null;
  input_snapshot_ref?: string | null;
  input_refs?: Record<string, unknown> | null;
  input_refs_json?: string | null;
  status?: ModelRunStatus;
  error_summary?: string | null;
  token_count?: number | null;
  cost_estimate?: number | null;
  created_at?: number;
}

export interface ModelRunRecord {
  model_run_id: string;
  model_id: string | null;
  model_provider: string | null;
  prompt_version: string | null;
  tool_manifest_version: string | null;
  output_schema_version: string | null;
  agent_id: string | null;
  instance_id: string | null;
  envelope_hash: string | null;
  parent_model_run_id: string | null;
  input_snapshot_ref: string | null;
  input_refs_json: string | null;
  input_refs: Record<string, unknown> | null;
  completion_summary: string | null;
  status: ModelRunStatus;
  error_summary: string | null;
  token_count: number;
  cost_estimate: number | null;
  created_at: number;
  completed_at: number | null;
}

/** Fields shared by model-backed and service-operation trace appends. */
interface AppendToolTraceCommon {
  /** Host-derived access scope; legacy rows remain unscoped. */
  owner_scope?: string | null;
  project_id?: string | null;
  channel_id?: string | null;
  diagnostic_json?: string | null;
  evidence_json?: string | null;
  catalog_revision?: string | null;

  trace_id?: string;
  gateway_call_id?: string | null;
  tool_name: string;
  input_summary?: string | null;
  output_summary?: string | null;
  execution_status?: string | null;
  duration_ms?: number | null;
  envelope_hash?: string | null;
  /** Thrower's closed cause (e.g. envelope_missing). Carried, never invented. */
  failure_code?: string | null;
  created_at?: number;
}

/**
 * Model-backed append. `model_run_id` names the authorizing model run and stays
 * required: the existing gateway/tracing callers are unchanged.
 */
export interface AppendToolTraceInput extends AppendToolTraceCommon {
  model_run_id: string;
}

/**
 * Service/CLI operation append. A truthful host operation traces itself without
 * inventing a model run: the row is anchored by a nonempty `operation_id` and
 * `actor_principal_id`, which stay required.
 *
 * `model_run_id` is OPTIONAL causal provenance: when a real completed model run
 * caused this operation observation, its id may be carried so the association is
 * queryable (the `model_runs` FK validates that the reference is real). It is
 * never fabricated, never invented, and never serves as execution authorization
 * - an operation without a causing run simply omits it and the column stays NULL.
 */
export interface AppendOperationToolTraceInput extends AppendToolTraceCommon {
  operation_id: string;
  actor_principal_id: string;
  /** Optional real causal model run. Stored when supplied; absent stays NULL. */
  model_run_id?: string | null;
}

export interface ToolTraceRecord {
  /** Host-derived access scope; legacy rows remain unscoped. */
  owner_scope?: string | null;
  project_id?: string | null;
  channel_id?: string | null;
  diagnostic_json?: string | null;
  evidence_json?: string | null;
  catalog_revision?: string | null;

  trace_id: string;
  /** NULL only for a service/operation-origin trace; legacy rows keep their model id. */
  model_run_id: string | null;
  /** Set (with actor_principal_id) exactly when this is an operation-origin trace. */
  operation_id: string | null;
  actor_principal_id: string | null;
  gateway_call_id: string | null;
  tool_name: string;
  input_summary: string | null;
  output_summary: string | null;
  execution_status: string | null;
  duration_ms: number;
  envelope_hash: string | null;
  failure_code: string | null;
  created_at: number;
}

export interface ToolTraceScope {
  owner_scope: string;
  project_id: string;
  channel_id?: string;
}

export interface ListToolTracesInput extends ToolTraceScope {
  evidence_only?: boolean;
  model_run_id?: string;
  tool_name?: string;
  cursor?: string;
  limit?: number;
}

export interface ToolTracePage {
  /** Metadata only: evidence_json is null. Read a scoped trace for details. */
  traces: ToolTraceRecord[];
  next_cursor: string | null;
}
