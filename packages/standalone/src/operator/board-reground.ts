/**
 * Board re-ground: the text block a fresh conductor session reads before its
 * first judgment. Built from the SAME ledger surface `task_list` serves
 * (listPage, kind='owner'), paged to completeness per open status - a capped
 * single page could silently hide the very card the next judgment needs, and
 * a "whole board" claim must rest on a whole read.
 */
import type { TaskLedger } from './task-ledger.js';
import type { TaskRecord } from './task-ledger.js';
import type { TaskStatus } from './task-ledger.js';

const OPEN_STATUSES: TaskStatus[] = ['pending', 'in_progress', 'review'];

export function buildBoardReground(ledger: TaskLedger, cap = 60): string {
  const open: TaskRecord[] = [];
  for (const status of OPEN_STATUSES) {
    let cursor: string | undefined;
    // Pagination-complete: accumulate until nextCursor is null.
    for (;;) {
      const page = ledger.listPage({ status, order: 'updated', limit: 200, cursor });
      open.push(...page.tasks);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
  }
  open.sort((a, b) =>
    a.updatedAt === b.updatedAt ? b.id - a.id : a.updatedAt < b.updatedAt ? 1 : -1
  );

  const shown = open.slice(0, cap);
  const lines = shown.map((t) => `- #${t.id} [${t.status}] ${t.title}`);
  if (open.length === 0) {
    lines.push('(no open tasks)');
  } else if (open.length > cap) {
    lines.push(`(+${open.length - cap} more open)`);
  }
  return ['[BOARD REGROUND]', ...lines, '[/BOARD REGROUND]'].join('\n');
}
