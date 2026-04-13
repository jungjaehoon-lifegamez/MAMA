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
  source_raw_db_ref: string | null;
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
