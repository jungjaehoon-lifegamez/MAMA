/**
 * The chat lane's cause wire.
 *
 * A reconcile work order carries its delta batch, so every durable change the run makes can
 * name what caused it. The chat lane had no such wire at all - `causeEventIds` was supplied
 * by exactly one caller in the codebase, the work-order consumer.
 *
 * Measured on the live effect ledger 2026-07-30: 3 attributed, 14 unattributed, and every
 * unattributed row was a `task_update` from `agent=conductor`. Over the preceding six hours
 * the run registry held 1,611 conductor runs against 45 board-worker runs - so the lane with
 * no cause wire is the one doing most of the work.
 *
 * The owner's message IS the cause, and the router knows it before the agent runs.
 */
import { describe, it, expect } from 'vitest';
import { causeFromOwnerMessage } from '../../src/gateways/message-router.js';

describe('causeFromOwnerMessage', () => {
  it('cites the owner message that started the turn', () => {
    expect(causeFromOwnerMessage('msg_9182', 'telegram:7026976631:msg_9182')).toEqual({
      causeEventIds: ['telegram:7026976631:msg_9182'],
    });
  });

  // The line that keeps this from becoming the thing the ledger exists to refuse. A
  // generated id names no message; citing it would be a fabricated citation dressed as
  // provenance, and an unattributed change is the honest answer instead.
  it('refuses a generated turn id rather than citing something unresolvable', () => {
    expect(causeFromOwnerMessage('generated:0f9a1c', 'discord:C1:generated:0f9a1c')).toBeNull();
  });

  it('refuses an empty turn id or an empty ref', () => {
    expect(causeFromOwnerMessage('', 'telegram:1:x')).toBeNull();
    expect(causeFromOwnerMessage('msg_1', '   ')).toBeNull();
  });

  // Found in review. A whitespace-only turn id is truthy and is not `generated:`, and the
  // router prefixes source and channel onto it - so the ref came out non-empty
  // (`telegram:C1:   `) and named no message at all.
  it('refuses a whitespace-only turn id, which the ref would otherwise hide', () => {
    expect(causeFromOwnerMessage('   ', 'telegram:C1:   ')).toBeNull();
    expect(causeFromOwnerMessage('\t\n', 'discord:C1:\t\n')).toBeNull();
  });

  it('still accepts a turn id that merely has padding around a real id', () => {
    expect(causeFromOwnerMessage(' msg_9182 ', 'telegram:C1:msg_9182')).toEqual({
      causeEventIds: ['telegram:C1:msg_9182'],
    });
  });

  // Spread into the run options, so "no honest cause" leaves the field absent rather than
  // present-and-empty - the ledger treats those differently, and an empty array would claim
  // the run had a batch and it was blank.
  it('is spreadable, and contributes nothing when there is no cause', () => {
    const withCause = { a: 1, ...(causeFromOwnerMessage('m1', 'slack:C1:m1') ?? {}) };
    const without = { a: 1, ...(causeFromOwnerMessage('generated:x', 'slack:C1:y') ?? {}) };
    expect(withCause).toHaveProperty('causeEventIds');
    expect(without).not.toHaveProperty('causeEventIds');
  });
});
