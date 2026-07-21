/**
 * OperatorActionVerifier (M8 Phase 2) - verifies that a reconcile run actually
 * performed its obligated action. Ports Kagemusha's ContractActionVerifier
 * snapshot-diff mechanism, strengthened per plan review: signals must be BOUND
 * to the run, not to unrelated board activity.
 *
 * Verified iff, after the run:
 *  (a) a NEW gateway tool-call trace row exists (rowid past the snapshot)
 *      whose normalized tool name is one of the obligated tools, or
 *  (b) a NEW no-update note exists with EXACTLY this run's scope.
 * Slot/ledger hash deltas are recorded as evidence detail only -- another
 * writer may have moved them (the board-writer queue makes in-queue runs
 * non-concurrent, which closes the remaining race).
 *
 * Observe, never block: the caller records the outcome and emits a notice;
 * an unverified run is a loud signal, not a rejection.
 */

import { createHash } from 'node:crypto';
import type { TaskRecord, TemporalGenerationRecord } from './task-ledger.js';
import {
  temporalNoUpdateScope,
  temporalReceiptInvariantError,
  type TemporalEffectReceipt,
  type TemporalWorkContext,
} from './temporal-effect.js';

export const OBLIGATED_TOOLS = [
  'report_publish',
  'task_create',
  'task_update',
  'contract_no_update',
] as const;

export interface VerifierDeps {
  /** Current report slots (id -> html). */
  getSlots: () => Array<{ slotId: string; html: string }>;
  /** Stable hash of the task ledger payload. */
  getLedgerHash: () => string;
  /** Max no-update note id for a scope (0 when none). */
  getScopedNoteMaxId: (scope: string) => number;
  /**
   * Count of gateway tool-call trace rows past a rowid whose normalized tool
   * name is in OBLIGATED_TOOLS (bound to the reconcile agent).
   */
  countObligatedTraceRowsSince: (maxId: number) => number;
  /** Max gateway trace rowid right now (0 when none). */
  getTraceMaxId: () => number;
}

export interface ActionSnapshot {
  slotHashes: Record<string, string>;
  ledgerHash: string;
  scopedNoteMaxId: number;
  traceMaxId: number;
}

export interface VerifyResult {
  verified: boolean;
  /** Human-readable evidence lines for the activity record. */
  effects: string[];
}

export function captureSnapshot(deps: VerifierDeps, scope: string): ActionSnapshot {
  const slotHashes: Record<string, string> = {};
  for (const slot of deps.getSlots()) {
    slotHashes[slot.slotId] = createHash('sha256').update(slot.html).digest('hex');
  }
  return {
    slotHashes,
    ledgerHash: deps.getLedgerHash(),
    scopedNoteMaxId: deps.getScopedNoteMaxId(scope),
    traceMaxId: deps.getTraceMaxId(),
  };
}

export function verifyAfterRun(
  deps: VerifierDeps,
  before: ActionSnapshot,
  scope: string
): VerifyResult {
  const effects: string[] = [];
  let verified = false;

  // (a) run-bound signal: obligated gateway tool traces past the snapshot.
  const obligatedTraces = deps.countObligatedTraceRowsSince(before.traceMaxId);
  if (obligatedTraces > 0) {
    verified = true;
    effects.push(`obligated tool traces: ${obligatedTraces}`);
  }

  // (b) run-bound signal: a new no-update note with EXACTLY this scope.
  const noteMaxNow = deps.getScopedNoteMaxId(scope);
  if (noteMaxNow > before.scopedNoteMaxId) {
    verified = true;
    effects.push(`no-update note recorded (scope=${scope})`);
  }

  // Evidence detail only (NOT sufficient alone -- see module doc).
  const after = captureSnapshot(deps, scope);
  const changedSlots = Object.keys({ ...before.slotHashes, ...after.slotHashes }).filter(
    (id) => before.slotHashes[id] !== after.slotHashes[id]
  );
  if (changedSlots.length > 0) {
    effects.push(`slots changed: ${changedSlots.join(', ')}`);
  }
  if (after.ledgerHash !== before.ledgerHash) {
    effects.push('task ledger changed');
  }

  return { verified, effects };
}

export interface TemporalVerifierDeps {
  loadTemporalWorkContext: (attemptId: number) => TemporalWorkContext;
  getTemporalEffect: (attemptId: number) => TemporalEffectReceipt | null;
  getTask: (taskId: number) => TaskRecord | null;
  getTemporalGeneration: (generationKey: string) => TemporalGenerationRecord | null;
  getScopedNoteMaxId: (scope: string) => number;
}

export type TemporalEffectSnapshot = Readonly<TemporalWorkContext & { scopedNoteMaxId: number }>;

export type TemporalVerifyResult =
  | {
      verified: true;
      outcome: TemporalEffectReceipt['outcome'] | 'verified_superseded';
      effects: string[];
    }
  | { verified: false; reason: string; effects: string[] };

export function captureTemporalEffectSnapshot(
  deps: TemporalVerifierDeps,
  attemptId: number
): TemporalEffectSnapshot {
  const context = deps.loadTemporalWorkContext(attemptId);
  if (context.attemptId !== attemptId) {
    throw new Error(`temporal verifier context attempt mismatch for ${attemptId}`);
  }
  return Object.freeze({
    ...context,
    scopedNoteMaxId: deps.getScopedNoteMaxId(temporalNoUpdateScope(context)),
  });
}

export function verifyTemporalEffect(
  deps: TemporalVerifierDeps,
  before: TemporalEffectSnapshot
): TemporalVerifyResult {
  const effects: string[] = [];
  const receipt = deps.getTemporalEffect(before.attemptId);
  if (!receipt) return temporalFailure('temporal effect receipt missing', effects);
  const receiptError = temporalReceiptInvariantError(receipt, {
    attemptId: before.attemptId,
    taskId: before.taskId,
    generationKey: before.generationKey,
    occurrenceKey: before.occurrenceKey,
    beforeRevision: before.revision,
  });
  if (receiptError) return temporalFailure(receiptError, effects);

  const generation = deps.getTemporalGeneration(before.generationKey);
  if (
    !generation ||
    generation.generationKey !== before.generationKey ||
    generation.taskId !== before.taskId ||
    generation.temporalEpoch !== before.temporalEpoch ||
    generation.occurrenceKey !== before.occurrenceKey ||
    generation.checkAt !== before.checkAt ||
    generation.lastWorkOrderId !== before.attemptId ||
    generation.disposition !== receipt.outcome
  ) {
    return temporalFailure('temporal generation invariant failed', effects);
  }

  const requiresNote = receipt.outcome === 'final_no_update' || receipt.outcome === 'deferred';
  if (
    requiresNote &&
    deps.getScopedNoteMaxId(temporalNoUpdateScope(before)) <= before.scopedNoteMaxId
  ) {
    return temporalFailure('exact-scope temporal no-update note missing', effects);
  }

  const task = deps.getTask(before.taskId);
  if (!task) return temporalFailure('temporal receipt owner task missing', effects);
  if (task.id !== before.taskId) {
    return temporalFailure('temporal owner task identity mismatch', effects);
  }
  if (task.revision < receipt.afterRevision) {
    return temporalFailure('temporal owner task revision precedes receipt', effects);
  }
  effects.push(`receipt:${receipt.workorderAttemptId}`);
  effects.push(`outcome:${receipt.outcome}`);
  if (task.revision > receipt.afterRevision) {
    effects.push(`owner task advanced to revision ${task.revision}`);
    return { verified: true, outcome: 'verified_superseded', effects };
  }
  if (
    task.lastTemporalAttemptId !== before.attemptId ||
    task.lastTemporalCheckedAt !== receipt.createdAt
  ) {
    return temporalFailure('temporal owner task attempt marker mismatch', effects);
  }
  if (receipt.outcome === 'resolved' || receipt.outcome === 'final_no_update') {
    if (
      task.temporalReconciledOccurrenceKey !== before.occurrenceKey ||
      task.nextTemporalCheckAt !== null
    ) {
      return temporalFailure('temporal owner task final markers are invalid', effects);
    }
  } else if (task.nextTemporalCheckAt !== receipt.nextTemporalCheckAt) {
    return temporalFailure('temporal owner task deferred check mismatch', effects);
  }
  return { verified: true, outcome: receipt.outcome, effects };
}

function temporalFailure(reason: string, effects: string[]): TemporalVerifyResult {
  return { verified: false, reason, effects };
}
