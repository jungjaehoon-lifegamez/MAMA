export interface TemporalWorkContext {
  attemptId: number;
  generationKey: string;
  taskId: number;
  temporalEpoch: number;
  occurrenceKey: string;
  checkAt: number;
  revision: number;
  sourceChannel: string | null;
  sourceEventId: string | null;
}

interface TemporalReconcileBase {
  expected_revision: number;
  reason: string;
}

export interface TemporalResolvedInput extends TemporalReconcileBase {
  outcome: 'resolved';
  status?: 'pending' | 'in_progress' | 'review' | 'blocked' | 'done' | 'cancelled';
  due_at?: string | null;
}

export interface TemporalFinalNoUpdateInput extends TemporalReconcileBase {
  outcome: 'final_no_update';
  evidence_summary: string;
}

export interface TemporalDeferredInput extends TemporalReconcileBase {
  outcome: 'deferred';
  next_temporal_check_at: string;
}

export type TemporalReconcileInput =
  | TemporalResolvedInput
  | TemporalFinalNoUpdateInput
  | TemporalDeferredInput;

export interface TemporalEffectReceipt {
  workorderAttemptId: number;
  taskId: number;
  generationKey: string;
  occurrenceKey: string;
  outcome: 'resolved' | 'final_no_update' | 'deferred';
  beforeRevision: number;
  afterRevision: number;
  changedFields: string[];
  reason: string;
  nextTemporalCheckAt: number | null;
  createdAt: number;
}

export function temporalNoUpdateScope(context: TemporalWorkContext): string {
  return `temporal:${context.taskId}:${context.occurrenceKey}:${context.checkAt}`;
}
