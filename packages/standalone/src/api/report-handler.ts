import { Router, type Request, type Response } from 'express';
import type { ServerResponse } from 'node:http';

export interface ReportSlot {
  slotId: string;
  html: string;
  priority: number;
  updatedAt: number;
}

export interface ReportStore {
  get(slotId: string): ReportSlot | undefined;
  update(slotId: string, html: string, priority: number): void;
  delete(slotId: string): void;
  getAll(): Record<string, ReportSlot>;
  getAllSorted(): ReportSlot[];
}

export interface ReportPublishResult {
  acceptedSlotIds: string[];
  changedSlotIds: string[];
}

export function createReportStore(): ReportStore {
  const slots = new Map<string, ReportSlot>();

  return {
    get(slotId: string): ReportSlot | undefined {
      const slot = slots.get(slotId);
      return slot ? { ...slot } : undefined;
    },

    update(slotId: string, html: string, priority: number): void {
      slots.set(slotId, {
        slotId,
        html,
        priority,
        updatedAt: Date.now(),
      });
    },

    delete(slotId: string): void {
      slots.delete(slotId);
    },

    getAll(): Record<string, ReportSlot> {
      const result: Record<string, ReportSlot> = {};
      for (const [key, value] of slots) {
        result[key] = { ...value };
      }
      return result;
    },

    getAllSorted(): ReportSlot[] {
      return Array.from(slots.values(), (slot) => ({ ...slot })).sort(
        (a, b) => a.priority - b.priority
      );
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

const MAX_SLOT_BYTES = 65_536;
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
): (slots: Record<string, string>) => ReportPublishResult {
  return (slots) => {
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
      if (existing?.html === html) {
        continue;
      }
      store.update(slotId, html, existing?.priority ?? 0);
      changed.push(slotId);
    }
    if (changed.length > 0) {
      broadcastReportUpdate(sseClients, { slots: store.getAllSorted() });
      console.log(`[Report] published slots: ${changed.join(', ')}`);
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
    const body = req.body as { slots?: Record<string, { html: string; priority?: number }> };
    const incoming = body?.slots ?? {};
    for (const [id, { html, priority = 0 }] of Object.entries(incoming)) {
      store.update(id, html, priority);
    }
    broadcastReportUpdate(sseClients, { slots: store.getAllSorted() });
    res.json({ ok: true });
  });

  // PUT /slots/:slotId — single update
  router.put('/slots/:slotId', (req: Request<{ slotId: string }>, res: Response) => {
    const slotId = req.params.slotId as string;
    const { html, priority = 0 } = req.body as { html: string; priority?: number };
    store.update(slotId, html, priority);
    broadcastReportUpdate(sseClients, { slot: slotId, html, priority });
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
