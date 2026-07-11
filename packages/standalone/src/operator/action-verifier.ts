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
