import { describe, expect, it } from 'vitest';
import {
  COLLAPSED_SLOTS_STORAGE_KEY,
  formatSlotLabel,
  parseCollapsedSlots,
  pruneCollapsedSlots,
  serializeCollapsedSlots,
  toggleCollapsedSlot,
} from '../../ui/src/lib/slot-collapse.js';

describe('Story M9.4: Board slot collapse state', () => {
  it('uses the stable storage key', () => {
    expect(COLLAPSED_SLOTS_STORAGE_KEY).toBe('mama-ui-collapsed-slots');
  });

  it('parses only non-empty string array entries', () => {
    expect(Array.from(parseCollapsedSlots('["pipeline","",3,"briefing"]'))).toEqual([
      'pipeline',
      'briefing',
    ]);
  });

  it('falls back to an empty set for missing, invalid, or non-array values', () => {
    expect(parseCollapsedSlots(null).size).toBe(0);
    expect(parseCollapsedSlots('{broken').size).toBe(0);
    expect(parseCollapsedSlots('{"pipeline":true}').size).toBe(0);
  });

  it('serializes deterministically', () => {
    expect(serializeCollapsedSlots(new Set(['pipeline', 'briefing']))).toBe(
      '["briefing","pipeline"]'
    );
  });

  it('toggles into a new set without mutating the source', () => {
    const source = new Set(['briefing']);
    const added = toggleCollapsedSlot(source, 'pipeline');
    const removed = toggleCollapsedSlot(added, 'briefing');

    expect(Array.from(source)).toEqual(['briefing']);
    expect(Array.from(added)).toEqual(['briefing', 'pipeline']);
    expect(Array.from(removed)).toEqual(['pipeline']);
  });

  it('prunes stale persisted ids after a full report load', () => {
    const persisted = parseCollapsedSlots('["briefing","removed-slot"]');
    const pruned = pruneCollapsedSlots(persisted, new Set(['briefing', 'pipeline']));

    expect(Array.from(persisted)).toEqual(['briefing', 'removed-slot']);
    expect(Array.from(pruned)).toEqual(['briefing']);
    expect(serializeCollapsedSlots(pruned)).toBe('["briefing"]');
  });

  it('formats known and custom slot labels', () => {
    expect(formatSlotLabel('briefing')).toBe('Briefing');
    expect(formatSlotLabel('action_required')).toBe('Action required');
    expect(formatSlotLabel('decisions')).toBe('Decisions');
    expect(formatSlotLabel('pipeline')).toBe('Pipeline');
    expect(formatSlotLabel('customStatus-slot')).toBe('Custom status slot');
    expect(formatSlotLabel('---')).toBe('Report');
  });
});
