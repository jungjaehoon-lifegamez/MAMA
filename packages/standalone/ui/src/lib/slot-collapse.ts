export const COLLAPSED_SLOTS_STORAGE_KEY = 'mama-ui-collapsed-slots';

const KNOWN_SLOT_LABELS: Record<string, string> = {
  briefing: 'Briefing',
  action_required: 'Action required',
  decisions: 'Decisions',
  pipeline: 'Pipeline',
};

export function parseCollapsedSlots(value: string | null): Set<string> {
  if (value === null) {
    return new Set();
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(
      parsed.filter((slotId): slotId is string => typeof slotId === 'string' && slotId.length > 0)
    );
  } catch {
    return new Set();
  }
}

export function serializeCollapsedSlots(slots: ReadonlySet<string>): string {
  return JSON.stringify(Array.from(slots).sort());
}

export function toggleCollapsedSlot(slots: ReadonlySet<string>, slotId: string): Set<string> {
  const next = new Set(slots);
  if (next.has(slotId)) {
    next.delete(slotId);
  } else {
    next.add(slotId);
  }
  return next;
}

export function pruneCollapsedSlots(
  slots: ReadonlySet<string>,
  authoritativeSlotIds: ReadonlySet<string>
): Set<string> {
  return new Set(Array.from(slots).filter((slotId) => authoritativeSlotIds.has(slotId)));
}

export function formatSlotLabel(slotId: string): string {
  const knownLabel = KNOWN_SLOT_LABELS[slotId];
  if (knownLabel) {
    return knownLabel;
  }
  const readable = slotId
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .toLowerCase();
  if (!readable) {
    return 'Report';
  }
  return readable.charAt(0).toUpperCase() + readable.slice(1);
}
