import type { MemoryEventRecord, MemoryScopeRef } from './types.js';
import type { TwinRef } from '../edges/types.js';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type WorkReference = TwinRef | { kind: 'registry' | 'observation'; id: string };
export type WorkRef = WorkReference;

export interface RecordLink {
  relation:
    | 'supersedes'
    | 'refines'
    | 'contradicts'
    | 'mentions'
    | 'derived_from'
    | 'builds_on'
    | 'debates'
    | 'synthesizes'
    | 'blocks'
    | 'next_action_for'
    | 'case_member'
    | 'amends';
  target: WorkReference;
  attrs?: { role?: string; slot?: string; [key: string]: JsonValue | undefined };
}

export interface OwnerWorkPatch {
  title?: string | null;
  description?: string | null;
  status?: string | null;
  priority?: string | null;
  dueAt?: string | null;
  deadline?: string | null;
  completionCriteria?: string | null;
  assigneeText?: string | null;
  latestEvent?: string | null;
  resolutionKind?: string | null;
  confirmed?: boolean | null;
  roles?: Array<{ person: { kind: 'registry'; id: string }; role: string }> | null;
  data?: Record<string, JsonValue> | null;
}

export type WorkAssignment = {
  set?: OwnerWorkPatch;
  clear?: Array<keyof OwnerWorkPatch>;
} & (
  | { operation: 'create' }
  | { operation: 'revise' | 'withdraw'; commitmentId: string; expectedRevision: number }
);

/**
 * Legacy decisions-row fields that public save adapters keep projecting. These
 * columns remain the read model for existing recall/provenance surfaces until
 * the readers migrate to the command log.
 */
export interface JudgmentRecordFields {
  kind?: string | null;
  status?: string | null;
  summary?: string | null;
  isStatic?: number | null;
  userInvolvement?: string | null;
  sessionId?: string | null;
  needsValidation?: number | null;
  trustContext?: string | null;
  refinedFrom?: string[] | null;
  /**
   * Legacy `decisions.supersedes` column for records whose predecessor was
   * declared through the supersedeTargets projection rather than the
   * scope-checked `replaces` command field.
   */
  supersedes?: string | null;
}

/**
 * Append-only correction to an existing memory row's projection columns. The
 * judgment record stays the authority; the named columns on the target row are
 * the maintained projection that current readers consume.
 */
export interface JudgmentAmendment {
  target: { kind: 'memory'; id: string };
  outcome?: string | null;
  failureReason?: string | null;
  limitation?: string | null;
  status?: string | null;
  confidence?: number | null;
  durationDays?: number | null;
  supersedes?: string | null;
  supersededBy?: string | null;
}

/** Provenance carried onto the record's memory_events row. */
export interface JudgmentEventMeta {
  eventType?: MemoryEventRecord['event_type'];
  actor?: MemoryEventRecord['actor'];
  sourceTurnId?: string;
  reason?: string;
  evidenceRefs?: string[];
}

/**
 * Compatibility projections the command applies inside the same transaction so
 * pre-command readers keep working. None of these create authority beyond the
 * command itself; they mirror what the legacy writers used to persist inline.
 */
export interface JudgmentProjections {
  /** Legacy decision_edges rows kept in sync for recall readers. `fromId`
   * defaults to the appended record; amendment commands may name another row. */
  decisionEdges?: Array<{
    fromId?: string;
    targetId: string;
    relationship: string;
    reason?: string | null;
    weight?: number;
    createdBy?: string;
    approvedByUser?: number | null;
  }>;
  /**
   * Rows the command marks as superseded by the appended record. This mirrors
   * the legacy save surface where an unsigned caller's explicit `supersedes`
   * relationship moved the named target out of current truth; the command
   * boundary keeps `replaces` for scope-admitted supersession instead.
   */
  supersedeTargets?: string[];
  /** Registry record identity binding (item + actors). */
  recordIdentity?: {
    itemId?: string | null;
    actors?: Array<{ personId: string; role: string }>;
  };
}

export interface JudgmentCommand {
  commandId: string;
  topic: string;
  summary: string;
  reasoning?: string;
  recordKind: 'judgment' | 'commitment';
  payload?: Record<string, JsonValue>;
  appliesFrom?: number;
  appliesUntil?: number;
  links?: RecordLink[];
  replaces?: Array<{ id: string; reason: string }>;
  work?: WorkAssignment;
  scopes?: MemoryScopeRef[];
  /** Confidence supplied by the caller; no synthesis happens here. */
  confidence?: number;
  /** ISO 8601 YYYY-MM-DD for when the recorded event actually occurred. */
  eventDate?: string | null;
  /** Milliseconds epoch for when the recorded event actually occurred. */
  eventDatetime?: number | null;
  outcome?: string | null;
  failureReason?: string | null;
  limitation?: string | null;
  evidence?: string | string[] | null;
  alternatives?: string | string[] | null;
  risks?: string | null;
  /** Source references carried from normalized write provenance. */
  sourceRefs?: string[];
  /** Compact provenance record persisted on the decision row. */
  provenance?: Record<string, JsonValue>;
  /**
   * Authored record agent. Absent means the access principal writes the record;
   * an explicit null keeps the column empty for honest unsigned writes.
   */
  agentId?: string | null;
  modelRunId?: string | null;
  envelopeHash?: string | null;
  gatewayCallId?: string | null;
  /** Domain capture time for the record (decisions.created_at). */
  recordedAt?: number;
  /** Legacy decisions-row projection fields. */
  record?: JudgmentRecordFields;
  /** Append-only amendments applied to existing memory rows in-transaction. */
  amends?: JudgmentAmendment[];
  /** Memory event metadata for the record's save event. */
  event?: JudgmentEventMeta;
  /** Legacy compatibility projections written in the same transaction. */
  projections?: JudgmentProjections;
}

export interface JudgmentReceipt {
  status: 'committed';
  recordId: string;
  commandId: string;
  edgeIds: string[];
  watermark: number;
  work?: { commitmentId: string; revision: number };
  diagnostics: Array<{ stage: string; code: string; message: string }>;
}

export type IdentityCorrection = {
  commandId: string;
  expectedRevision: number;
  reason: string;
  scopes?: MemoryScopeRef[];
  evidence?: Array<{ kind: 'observation'; id: string }>;
} & (
  | { operation: 'add_alias'; nodeId: string; alias: string }
  | { operation: 'merge'; survivorId: string; memberIds: string[] }
  | {
      operation: 'split';
      parentId: string;
      children: Array<{ clientKey: string; name: string; aliases?: string[] }>;
      assignments: Array<{ edgeId: string; endpoint: 'from' | 'to'; childKey: string }>;
    }
  | {
      operation: 'assign_refs';
      parentId: string;
      assignments: Array<{
        edgeId: string;
        endpoint: 'from' | 'to';
        targetNodeId: string | null;
      }>;
    }
);

export interface IdentityCorrectionReceipt {
  commandId: string;
  identityRevision: number;
  children: Array<{ clientKey: string; ref: { kind: 'registry'; id: string } }>;
  changedSlots: Array<{ edgeId: string; endpoint: 'from' | 'to' }>;
  unresolved: Array<{ edgeId: string; endpoint: 'from' | 'to' }>;
}

export interface WorkGraphQuery {
  seeds?: WorkReference[];
  search?: { text: string; kinds?: WorkReference['kind'][] };
  view: 'overview' | 'neighbors' | 'timeline' | 'paths' | 'detail';
  section?: 'summary' | 'reasoning' | 'payload';
  textOffset?: number;
  textLimit?: number;
  from?: WorkReference;
  to?: WorkReference;
  maxDepth?: number;
  direction?: 'in' | 'out' | 'both';
  relations?: string[];
  history?: 'current' | 'all';
  eventRange?: { start?: number; end?: number };
  recordedRange?: { start?: number; end?: number };
  asOf?: number;
  limit?: number;
  cursor?: string;
}

export type WorkGraphNodeData =
  | {
      kind: 'memory';
      recordKind: 'legacy' | 'judgment' | 'commitment';
      topic: string;
      summary: string;
      recordedAt: number;
      appliesFrom: number | null;
      appliesUntil: number | null;
      stateAtSnapshot: 'current' | 'replaced' | 'withdrawn' | 'not_yet_effective' | 'expired';
      replaces: string[];
      payload: Record<string, JsonValue>;
    }
  | {
      kind: 'registry';
      nodeKind: 'item' | 'person' | 'client';
      name: string;
      visibleAliases: string[];
      identityRevision: number;
      visibleChildren: Array<{ kind: 'registry'; id: string }>;
      unresolvedSlots: Array<{ edgeId: string; endpoint: 'from' | 'to' }>;
    }
  | {
      kind: 'observation';
      connector: string;
      sourceId: string;
      sourceAt: number | null;
      observedAt: number;
      contentHash: string;
    }
  | {
      kind: 'case' | 'entity' | 'report' | 'edge' | 'raw';
      data: Record<string, JsonValue>;
    };

export interface WorkGraphPage {
  nodes: Array<{
    ref: WorkReference;
    resolvedRef: WorkReference;
    label: string;
    data: WorkGraphNodeData;
  }>;
  edges: Array<{
    id: string;
    relation: string;
    from: WorkReference;
    to: WorkReference;
    resolvedFrom: WorkReference;
    resolvedTo: WorkReference;
    attrs: JsonValue;
  }>;
  coverage: { returned: number; total: number | null; complete: boolean; reasons: string[] };
  snapshot: { judgmentWatermark: number; identityRevision: number; asOf: number };
  nextCursor: string | null;
}
