import type { SourceRef } from '@jungjaehoon/mama-core/provenance/source-ref';

export type VNextSituationStatus =
  | 'new'
  | 'in_progress'
  | 'blocked'
  | 'submitted'
  | 'done'
  | 'stale'
  | 'conflicting'
  | 'needs_review';

export type VNextSituationFreshness = 'live' | 'pending_verification' | 'stale' | 'degraded';
export type VNextSituationVerificationState = 'pending' | 'verified' | 'conflicting' | 'stale';

export interface VNextSituationInput {
  situationId: string;
  situationVersion: number;
  awarenessRunId: string;
  title: string;
  status: VNextSituationStatus;
  summary: string;
  nextAction: string;
  freshness: VNextSituationFreshness;
  verificationState: VNextSituationVerificationState;
  confidence: number;
  evidenceRefs: readonly SourceRef[];
  updatedAtMs: number;
  viewModelHash: string;
  priority?: number;
  tags?: readonly string[];
  pendingReason?: string;
  ownerHint?: string;
  issueCount?: number;
}

export interface VNextTodaySituationRow {
  situation_id: string;
  situation_version: number;
  awareness_run_id: string;
  title: string;
  summary: string;
  next_action: string;
  status: VNextSituationStatus;
  freshness: VNextSituationFreshness;
  verification_state: VNextSituationVerificationState;
  confidence: number;
  evidence_count: number;
  evidence_refs: string[];
  updated_at_ms: number;
  view_model_hash: string;
  priority: number;
  tags: string[];
  pending_reason: string | null;
  owner_hint: string | null;
  issue_count: number;
}

export interface VNextSituationProjection {
  projectionVersion: 1;
  generatedAtMs: number;
  viewModelHash: string | null;
  today: VNextTodaySituationRow[];
  status: {
    total: number;
    live: number;
    stale: number;
    degraded: number;
    pendingVerification: number;
    verified: number;
    issueCount: number;
    newestUpdatedAtMs: number | null;
  };
}

export interface VNextReportSlot {
  slotId: string;
  html: string;
  priority: number;
  updatedAt: number;
}

export type VNextProjectionProvider = () => VNextSituationProjection | null;
