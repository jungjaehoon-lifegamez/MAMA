import { Router, type Request, type Response } from 'express';
import type { ServerResponse } from 'node:http';
import { DebugLogger } from '@jungjaehoon/mama-core/debug-logger';

const reportLogger = new DebugLogger('Report');

export interface ReportSlot {
  slotId: string;
  html: string;
  priority: number;
  updatedAt: number;
  /** Task-ledger basis of authored analysis, never inferred from publish time. */
  basisRevision?: string | null;
  currentBasisRevision?: string;
  freshness?: 'current' | 'stale' | 'unknown';
}

export interface TaskFactProjection {
  basisRevision: string;
  html: string;
}

export interface ReportUpdateOptions {
  basisRevision?: string | null;
}

export interface ReportStore {
  get(slotId: string): ReportSlot | undefined;
  update(slotId: string, html: string, priority: number, options?: ReportUpdateOptions): void;
  delete(slotId: string): void;
  getAll(): Record<string, ReportSlot>;
  getAllSorted(): ReportSlot[];
  setTaskProjectionProvider(
    provider: (() => TaskFactProjection) | null,
    onRefresh?: (slots: ReportSlot[]) => void
  ): void;
  refreshTaskProjection(): boolean;
}

export interface ReportPublishResult {
  acceptedSlotIds: string[];
  changedSlotIds: string[];
}

export function createReportStore(
  options: {
    initialSlots?: Readonly<Record<string, ReportSlot>>;
    onChange?: (slots: Record<string, ReportSlot>) => void;
  } = {}
): ReportStore {
  const slots = new Map<string, ReportSlot>(
    Object.entries(options.initialSlots ?? {}).map(([id, slot]) => [id, { ...slot }])
  );
  let projectionProvider: (() => TaskFactProjection) | null = null;
  let projectionObserver: ((slots: ReportSlot[]) => void) | undefined;
  let currentBasis: string | undefined;
  let refreshing = false;
  const snapshot = (): Record<string, ReportSlot> =>
    Object.fromEntries(Array.from(slots, ([id, slot]) => [id, { ...slot }]));
  const sorted = (): ReportSlot[] =>
    Array.from(slots.values(), (slot) => ({ ...slot })).sort((a, b) => a.priority - b.priority);
  const changed = (): void => options.onChange?.(snapshot());
  const assertBasis = (basis: string): void => {
    if (typeof basis !== 'string' || !basis.trim() || basis !== basis.trim()) {
      throw new Error('Report basisRevision must be a non-empty canonical string');
    }
  };
  const freshness = (basis: string | null | undefined): ReportSlot['freshness'] =>
    basis === null || basis === undefined
      ? 'unknown'
      : basis === currentBasis
        ? 'current'
        : 'stale';
  const refreshTaskProjection = (): boolean => {
    if (!projectionProvider || refreshing) {
      return false;
    }
    refreshing = true;
    try {
      const projection = projectionProvider();
      assertBasis(projection.basisRevision);
      if (typeof projection.html !== 'string') {
        throw new Error('Task projection HTML is required');
      }
      currentBasis = projection.basisRevision;
      let didChange = false;
      const pipeline = slots.get('pipeline');
      if (
        !pipeline ||
        pipeline.html !== projection.html ||
        pipeline.basisRevision !== currentBasis ||
        pipeline.currentBasisRevision !== currentBasis ||
        pipeline.freshness !== 'current'
      ) {
        slots.set('pipeline', {
          slotId: 'pipeline',
          html: projection.html,
          priority: pipeline?.priority ?? 3,
          updatedAt: Date.now(),
          basisRevision: currentBasis,
          currentBasisRevision: currentBasis,
          freshness: 'current',
        });
        didChange = true;
      }
      for (const [id, slot] of slots) {
        if (id === 'pipeline') {
          continue;
        }
        const basis = slot.basisRevision ?? null;
        const state = freshness(basis);
        if (
          slot.basisRevision !== basis ||
          slot.currentBasisRevision !== currentBasis ||
          slot.freshness !== state
        ) {
          slots.set(id, {
            ...slot,
            basisRevision: basis,
            currentBasisRevision: currentBasis,
            freshness: state,
          });
          didChange = true;
        }
      }
      if (didChange) {
        changed();
        projectionObserver?.(sorted());
      }
      return didChange;
    } finally {
      refreshing = false;
    }
  };

  return {
    get(slotId: string): ReportSlot | undefined {
      refreshTaskProjection();
      const slot = slots.get(slotId);
      return slot ? { ...slot } : undefined;
    },

    update(
      slotId: string,
      html: string,
      priority: number,
      updateOptions?: ReportUpdateOptions
    ): void {
      if (projectionProvider && slotId === 'pipeline') {
        throw new Error('pipeline is a managed task projection; update the task ledger instead');
      }
      if (updateOptions?.basisRevision !== null && updateOptions?.basisRevision !== undefined) {
        assertBasis(updateOptions.basisRevision);
      }
      const basis = updateOptions?.basisRevision ?? null;
      slots.set(slotId, {
        slotId,
        html,
        priority,
        updatedAt: Date.now(),
        ...(projectionProvider || updateOptions?.basisRevision !== undefined
          ? {
              basisRevision: basis,
              ...(currentBasis
                ? { currentBasisRevision: currentBasis, freshness: freshness(basis) }
                : {}),
            }
          : {}),
      });
      changed();
    },

    delete(slotId: string): void {
      if (projectionProvider && slotId === 'pipeline') {
        throw new Error('pipeline is a managed task projection; update the task ledger instead');
      }
      slots.delete(slotId);
      changed();
    },

    getAll(): Record<string, ReportSlot> {
      refreshTaskProjection();
      return snapshot();
    },

    getAllSorted(): ReportSlot[] {
      refreshTaskProjection();
      return sorted();
    },
    setTaskProjectionProvider(provider, onRefresh) {
      projectionProvider = provider;
      projectionObserver = onRefresh;
      refreshTaskProjection();
    },
    refreshTaskProjection,
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
    const accepted: string[] = [];
    const changed: string[] = [];
    for (const [slotId, html] of entries.slice(0, MAX_SLOTS_PER_PUBLISH)) {
      if (Buffer.byteLength(html, 'utf-8') > MAX_SLOT_BYTES) {
        console.warn(`[Report] slot '${slotId}' exceeds ${MAX_SLOT_BYTES} bytes -- skipped`);
        continue;
      }
      accepted.push(slotId);
      const existing = store.get(slotId);
      if (
        existing?.html === html &&
        (options?.basisRevision === undefined || existing.basisRevision === options.basisRevision)
      ) {
        continue;
      }
      if (options === undefined) {
        store.update(slotId, html, existing?.priority ?? 0);
      } else {
        store.update(slotId, html, existing?.priority ?? 0, options);
      }
      changed.push(slotId);
    }
    if (changed.length > 0) {
      broadcastReportUpdate(sseClients, { slots: store.getAllSorted() });
      reportLogger.info(`published slots: ${changed.join(', ')}`);
    }
    return {
      acceptedSlotIds: accepted.sort(),
      changedSlotIds: changed.sort(),
    };
  };
}

/**
 * Create an Express Router that exposes report slot CRUD + SSE stream.
 */
export function createReportRouter(store: ReportStore, sseClients: Set<ServerResponse>): Router {
  const router = Router();

  // GET / — list all slots sorted by priority
  router.get('/', (_req: Request, res: Response) => {
    res.json({ slots: store.getAllSorted() });
  });

  // GET /events — SSE stream
  router.get('/events', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const raw = res as unknown as ServerResponse;
    sseClients.add(raw);

    req.on('close', () => {
      sseClients.delete(raw);
    });
  });

  // PUT / — bulk update
  router.put('/', (req: Request, res: Response) => {
    const body = req.body as {
      slots?: Record<string, { html: string; priority?: number; basisRevision?: string | null }>;
    };
    const incoming = body?.slots ?? {};
    for (const [id, { html, priority = 0, basisRevision }] of Object.entries(incoming)) {
      store.update(id, html, priority, { basisRevision });
    }
    broadcastReportUpdate(sseClients, { slots: store.getAllSorted() });
    res.json({ ok: true });
  });

  // PUT /slots/:slotId — single update
  router.put('/slots/:slotId', (req: Request<{ slotId: string }>, res: Response) => {
    const slotId = req.params.slotId as string;
    const {
      html,
      priority = 0,
      basisRevision,
    } = req.body as { html: string; priority?: number; basisRevision?: string | null };
    store.update(slotId, html, priority, { basisRevision });
    broadcastReportUpdate(sseClients, { slots: store.getAllSorted() });
    res.json({ ok: true, slot: slotId });
  });

  // DELETE /slots/:slotId — delete a slot
  router.delete('/slots/:slotId', (req: Request<{ slotId: string }>, res: Response) => {
    const slotId = req.params.slotId as string;
    store.delete(slotId);
    broadcastReportUpdate(sseClients, { deleted: slotId });
    res.json({ ok: true });
  });

  return router;
}
