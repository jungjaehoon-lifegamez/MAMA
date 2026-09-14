/**
 * Unit tests for OperatorActionVerifier (M8 Phase 2): every signal class is
 * run-bound -- unrelated activity must NOT verify. Synthetic data only.
 */
import { describe, it, expect } from 'vitest';
import {
  captureSnapshot,
  verifyAfterRun,
  type VerifierDeps,
} from '../../src/operator/action-verifier.js';

function makeDeps(overrides: Partial<VerifierDeps> = {}): VerifierDeps & {
  state: {
    slots: Array<{ slotId: string; html: string }>;
    ledger: string;
    notes: Map<string, number>;
    traceMax: number;
    obligatedSince: number;
  };
} {
  const state = {
    slots: [{ slotId: 'pipeline', html: '<p>v1</p>' }],
    ledger: 'hash-a',
    notes: new Map<string, number>(),
    traceMax: 100,
    obligatedSince: 0,
  };
  return {
    state,
    getSlots: () => state.slots,
    getLedgerHash: () => state.ledger,
    getScopedNoteMaxId: (scope: string) => state.notes.get(scope) ?? 0,
    countObligatedTraceRowsSince: () => state.obligatedSince,
    getTraceMaxId: () => state.traceMax,
    ...overrides,
  };
}

describe('OperatorActionVerifier', () => {
  const scope = 'reconcile:slack:C001';

  it('verifies on a new obligated gateway trace row', () => {
    const deps = makeDeps();
    const before = captureSnapshot(deps, scope);
    deps.state.obligatedSince = 2; // agent called report_publish + task_update
    const result = verifyAfterRun(deps, before, scope);
    expect(result.verified).toBe(true);
    expect(result.effects.join(' ')).toContain('obligated tool traces: 2');
  });

  it('verifies on a new no-update note with EXACTLY this scope', () => {
    const deps = makeDeps();
    const before = captureSnapshot(deps, scope);
    deps.state.notes.set(scope, 7);
    const result = verifyAfterRun(deps, before, scope);
    expect(result.verified).toBe(true);
    expect(result.effects.join(' ')).toContain(`scope=${scope}`);
  });

  it('a note for a FOREIGN scope does NOT verify', () => {
    const deps = makeDeps();
    const before = captureSnapshot(deps, scope);
    deps.state.notes.set('reconcile:chatwork:9', 5);
    const result = verifyAfterRun(deps, before, scope);
    expect(result.verified).toBe(false);
  });

  it('hash-only changes do NOT verify (another writer may have moved them)', () => {
    const deps = makeDeps();
    const before = captureSnapshot(deps, scope);
    deps.state.slots = [{ slotId: 'pipeline', html: '<p>v2</p>' }];
    deps.state.ledger = 'hash-b';
    const result = verifyAfterRun(deps, before, scope);
    expect(result.verified).toBe(false);
    // ...but the deltas ARE recorded as evidence detail.
    expect(result.effects.join(' ')).toContain('slots changed: pipeline');
    expect(result.effects.join(' ')).toContain('task ledger changed');
  });

  it('a no-op run yields unverified with no effects', () => {
    const deps = makeDeps();
    const before = captureSnapshot(deps, scope);
    const result = verifyAfterRun(deps, before, scope);
    expect(result.verified).toBe(false);
    expect(result.effects).toEqual([]);
  });
});
