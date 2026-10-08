import type { ErasedRecord } from '../identity/erased-record.js';
import type { MemoryEventRecord, MemoryScopeRef } from './types.js';
import type { TwinRef } from '../knowledge/twin-edge-types.js';

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

/**
 * What a revision sets on a piece of work.
 *
 * The core reads exactly three of these: the date fields, because a commitment's due
 * time is something it reasons about. Everything else round-trips as JSON through
 * `set_json` and is never destructured here -- it is one product's board vocabulary
 * (status, priority, assignee, resolution) and the product's own action schema is
 * where it is spelled out and checked.
 */
export interface OwnerWorkPatch {
  dueAt?: string | null;
  deadline?: string | null;
  /**
   * The offset (minutes from UTC, -840..840) a bare `deadline`'s day starts in.
   * Pairs with the date fields: an exact `dueAt` derives it, a bare deadline
   * may state it alone. Absent means the owner's zone answers.
   */
  deadlineOffsetMinutes?: number | null;
  [field: string]: JsonValue | undefined;
}

/**
 * The named lifecycle judgments an owner row accepts. A reclassification is a
 * revision whose status and resolutionKind are the SAME statement: completed
 * work and an item that was never a task must not close identically.
 */
export const WORK_RECLASSIFY_DISPOSITIONS = [
  'completed_evidence',
  'completed_no_issue',
  'non_task_record',
  'non_task_memory',
  'reopen',
] as const;
export type WorkReclassifyDisposition = (typeof WORK_RECLASSIFY_DISPOSITIONS)[number];

export type WorkAssignment = {
  set?: OwnerWorkPatch;
  clear?: Array<keyof OwnerWorkPatch>;
} & (
  | {
      operation: 'create';
      /**
       * Import vocabulary: the identity this work already had in a predecessor
       * store. A migration that brings existing owner rows into the commitment
       * log names their task id and revision so the log keeps the row's number
       * and CAS history instead of minting a new identity. Absent for work
       * first stated through this command log.
       */
      imported?: { rowId: number; revision?: number; createdAt?: number };
    }
  | { operation: 'revise'; commitmentId: string; expectedRevision?: number }
  | { operation: 'withdraw'; commitmentId: string; expectedRevision: number }
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
   * declared before the scope-checked `replaces` command field.
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

export type IdentityCorrectionAssignment = {
  edgeId: string;
  endpoint: 'from' | 'to';
} & (
  | { targetNodeId: string | null; targetClientKey?: never }
  | { targetClientKey: string; targetNodeId?: never }
);

export type IdentityCorrection = {
  commandId: string;
  expectedRevision: number;
  reason: string;
  scopes?: MemoryScopeRef[];
  evidence?: ReadonlyArray<{ kind: 'observation'; id: string }>;
} & (
  | { operation: 'add_alias'; nodeId: string; alias: string }
  | { operation: 'merge'; survivorId: string; memberIds: readonly string[] }
  | {
      operation: 'split';
      parentId: string;
      children: ReadonlyArray<{
        clientKey?: string;
        name: string;
        aliases?: readonly string[];
      }>;
      assignments: readonly IdentityCorrectionAssignment[];
    }
  | {
      operation: 'assign_refs';
      parentId: string;
      assignments: readonly IdentityCorrectionAssignment[];
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
  view: 'overview' | 'browse' | 'neighbors' | 'timeline' | 'paths' | 'detail';
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
  | (ErasedRecord & { kind: 'memory' | 'observation' | 'raw' })
  | {
      kind: 'memory';
      recordKind: 'legacy' | 'judgment' | 'commitment';
      /** Stored classification, independent of the graph reference kind. */
      memoryKind?: string | null;
      topic: string;
      summary: string;
      recordedAt: number;
      appliesFrom: number | null;
      appliesUntil: number | null;
      stateAtSnapshot: 'current' | 'replaced' | 'withdrawn' | 'not_yet_effective' | 'expired';
      replaces: string[];
      payload: Record<string, JsonValue>;
      /** The commitment this record is a revision of, when it is one. */
      work: {
        commitmentId: string;
        rowId: number;
        revision: number;
        latestJudgmentRef: WorkReference;
      } | null;
      /**
       * Whether `summary` holds the whole selected section text. When it does not,
       * `nextRead` is the same query with the offset advanced past what was returned.
       */
      content: { complete: boolean; nextRead: WorkGraphQuery | null };
    }
  | {
      kind: 'registry';
      nodeKind: 'item' | 'person' | 'client';
      name: string;
      parentId: string | null;
      visibleAliases: string[];
      identityRevision: number;
      visibleChildren: Array<{ kind: 'registry'; id: string; name: string }>;
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
