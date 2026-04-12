/**
 * Entity Audit Viewer Module
 *
 * Minimal audit-run surface. DOM-free controller + render-state helpers so
 * the module can be unit-tested in node.
 */

/* eslint-env browser */

import { API } from '../utils/api.js';

export type AuditRunStatus = 'running' | 'complete' | 'failed' | 'timeout';
export type AuditRunClassification = 'improved' | 'stable' | 'regressed' | 'inconclusive';

export interface EntityAuditRunSummary {
  id: string;
  status: AuditRunStatus;
  baseline_run_id: string | null;
  classification: AuditRunClassification | null;
  reason: string | null;
  created_at: number;
  completed_at: number | null;
  metrics?: {
    false_merge_rate?: number;
    cross_language_candidate_recall_at_10?: number;
    ontology_violation_count?: number;
    projection_fragmentation_rate?: number;
  } | null;
}

export interface EntityAuditListResponse {
  runs: EntityAuditRunSummary[];
}

export interface EntityAuditStartResponse {
  run_id: string;
}

export class EntityAuditController {
  async startRun(): Promise<EntityAuditStartResponse> {
    return API.post<EntityAuditStartResponse>('/api/entities/audit/run', {});
  }

  async listRuns(limit = 25): Promise<EntityAuditListResponse> {
    return API.get<EntityAuditListResponse>('/api/entities/audit/runs', { limit });
  }

  async getRun(runId: string): Promise<EntityAuditRunSummary> {
    return API.get<EntityAuditRunSummary>(`/api/entities/audit/runs/${encodeURIComponent(runId)}`);
  }
}

export interface AuditBannerState {
  variant: 'neutral' | 'success' | 'warning' | 'danger';
  label: string;
  headline: string;
  hint: string;
}

export function buildAuditBannerState(run: EntityAuditRunSummary): AuditBannerState {
  if (run.status === 'running') {
    return {
      variant: 'neutral',
      label: 'RUNNING',
      headline: 'Audit run in progress',
      hint: 'Wait for completion before starting a new run.',
    };
  }
  if (run.status === 'failed' || run.status === 'timeout') {
    return {
      variant: 'danger',
      label: run.status.toUpperCase(),
      headline: `Audit run ${run.status}`,
      hint: run.reason ?? 'Check server logs for details.',
    };
  }
  switch (run.classification) {
    case 'regressed':
      return {
        variant: 'danger',
        label: 'REGRESSED',
        headline: 'false_merge_rate spike detected',
        hint: 'See #false-merge-spike in the entity substrate runbook.',
      };
    case 'improved':
      return {
        variant: 'success',
        label: 'IMPROVED',
        headline: 'All tracked metrics improved or held',
        hint: 'Safe to promote the current baseline.',
      };
    case 'inconclusive':
      return {
        variant: 'warning',
        label: 'INCONCLUSIVE',
        headline: 'No baseline available for comparison',
        hint: 'Re-run after the next ingest pass to establish a baseline.',
      };
    case 'stable':
    default:
      return {
        variant: 'neutral',
        label: 'STABLE',
        headline: 'Metrics within tolerance',
        hint: 'No action required.',
      };
  }
}

export interface AuditMetricRow {
  key: string;
  label: string;
  value: string;
}

export function buildAuditMetricRows(run: EntityAuditRunSummary): AuditMetricRow[] {
  const metrics = run.metrics ?? {};
  return [
    {
      key: 'false_merge_rate',
      label: 'False merge rate',
      value: formatNumber(metrics.false_merge_rate),
    },
    {
      key: 'cross_language_candidate_recall_at_10',
      label: 'Cross-language recall@10',
      value: formatNumber(metrics.cross_language_candidate_recall_at_10),
    },
    {
      key: 'ontology_violation_count',
      label: 'Ontology violations',
      value: formatInteger(metrics.ontology_violation_count),
    },
    {
      key: 'projection_fragmentation_rate',
      label: 'Projection fragmentation',
      value: formatNumber(metrics.projection_fragmentation_rate),
    },
  ];
}

function formatNumber(value: number | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  return value.toFixed(3);
}

function formatInteger(value: number | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  return String(Math.round(value));
}

export function buildConcurrentRunLockoutMessage(run: EntityAuditRunSummary): string {
  return `Audit run ${run.id} is already in progress. Wait for it to finish before starting a new one.`;
}
