import type { MemoryScopeRef } from './types.js';
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
    | 'mentions'
    | 'derived_from'
    | 'builds_on'
    | 'debates'
    | 'synthesizes'
    | 'blocks'
    | 'next_action_for'
    | 'case_member';
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
  | { operation: 'create'; creationKey: string }
  | { operation: 'revise' | 'withdraw'; commitmentId: string; expectedRevision: number }
);

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
      recordKind: 'judgment' | 'commitment';
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
