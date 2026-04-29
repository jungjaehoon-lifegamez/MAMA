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

export interface AppendToolTraceInput {
  trace_id?: string;
  model_run_id: string;
  gateway_call_id?: string | null;
  tool_name: string;
  input_summary?: string | null;
  output_summary?: string | null;
  execution_status?: string | null;
  duration_ms?: number | null;
  envelope_hash?: string | null;
  created_at?: number;
}

export interface ToolTraceRecord {
  trace_id: string;
  model_run_id: string;
  gateway_call_id: string | null;
  tool_name: string;
  input_summary: string | null;
  output_summary: string | null;
  execution_status: string | null;
  duration_ms: number;
  envelope_hash: string | null;
  created_at: number;
}
