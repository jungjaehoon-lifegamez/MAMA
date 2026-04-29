import type { MemoryScopeRef } from '../memory/types.js';
import type { TwinRef } from '../edges/types.js';

export type SituationFocus = 'decisions' | 'risks' | 'open_questions' | 'cases' | 'raw';

export type SituationRefKind = TwinRef['kind'] | 'memory';

export interface SituationRef {
  kind: SituationRefKind;
  id: string;
}

export interface SituationProjectRef {
  kind: 'project';
  id: string;
}

export interface AgentSituationEffectiveFilters {
  scopes: MemoryScopeRef[];
  connectors: string[];
  project_refs: SituationProjectRef[];
  tenant_id: string;
  as_of?: string | null;
}

export interface AgentSituationCacheKeyInput extends AgentSituationEffectiveFilters {
  range_start_ms: number;
  range_end_ms: number;
  focus: SituationFocus[];
  limit: number;
  ranking_policy_version: string;
}

export interface AgentSituationCacheKeyResult {
  cacheKey: string;
  canonicalInput: AgentSituationCacheKeyInput;
  canonicalJson: string;
  filtersHash: string;
  scopeHash: string;
}

export type SituationCaveatCode =
  | 'connector_stale'
  | 'some_sources_unavailable'
  | 'low_confidence_visible_memory'
  | 'graph_api_unavailable_until_m6'
  | 'case_visibility_incomplete'
  | 'no_visible_sources';

export interface SituationSourceCoverage {
  connector?: string;
  channel_id?: string | null;
  memory_scope?: MemoryScopeRef;
  raw_count: number;
  memory_count: number;
  case_count: number;
  edge_count: number;
  last_seen: string | null;
  stale: boolean;
}

export interface SituationBriefing {
  decisions: string[];
  facts: string[];
  open_questions: string[];
  risks: string[];
}

export interface SituationRankedItem {
  ref: SituationRef;
  kind: string;
  score: number;
  reasons: string[];
  caveats: string[];
}

export interface SituationPendingHumanQuestion {
  memory_id: string;
  title: string;
  summary: string;
}

export interface SituationEntityCluster {
  label: string;
  entity_refs: Array<{ kind: 'entity'; id: string }>;
  source_refs: Array<{ kind: 'raw' | 'memory' | 'case'; id: string }>;
  caveats: string[];
}

export interface SituationRecommendedTool {
  tool: 'raw.search' | 'raw.searchAll' | 'raw.window' | 'memory.recall' | 'graph.neighborhood';
  args: Record<string, unknown>;
  reason: string;
  expected_refs: SituationRef[];
}

export interface AgentSituationPacket {
  packet_id: string;
  scope: MemoryScopeRef[];
  range_start: string;
  range_end: string;
  generated_at: string;
  freshness: Record<string, unknown>;
  source_coverage: SituationSourceCoverage[];
  briefing: SituationBriefing;
  ranked_items: SituationRankedItem[];
  top_memory_refs: string[];
  pending_human_questions: SituationPendingHumanQuestion[];
  entity_clusters: SituationEntityCluster[];
  recommended_next_tools: SituationRecommendedTool[];
  ranking_policy_version: string;
  ttl_seconds: number;
  generated_from_slice_ids: string[];
  caveats: string[];
  cache: {
    hit: boolean;
    cache_key: string;
    expires_at: string;
  };
}

export interface AgentSituationInput {
  scope: MemoryScopeRef[];
  range_start_ms: number;
  range_end_ms: number;
  focus: SituationFocus[];
  limit: number;
  effective_filters: AgentSituationEffectiveFilters;
  envelope_hash: string;
  agent_id: string;
  model_run_id: string;
  ranking_policy_version?: string;
  refresh?: boolean;
  now_ms?: number;
}

export interface AgentSituationPacketRecord {
  packet_id: string;
  cache_key: string;
  scope_json: string;
  scope: MemoryScopeRef[];
  scope_hash: string;
  range_start_ms: number;
  range_end_ms: number;
  focus_json: string;
  focus: SituationFocus[];
  envelope_hash: string;
  envelope_effective_filters_json: string;
  envelope_effective_filters: AgentSituationEffectiveFilters;
  envelope_effective_filters_hash: string;
  ranking_policy_version: string;
  generated_at: number;
  expires_at: number;
  ttl_seconds: number;
  freshness_json: string;
  freshness: Record<string, unknown>;
  source_coverage_json: string;
  source_coverage: SituationSourceCoverage[];
  briefing_json: string;
  briefing: SituationBriefing;
  ranked_items_json: string;
  ranked_items: SituationRankedItem[];
  top_memory_refs_json: string;
  top_memory_refs: string[];
  pending_human_questions_json: string;
  pending_human_questions: SituationPendingHumanQuestion[];
  entity_clusters_json: string;
  entity_clusters: SituationEntityCluster[];
  recommended_next_tools_json: string;
  recommended_next_tools: SituationRecommendedTool[];
  generated_from_slice_ids_json: string;
  generated_from_slice_ids: string[];
  caveats_json: string;
  caveats: string[];
  agent_id: string;
  model_run_id: string;
  input_snapshot_ref: string;
  source_refs_json: string;
  source_refs: SituationRef[];
  tenant_id: string;
  project_id: string;
  memory_scope_kind: MemoryScopeRef['kind'];
  memory_scope_id: string;
  created_at: number;
}

export interface AgentSituationLease {
  cache_key: string;
  ranking_policy_version: string;
  lease_owner: string;
  lease_expires_at: number;
  created_at: number;
}

export interface AgentSituationCandidate {
  ref: SituationRef;
  kind: string;
  title: string;
  summary: string;
  timestamp_ms: number;
  confidence?: number | null;
  status?: string | null;
  is_open_question?: boolean;
  has_debate_edge?: boolean;
  connector?: string | null;
  channel_id?: string | null;
  scope?: MemoryScopeRef | null;
}

export interface SituationScore {
  score: number;
  reasons: string[];
  caveats: string[];
}
