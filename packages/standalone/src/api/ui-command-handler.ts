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
  type: 'navigate' | 'notify' | 'suggest_change' | 'refresh';
  payload: Record<string, unknown>;
}

export interface PageContext {
  currentRoute: string;
  selectedItem?: { type: string; id: string };
  pageData?: Record<string, unknown>;
}

const MAX_QUEUE = 50;

export class UICommandQueue {
  private commands: UICommand[] = [];
  private pageContext: PageContext | null = null;

  push(cmd: UICommand): void {
    this.commands.push(cmd);
    if (this.commands.length > MAX_QUEUE) {
      this.commands = this.commands.slice(-MAX_QUEUE);
    }
  }

  drain(): UICommand[] {
    const cmds = this.commands;
    this.commands = [];
    return cmds;
  }

  setPageContext(ctx: PageContext): void {
    this.pageContext = ctx;
  }

  getPageContext(): PageContext | null {
    return this.pageContext;
  }
}

// ── HTTP Handlers ───────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** GET /api/ui/commands — viewer drains pending commands */
export function handleGetUICommands(res: ServerResponse, queue: UICommandQueue): void {
  json(res, 200, { commands: queue.drain() });
}

/** POST /api/ui/page-context — viewer reports current page state */
export function handlePostPageContext(
  res: ServerResponse,
  body: PageContext,
  queue: UICommandQueue
): void {
  queue.setPageContext(body);
  json(res, 200, { success: true });
}

/** POST /api/ui/commands — agent pushes a UI command */
export function handlePostUICommand(
  res: ServerResponse,
  body: UICommand,
  queue: UICommandQueue
): void {
  queue.push(body);
  json(res, 200, { success: true });
}
