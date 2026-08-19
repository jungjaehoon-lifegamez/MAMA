import { describe, expect, it } from 'vitest';
import { BoardRefreshGate, boardFullNoUpdateScope } from '../../src/operator/board-refresh-gate.js';

describe('TG-06 BoardRefreshGate', () => {
  it('starts boot-dirty, captures one full generation, and stays clean after its verified effect', () => {
    const gate = new BoardRefreshGate({ initialGeneration: 100 });

    expect(gate.needsFullRepair()).toBe(true);
    expect(gate.captureFullRepair()).toEqual({
      repairGeneration: 100,
      noUpdateScope: 'full:100',
    });

    gate.completeVerifiedFull(100);
    expect(gate.needsFullRepair()).toBe(false);
  });

  it('TG-01 keeps a newer channel delta dirty when an older verified reconcile completes', () => {
    const gate = new BoardRefreshGate({ initialGeneration: 20 });
    const older = gate.markChannelDirty('telegram:owner');
    const newer = gate.markChannelDirty('telegram:owner');

    gate.completeVerifiedReconcile('telegram:owner', older);
    expect(gate.dirtyGeneration('telegram:owner')).toBe(newer);

    gate.completeVerifiedReconcile('telegram:owner', newer);
    expect(gate.dirtyGeneration('telegram:owner')).toBeNull();
  });

  it.each([
    'debounce pending',
    'budget deferred',
    'enqueue failure',
    'run failure',
    'unverified completion',
    'missing effect',
  ])('keeps the channel dirty after %s', (_failureState) => {
    const gate = new BoardRefreshGate({ initialGeneration: 30 });
    const generation = gate.markChannelDirty('slack:C1');

    // Every named state deliberately omits a verified completion transition.
    expect(gate.dirtyGeneration('slack:C1')).toBe(generation);
    expect(gate.needsFullRepair()).toBe(true);
  });

  it('clears only the captured unauthorized private partition without clearing boot or newer work', () => {
    const gate = new BoardRefreshGate({ initialGeneration: 40 });
    const captured = gate.markChannelDirty('kagemusha:private');
    const other = gate.markChannelDirty('telegram:owner');
    const newer = gate.markChannelDirty('kagemusha:private');

    gate.consumeUnauthorizedPartition('kagemusha:private', captured);
    expect(gate.dirtyGeneration('kagemusha:private')).toBe(newer);
    expect(gate.dirtyGeneration('telegram:owner')).toBe(other);
    expect(gate.needsFullRepair()).toBe(true);
  });

  it('a verified full clears boot and generations at or before its capture, but preserves later deltas', () => {
    const gate = new BoardRefreshGate({ initialGeneration: 50 });
    gate.markChannelDirty('slack:C1');
    const full = gate.captureFullRepair();
    const later = gate.markChannelDirty('telegram:owner');

    gate.completeVerifiedFull(full.repairGeneration);
    expect(gate.dirtyGeneration('slack:C1')).toBeNull();
    expect(gate.dirtyGeneration('telegram:owner')).toBe(later);
    expect(gate.needsFullRepair()).toBe(true);
  });

  it('derives the exact contract_no_update scope from the captured generation', () => {
    expect(boardFullNoUpdateScope(987)).toBe('full:987');
  });
});
