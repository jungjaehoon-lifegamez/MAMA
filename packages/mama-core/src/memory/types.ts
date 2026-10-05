import { createHash } from 'node:crypto';

import type { RecordActor } from '../registry/types.js';
import type { DecisionCorrection } from './decision-links.js';
import type { RecordLink } from './judgment-types.js';
import type {
  SearchHitDiagnostics,
  SearchQualityOptions,
  SearchStrictness,
} from '../knowledge/search-quality.js';

/**
 * The scope kinds this repository's own products happen to use.
 *
 * NOT the set of kinds that exist. A scope is a (kind, id) pair; the pair is the
 * core's, the vocabulary is the consumer's. These are exported so a product can
 * reuse a familiar word, and so nothing that already writes them has to change --
 * they are not a gate. A consumer with a kind of its own passes it and the core
 * carries it, because the core does not read the kind, it matches it.
 */
export const COMMON_MEMORY_SCOPE_KINDS = ['global', 'user', 'channel', 'project'] as const;
/** Kept as the old name for callers that import it; same list, still not a gate. */
export const MEMORY_SCOPE_KINDS = COMMON_MEMORY_SCOPE_KINDS;
export type MemoryScopeKind = string;

/**
 * What a memory can be.
 *
 * `task`, `schedule` and `compiled` were here and are not any more. Nothing writes
 * them -- no call site in either package, no row in the live database -- and they name
 * one product's board, cron and context-packet vocabulary rather than anything a
 * memory is. The stored kind check still accepts the retired task and schedule values;
 * adding a new kind needs a migration because that check constrains the column.
 */
export const MEMORY_KINDS = [
  'decision',
  'preference',
  'constraint',
  'lesson',
  'fact',
  'workflow',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryKindFilter = MemoryKind | [MemoryKind, ...MemoryKind[]];

export const MEMORY_STATUSES = ['active', 'superseded', 'contradicted', 'stale'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_TRUTH_STATUSES = ['active', 'superseded', 'contradicted', 'stale'] as const;
export type MemoryTruthStatus = (typeof MEMORY_TRUTH_STATUSES)[number];

export const MEMORY_EDGE_TYPES = ['supersedes', 'builds_on', 'synthesizes', 'contradicts'] as const;
export type MemoryEdgeType = (typeof MEMORY_EDGE_TYPES)[number];

export const MEMORY_AGENT_ACTIONS = [
  'save',
  'supersede',
  'contradict',
  'mark_stale',
  'quarantine',
  'no_op',
] as const;
export type MemoryAgentAction = (typeof MEMORY_AGENT_ACTIONS)[number];

export const MEMORY_CONSULT_INTENTS = [
  'bootstrap_session',
  'validate_claim',
  'get_relevant_truth',
  'check_conflicts',
  'explain_history',
] as const;
export type MemoryConsultIntent = (typeof MEMORY_CONSULT_INTENTS)[number];

export interface MemoryScopeRef {
  kind: MemoryScopeKind;
  id: string;
}

export interface MemorySourceRef {
  /**
   * Which package wrote this. A free string, not a union of the four packages that
   * happened to exist when it was written: a second product installing this core would
   * have had to be added to the core's own type before it could save anything.
   */
  package: string;
  source_type: string;
  user_id?: string;
  channel_id?: string;
  project_id?: string;
}

export interface MemoryRecord {
  id: string;
  topic: string;
  kind: MemoryKind;
  summary: string;
  details: string;
  /** One-line context that tells an agent when this guidance applies. */
  applies_when?: string;
  /** Ordered procedure steps for workflow records. */
  steps?: string[];
  /** Evidence checks a workflow must complete, in order. */
  evidence_checks?: string[];
  confidence: number;
  status: MemoryStatus;
  scopes: MemoryScopeRef[];
  source: MemorySourceRef;
  created_at: number | string;
  updated_at: number | string;
  /** ISO 8601 date when the event actually occurred (e.g. "2023-01-15"). Null if not set. */
  event_date?: string | null;
  /** Source event timestamp in milliseconds when known. Null if not set. */
  event_datetime?: number | null;
  /** Maintained outcome projection (SUCCESS | FAILED | PARTIAL | pending). Null when unset. */
  outcome?: string | null;
  /** On a record search expansion added: the hit it came from and the link it followed there. */
  reached_through?: MemoryReachedThrough;
  retrieval_diagnostics?: SearchHitDiagnostics;
}

export interface MemoryReachedThrough {
  /** The search hit the link starts from. */
  from: string;
  /** The link's relation as seen from that hit (`builds_on`, `built_on_by`, `supersedes_chain`, ...). */
  relation: string;
  /** The reason the agent gave for the link; null for the supersedes chain. */
  reason: string | null;
  /** Later links that contradict this one, each with its reason. */
  corrected_by?: DecisionCorrection[];
}

/**
 * Turns text into a vector for the semantic index. A null result is the explicit no-vector mode:
 * a record is written without a vector and a query searches by text only. A failure must throw.
 */
export interface MemoryEmbedder {
  embed(text: string, role: 'query' | 'passage'): Promise<Float32Array | null>;
}

export type RecallMemoryOptions = SearchQualityOptions & {
  kind?: MemoryKindFilter;
  scopes?: MemoryScopeRef[];
  includeProfile?: boolean;
  includeHistory?: boolean;
  skipGraphExpansion?: boolean;
  limit?: number;
  /**
   * The query's embedder; a consumer passes the one it writes with (`createKnowledge`), and one
   * that answers null searches by text only. Absent, recall uses the core's own embedder, which the
   * MCP server and MAMA OS rely on.
   */
  embedder?: MemoryEmbedder;
};

export interface RecallSearchDiagnostics {
  candidate_counts: {
    vector: number;
    lexical: number;
    graph_expanded: number;
    vector_only: number;
    rejected_by_strictness: number;
  };
  threshold: number;
  strictness: SearchStrictness;
}

export interface MemoryEdge {
  from_id: string;
  to_id: string;
  type: MemoryEdgeType;
  reason?: string;
}

export interface ProfileSnapshot {
  static: MemoryRecord[];
  dynamic: MemoryRecord[];
  evidence: Array<{
    memory_id: string;
    topic: string;
    why_included: string;
  }>;
}

export interface RecallBundle {
  profile: ProfileSnapshot;
  memories: MemoryRecord[];
  /**
   * Hits from a source outside the judgment log, when the caller asked for them.
   *
   * This was typed as the connector event index's row, which made the core's
   * recall bundle depend on a package three of four consumers do not install. The
   * shape is whatever the source produced; what the core states is that a hit is
   * ranked and scored.
   */
  connector_event_hits?: SourceSearchHit[];
  graph_context: {
    primary: MemoryRecord[];
    expanded: MemoryRecord[];
    edges: MemoryEdge[];
  };
  search_meta: {
    query: string;
    scope_order: MemoryScopeKind[];
    retrieval_sources: string[];
    diagnostics?: RecallSearchDiagnostics;
  };
}

/** A ranked hit from a source the core did not author. Its fields are the source's. */
export interface SourceSearchHit extends Record<string, unknown> {
  rank: number;
  score: number;
}

/** A search result: authored by the judgment log, or found in a source. */
export type MemorySearchResultHit = MemoryRecord | SourceSearchHit;

export interface MemoryEventRecord {
  event_id: string;
  event_type:
    | 'observed_conversation'
    | 'save'
    | 'supersede'
    | 'contradict'
    | 'mark_stale'
    | 'quarantine'
    | 'no_op'
    | 'audit_failed'
    | 'notice_sent'
    | 'provenance.empty_batch'
    | 'provenance.link_write_failed'
    | 'connector_event_index.retention_swept'
    | 'case.link_created'
    | 'case.link_revoked'
    | 'case.membership_pinned'
    | 'case.membership_unpinned'
    | 'case.source_promoted'
    | 'case.freshness_drifted'
    | 'automation.job.started'
    | 'automation.job.succeeded'
    | 'automation.job.failed'
    | 'automation.job.skipped_concurrent'
    | 'review.bulk.approved'
    | 'review.bulk.rejected'
    | 'review.bulk.deferred'
    | 'canary.drift.false_merge_rate'
    | 'canary.drift.projection_fragmentation_rate'
    | 'canary.drift.replay_stale'
    | 'auth.role_denied'
    | 'ontology.proposal'
    | 'ontology.approval'
    | 'repair.approval'
    | 'case.fast_write_applied'
    | 'case.fast_write_lock_skipped'
    | 'case.correction_applied'
    | 'case.correction_reverted'
    | 'case.correction_superseded'
    | 'case.membership_tombstoned'
    | 'case.merged'
    | 'case.split'
    | 'case.membership_matched'
    | 'case.membership_candidate';
  actor:
    | 'memory_agent'
    | 'main_agent'
    | 'user'
    | 'system'
    | `user:${string}`
    | `user_uuid:${string}`
    | `local:${string}`
    | `actor:${string}`
    | 'token:bearer';
  source_turn_id?: string;
  memory_id?: string;
  topic?: string;
  scope_refs: MemoryScopeRef[];
  evidence_refs?: string[];
  reason?: string;
  created_at: number;
}

export interface MemoryWriteProvenance {
  actor?: MemoryEventRecord['actor'];
  agent_id?: string;
  model_run_id?: string;
  envelope_hash?: string;
  tool_name?: string;
  gateway_call_id?: string;
  context_packet_id?: string;
  source_turn_id?: string;
  source_message_ref?: string;
  source_refs?: string[];
}

export interface MemoryProvenanceRecord {
  memory_id: string;
  agent_id: string | null;
  model_run_id: string | null;
  envelope_hash: string | null;
  gateway_call_id: string | null;
  source_refs: string[];
  provenance: Record<string, unknown>;
  latest_event?: MemoryEventRecord;
}

export interface PublicSaveMemoryInput {
  topic: string;
  kind: MemoryKind;
  summary: string;
  details: string;
  appliesWhen?: string;
  steps?: string[];
  evidenceChecks?: string[];
  confidence?: number;
  status?: MemoryStatus;
  scopes: MemoryScopeRef[];
  source: MemorySourceRef;
  excludeIds?: string[];
  eventDate?: string;
  eventDateTime?: number;
  entityObservationIds?: string[];
  itemId?: string | null;
  actors?: RecordActor[];
  /** Explicit, scope-checked relationships from this new judgment. */
  links?: RecordLink[];
  /** Earlier records this judgment explicitly replaces; matching topic is not enough. */
  replaces?: Array<{ id: string; reason: string }>;
}

export interface PublicIngestMemoryInput {
  content: string;
  scopes?: MemoryScopeRef[];
  source: MemorySourceRef;
  eventDate?: string;
  eventDateTime?: number;
}

export type PublicIngestConversationInput = IngestConversationInput;

export interface AuditFindingRecord {
  finding_id: string;
  kind:
    | 'wrong_direction'
    | 'memory_conflict'
    | 'stale_memory'
    | 'unsupported_claim'
    | 'memory_injection_suspect';
  severity: 'low' | 'medium' | 'high' | 'warn';
  summary: string;
  evidence_refs: string[];
  affected_memory_ids: string[];
  recommended_action: string;
  status: 'open' | 'notified' | 'resolved' | 'dismissed';
  created_at: number;
  resolved_at?: number;
}

export interface AuditNotice {
  type: 'direction_alert' | 'truth_conflict' | 'truth_update' | 'memory_warning';
  severity: 'low' | 'medium' | 'high';
  summary: string;
  evidence: Array<{ type: 'conversation' | 'memory' | 'event'; ref: string; excerpt?: string }>;
  recommended_action: 'recheck' | 'consult_memory' | 'avoid_claim' | 'use_truth_snapshot';
  relevant_memories: Array<{ id: string; topic: string; summary: string }>;
}

export interface MemoryConsultResult {
  status: 'ok' | 'conflict' | 'uncertain' | 'no_relevant_memory';
  summary: string;
  evidence: Array<{ type: 'memory' | 'event'; ref: string; excerpt?: string }>;
  truth_snapshot?: Array<{ id: string; topic: string; summary: string; status: string }>;
  recommended_action?: string;
}

export function createEmptyRecallBundle(query: string): RecallBundle {
  return {
    profile: {
      static: [],
      dynamic: [],
      evidence: [],
    },
    memories: [],
    graph_context: {
      primary: [],
      expanded: [],
      edges: [],
    },
    search_meta: {
      query,
      scope_order: ['project'],
      retrieval_sources: ['vector'],
    },
  };
}

// --- Conversation Extraction Types ---

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface IngestConversationInput {
  messages: ConversationMessage[];
  scopes: MemoryScopeRef[];
  source: MemorySourceRef;
  extract?: {
    enabled: boolean;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
  };
  /** Prefix for all topics created by this ingestion (e.g. "bench_questionId_") for data isolation */
  topicPrefix?: string;
  /**
   * ISO 8601 date string (e.g. "2023-01-15") representing when the conversation actually occurred.
   * When provided, all memories extracted from this ingestion will have their event_date set to this value.
   * Defaults to created_at (ingestion time) if omitted.
   */
  sessionDate?: string;
}

export interface ExtractedMemoryUnit {
  kind: MemoryKind;
  topic: string;
  summary: string;
  details: string;
  confidence: number;
}

export interface IngestConversationResult {
  rawId: string;
  extractedMemories: Array<{ id: string; kind: MemoryKind; topic: string }>;
}

// --- Scope identity -------------------------------------------------------------
//
// Two scope lists naming the same scopes are the same list. The order and the hash below
// are what makes that true, so they live with the type rather than with any one reader.

const SCOPE_ORDER = new Map([
  ['project', 0],
  ['channel', 1],
  ['user', 2],
  ['global', 3],
]);

function assertScope(scope: MemoryScopeRef): MemoryScopeRef {
  // A kind is nonblank text. Which kinds exist is the consumer's statement, not a
  // list kept here -- this used to compare against COMMON_MEMORY_SCOPE_KINDS, so a
  // consumer whose world had a kind of its own could not store one.
  if (typeof scope.kind !== 'string' || scope.kind.trim().length === 0) {
    throw new Error(`Memory scope kind must be nonblank text, got: ${String(scope.kind)}`);
  }
  const id = scope.id.trim();
  if (id.length === 0) {
    throw new Error('Memory scope id must not be empty');
  }
  return { kind: scope.kind, id };
}

function scopeKey(scope: MemoryScopeRef): string {
  return `${scope.kind}\0${scope.id}`;
}

function sortScopes(scopes: MemoryScopeRef[]): MemoryScopeRef[] {
  return [...scopes].sort((left, right) => {
    const orderDiff = (SCOPE_ORDER.get(left.kind) ?? 4) - (SCOPE_ORDER.get(right.kind) ?? 4);
    if (orderDiff !== 0) {
      return orderDiff;
    }
    return left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
  });
}

export function canonicalizeContextScopes(scopes: readonly MemoryScopeRef[] | undefined): {
  scopes: MemoryScopeRef[];
  scopeJson: string;
  scopeHash: string;
} {
  const unique = new Map<string, MemoryScopeRef>();
  for (const scope of scopes ?? []) {
    const normalized = assertScope(scope);
    unique.set(scopeKey(normalized), normalized);
  }
  const canonicalScopes = sortScopes([...unique.values()]);
  const scopeJson = JSON.stringify(canonicalScopes);
  const scopeHash = createHash('sha256').update(scopeJson).digest('hex');
  return {
    scopes: canonicalScopes,
    scopeJson,
    scopeHash,
  };
}
