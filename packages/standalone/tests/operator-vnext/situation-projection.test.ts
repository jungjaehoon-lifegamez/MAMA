import { describe, expect, it } from 'vitest';

import {
  buildSituationProjection,
  buildReportSlotsFromSituationProjection,
} from '../../src/operator-vnext/situation-projection.js';
import type { VNextSituationInput } from '../../src/operator-vnext/situation-projection-types.js';

const sourceRefs = [{ kind: 'raw' as const, connector: 'manual', id: 'event-42' }];

function makeSituation(overrides: Partial<VNextSituationInput> = {}): VNextSituationInput {
  return {
    situationId: 'sit_manual_42',
    situationVersion: 3,
    awarenessRunId: 'run_manual_42',
    title: 'Synthetic onboarding follow-up',
    status: 'needs_review',
    summary: 'Synthetic fixture needs operator review before publication.',
    nextAction: 'Review the synthetic follow-up and commit the next operator action.',
    freshness: 'live',
    verificationState: 'pending',
    confidence: 0.82,
    evidenceRefs: sourceRefs,
    updatedAtMs: 1_710_000_000_000,
    priority: 7,
    tags: ['follow_up'],
    pendingReason: 'Memory has not verified the latest connector delta yet.',
    ownerHint: 'operator',
    issueCount: 1,
    viewModelHash: 'vm_hash_manual_42',
    ...overrides,
  };
}

describe('Story PR5.1: vNext Situation Projection', () => {
  describe('AC #1: deterministic dashboard projection from one situation model', () => {
    it('keeps current state, freshness, verification, and evidence hash together', () => {
      const projection = buildSituationProjection([makeSituation()]);

      expect(projection.projectionVersion).toBe(1);
      expect(projection.viewModelHash).toBe('vm_hash_manual_42');
      expect(projection.today).toHaveLength(1);
      expect(projection.today[0]).toMatchObject({
        situation_id: 'sit_manual_42',
        situation_version: 3,
        awareness_run_id: 'run_manual_42',
        title: 'Synthetic onboarding follow-up',
        freshness: 'live',
        verification_state: 'pending',
        view_model_hash: 'vm_hash_manual_42',
        next_action: 'Review the synthetic follow-up and commit the next operator action.',
        evidence_count: 1,
        pending_reason: 'Memory has not verified the latest connector delta yet.',
      });
      expect(projection.status).toMatchObject({
        total: 1,
        pendingVerification: 1,
        degraded: 0,
      });
    });

    it('sorts by priority before recency and emits stable report slots', () => {
      const olderHighPriority = makeSituation({
        situationId: 'sit_high',
        title: 'High priority synthetic issue',
        priority: 1,
        updatedAtMs: 100,
        viewModelHash: 'hash_high',
      });
      const newerLowPriority = makeSituation({
        situationId: 'sit_low',
        title: 'Low priority synthetic issue',
        priority: 20,
        updatedAtMs: 200,
        viewModelHash: 'hash_low',
      });

      const projection = buildSituationProjection([newerLowPriority, olderHighPriority]);
      expect(projection.today.map((row) => row.situation_id)).toEqual(['sit_high', 'sit_low']);

      const slots = buildReportSlotsFromSituationProjection(projection);
      expect(slots.map((slot) => slot.slotId)).toEqual([
        'briefing',
        'vnext-status',
        'vnext-today',
        'vnext-evidence',
      ]);
      expect(slots[0].html).toContain('2 current situations');
      expect(slots[0].html).toContain('High priority synthetic issue');
      expect(slots[2].html).toContain('High priority synthetic issue');
      expect(slots[2].html).toContain('hash_high');
    });

    it('rejects invalid numeric projection fields before sorting or aggregation', () => {
      expect(() => buildSituationProjection([makeSituation({ priority: Number.NaN })])).toThrow(
        'priority must be a non-negative integer'
      );
      expect(() => buildSituationProjection([makeSituation({ issueCount: -1 })])).toThrow(
        'issueCount must be a non-negative integer'
      );
      expect(() => buildSituationProjection([makeSituation()], Number.POSITIVE_INFINITY)).toThrow(
        'nowMs must be a non-negative integer'
      );
    });
  });
});
