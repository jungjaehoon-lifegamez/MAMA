import { describe, expect, it } from 'vitest';
import { renderPipelineSlot } from '../../src/operator/board-pipeline-render.js';
import type { TaskRecord } from '../../src/operator/task-ledger.js';

const NOW = Date.parse('2026-09-03T00:00:00Z');

function task(id: number, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    title: `Task ${id} <b>`,
    status: 'in_progress',
    priority: 'normal',
    deadline: null,
    createdAt: NOW - 10_000,
    updatedAt: NOW - id,
    kind: 'owner',
    deadlineIso: null,
    assignee: null,
    sourceChannel: 'trello:board-private-id',
    sourceEventId: `evt_${id}`,
    latestEvent: null,
    autoCreated: false,
    confirmed: true,
    dueAt: null,
    deadlineOffsetMinutes: null,
    revision: 1,
    temporalEpoch: 0,
    temporalReconciledOccurrenceKey: null,
    lastTemporalCheckedAt: null,
    nextTemporalCheckAt: null,
    lastTemporalAttemptId: null,
    temporalState: 'none',
    reviewStartedAt: null,
    reviewAnchorEventId: null,
    ...overrides,
  } as TaskRecord;
}

describe('Story ONE-MAMA-P1 Task 6: host-rendered pipeline slot', () => {
  it('AC #1 renders every active row with D-day, escaped titles and no internal ids', () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      task(i + 1, { deadlineIso: `2026-09-${String(1 + (i % 9)).padStart(2, '0')}` })
    );
    const html = renderPipelineSlot(rows, NOW, 40);
    expect(html).toContain('D+');
    expect(html).toContain('D-');
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('board-private-id');
    expect(html).not.toMatch(/\bevt_/);
    // All 15 provided rows are shown; the footer reports the ledger total when it is larger.
    expect(html.match(/<tr>/g)?.length).toBe(16);
    expect(html).toContain('Showing 15 of 40 active items');
    expect(html).toContain('<td>trello</td>');
  });

  it('AC #2 marks overdue as danger, review and unassigned-soon as warning, hides terminal rows', () => {
    const html = renderPipelineSlot(
      [
        task(1, { deadlineIso: '2026-09-01' }),
        task(2, { status: 'review', deadlineIso: '2026-09-20' }),
        task(3, { deadlineIso: '2026-09-05', assignee: null }),
        task(4, { deadlineIso: '2026-10-05', assignee: 'someone' }),
        task(5, { status: 'done', deadlineIso: '2026-09-01' }),
        task(6, { autoCreated: true, confirmed: false }),
      ],
      NOW,
      5
    );
    expect(html).toContain('badge-danger">in_progress');
    expect(html).toContain('badge-warning">review');
    expect(html.match(/badge-warning/g)?.length).toBe(2);
    expect(html).toContain('badge-info">in_progress');
    expect(html).not.toContain('Task 5');
    expect(html).toContain('Task 6 &lt;b&gt; (unconfirmed)');
    expect(html).not.toContain('Showing');
  });
});
