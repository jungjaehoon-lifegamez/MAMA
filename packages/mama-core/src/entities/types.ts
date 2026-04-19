export const ENTITY_KINDS = ['project', 'person', 'organization', 'work_item'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const ENTITY_ALIAS_LABEL_TYPES = ['pref', 'alt', 'hidden', 'source_native'] as const;
export type EntityAliasLabelType = (typeof ENTITY_ALIAS_LABEL_TYPES)[number];

export const ENTITY_CANDIDATE_STATUSES = [
  'pending',
  'auto_merged',
  'approved',
  'rejected',
  'deferred',
] as const;
export type EntityCandidateStatus = (typeof ENTITY_CANDIDATE_STATUSES)[number];

export const ENTITY_MERGE_ACTION_TYPES = ['merge', 'reject', 'defer', 'split'] as const;
export type EntityMergeActionType = (typeof ENTITY_MERGE_ACTION_TYPES)[number];

export const ENTITY_SCOPE_KINDS = ['project', 'channel', 'user', 'global'] as const;
export type EntityScopeKind = (typeof ENTITY_SCOPE_KINDS)[number];

export const ENTITY_NODE_STATUSES = ['active', 'merged', 'archived'] as const;
export type EntityNodeStatus = (typeof ENTITY_NODE_STATUSES)[number];

export const ENTITY_ALIAS_STATUSES = ['active', 'suppressed'] as const;
export type EntityAliasStatus = (typeof ENTITY_ALIAS_STATUSES)[number];

export const ENTITY_OBSERVATION_TYPES = ['generic', 'author', 'channel'] as const;
export type EntityObservationType = (typeof ENTITY_OBSERVATION_TYPES)[number];

export const ENTITY_CANDIDATE_KINDS = ['alias_to_entity', 'entity_to_entity', 'cluster'] as const;
export type EntityCandidateKind = (typeof ENTITY_CANDIDATE_KINDS)[number];

export const ENTITY_ACTOR_TYPES = ['system', 'user', 'agent'] as const;
export type EntityActorType = (typeof ENTITY_ACTOR_TYPES)[number];

export const ENTITY_INGEST_RUN_STATUSES = ['running', 'complete', 'failed'] as const;
export type EntityIngestRunStatus = (typeof ENTITY_INGEST_RUN_STATUSES)[number];

export const ENTITY_INGEST_RUN_KINDS = ['live', 'replay', 'backfill'] as const;
export type EntityIngestRunKind = (typeof ENTITY_INGEST_RUN_KINDS)[number];

export const ENTITY_LINEAGE_CONTRIBUTION_KINDS = [
  'seed',
  'merge_adopt',
  'manual_attach',
  'rollback_restore',
] as const;
export type EntityLineageContributionKind = (typeof ENTITY_LINEAGE_CONTRIBUTION_KINDS)[number];

export const ENTITY_LINEAGE_STATUSES = ['active', 'superseded', 'rolled_back'] as const;
export type EntityLineageStatus = (typeof ENTITY_LINEAGE_STATUSES)[number];

export const ENTITY_LINEAGE_CAPTURE_MODES = ['direct', 'backfilled'] as const;
export type EntityLineageCaptureMode = (typeof ENTITY_LINEAGE_CAPTURE_MODES)[number];

export interface EntityNode {
  id: string;
  kind: EntityKind;
  preferred_label: string;
  status: EntityNodeStatus;
  scope_kind: EntityScopeKind;
  scope_id: string | null;
  merged_into: string | null;
  created_at: number;
  updated_at: number;
}

export interface EntityAlias {
  id: string;
  entity_id: string;
  label: string;
  normalized_label: string;
  lang: string | null;
  script: string | null;
  label_type: EntityAliasLabelType;
  source_type: string;
  source_ref: string | null;
  confidence: number | null;
  status: EntityAliasStatus;
  created_at: number;
}

export interface EntityObservation {
  id: string;
  observation_type: EntityObservationType;
  entity_kind_hint: EntityKind | null;
  surface_form: string;
  normalized_form: string;
  lang: string | null;
  script: string | null;
  context_summary: string | null;
  related_surface_forms: string[];
  timestamp_observed: number | null;
  scope_kind: EntityScopeKind;
  scope_id: string | null;
  extractor_version: string;
  embedding_model_version: string | null;
  source_connector: string;
  source_locator: string | null;
  source_raw_record_id: string;
  created_at: number;
}

export interface EntityResolutionCandidate {
  id: string;
  candidate_kind: EntityCandidateKind;
  left_ref: string;
  right_ref: string;
  status: EntityCandidateStatus;
  score_total: number;
  score_structural: number;
  score_string: number;
  score_context: number;
  score_graph: number;
  score_embedding: number;
  rule_trace: string | null;
  extractor_version: string;
  embedding_model_version: string | null;
  created_at: number;
  updated_at: number;
}

export interface EntityLink {
  id: string;
  from_entity_id: string;
  to_entity_id: string;
  relation_type: string;
  confidence: number;
  source_basis: string;
  created_at: number;
  updated_at: number;
}

export interface EntityTimelineEvent {
  id: string;
  entity_id: string;
  event_type: string;
  role?: string | null;
  valid_from: number | null;
  valid_to: number | null;
  observed_at: number | null;
  source_ref: string | null;
  summary: string;
  details: string | null;
  created_at: number;
}

export interface EntityMergeAction {
  id: string;
  action_type: EntityMergeActionType;
  source_entity_id: string | null;
  target_entity_id: string | null;
  candidate_id: string | null;
  actor_type: EntityActorType;
  actor_id: string | null;
  reason: string;
  evidence_json: string;
  created_at: number;
}

export interface EntityIngestRun {
  id: string;
  connector: string;
  run_kind: EntityIngestRunKind;
  status: EntityIngestRunStatus;
  scope_key: string;
  source_window_start: number | null;
  source_window_end: number | null;
  raw_count: number;
  observation_count: number;
  candidate_count: number;
  reviewable_count: number;
  audit_run_id: string | null;
  audit_classification: 'improved' | 'stable' | 'regressed' | 'inconclusive' | null;
  error_reason: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface EntityLineageLink {
  id: string;
  canonical_entity_id: string;
  entity_observation_id: string;
  source_entity_id: string | null;
  contribution_kind: EntityLineageContributionKind;
  run_id: string | null;
  candidate_id: string | null;
  review_action_id: string | null;
  status: EntityLineageStatus;
  capture_mode: EntityLineageCaptureMode;
  confidence: number;
  created_at: number;
  superseded_at: number | null;
}
