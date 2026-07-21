/**
 * Unit tests for OperatorActionVerifier (M8 Phase 2): every signal class is
 * run-bound -- unrelated activity must NOT verify. Synthetic data only.
 */
import { describe, it, expect } from 'vitest';
import {
  captureSnapshot,
  captureTemporalEffectSnapshot,
  verifyTemporalEffect,
  verifyAfterRun,
  type TemporalVerifierDeps,
  type VerifierDeps,
} from '../../src/operator/action-verifier.js';
import type { TaskRecord, TemporalGenerationRecord } from '../../src/operator/task-ledger.js';
import type {
  TemporalEffectReceipt,
  TemporalWorkContext,
} from '../../src/operator/temporal-effect.js';

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

describe('Story A2 Task 8: temporal receipt verifier', () => {
  const context: TemporalWorkContext = {
    attemptId: 41,
    generationKey: 'generation:41',
    taskId: 7,
    temporalEpoch: 2,
    occurrenceKey: 'due:1784646000000',
    checkAt: 1784646000000,
    revision: 5,
    sourceChannel: 'trello:synthetic-board',
    sourceEventId: 'synthetic-card',
  };
  const receipt: TemporalEffectReceipt = {
    workorderAttemptId: 41,
    taskId: 7,
    generationKey: 'generation:41',
    occurrenceKey: 'due:1784646000000',
    outcome: 'resolved',
    beforeRevision: 5,
    afterRevision: 6,
    changedFields: ['status', 'temporal_reconciled_occurrence_key', 'last_temporal_attempt_id'],
    reason: 'Fresh evidence confirms completion',
    nextTemporalCheckAt: null,
    createdAt: 1784646000100,
  };
  const task = {
    id: 7,
    revision: 6,
    status: 'done',
    temporalReconciledOccurrenceKey: context.occurrenceKey,
    nextTemporalCheckAt: null,
    lastTemporalAttemptId: 41,
    lastTemporalCheckedAt: receipt.createdAt,
  } as TaskRecord;
  const generation = {
    generationKey: context.generationKey,
    taskId: 7,
    temporalEpoch: 2,
    occurrenceKey: context.occurrenceKey,
    checkAt: context.checkAt,
    disposition: 'resolved',
    lastWorkOrderId: 41,
  } as TemporalGenerationRecord;

  function temporalDeps(overrides: Partial<TemporalVerifierDeps> = {}): TemporalVerifierDeps {
    return {
      loadTemporalWorkContext: () => context,
      getTemporalEffect: () => receipt,
      getTask: () => task,
      getTemporalGeneration: () => generation,
      getScopedNoteMaxId: () => 0,
      ...overrides,
    };
  }

  it('verifies a receipt bound to attempt, task, occurrence, and exactly one revision', () => {
    const deps = temporalDeps();
    const before = captureTemporalEffectSnapshot(deps, 41);
    expect(verifyTemporalEffect(deps, before)).toMatchObject({
      verified: true,
      outcome: 'resolved',
    });
  });

  it('accepts a legitimate later owner update as verified_superseded', () => {
    const deps = temporalDeps({ getTask: () => ({ ...task, revision: 7 }) as TaskRecord });
    const before = captureTemporalEffectSnapshot(deps, 41);
    expect(verifyTemporalEffect(deps, before)).toMatchObject({
      verified: true,
      outcome: 'verified_superseded',
    });
  });

  it('rejects receipts from another retry and non-unit revision changes', () => {
    const before = captureTemporalEffectSnapshot(temporalDeps(), 41);
    expect(
      verifyTemporalEffect(
        temporalDeps({
          getTemporalEffect: () => ({ ...receipt, workorderAttemptId: 40 }),
        }),
        before
      )
    ).toMatchObject({ verified: false, reason: expect.stringContaining('attempt') });
    expect(
      verifyTemporalEffect(
        temporalDeps({ getTemporalEffect: () => ({ ...receipt, afterRevision: 7 }) }),
        before
      )
    ).toMatchObject({ verified: false, reason: expect.stringContaining('revision') });
    expect(
      verifyTemporalEffect(
        temporalDeps({ getTask: () => ({ ...task, id: 99 }) as TaskRecord }),
        before
      )
    ).toMatchObject({ verified: false, reason: expect.stringContaining('identity') });
    expect(
      verifyTemporalEffect(
        temporalDeps({
          getTemporalEffect: () => ({ ...receipt, changedFields: ['deadline'] }),
        }),
        before
      )
    ).toMatchObject({ verified: false, reason: expect.stringContaining('resolved') });
    expect(
      verifyTemporalEffect(
        temporalDeps({
          getTask: () => ({ ...task, lastTemporalCheckedAt: null }) as TaskRecord,
        }),
        before
      )
    ).toMatchObject({ verified: false, reason: expect.stringContaining('attempt marker') });
  });

  it('requires exact-scope notes and outcome-specific deferred markers', () => {
    const deferredReceipt: TemporalEffectReceipt = {
      ...receipt,
      outcome: 'deferred',
      changedFields: ['next_temporal_check_at', 'last_temporal_attempt_id'],
      nextTemporalCheckAt: context.checkAt + 60_000,
    };
    const deferredTask = {
      ...task,
      status: 'pending',
      temporalReconciledOccurrenceKey: null,
      nextTemporalCheckAt: context.checkAt + 60_000,
    } as TaskRecord;
    const deferredGeneration = {
      ...generation,
      disposition: 'deferred',
    } as TemporalGenerationRecord;
    const before = captureTemporalEffectSnapshot(temporalDeps(), 41);
    const deps = temporalDeps({
      getTemporalEffect: () => deferredReceipt,
      getTask: () => deferredTask,
      getTemporalGeneration: () => deferredGeneration,
      getScopedNoteMaxId: () => 0,
    });
    expect(verifyTemporalEffect(deps, before)).toMatchObject({
      verified: false,
      reason: expect.stringContaining('no-update note'),
    });
    expect(verifyTemporalEffect({ ...deps, getScopedNoteMaxId: () => 1 }, before)).toMatchObject({
      verified: true,
      outcome: 'deferred',
    });

    const preexistingNoteBefore = captureTemporalEffectSnapshot(
      temporalDeps({ getScopedNoteMaxId: () => 1 }),
      41
    );
    expect(
      verifyTemporalEffect({ ...deps, getScopedNoteMaxId: () => 1 }, preexistingNoteBefore)
    ).toMatchObject({ verified: false, reason: expect.stringContaining('no-update note') });
  });
});
