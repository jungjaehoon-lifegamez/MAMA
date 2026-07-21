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

/** Host-only evidence identity validated against the active envelope/model run. */
export interface TemporalEvidenceAttestation {
  contextPacketId: string;
  contextPacketSha256: string;
}

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
  attestationVersion: 0 | 1;
  contextPacketId: string;
  contextPacketSha256: string;
  nextTemporalCheckAt: number | null;
  createdAt: number;
}

export interface TemporalReceiptExpectation {
  attemptId: number;
  taskId: number;
  generationKey: string;
  occurrenceKey: string;
  beforeRevision?: number;
}

/** Shared immutable receipt checks used by both live audit and recovery. */
export function temporalReceiptInvariantError(
  receipt: TemporalEffectReceipt,
  expected: TemporalReceiptExpectation
): string | null {
  if (receipt.attestationVersion !== 1) {
    return 'legacy temporal receipt evidence is quarantined';
  }
  if (receipt.workorderAttemptId !== expected.attemptId) {
    return 'temporal receipt attempt mismatch';
  }
  if (receipt.taskId !== expected.taskId) {
    return 'temporal receipt task mismatch';
  }
  if (receipt.generationKey !== expected.generationKey) {
    return 'temporal receipt generation mismatch';
  }
  if (receipt.occurrenceKey !== expected.occurrenceKey) {
    return 'temporal receipt occurrence mismatch';
  }
  if (
    (expected.beforeRevision !== undefined && receipt.beforeRevision !== expected.beforeRevision) ||
    receipt.afterRevision !== receipt.beforeRevision + 1
  ) {
    return 'temporal receipt revision invariant failed';
  }
  if (!receipt.reason.trim()) {
    return 'temporal receipt reason missing';
  }
  if (
    typeof receipt.contextPacketId !== 'string' ||
    !receipt.contextPacketId.trim() ||
    typeof receipt.contextPacketSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(receipt.contextPacketSha256)
  ) {
    return 'temporal receipt evidence attestation is invalid';
  }
  if (!Number.isSafeInteger(receipt.createdAt)) {
    return 'temporal receipt creation time is invalid';
  }
  if (new Set(receipt.changedFields).size !== receipt.changedFields.length) {
    return 'temporal receipt changed fields contain duplicates';
  }

  const workflowFields = new Set(['status', 'deadline', 'due_at']);
  const resolvedEffectFields = new Set(['status', 'due_at']);
  const hasWorkflowChange = receipt.changedFields.some((field) => workflowFields.has(field));
  const hasResolvedEffect = receipt.changedFields.some((field) => resolvedEffectFields.has(field));
  const markerChanged = receipt.changedFields.includes('temporal_reconciled_occurrence_key');
  if (receipt.outcome === 'resolved') {
    if (!hasResolvedEffect || !markerChanged || receipt.nextTemporalCheckAt !== null) {
      return 'resolved temporal receipt markers are invalid';
    }
  } else if (receipt.outcome === 'final_no_update') {
    if (
      hasWorkflowChange ||
      !markerChanged ||
      receipt.nextTemporalCheckAt !== null ||
      !receipt.reason.includes('evidence_sha256=')
    ) {
      return 'final_no_update temporal receipt markers are invalid';
    }
  } else if (
    hasWorkflowChange ||
    markerChanged ||
    !receipt.changedFields.includes('next_temporal_check_at') ||
    receipt.nextTemporalCheckAt === null ||
    receipt.nextTemporalCheckAt <= receipt.createdAt
  ) {
    return 'deferred temporal receipt markers are invalid';
  }
  return null;
}

export function temporalNoUpdateScope(context: TemporalWorkContext): string {
  return `temporal:${context.taskId}:${context.occurrenceKey}:${context.checkAt}`;
}
