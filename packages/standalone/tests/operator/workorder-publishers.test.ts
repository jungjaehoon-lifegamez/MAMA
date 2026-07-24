/**
 * Story S2-T2: publisher contracts - occurrence keys, payload schemas, and the
 * retired-flag boot guard (workorders are the only run path since v0.28.0).
 * Plan: docs/superpowers/plans/2026-07-18-stage2-workorder-ownership.md
 */
import { describe, it, expect } from 'vitest';
import {
  assertStage2FlagCompatible,
  validateWorkOrderPayload,
  boardFullKey,
  boardManualKey,
  boardReconcileKey,
  wikiBatchKey,
  promotionKey,
} from '../../src/operator/workorder-publishers.js';

describe('Story S2-T2: publisher contracts', () => {
  describe('AC #1: retired flag guard is strict (no-fallback)', () => {
    it('absent/empty/on boot fine (the pipeline always runs)', () => {
      expect(() => assertStage2FlagCompatible({})).not.toThrow();
      expect(() => assertStage2FlagCompatible({ MAMA_STAGE2_WORKORDERS: '' })).not.toThrow();
      expect(() => assertStage2FlagCompatible({ MAMA_STAGE2_WORKORDERS: 'on' })).not.toThrow();
    });

    it('explicit legacy pins fail the boot loudly instead of silently running the pipeline', () => {
      expect(() => assertStage2FlagCompatible({ MAMA_STAGE2_WORKORDERS: 'off' })).toThrow(
        /no longer supported/
      );
      expect(() => assertStage2FlagCompatible({ MAMA_STAGE2_WORKORDERS: 'shadow' })).toThrow(
        /no longer supported/
      );
      expect(() => assertStage2FlagCompatible({ MAMA_STAGE2_WORKORDERS: '1' })).toThrow(
        /no longer supported/
      );
    });
  });

  describe('AC #3: occurrence keys', () => {
    it('same 30-min slot dedups, next slot mints fresh; manual keys are always distinct', () => {
      const t = 1_700_000_000_000;
      expect(boardFullKey(t)).toBe(boardFullKey(t + 60_000));
      expect(boardFullKey(t)).not.toBe(boardFullKey(t + 31 * 60_000));
      expect(boardManualKey(t)).not.toBe(boardFullKey(t));
      expect(boardManualKey(t)).not.toBe(boardManualKey(t + 1));
    });

    it('reconcile keys are per-fire occurrences; wiki/promotion keys well-formed', () => {
      const t = 1_700_000_000_000;
      expect(boardReconcileKey('slack:C1', t)).not.toBe(boardReconcileKey('slack:C2', t));
      // Timestamp key (PR bot round): distinct fires carry distinct deltas -
      // a slot key would dedup the later one away. Debounce coalesces.
      expect(boardReconcileKey('slack:C1', t)).not.toBe(boardReconcileKey('slack:C1', t + 1000));
      expect(wikiBatchKey('extraction:completed', t)).toContain('extraction:completed');
      expect(promotionKey(t)).toBe(promotionKey(t + 60 * 60 * 1000)); // same 6h slot
    });
  });

  describe('AC #4: payload schemas reject loudly', () => {
    it('unknown fields are rejected (misspellings must not drop silently)', () => {
      expect(() => validateWorkOrderPayload('board', { mode: 'full', froce: true })).toThrow(
        /unknown field 'froce'/
      );
    });

    it('board: mode required; reconcile requires channelKey + deltaLines', () => {
      expect(() => validateWorkOrderPayload('board', {})).toThrow(/mode/);
      expect(() => validateWorkOrderPayload('board', { mode: 'reconcile' })).toThrow(/channelKey/);
      expect(() =>
        validateWorkOrderPayload('board', {
          mode: 'reconcile',
          channelKey: 'slack:C1',
          deltaLines: [],
        })
      ).toThrow(/deltaLines/);
      expect(() =>
        validateWorkOrderPayload('board', {
          mode: 'reconcile',
          channelKey: 'slack:C1',
          deltaLines: ['+ new message'],
        })
      ).not.toThrow();
      expect(() => validateWorkOrderPayload('board', { mode: 'full', force: true })).not.toThrow();
    });

    it('wiki needs batchId + events[]; promotion needs scheduledAt', () => {
      expect(() => validateWorkOrderPayload('wiki', { batchId: 'b-1' })).toThrow(/events/);
      expect(() => validateWorkOrderPayload('wiki', { batchId: 'b-1', events: [] })).not.toThrow();
      expect(() => validateWorkOrderPayload('memory-curation', {})).toThrow(/scheduledAt/);
      expect(() =>
        validateWorkOrderPayload('memory-curation', { scheduledAt: '2026-07-18T12:00:00Z' })
      ).not.toThrow();
    });

    it('rejects caller-supplied attempts for every normal publisher kind', () => {
      expect(() => validateWorkOrderPayload('board', { mode: 'full', attempts: 2 })).toThrow(
        /attempts.*ledger-managed/
      );
      expect(() =>
        validateWorkOrderPayload('wiki', { batchId: 'b-1', events: [], attempts: 2 })
      ).toThrow(/attempts.*ledger-managed/);
      expect(() =>
        validateWorkOrderPayload('memory-curation', {
          scheduledAt: '2026-07-18T12:00:00Z',
          attempts: 2,
        })
      ).toThrow(/attempts.*ledger-managed/);
    });

    it('accepts only bounded temporal generation identifiers and source provenance', () => {
      expect(() =>
        validateWorkOrderPayload('temporal', {
          generationKey: 'task:1:epoch:1:due:10:check:10',
          taskId: 1,
          temporalEpoch: 1,
          occurrenceKey: 'epoch:1:due:10',
          checkAt: 10,
          sourceChannel: 'trello:synthetic-board',
          sourceEventId: 'synthetic-card',
        })
      ).not.toThrow();
      expect(() =>
        validateWorkOrderPayload('temporal', {
          generationKey: 'g',
          taskId: 1,
          temporalEpoch: 1,
          occurrenceKey: 'o',
          checkAt: 10,
          connectorBody: 'must not be copied',
        })
      ).toThrow(/unknown field/);
    });
  });
});
