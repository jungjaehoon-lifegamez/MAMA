import type { MemoryScopeRef } from '../memory/types.js';

export const CONTEXT_REF_KINDS = ['memory', 'raw', 'entity', 'case'] as const;
export type ContextRefKind = (typeof CONTEXT_REF_KINDS)[number];

export const UNSUPPORTED_CONTEXT_REF_KINDS = [
  'decision',
  'wiki_page',
  'context_packet',
  'report',
] as const;
export type UnsupportedContextRefKind = (typeof UNSUPPORTED_CONTEXT_REF_KINDS)[number];

export type ContextRef =
  | { kind: 'memory'; id: string }
  | {
      kind: 'raw';
      raw_id: string;
      connector: string;
      source_id?: string;
      channel_id?: string | null;
    }
  | { kind: 'entity'; id: string }
  | { kind: 'case'; id: string };

export interface ContextRange {
  start_ms?: number;
  end_ms?: number;
}

export interface ContextProjectRef {
  kind: 'project';
  id: string;
}

export interface ContextCompileInput {
  task: string;
  scopes?: MemoryScopeRef[];
  seed_refs?: ContextRef[];
  connectors?: string[];
  project_refs?: ContextProjectRef[];
  tenant_id?: string | null;
  range?: ContextRange;
  as_of?: string | number | null;
  limit?: number;
  max_tool_calls?: number;
  max_ms?: number;
  max_tokens?: number;
  strictness?: 'recall' | 'balanced' | 'strict' | 'low' | 'medium' | 'high';
}

export interface ContextBoundary {
  scopes?: MemoryScopeRef[];
  connectors?: string[];
  project_refs?: ContextProjectRef[];
  tenant_id?: string | null;
  as_of?: string | number | null;
  range?: ContextRange;
}

export interface CanonicalContextScopes {
  scopes: MemoryScopeRef[];
  scopeJson: string;
  scopeHash: string;
}

export interface ContextVisibility {
  scopes: MemoryScopeRef[];
  scope_json: string;
  scope_hash: string;
  connectors: string[];
  project_refs: ContextProjectRef[];
  tenant_id: string | null;
  as_of: string | number | null;
  range: ContextRange | null;
}

export interface ContextEvidence {
  ref: ContextRef;
  title?: string;
  excerpt?: string;
  score?: number;
  reasons?: string[];
  retrieval_diagnostics?: unknown;
}

export interface ContextPacket {
  packet_id: string;
  mode: 'general';
  task: string;
  scopes: MemoryScopeRef[];
  scope_hash: string;
  generated_at: string;
  range: ContextRange | null;
  as_of: string | number | null;
  compiler_version: string;
  source_refs: ContextRef[];
  selected_evidence: ContextEvidence[];
  evidence_clusters: unknown[];
  related_decisions: unknown[];
  rejected_refs: ContextRef[];
  rejected_refs_truncated: boolean;
  rejected_summary: string[];
  missing_context: string[];
  caveats: string[];
  expansion_trace: unknown[];
  retrieval_diagnostics: unknown;
  budget: {
    max_tool_calls?: number;
    used_tool_calls: number;
    max_ms?: number;
    elapsed_ms: number;
    max_tokens?: number;
    estimated_tokens: number;
    budget_exhausted: boolean;
  };
  budget_manifest: {
    budget_exhausted: boolean;
    skipped_operators: string[];
  };
}

export interface ContextPacketRecord {
  packet_id: string;
  task: string;
  packet_json: string;
  packet: ContextPacket;
  scope_json: string;
  scopes: MemoryScopeRef[];
  scope_hash: string;
  envelope_hash: string;
  model_run_id: string;
  agent_id: string;
  input_snapshot_ref: string;
  source_refs_json: string;
  source_refs: ContextRef[];
  tenant_id: string;
  project_id: string;
  memory_scope_kind: MemoryScopeRef['kind'];
  memory_scope_id: string;
  created_at: number;
}

export interface TrustedContextPacketLookupInput {
  packetId: string;
  envelopeHash: string;
  modelRunId?: string;
  callerModelRunId?: string;
  includeFailed?: boolean;
}
