/**
 * Pure-function tests for the operator board's SSE merge + ordering logic
 * (ui/src/api/report.ts). Node environment -- no DOM needed.
 */

import { describe, it, expect } from 'vitest';
import { mergeReportEvent, orderSlots } from '../../ui/src/api/report';

describe('mergeReportEvent', () => {
  it('replaces the record with a bulk slots snapshot', () => {
    const prev = { stale: { slotId: 'stale', html: 'x', priority: 0, updatedAt: 1 } };
    const next = mergeReportEvent(prev, {
      slots: [{ slotId: 'briefing', html: '<p>x</p>', priority: 0, updatedAt: 5 }],
    });
    expect(next.briefing.html).toBe('<p>x</p>');
    expect(next.stale).toBeUndefined();
  });

  it('merges a single-slot event and stamps updatedAt', () => {
    const next = mergeReportEvent({}, { slot: 'decisions', html: '<p>d</p>', priority: 2 });
    expect(next.decisions.html).toBe('<p>d</p>');
    expect(next.decisions.updatedAt).toBeGreaterThan(0);
  });

  it('removes a slot on a deleted event', () => {
    const prev = { briefing: { slotId: 'briefing', html: 'b', priority: 0, updatedAt: 1 } };
    const next = mergeReportEvent(prev, { deleted: 'briefing' });
    expect(next.briefing).toBeUndefined();
  });

  it('ignores malformed payloads', () => {
    const prev = { briefing: { slotId: 'briefing', html: 'b', priority: 0, updatedAt: 1 } };
    expect(mergeReportEvent(prev, { nonsense: true })).toEqual(prev);
    expect(mergeReportEvent(prev, null)).toEqual(prev);
  });
});

describe('orderSlots', () => {
  it('orders known slots first, then custom by priority', () => {
    const rec = {
      zebra: { slotId: 'zebra', html: 'z', priority: 9, updatedAt: 1 },
      alpha: { slotId: 'alpha', html: 'a', priority: 1, updatedAt: 1 },
      pipeline: { slotId: 'pipeline', html: 'p', priority: 99, updatedAt: 1 },
      briefing: { slotId: 'briefing', html: 'b', priority: 5, updatedAt: 1 },
    };
    expect(orderSlots(rec).map((s) => s.slotId)).toEqual([
      'briefing',
      'pipeline',
      'alpha',
      'zebra',
    ]);
  });

  it('returns empty for an empty record', () => {
    expect(orderSlots({})).toEqual([]);
  });
});
