export interface ReportSlot {
  slotId: string;
  html: string;
  priority: number;
  updatedAt: number;
}

export const SLOT_ORDER = ['briefing', 'action_required', 'decisions', 'pipeline'] as const;

export type SlotRecord = Record<string, ReportSlot>;

/**
 * Fold an SSE `report-update` payload into the slot record.
 *
 * Wire shapes from src/api/report-handler.ts:
 *  - bulk:    { slots: ReportSlot[] }  (full snapshot -- replaces the record)
 *  - single:  { slot, html, priority } (no updatedAt -- stamped client-side)
 *  - removal: { deleted: slotId }
 */
export function mergeReportEvent(prev: SlotRecord, data: unknown): SlotRecord {
  const d = data as {
    slots?: ReportSlot[];
    slot?: string;
    html?: string;
    priority?: number;
    deleted?: string;
  };
  if (Array.isArray(d?.slots)) {
    const next: SlotRecord = {};
    for (const slot of d.slots) {
      next[slot.slotId] = slot;
    }
    return next;
  }
  if (d?.deleted) {
    const next = { ...prev };
    delete next[d.deleted];
    return next;
  }
  if (d?.slot && d.html !== undefined) {
    return {
      ...prev,
      [d.slot]: {
        slotId: d.slot,
        html: d.html,
        priority: d.priority ?? 0,
        updatedAt: Date.now(),
      },
    };
  }
  return prev;
}

/** Known slots first in fixed order, then custom slots by priority. */
export function orderSlots(slots: SlotRecord): ReportSlot[] {
  const knownIds = SLOT_ORDER as readonly string[];
  const known = knownIds.filter((id) => slots[id]).map((id) => slots[id]);
  const custom = Object.values(slots)
    .filter((s) => !knownIds.includes(s.slotId))
    .sort((a, b) => a.priority - b.priority);
  return [...known, ...custom];
}
