import type { DatabaseAdapter } from '../db-manager.js';
import type { EntityAlias, EntityAliasLabelType, EntityNode } from '../entities/types.js';
import type { TwinEdgeRecord, TwinEdgeType, TwinRef, TwinScopeRef } from '../edges/types.js';

export type AgentGraphAdapter = Pick<DatabaseAdapter, 'prepare' | 'transaction'>;

export interface AgentGraphEdgeFilters {
  edge_types?: TwinEdgeType[];
}

export interface ResolveEntityInput {
  label: string;
  scopes?: TwinScopeRef[];
  context_refs?: TwinRef[];
  limit?: number;
  as_of_ms?: number | null;
}

export interface ResolvedEntityCandidate {
  entity: EntityNode;
  matched_label: string;
  match_source: 'preferred_label' | 'alias' | 'observation';
  score: number;
}

export interface ResolveEntityResult {
  entity: EntityNode | null;
  candidates: ResolvedEntityCandidate[];
}

export interface GraphNeighborhoodInput {
  ref: TwinRef;
  depth?: number;
  scopes?: TwinScopeRef[];
  edge_filters?: AgentGraphEdgeFilters;
  as_of_ms?: number | null;
  limit?: number;
}

export interface AgentGraphResult {
  nodes: TwinRef[];
  edges: TwinEdgeRecord[];
}

export interface GraphPathsInput {
  from_ref: TwinRef;
  to_ref: TwinRef;
  max_depth?: number;
  scopes?: TwinScopeRef[];
  edge_filters?: AgentGraphEdgeFilters;
  as_of_ms?: number | null;
  limit?: number;
}

export interface AgentGraphPath {
  refs: TwinRef[];
  edges: TwinEdgeRecord[];
}

export interface GraphPathsResult {
  paths: AgentGraphPath[];
}

export interface GraphTimelineInput {
  ref: TwinRef;
  scopes?: TwinScopeRef[];
  edge_filters?: AgentGraphEdgeFilters;
  from_ms?: number;
  to_ms?: number;
  as_of_ms?: number | null;
  limit?: number;
}

export interface AgentGraphTimelineEvent {
  kind: 'edge';
  at_ms: number;
  edge: TwinEdgeRecord;
}

export interface GraphTimelineResult {
  ref: TwinRef;
  events: AgentGraphTimelineEvent[];
}

export interface AttachEntityAliasWithEdgeInput {
  entity_id: string;
  label: string;
  label_type?: EntityAliasLabelType;
  lang?: string | null;
  script?: string | null;
  confidence?: number | null;
  source_type: string;
  source_ref?: string | null;
  agent_id: string;
  model_run_id: string;
  envelope_hash: string;
  edge_idempotency_key?: string;
  scopes?: TwinScopeRef[];
}

export interface AttachEntityAliasWithEdgeResult {
  alias: EntityAlias;
  edge: TwinEdgeRecord;
}
