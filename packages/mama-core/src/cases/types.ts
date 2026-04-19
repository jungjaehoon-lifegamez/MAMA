export const CASE_TRUTH_STATUSES = [
  'active',
  'blocked',
  'resolved',
  'stale',
  'archived',
  'merged',
  'split',
] as const;
export type CaseTruthStatus = (typeof CASE_TRUTH_STATUSES)[number];

export const CASE_FAST_WRITE_STATUSES = ['active', 'blocked', 'resolved', 'stale'] as const;
export type CaseFastWriteStatus = (typeof CASE_FAST_WRITE_STATUSES)[number];

export const CASE_MEMBERSHIP_SOURCE_TYPES = [
  'decision',
  'event',
  'observation',
  'artifact',
] as const;
export type CaseMembershipSourceType = (typeof CASE_MEMBERSHIP_SOURCE_TYPES)[number];

export const CASE_MEMBERSHIP_STATUSES = [
  'active',
  'candidate',
  'removed',
  'excluded',
  'stale',
] as const;
export type CaseMembershipStatus = (typeof CASE_MEMBERSHIP_STATUSES)[number];

export const CASE_MEMBERSHIP_ADDED_BY = [
  'wiki-compiler',
  'memory-agent',
  'user-correction',
] as const;
export type CaseMembershipAddedBy = (typeof CASE_MEMBERSHIP_ADDED_BY)[number];

export const CASE_CORRECTION_TARGET_KINDS = ['case_field', 'membership', 'wiki_section'] as const;
export type CaseCorrectionTargetKind = (typeof CASE_CORRECTION_TARGET_KINDS)[number];

export const CASE_PROPOSAL_KINDS = [
  'ambiguous_slug',
  'duplicate_frontmatter',
  'missing_frontmatter',
  'unknown_case_id',
  'stale_case_id',
  'merged_target',
  'archived_target',
  'lock_conflict',
  'corrupt_frontmatter',
  'quarantined_accepted_case',
] as const;
export type CaseProposalKind = (typeof CASE_PROPOSAL_KINDS)[number];

export const CASE_PROPOSAL_RESOLUTIONS = ['accepted', 'rejected', 'modified', 'merged'] as const;
export type CaseProposalResolution = (typeof CASE_PROPOSAL_RESOLUTIONS)[number];

export const CASE_CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type CaseConfidence = (typeof CASE_CONFIDENCE_LEVELS)[number];

export interface CaseTruthRecord {
  case_id: string;
  current_wiki_path: string | null;
  title: string;
  status: CaseTruthStatus;
  status_reason: string | null;
  primary_actors: string | null;
  blockers: string | null;
  last_activity_at: string | null;
  canonical_case_id?: string | null;
  split_from_case_id?: string | null;
  wiki_path_history: string | null;
  scope_refs: string | null;
  confidence: CaseConfidence | null;
  compiled_at: string | null;
  state_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CaseMembershipRecord {
  case_id: string;
  source_type: CaseMembershipSourceType;
  source_id: string;
  role: string | null;
  confidence: number | null;
  reason: string | null;
  status: CaseMembershipStatus;
  added_by: CaseMembershipAddedBy;
  added_at: string;
  updated_at: string;
  user_locked: 0 | 1;
}

export interface CaseCorrectionRecord {
  correction_id: string;
  case_id: string;
  target_kind: CaseCorrectionTargetKind;
  target_ref_json: string;
  target_ref_hash: Buffer;
  field_name: string | null;
  old_value_json: string | null;
  new_value_json: string;
  reason: string;
  is_lock_active: 0 | 1;
  superseded_by: string | null;
  reverted_at: string | null;
  applied_by: string;
  applied_at: string;
}

export interface CaseCorrectionRequiresReconfirmResult {
  kind: 'requires_reconfirm';
  code: 'case.correction_requires_reconfirm';
  case_id: string;
  target_kind: CaseCorrectionTargetKind;
  target_ref_json: string;
  current_value_json: string;
  old_value_json: string | null;
  proposed_new_value_json: string;
  reconfirm_token: string;
  reconfirm_token_expires_at: string;
  message: string;
}

export interface CaseProposalQueueRecord {
  proposal_id: string;
  project: string;
  proposal_kind: CaseProposalKind;
  proposed_payload: string;
  payload_fingerprint: Buffer;
  conflicting_case_id: string | null;
  detected_at: string;
  resolved_at: string | null;
  resolution: CaseProposalResolution | null;
  resolution_note: string | null;
}

export interface CasePrimaryActor {
  entity_id: string;
  role: string;
}

export interface CaseBlocker {
  text: string;
  source_decision_id?: string;
  source_event_id?: string;
}

export interface CaseAssemblyMembership {
  source_type: CaseMembershipSourceType;
  source_id: string;
  role: string | null;
  confidence: number | null;
  reason: string | null;
  user_locked: boolean;
}

export interface CaseAssemblyDecision {
  id: string;
  topic: string;
  decision: string;
  reasoning: string | null;
  confidence: number | null;
  event_date: string | null;
}

export interface CaseAssemblyTimelineEvent {
  event_id: string;
  event_type: string;
  entity_id: string;
  role: string | null;
  observed_at: string;
  summary: string;
  details: string | null;
}

export interface CaseAssemblyObservation {
  observation_id: string;
  surface_form: string;
  source_locator: string;
  timestamp_observed: string;
}

export interface CaseAssemblyCorrection {
  correction_id: string;
  target_kind: CaseCorrectionTargetKind;
  target_ref: Record<string, unknown>;
  new_value_json: string;
  reason: string;
  applied_at: string;
}

export interface CaseAssemblyLinkedCase {
  case_id: string;
  relation: 'merged_from' | 'split_into' | 'wikilink';
}

export interface WikiPageAssemblySnapshot {
  title: string | null;
  content: string | null;
  confidence: CaseConfidence | null;
  compiled_at: string | null;
}

export interface CaseAssembly {
  case_id: string;
  current_wiki_path: string | null;
  wiki_page: WikiPageAssemblySnapshot | null;
  case_truth: {
    title: string;
    status: CaseTruthStatus;
    status_reason: string | null;
    primary_actors: CasePrimaryActor[];
    blockers: CaseBlocker[];
    last_activity_at: string | null;
    confidence: CaseConfidence | null;
    canonical_case_id: string | null;
    split_from_case_id: string | null;
  } | null;
  memberships: CaseAssemblyMembership[];
  timeline_events: CaseAssemblyTimelineEvent[];
  decisions: CaseAssemblyDecision[];
  recent_evidence: CaseAssemblyObservation[];
  active_corrections: CaseAssemblyCorrection[];
  linked_cases: CaseAssemblyLinkedCase[];
  resolved_via_case_id?: string;
  // Phase 3 additive extensions (optional so existing consumers keep
  // working; populated when the case-first substrate is present).
  case_links?: Array<{
    link_id: string;
    case_id_from: string;
    case_id_to: string;
    link_type: string;
    created_at: string;
    created_by: string;
    confidence: number | null;
    reason_json: string | null;
    source_kind: string;
    source_ref: string | null;
  }>;
  promoted_sources?: {
    canonical_decision_id: string | null;
    canonical_event_id: string | null;
    promoted_at: string | null;
    promoted_by: string | null;
    promotion_reason: string | null;
  } | null;
  freshness?: {
    freshness_score: number | null;
    freshness_state: string | null;
    freshness_score_is_drifted: 0 | 1;
    freshness_drift_threshold: number | null;
    freshness_checked_at: string | null;
    freshness_reason_json: string | null;
  } | null;
  membership_explanations?: Record<string, Record<string, unknown>>;
}

export interface CanonicalCaseResolution {
  terminal_case_id: string;
  chain: string[];
  resolved_via_case_id: string | null;
}

export interface CaseTimelineRangeInput {
  case_id: string;
  from?: string | number;
  to?: string | number;
  order?: 'asc' | 'desc';
  limit?: number;
  include_connector_enrichments?: boolean;
}

export interface CaseTimelineRangeItem {
  item_type: CaseMembershipSourceType;
  source_type: CaseMembershipSourceType;
  source_id: string;
  source_locator: string | null;
  event_datetime: number | null;
  event_date: string | null;
  title: string | null;
  summary: string | null;
  role: string | null;
  confidence: number | null;
  membership_reason: string | null;
  connector_event?: {
    event_index_id: string;
    source_connector: string;
    source_id: string;
    source_locator: string | null;
    artifact_locator: string | null;
    title: string | null;
    content: string;
    event_datetime: number | null;
    event_date: string | null;
  } | null;
}

export interface CaseTimelineRangeResult {
  terminal_case_id: string;
  resolved_via_case_id: string | null;
  chain: string[];
  items: CaseTimelineRangeItem[];
}
