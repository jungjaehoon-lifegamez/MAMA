/**
 * Entity Review Queue Module
 *
 * Minimal review surface for canonical entity resolution candidates.
 * Data layer is intentionally DOM-free so it can be unit-tested in node.
 */

/* eslint-env browser */

import { API } from '../utils/api.js';

export interface EntityCandidateRef {
  kind: string;
  id: string;
  label: string;
}

export interface EntityCandidateSummary {
  id: string;
  candidate_kind: string;
  status: string;
  score_total: number;
  left_ref: EntityCandidateRef;
  right_ref: EntityCandidateRef;
  created_at: string;
  scope_kind: string | null;
  scope_id: string | null;
}

export interface EntityCandidateEvidence {
  id: string;
  surface_form: string;
  normalized_form: string;
  lang: string | null;
  script: string | null;
  context_summary: string | null;
  scope_kind: string | null;
  scope_id: string | null;
  source_connector: string;
  source_raw_record_id: string;
  timestamp_observed: number | null;
}

export interface EntityCandidateDetail extends EntityCandidateSummary {
  score_structural: number;
  score_string: number;
  score_context: number;
  score_graph: number;
  score_embedding: number;
  rule_trace: string[];
  evidence: EntityCandidateEvidence[];
  extractor_version: string;
  embedding_model_version: string | null;
}

export interface EntityCandidateListResponse {
  candidates: EntityCandidateSummary[];
  next_cursor: string | null;
}

export interface EntityCandidateDetailResponse {
  candidate: EntityCandidateDetail;
}

export interface EntityReviewActionResult {
  candidate_id: string;
  merge_action_id: string;
  action: string;
  actor_id: string;
  created_at: string;
}

export type ReviewAction = 'approve' | 'reject' | 'defer';

export interface CandidateListRenderState {
  isEmpty: boolean;
  total: number;
  rows: Array<{
    id: string;
    scoreText: string;
    leftLabel: string;
    rightLabel: string;
    scopeLabel: string;
    createdAtIso: string;
  }>;
  nextCursor: string | null;
}

export interface CandidateDetailRenderState {
  id: string;
  leftLabel: string;
  rightLabel: string;
  scoreBreakdown: Array<{ key: string; label: string; value: number }>;
  ruleTrace: string[];
  evidence: EntityCandidateEvidence[];
  extractorVersion: string;
  embeddingModelVersion: string;
}

export class EntityReviewController {
  private readonly endpoint: string;

  constructor(opts: { endpoint?: string } = {}) {
    this.endpoint = opts.endpoint ?? '/api/entities/candidates';
  }

  async fetchCandidates(
    params: { limit?: number; cursor?: string | null } = {}
  ): Promise<EntityCandidateListResponse> {
    const query: Record<string, string | number | null | undefined> = {};
    if (typeof params.limit === 'number') query.limit = params.limit;
    if (params.cursor) query.cursor = params.cursor;
    return API.get<EntityCandidateListResponse>(this.endpoint, query);
  }

  async fetchCandidate(id: string): Promise<EntityCandidateDetailResponse> {
    return API.get<EntityCandidateDetailResponse>(`${this.endpoint}/${encodeURIComponent(id)}`);
  }

  async review(
    id: string,
    action: ReviewAction,
    body: { reason?: string } = {}
  ): Promise<EntityReviewActionResult> {
    return API.post<EntityReviewActionResult>(
      `${this.endpoint}/${encodeURIComponent(id)}/${action}`,
      body
    );
  }
}

export function buildListRenderState(
  response: EntityCandidateListResponse
): CandidateListRenderState {
  return {
    isEmpty: response.candidates.length === 0,
    total: response.candidates.length,
    rows: response.candidates.map((c) => ({
      id: c.id,
      scoreText: c.score_total.toFixed(2),
      leftLabel: c.left_ref.label,
      rightLabel: c.right_ref.label,
      scopeLabel: c.scope_kind ? `${c.scope_kind}:${c.scope_id ?? ''}` : 'global',
      createdAtIso: c.created_at,
    })),
    nextCursor: response.next_cursor,
  };
}

export function buildDetailRenderState(
  response: EntityCandidateDetailResponse
): CandidateDetailRenderState {
  const c = response.candidate;
  return {
    id: c.id,
    leftLabel: c.left_ref.label,
    rightLabel: c.right_ref.label,
    scoreBreakdown: [
      { key: 'total', label: 'Total', value: c.score_total },
      { key: 'structural', label: 'Structural', value: c.score_structural },
      { key: 'string', label: 'String', value: c.score_string },
      { key: 'context', label: 'Context', value: c.score_context },
      { key: 'graph', label: 'Graph', value: c.score_graph },
      { key: 'embedding', label: 'Embedding', value: c.score_embedding },
    ],
    ruleTrace: c.rule_trace,
    evidence: c.evidence,
    extractorVersion: c.extractor_version,
    embeddingModelVersion: c.embedding_model_version ?? 'n/a',
  };
}

export function renderEmptyState(): string {
  return 'No candidates pending review.';
}
