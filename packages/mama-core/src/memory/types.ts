export const MEMORY_SCOPE_KINDS = ['global', 'user', 'channel', 'project'] as const;
export type MemoryScopeKind = (typeof MEMORY_SCOPE_KINDS)[number];

export const MEMORY_KINDS = ['decision', 'preference', 'constraint', 'lesson', 'fact'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_STATUSES = ['active', 'superseded', 'contradicted', 'stale'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_TRUTH_STATUSES = [
  'active',
  'superseded',
  'contradicted',
  'stale',
  'quarantined',
] as const;
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

export const MEMORY_AUDIT_ACK_STATUSES = ['applied', 'skipped', 'failed'] as const;
export type MemoryAuditAckStatus = (typeof MEMORY_AUDIT_ACK_STATUSES)[number];

export interface MemoryScopeRef {
  kind: MemoryScopeKind;
  id: string;
}

export interface MemoryRecord {
  id: string;
  topic: string;
  kind: MemoryKind;
  summary: string;
  details: string;
  confidence: number;
  status: MemoryStatus;
  scopes: MemoryScopeRef[];
  source: {
    package: 'mama-core' | 'mcp-server' | 'standalone' | 'claude-code-plugin';
    source_type: string;
    user_id?: string;
    channel_id?: string;
    project_id?: string;
  };
  created_at: number | string;
  updated_at: number | string;
  /** ISO 8601 date when the event actually occurred (e.g. "2023-01-15"). Null if not set. */
  event_date?: string | null;
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
  graph_context: {
    primary: MemoryRecord[];
    expanded: MemoryRecord[];
    edges: MemoryEdge[];
  };
  search_meta: {
    query: string;
    scope_order: MemoryScopeKind[];
    retrieval_sources: string[];
  };
}

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
    | 'notice_sent';
  actor: 'memory_agent' | 'main_agent' | 'user' | 'system';
  source_turn_id?: string;
  memory_id?: string;
  topic?: string;
  scope_refs: MemoryScopeRef[];
  evidence_refs?: string[];
  reason?: string;
  created_at: number;
}

export interface AuditFindingRecord {
  finding_id: string;
  kind: 'wrong_direction' | 'memory_conflict' | 'stale_memory' | 'unsupported_claim';
  severity: 'low' | 'medium' | 'high';
  summary: string;
  evidence_refs: string[];
  affected_memory_ids: string[];
  recommended_action: string;
  status: 'open' | 'notified' | 'resolved' | 'dismissed';
  created_at: number;
  resolved_at?: number;
}

export interface MemoryAuditAck {
  status: MemoryAuditAckStatus;
  action: MemoryAgentAction;
  event_ids: string[];
  reason?: string;
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

export interface MemoryAgentBootstrap {
  current_goal?: string;
  scope_context: MemoryScopeRef[];
  channel_summary_markdown?: string;
  truth_snapshot: Array<{
    id: string;
    topic: string;
    summary: string;
    trust_score: number;
  }>;
  open_audit_findings: Array<{
    id: string;
    kind: string;
    severity: string;
    summary: string;
  }>;
  recent_memory_events: Array<{
    id: string;
    type: string;
    topic?: string;
    created_at: number;
  }>;
  profile_snapshot?: {
    static: Array<{ id: string; summary: string }>;
    dynamic: Array<{ id: string; summary: string }>;
  };
  main_agent_state?: {
    active_goal?: string;
    active_channel?: string;
    active_user?: string;
  };
}

export interface MemoryTruthRow {
  memory_id: string;
  topic: string;
  kind?: MemoryKind;
  truth_status: MemoryTruthStatus;
  effective_summary: string;
  effective_details: string;
  trust_score: number;
  scope_refs: MemoryScopeRef[];
  supporting_event_ids: string[];
  superseded_by?: string;
  contradicted_by?: string[];
  created_at?: number;
  updated_at?: number;
}

export interface ChannelSummaryRecord {
  channel_key: string;
  summary_markdown: string;
  delta_hash?: string;
  updated_at: number;
}

export interface ChannelSummaryStateDecision {
  memory_id: string;
  topic: string;
  summary: string;
  updated_at: number;
}

export interface ChannelSummaryStateMilestone {
  topic: string;
  action: MemoryAgentAction;
  summary: string;
  timestamp: number;
  memory_id?: string;
}

export interface ChannelSummaryAuditOutcome {
  topic: string;
  status: MemoryAuditAckStatus;
  reason?: string;
  timestamp: number;
}

export interface ChannelSummaryStateRecord {
  channel_key: string;
  active_topic?: string;
  active_decisions: ChannelSummaryStateDecision[];
  recent_milestones: ChannelSummaryStateMilestone[];
  recent_audit_outcomes: ChannelSummaryAuditOutcome[];
  state_hash: string;
  updated_at: number;
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

export function createEmptyMemoryAgentBootstrap(
  input: Pick<MemoryAgentBootstrap, 'scope_context'> &
    Partial<Omit<MemoryAgentBootstrap, 'scope_context'>>
): MemoryAgentBootstrap {
  return {
    current_goal: input.current_goal,
    scope_context: input.scope_context,
    channel_summary_markdown: input.channel_summary_markdown,
    truth_snapshot: input.truth_snapshot ?? [],
    open_audit_findings: input.open_audit_findings ?? [],
    recent_memory_events: input.recent_memory_events ?? [],
    profile_snapshot: input.profile_snapshot,
    main_agent_state: input.main_agent_state,
  };
}

export function createMemoryAuditAck(
  input: Pick<MemoryAuditAck, 'status' | 'action' | 'event_ids'> & Partial<MemoryAuditAck>
): MemoryAuditAck {
  return {
    status: input.status,
    action: input.action,
    event_ids: input.event_ids,
    reason: input.reason,
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
  source: {
    package: 'mama-core' | 'mcp-server' | 'standalone' | 'claude-code-plugin';
    source_type: string;
    user_id?: string;
    channel_id?: string;
    project_id?: string;
  };
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
