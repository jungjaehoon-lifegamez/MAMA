import type { DatabaseAdapter } from '../db-manager.js';
import type { EntityAlias, EntityAliasLabelType, EntityNode } from '../entities/types.js';
import type {
  TwinEdgeRecord,
  TwinEdgeType,
  TwinProjectRef,
  TwinRef,
  TwinScopeRef,
} from '../edges/types.js';

export type AgentGraphAdapter = Pick<DatabaseAdapter, 'prepare' | 'transaction'>;

export interface AgentGraphEdgeFilters {
  edge_types?: TwinEdgeType[];
}

export interface ResolveEntityInput {
  label: string;
  scopes?: TwinScopeRef[];
  connectors?: string[];
  project_refs?: TwinProjectRef[];
  tenant_id?: string | null;
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
  connectors?: string[];
  project_refs?: TwinProjectRef[];
  tenant_id?: string | null;
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
  connectors?: string[];
  project_refs?: TwinProjectRef[];
  tenant_id?: string | null;
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
  connectors?: string[];
  project_refs?: TwinProjectRef[];
  tenant_id?: string | null;
  edge_filters?: AgentGraphEdgeFilters;
  from_ms?: number;
  to_ms?: number;
  as_of_ms?: number | null;
  limit?: number;
}

export interface AgentGraphTimelineMemoryEvent {
  kind: 'memory';
  at_ms: number;
  ref: Extract<TwinRef, { kind: 'memory' }>;
  memory: {
    id: string;
    topic: string | null;
    decision: string | null;
    created_at: number;
    event_datetime: number | null;
  };
}

export interface AgentGraphTimelineCaseEvent {
  kind: 'case';
  at_ms: number;
  ref: Extract<TwinRef, { kind: 'case' }>;
  case: {
    case_id: string;
    title: string;
    status: string;
    created_at: string | number;
    updated_at: string | number;
    last_activity_at: string | null;
  };
}

export interface AgentGraphTimelineEntityEvent {
  kind: 'entity';
  at_ms: number;
  ref: Extract<TwinRef, { kind: 'entity' }>;
  entity: EntityNode;
}

export interface AgentGraphTimelineRawEvent {
  kind: 'raw';
  at_ms: number;
  ref: Extract<TwinRef, { kind: 'raw' }>;
  raw: {
    event_index_id: string;
    source_connector: string;
    source_type: string;
    source_id: string;
    source_locator: string | null;
    title: string | null;
    event_datetime: number | null;
    source_timestamp_ms: number;
  };
}

export interface AgentGraphTimelineEdgeEvent {
  kind: 'edge';
  at_ms: number;
  edge: TwinEdgeRecord;
}

export type AgentGraphTimelineEvent =
  | AgentGraphTimelineMemoryEvent
  | AgentGraphTimelineCaseEvent
  | AgentGraphTimelineEntityEvent
  | AgentGraphTimelineRawEvent
  | AgentGraphTimelineEdgeEvent;

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
  source_refs?: TwinRef[];
  agent_id: string;
  model_run_id: string;
  envelope_hash: string;
  request_idempotency_key?: string;
  edge_idempotency_key?: string;
  scopes?: TwinScopeRef[];
  connectors?: string[];
  project_refs?: TwinProjectRef[];
  tenant_id?: string | null;
}

export interface AttachEntityAliasWithEdgeResult {
  alias: EntityAlias;
  edge: TwinEdgeRecord;
}
