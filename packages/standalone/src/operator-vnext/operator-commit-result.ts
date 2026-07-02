import type { SourceRef } from '@jungjaehoon/mama-core/provenance/source-ref';

export type OperatorCommitStatus = 'changed' | 'no_update';
export type OperatorCommitOutcome = 'committed' | 'already_committed' | 'recovered';

export interface OperatorNoUpdateCommitInput {
  noUpdateId?: string;
  scopeKey: string;
  reason: string;
}

export interface OperatorCursorCommitInput {
  commitId?: string;
  cursorName: string;
  firstChangeSeq: number;
  lastChangeSeq: number;
  idempotencyKey: string;
  status: OperatorCommitStatus;
  changedRefs?: readonly SourceRef[];
  sourceRefs: readonly SourceRef[];
  noUpdate?: OperatorNoUpdateCommitInput;
  nowMs?: number;
}

export interface OperatorCursorCommitResult {
  outcome: OperatorCommitOutcome;
  commitId: string;
  cursorName: string;
  firstChangeSeq: number;
  lastChangeSeq: number;
  idempotencyKey: string;
  status: OperatorCommitStatus;
  cursorAdvanced: boolean;
}

export interface OperatorNoUpdateLedgerInput {
  noUpdateId: string;
  scopeKey: string;
  reason: string;
  sourceRefs: readonly SourceRef[];
  idempotencyKey: string;
  nowMs?: number;
}

export interface OperatorNoUpdateLedgerRow {
  noUpdateId: string;
  scopeKey: string;
  reason: string;
  sourceRefs: string[];
  idempotencyKey: string;
  createdAtMs: number;
}
