import { describe, expect, it } from 'vitest';
import {
  presentTaskTemporal,
  type TaskTemporalPresentationInput,
} from '../../ui/src/lib/task-temporal';

function input(
  temporalState: TaskTemporalPresentationInput['temporalState'],
  dueAt: string | null = null,
  dueDate: string | null = null
): TaskTemporalPresentationInput {
  return { temporalState, dueAt, dueDate };
}

describe('Story A2 Task 11: task temporal presentation', () => {
  it.each([
    ['closed', 'closed', 'Closed', 'Schedule closed'],
    ['date_upcoming', 'upcoming', 'Upcoming', 'Due 2026-07-22'],
    ['date_due', 'due', 'Due today', 'Due today (2026-07-21)'],
    ['date_overdue', 'overdue', 'Overdue', 'Overdue since 2026-07-20'],
    ['unscheduled', 'unscheduled', 'Unscheduled', 'No due date'],
  ] as const)(
    'maps %s from the server state without reading workflow status',
    (state, category, label, fact) => {
      const dueDate = state.startsWith('date_')
        ? (fact.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null)
        : null;
      expect(presentTaskTemporal(input(state, null, dueDate))).toMatchObject({
        category,
        badgeLabel: label,
        fact,
      });
    }
  );

  it('formats an exact upcoming instant in the selected local time zone', () => {
    const dueAt = '2026-07-21T05:00:00.000Z';
    const expected = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Seoul',
    }).format(new Date(dueAt));

    expect(
      presentTaskTemporal(input('exact_upcoming', dueAt, '2026-07-21'), {
        locale: 'en-US',
        timeZone: 'Asia/Seoul',
      })
    ).toMatchObject({
      category: 'upcoming',
      badgeLabel: 'Upcoming',
      dueLabel: expected,
      fact: `Due ${expected}`,
    });
  });

  it('renders exact overdue as a temporal fact without changing lifecycle state', () => {
    const dueAt = '2026-07-21T05:00:00.000Z';
    const expected = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Seoul',
    }).format(new Date(dueAt));

    expect(
      presentTaskTemporal(input('exact_overdue', dueAt, '2026-07-21'), {
        locale: 'en-US',
        timeZone: 'Asia/Seoul',
      })
    ).toEqual({
      category: 'overdue',
      badgeLabel: 'Overdue',
      dueLabel: expected,
      fact: `Overdue since ${expected}`,
    });
  });

  it('fails loudly when an exact or date state lacks its canonical due value', () => {
    expect(() => presentTaskTemporal(input('exact_overdue'))).toThrow(/due_at/);
    expect(() => presentTaskTemporal(input('date_due'))).toThrow(/due_date/);
  });
});
