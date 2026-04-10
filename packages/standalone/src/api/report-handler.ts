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

export function createReportStore(): ReportStore {
  const slots = new Map<string, ReportSlot>();

  return {
    get(slotId: string): ReportSlot | undefined {
      return slots.get(slotId);
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
        result[key] = value;
      }
      return result;
    },

    getAllSorted(): ReportSlot[] {
      return Array.from(slots.values()).sort((a, b) => a.priority - b.priority);
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
