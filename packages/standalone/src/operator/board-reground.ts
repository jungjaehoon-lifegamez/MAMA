/**
 * Board re-ground: the text block a fresh conductor session reads before its
 * first judgment. Built from the SAME ledger surface `task_list` serves
 * (listPage, kind='owner').
 *
 * Bounded by construction: one page of `cap` per open status. listPage's
 * 'updated' order matches the merge sort exactly, so the global top-cap is
 * provably contained in the union of the per-status top-cap pages - no
 * unbounded cursor loop (review: the loop was quadratic on the status
 * partition and its cursor path had no coverage). The honest total for the
 * "(+N more open)" line comes from the pages' own `total` counts.
 *
 * Titles are agent-authored from untrusted channel text and this block lands
 * at maximum prompt authority on every fresh session, so each title line is
 * sanitized: newlines collapsed, close-marker occurrences broken.
 */
import type { TaskLedger, TaskRecord, TaskStatus } from './task-ledger.js';

const OPEN_STATUSES: TaskStatus[] = ['pending', 'in_progress', 'review'];
const CLOSE_MARKER = '[/BOARD REGROUND]';

function sanitizeTitle(title: string): string {
  return title
    .replace(/[\r\n]+/g, ' ')
    .split(CLOSE_MARKER)
    .join('[/BOARD-REGROUND]');
}

export function buildBoardReground(ledger: TaskLedger, cap = 60): string {
  const open: TaskRecord[] = [];
  let total = 0;
  for (const status of OPEN_STATUSES) {
    const page = ledger.listPage({ status, order: 'updated', limit: cap });
    open.push(...page.tasks);
    total += page.total;
  }
  open.sort((a, b) =>
    a.updatedAt === b.updatedAt ? b.id - a.id : a.updatedAt < b.updatedAt ? 1 : -1
  );

  const shown = open.slice(0, cap);
  const lines = shown.map((t) => `- #${t.id} [${t.status}] ${sanitizeTitle(t.title)}`);
  if (total === 0) {
    lines.push('(no open tasks)');
  } else if (total > shown.length) {
    lines.push(`(+${total - shown.length} more open)`);
  }
  return ['[BOARD REGROUND]', ...lines, CLOSE_MARKER].join('\n');
}
