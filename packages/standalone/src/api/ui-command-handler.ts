/**
 * UI Command Queue — bidirectional Agent↔Viewer communication
 *
 * Ported from SmartStore's NavigationContext + Layout command polling pattern.
 * - Viewer → Agent: POST /api/ui/page-context (current page state)
 * - Agent → Viewer: GET /api/ui/commands (1s polling, drain on read)
 * - Agent push:      POST /api/ui/commands (queue a command)
 */

import type { ServerResponse } from 'node:http';

export interface UICommand {
  id?: string;
  type: 'navigate' | 'notify' | 'suggest_change' | 'refresh';
  payload: Record<string, unknown>;
}

export interface UICommandAck {
  command_ids: string[];
}

export interface PageContext {
  currentRoute: string;
  channelId?: string;
  selectedItem?: { type: string; id: string };
  pageData?: Record<string, unknown>;
}

const MAX_QUEUE = 50;
const VIEWER_FRONTDOOR_CHANNEL_ID = 'mama_os_main';
const LEGACY_VIEWER_SESSION_PREFIX = 'session_';
const COMMAND_REDELIVERY_MS = 4000;

type QueuedUICommand = {
  id: string;
  type: UICommand['type'];
  payload: Record<string, unknown>;
  delivered_at: number | null;
};

export class UICommandQueue {
  private commands: QueuedUICommand[] = [];
  private pageContext: PageContext | null = null;
  private pageContexts = new Map<string, PageContext>();
  private nextCommandSeq = 0;

  push(cmd: UICommand): UICommand {
    const queued: QueuedUICommand = {
      id: cmd.id ?? `ui_${Date.now()}_${++this.nextCommandSeq}`,
      type: cmd.type,
      payload: cmd.payload,
      delivered_at: null,
    };
    this.commands.push(queued);
    if (this.commands.length > MAX_QUEUE) {
      this.commands = this.commands.slice(-MAX_QUEUE);
    }
    return {
      id: queued.id,
      type: queued.type,
      payload: queued.payload,
    };
  }

  drain(): UICommand[] {
    const now = Date.now();
    const cmds = this.commands.filter(
      (cmd) => cmd.delivered_at === null || now - cmd.delivered_at >= COMMAND_REDELIVERY_MS
    );
    for (const cmd of cmds) {
      cmd.delivered_at = now;
    }
    return cmds.map((cmd) => ({
      id: cmd.id,
      type: cmd.type,
      payload: cmd.payload,
    }));
  }

  ack(commandIds: string[]): void {
    const ids = new Set(commandIds);
    this.commands = this.commands.filter((cmd) => !ids.has(cmd.id));
  }

  setPageContext(ctx: PageContext): void {
    this.pageContext = ctx;
    if (ctx.channelId) {
      this.pageContexts.set(ctx.channelId, ctx);
      if (ctx.channelId.startsWith(LEGACY_VIEWER_SESSION_PREFIX)) {
        this.pageContexts.set(VIEWER_FRONTDOOR_CHANNEL_ID, {
          ...ctx,
          channelId: VIEWER_FRONTDOOR_CHANNEL_ID,
        });
      }
    }
  }

  getPageContext(channelId?: string): PageContext | null {
    if (channelId) {
      return this.pageContexts.get(channelId) ?? null;
    }
    return this.pageContext;
  }
}

// ── HTTP Handlers ───────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isValidPageContext(body: unknown): body is PageContext {
  if (!isRecord(body) || typeof body.currentRoute !== 'string') {
    return false;
  }
  if (body.channelId !== undefined && typeof body.channelId !== 'string') {
    return false;
  }
  if (body.selectedItem !== undefined) {
    if (
      !isRecord(body.selectedItem) ||
      typeof body.selectedItem.type !== 'string' ||
      typeof body.selectedItem.id !== 'string'
    ) {
      return false;
    }
  }
  if (body.pageData !== undefined && !isRecord(body.pageData)) {
    return false;
  }
  return true;
}

function isValidUICommand(body: unknown): body is UICommand {
  if (!isRecord(body)) {
    return false;
  }
  if (!['navigate', 'notify', 'suggest_change', 'refresh'].includes(String(body.type))) {
    return false;
  }
  if (!isRecord(body.payload)) {
    return false;
  }
  return true;
}

function isValidUICommandAck(body: unknown): body is UICommandAck {
  if (!isRecord(body) || !Array.isArray(body.command_ids)) {
    return false;
  }
  return body.command_ids.every((id) => typeof id === 'string' && id.length > 0);
}

/** GET /api/ui/commands — viewer drains pending commands */
export function handleGetUICommands(res: ServerResponse, queue: UICommandQueue): void {
  json(res, 200, { commands: queue.drain() });
}

/** GET /api/ui/page-context — agent reads current viewer state */
export function handleGetPageContext(res: ServerResponse, queue: UICommandQueue): void {
  const ctx = queue.getPageContext();
  json(res, 200, { success: true, context: ctx });
}

/** POST /api/ui/page-context — viewer reports current page state */
export function handlePostPageContext(
  res: ServerResponse,
  body: PageContext,
  queue: UICommandQueue
): void {
  if (!isValidPageContext(body)) {
    json(res, 400, { error: 'invalid payload' });
    return;
  }
  queue.setPageContext(body);
  json(res, 200, { success: true });
}

/** POST /api/ui/commands — agent pushes a UI command */
export function handlePostUICommand(
  res: ServerResponse,
  body: UICommand,
  queue: UICommandQueue
): void {
  if (!isValidUICommand(body)) {
    json(res, 400, { error: 'invalid payload' });
    return;
  }
  queue.push(body);
  json(res, 200, { success: true });
}

/** POST /api/ui/commands/ack — viewer acknowledges applied commands */
export function handlePostUICommandAck(
  res: ServerResponse,
  body: UICommandAck,
  queue: UICommandQueue
): void {
  if (!isValidUICommandAck(body)) {
    json(res, 400, { error: 'invalid payload' });
    return;
  }
  queue.ack(body.command_ids);
  json(res, 200, { success: true, acknowledged: body.command_ids.length });
}
