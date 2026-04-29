import type { Buffer } from 'node:buffer';

export const TWIN_REF_KINDS = ['memory', 'case', 'entity', 'report', 'edge', 'raw'] as const;
export type TwinRefKind = (typeof TWIN_REF_KINDS)[number];

export const TWIN_EDGE_SOURCES = ['agent', 'human', 'code'] as const;
export type TwinEdgeSource = (typeof TWIN_EDGE_SOURCES)[number];

export const TWIN_EDGE_TYPES = [
  'supersedes',
  'builds_on',
  'debates',
  'synthesizes',
  'mentions',
  'derived_from',
  'case_member',
  'alias_of',
  'next_action_for',
  'blocks',
] as const;
export type TwinEdgeType = (typeof TWIN_EDGE_TYPES)[number];

export type TwinRef = {
  [Kind in TwinRefKind]: {
    kind: Kind;
    id: string;
  };
}[TwinRefKind];

export type TwinEdgeSubjectRef = Exclude<TwinRef, { kind: 'raw' }>;

export interface TwinScopeRef {
  kind: 'global' | 'user' | 'channel' | 'project';
  id: string;
}

export interface TwinProjectRef {
  kind: string;
  id: string;
}

export interface TwinVisibility {
  scopes?: TwinScopeRef[];
  connectors?: string[];
  projectRefs?: TwinProjectRef[];
  tenantId?: string | null;
}

export interface InsertTwinEdgeInput {
  edge_id?: string;
  edge_type: TwinEdgeType;
  subject_ref: TwinEdgeSubjectRef;
  object_ref: TwinRef;
  relation_attrs?: unknown;
  confidence?: number;
  source: TwinEdgeSource;
  agent_id?: string;
  model_run_id?: string;
  envelope_hash?: string;
  request_idempotency_key?: string;
  edge_idempotency_key?: string;
  human_actor_id?: string;
  human_actor_role?: 'commander' | 'configurator_elevated';
  authority_scope_json?: unknown;
  reason_classification?:
    | 'factual_correction'
    | 'agent_inference_wrong'
    | 'privacy_redaction'
    | 'duplicate_merge'
    | 'state_override'
    | 'other';
  reason_text?: string;
  evidence_refs?: unknown;
}

export interface TwinEdgeRecord {
  edge_id: string;
  edge_type: TwinEdgeType;
  subject_ref: TwinRef;
  object_ref: TwinRef;
  relation_attrs_json: string | null;
  relation_attrs: unknown | null;
  confidence: number;
  source: TwinEdgeSource;
  agent_id: string | null;
  model_run_id: string | null;
  envelope_hash: string | null;
  human_actor_id: string | null;
  human_actor_role: string | null;
  authority_scope_json: string | null;
  authority_scope: unknown | null;
  reason_classification: string | null;
  reason_text: string | null;
  evidence_refs_json: string | null;
  evidence_refs: unknown | null;
  request_idempotency_key: string | null;
  edge_idempotency_key: string | null;
  content_hash: Buffer;
  created_at: number;
}

export interface ListVisibleTwinEdgesOptions {
  scopes?: TwinScopeRef[];
  connectors?: string[];
  projectRefs?: TwinProjectRef[];
  tenantId?: string | null;
  edgeTypes?: TwinEdgeType[];
  asOfMs?: number | null;
  limit?: number;
}

type AssertFalse<T extends false> = T;
type IsAssignable<T, U> = T extends U ? true : false;
type RawSubjectRef = { kind: 'raw'; id: string };
type _RawSubjectRefIsNotAssignable = AssertFalse<
  IsAssignable<RawSubjectRef, InsertTwinEdgeInput['subject_ref']>
>;
