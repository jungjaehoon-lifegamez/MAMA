/**
 * Validation Session Domain Types + Metric Profiles
 *
 * Shared observable validation model for agent execution.
 * Every run path (delegate, agent_test, system_run, audit) feeds the same model.
 */

// ── Statuses ───────────────────────────────────────────────────────────────

export type ExecutionStatus = 'started' | 'completed' | 'failed' | 'timeout';

export type ValidationOutcome = 'healthy' | 'improved' | 'regressed' | 'inconclusive';

export type ValidationTriggerType = 'agent_test' | 'delegate_run' | 'system_run' | 'audit';

// ── Snapshot ───────────────────────────────────────────────────────────────

export interface ApiSnapshot {
  agent?: {
    enabled?: boolean;
    version?: number;
    display_name?: string;
  };
  activity?: {
    count?: number;
    latest_type?: string | null;
    latest_score?: number | null;
  };
  summary?: {
    consecutive_errors?: number;
    error_rate?: number;
  };
}

// ── Validation Session ─────────────────────────────────────────────────────

export interface CreateValidationSessionInput {
  id: string;
  agent_id: string;
  agent_version: number;
  trigger_type: ValidationTriggerType;
  goal?: string;
  metric_profile_json: string;
  baseline_version?: number;
  baseline_session_id?: string;
  execution_status: ExecutionStatus;
  validation_outcome: ValidationOutcome;
  summary?: string;
  recommendation?: string;
  before_snapshot_json?: string;
  after_snapshot_json?: string;
  report_json?: string;
  schema_version?: number;
  requires_approval?: number;
  started_at: number;
  ended_at?: number;
}

export interface ValidationSessionRow {
  id: string;
  agent_id: string;
  agent_version: number;
  trigger_type: string;
  goal: string | null;
  metric_profile_json: string;
  baseline_version: number | null;
  baseline_session_id: string | null;
  execution_status: string;
  validation_outcome: string;
  summary: string | null;
  recommendation: string | null;
  before_snapshot_json: string | null;
  after_snapshot_json: string | null;
  report_json: string | null;
  schema_version: number;
  requires_approval: number;
  started_at: number;
  ended_at: number | null;
}

// ── Validation Metrics ─────────────────────────────────────────────────────

export type MetricDirection = 'up_good' | 'down_good' | 'neutral';

export interface SaveValidationMetricInput {
  validation_session_id: string;
  name: string;
  value: number;
  baseline_value?: number;
  delta_value?: number;
  direction: MetricDirection;
}

export interface ValidationMetricRow {
  id: number;
  validation_session_id: string;
  name: string;
  value: number;
  baseline_value: number | null;
  delta_value: number | null;
  direction: string;
  created_at: number;
}

// ── Agent Validation State ─────────────────────────────────────────────────

export interface AgentValidationStateRow {
  agent_id: string;
  trigger_type: string;
  approved_version: number | null;
  approved_session_id: string | null;
  current_status: string | null;
  last_validation_at: number | null;
  updated_at: number;
}

export interface UpdateValidationStateInput {
  approved_version?: number;
  approved_session_id?: string;
  current_status?: string;
  last_validation_at?: number;
}

// ── Session Detail (joined) ────────────────────────────────────────────────

export interface ValidationSessionDetail {
  session: ValidationSessionRow;
  metrics: ValidationMetricRow[];
}

// ── Metric Profiles ────────────────────────────────────────────────────────

export interface MetricThreshold {
  warn: number;
  critical: number;
}

export interface MetricProfile {
  primary_metrics: string[];
  thresholds: Record<string, MetricThreshold>;
  extensions?: string[];
}

const DEFAULT_METRIC_PROFILE: MetricProfile = {
  primary_metrics: ['duration_ms', 'token_cost', 'completion_rate'],
  thresholds: {
    duration_ms: { warn: 30_000, critical: 60_000 },
    token_cost: { warn: 5_000, critical: 10_000 },
  },
};

const WIKI_AGENT_METRIC_PROFILE: MetricProfile = {
  primary_metrics: [
    'publish_latency_ms',
    'token_cost',
    'meaningless_run_rate',
    'change_detection_rate',
    'path_efficiency',
  ],
  thresholds: {
    publish_latency_ms: { warn: 30_000, critical: 60_000 },
    meaningless_run_rate: { warn: 0.3, critical: 0.5 },
  },
};

const DASHBOARD_AGENT_METRIC_PROFILE: MetricProfile = {
  primary_metrics: ['briefing_latency_ms', 'token_cost', 'signal_to_noise', 'staleness'],
  thresholds: {
    briefing_latency_ms: { warn: 20_000, critical: 45_000 },
    staleness: { warn: 0.4, critical: 0.7 },
  },
};

const PROFILE_REGISTRY: Record<string, MetricProfile> = {
  'wiki-agent': WIKI_AGENT_METRIC_PROFILE,
  'dashboard-agent': DASHBOARD_AGENT_METRIC_PROFILE,
};

export function getMetricProfile(agentId: string): MetricProfile {
  return PROFILE_REGISTRY[agentId] ?? DEFAULT_METRIC_PROFILE;
}

// ── JSON Size Guard ────────────────────────────────────────────────────────

const MAX_JSON_BYTES = 50 * 1024; // 50KB

export function guardJsonSize(json: string | undefined | null): string | null {
  if (!json) return null;
  if (json.length > MAX_JSON_BYTES) {
    return json.slice(0, MAX_JSON_BYTES);
  }
  return json;
}

export const SCHEMA_VERSION = 1;
