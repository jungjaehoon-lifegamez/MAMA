/**
 * Story S2-T2: publisher gate - pure decision, occurrence keys, payload schemas.
 * Plan: docs/superpowers/plans/2026-07-18-stage2-workorder-ownership.md
 */
import { describe, it, expect } from 'vitest';
import {
  readStage2Flag,
  resolvePublishAction,
  resolveReconcileAction,
  validateWorkOrderPayload,
  boardFullKey,
  boardManualKey,
  boardReconcileKey,
  wikiBatchKey,
  promotionKey,
  STAGE2_FLAGS,
} from '../../src/operator/workorder-publishers.js';
import { WORKORDER_KINDS } from '../../src/operator/task-ledger.js';

describe('Story S2-T2: publisher gate', () => {
  describe('AC #1: flag parsing is strict (no-fallback)', () => {
    it('absent/empty -> off; valid values pass through', () => {
      expect(readStage2Flag({})).toBe('off');
      expect(readStage2Flag({ MAMA_STAGE2_WORKORDERS: '' })).toBe('off');
      for (const flag of STAGE2_FLAGS) {
        expect(readStage2Flag({ MAMA_STAGE2_WORKORDERS: flag })).toBe(flag);
      }
    });

    it('malformed values throw at boot instead of silently reverting to legacy', () => {
      expect(() => readStage2Flag({ MAMA_STAGE2_WORKORDERS: '1' })).toThrow(/must be one of/);
      expect(() => readStage2Flag({ MAMA_STAGE2_WORKORDERS: 'shado' })).toThrow(/must be one of/);
    });
  });

  describe('AC #2: gate decision - every flag x kind combination', () => {
    it('off -> legacy for all kinds', () => {
      for (const kind of WORKORDER_KINDS) {
        expect(resolvePublishAction('off', kind)).toBe('legacy');
      }
    });

    it('on -> enqueue for all kinds', () => {
      for (const kind of WORKORDER_KINDS) {
        expect(resolvePublishAction('on', kind)).toBe('enqueue');
      }
    });

    it('shadow -> board dual-runs, wiki/promotion stay pure legacy (no uncaptured writes)', () => {
      expect(resolvePublishAction('shadow', 'board')).toBe('both');
      expect(resolvePublishAction('shadow', 'wiki')).toBe('legacy');
      expect(resolvePublishAction('shadow', 'memory-curation')).toBe('legacy');
    });

    it('reconcile leg converts at on ONLY (bracket verification stays legacy in shadow)', () => {
      expect(resolveReconcileAction('off')).toBe('legacy');
      expect(resolveReconcileAction('shadow')).toBe('legacy');
      expect(resolveReconcileAction('on')).toBe('enqueue');
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

    it('reconcile keys scope per channel per slot; wiki/promotion keys well-formed', () => {
      const t = 1_700_000_000_000;
      expect(boardReconcileKey('slack:C1', t)).not.toBe(boardReconcileKey('slack:C2', t));
      expect(boardReconcileKey('slack:C1', t)).toBe(boardReconcileKey('slack:C1', t + 1000));
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

    it('ledger-managed attempts field is allowed everywhere', () => {
      expect(() => validateWorkOrderPayload('board', { mode: 'full', attempts: 2 })).not.toThrow();
    });
  });
});
