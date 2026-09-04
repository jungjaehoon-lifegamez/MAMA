/**
 * Host-rendered pipeline slot.
 *
 * The pipeline is a projection of the task ledger, so the host renders it from the
 * ledger's own deadline_priority order and publishes it before the board turn runs.
 * The model writes judgment (briefing, action_required, decisions); it no longer
 * re-types a table the system already knows. No internal ids, no channel ids.
 */
import type { TaskRecord } from './task-ledger.js';

export const PIPELINE_SLOT_ROWS = 12;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function dDay(deadlineIso: string | null, nowMs: number): string {
  if (!deadlineIso) {
    return '-';
  }
  const days = Math.round((Date.parse(`${deadlineIso}T00:00:00Z`) - nowMs) / 86_400_000);
  return days >= 0 ? `D-${days}` : `D+${-days}`;
}

function sourceLabel(sourceChannel: string | null): string {
  if (!sourceChannel) {
    return '-';
  }
  const separator = sourceChannel.indexOf(':');
  // Only the connector name is displayable; the channel id is an internal key.
  return separator > 0 ? sourceChannel.slice(0, separator) : sourceChannel;
}

function statusBadge(row: TaskRecord, nowMs: number): string {
  const overdue = row.deadlineIso !== null && Date.parse(`${row.deadlineIso}T00:00:00Z`) < nowMs;
  if (overdue) {
    return 'badge-danger';
  }
  if (row.status === 'review') {
    return 'badge-warning';
  }
  if (row.assignee === null && row.deadlineIso !== null) {
    const days = (Date.parse(`${row.deadlineIso}T00:00:00Z`) - nowMs) / 86_400_000;
    if (days <= 7) {
      return 'badge-warning';
    }
  }
  return 'badge-info';
}

/**
 * `rows` must already be the ledger's deadline_priority page of NON-terminal owner tasks
 * (listPage({ includeTerminal: false, order: 'deadline_priority', limit: PIPELINE_SLOT_ROWS })).
 * `total` is that page's total so the slot can say how much of the ledger it shows.
 */
export function renderPipelineSlot(
  rows: readonly TaskRecord[],
  nowMs: number,
  total: number
): string {
  const shown = rows
    .filter((row) => row.status !== 'done' && row.status !== 'cancelled' && row.status !== 'failed')
    .slice(0, PIPELINE_SLOT_ROWS);
  const body = shown
    .map((row) => {
      const unconfirmed = row.autoCreated && !row.confirmed ? ' (unconfirmed)' : '';
      return (
        '<tr>' +
        `<td><span class="badge ${statusBadge(row, nowMs)}">${escapeHtml(row.status)}</span></td>` +
        `<td>${escapeHtml(row.title)}${unconfirmed}</td>` +
        `<td>${row.deadlineIso ?? '-'}</td>` +
        `<td>${dDay(row.deadlineIso, nowMs)}</td>` +
        `<td>${escapeHtml(row.assignee ?? 'unassigned')}</td>` +
        `<td>${escapeHtml(sourceLabel(row.sourceChannel))}</td>` +
        '</tr>'
      );
    })
    .join('');
  const coverage =
    total > shown.length
      ? `<p class="report-note">Showing ${shown.length} of ${total} active items (deadline first).</p>`
      : '';
  return (
    '<table class="report-table"><thead><tr>' +
    '<th>Status</th><th>Item</th><th>Deadline</th><th>D-day</th><th>Assignee</th><th>Source</th>' +
    `</tr></thead><tbody>${body}</tbody></table>${coverage}`
  );
}
