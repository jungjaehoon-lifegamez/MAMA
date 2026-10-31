import type { ServerResponse } from 'node:http';
import { DebugLogger } from '@jungjaehoon/mama-core/debug-logger';

const reportLogger = new DebugLogger('Report');

export interface ReportSlot {
  slotId: string;
  html: string;
  priority: number;
  updatedAt: number;
  /** The action that last wrote this slot; absent on snapshots predating trace attribution. */
  operationId?: string | null;
  modelRunId?: string | null;
}

export interface ReportUpdateOptions {
  operationId?: string | null;
  modelRunId?: string | null;
}

export interface ReportStore {
  get(slotId: string): ReportSlot | undefined;
  /** Whether report.publish may author this slot under the current store binding. */
  isPublishable(slotId: string): boolean;
  update(slotId: string, html: string, priority: number, options?: ReportUpdateOptions): void;
  /** Commit one agent-authored batch before reporting publication success. */
  publishBatch(
    updates: readonly {
      slotId: string;
      html: string;
      priority: number;
      options?: ReportUpdateOptions;
    }[]
  ): void;
  getAll(): Record<string, ReportSlot>;
  getAllSorted(): ReportSlot[];
}

export interface ReportPublishResult {
  acceptedSlotIds: string[];
  changedSlotIds: string[];
}

export function createReportStore(
  options: {
    initialSlots?: Readonly<Record<string, ReportSlot>>;
    onChange?: (slots: Record<string, ReportSlot>) => void;
    beforePublish?: (slots: Record<string, ReportSlot>) => void;
  } = {}
): ReportStore {
  let slots = new Map<string, ReportSlot>(
    Object.entries(options.initialSlots ?? {}).map(([id, slot]) => [id, { ...slot }])
  );
  const snapshot = (): Record<string, ReportSlot> =>
    Object.fromEntries(Array.from(slots, ([id, slot]) => [id, { ...slot }]));
  const sorted = (): ReportSlot[] =>
    Array.from(slots.values(), (slot) => ({ ...slot })).sort((a, b) => a.priority - b.priority);
  const changed = (): void => options.onChange?.(snapshot());
  const authoredSlot = (
    slotId: string,
    html: string,
    priority: number,
    updateOptions?: ReportUpdateOptions
  ): ReportSlot => {
    return {
      slotId,
      html,
      priority,
      updatedAt: Date.now(),
      ...(updateOptions?.operationId === undefined
        ? {}
        : { operationId: updateOptions.operationId }),
      ...(updateOptions?.modelRunId === undefined ? {} : { modelRunId: updateOptions.modelRunId }),
    };
  };

  return {
    isPublishable(_slotId: string): boolean {
      return true;
    },
    get(slotId: string): ReportSlot | undefined {
      const slot = slots.get(slotId);
      return slot ? { ...slot } : undefined;
    },

    update(
      slotId: string,
      html: string,
      priority: number,
      updateOptions?: ReportUpdateOptions
    ): void {
      slots.set(slotId, authoredSlot(slotId, html, priority, updateOptions));
      changed();
    },

    publishBatch(updates): void {
      if (updates.length === 0) {
        return;
      }
      const staged = new Map(slots);
      for (const update of updates) {
        staged.set(
          update.slotId,
          authoredSlot(update.slotId, update.html, update.priority, update.options)
        );
      }
      const next = Object.fromEntries(Array.from(staged, ([id, slot]) => [id, { ...slot }]));
      options.beforePublish?.(next);
      slots = staged;
      options.onChange?.(next);
    },

    getAll(): Record<string, ReportSlot> {
      return snapshot();
    },

    getAllSorted(): ReportSlot[] {
      return sorted();
    },
  };
}

/**
 * Broadcast an SSE-formatted payload to all connected clients.
 */
export function broadcastReportUpdate(
  clients: Set<ServerResponse>,
  data: Record<string, unknown>
): void {
  const payload = `event: report-update\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

// 64 KB dropped the whole-board pipeline slot silently past ~280 rows, leaving the owner a
// stale table with no error (review of #258). The viewer renders HTML; SSE carries it fine.
const MAX_SLOT_BYTES = 512 * 1024;
const MAX_SLOTS_PER_PUBLISH = 24;

/**
 * The single write path for agent/heartbeat report publishing: accept every valid slot
 * (any slot id -- the board renders known slots first, then custom), persist changed HTML,
 * and broadcast one full snapshot only when something changed. Oversized slots are skipped
 * LOUDLY, never truncated silently (observability over restriction).
 */
export function createReportPublisher(
  store: ReportStore,
  sseClients: Set<ServerResponse>
): (slots: Record<string, string>, options?: ReportUpdateOptions) => ReportPublishResult {
  return (slots, options) => {
    const entries = Object.entries(slots);
    if (entries.length > MAX_SLOTS_PER_PUBLISH) {
      console.warn(
        `[Report] publish carried ${entries.length} slots; keeping the first ${MAX_SLOTS_PER_PUBLISH}`
      );
    }
    const publishableEntries = entries.slice(0, MAX_SLOTS_PER_PUBLISH).filter(([slotId, html]) => {
      if (Buffer.byteLength(html, 'utf-8') > MAX_SLOT_BYTES) {
        console.warn(`[Report] slot '${slotId}' exceeds ${MAX_SLOT_BYTES} bytes -- skipped`);
        return false;
      }
      return true;
    });
    const accepted: string[] = [];
    const changed: string[] = [];
    const batch: Array<{
      slotId: string;
      html: string;
      priority: number;
      options?: ReportUpdateOptions;
    }> = [];
    for (const [slotId, html] of publishableEntries) {
      accepted.push(slotId);
      const existing = store.get(slotId);
      if (existing?.html === html) {
        continue;
      }
      batch.push({
        slotId,
        html,
        priority: existing?.priority ?? 0,
        ...(options ? { options } : {}),
      });
      changed.push(slotId);
    }
    if (changed.length > 0) {
      store.publishBatch(batch);
      broadcastReportUpdate(sseClients, { slots: store.getAllSorted() });
      reportLogger.info(`published slots: ${changed.join(', ')}`);
    }
    return {
      acceptedSlotIds: accepted.sort(),
      changedSlotIds: changed.sort(),
    };
  };
}
