import type { TaskTemporalState } from '../api/client';

export type TaskTemporalCategory = 'closed' | 'upcoming' | 'due' | 'overdue' | 'unscheduled';

export interface TaskTemporalPresentationInput {
  temporalState: TaskTemporalState;
  dueAt: string | null;
  dueDate: string | null;
}

export interface TaskTemporalFormatOptions {
  locale?: string;
  timeZone?: string;
}

export interface TaskTemporalPresentation {
  category: TaskTemporalCategory;
  badgeLabel: string;
  dueLabel: string;
  fact: string;
}

function formatExactDueAt(value: string, options: TaskTemporalFormatOptions): string {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) {
    throw new Error(`task temporal due_at is invalid: ${value}`);
  }
  return new Intl.DateTimeFormat(options.locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: options.timeZone,
  }).format(instant);
}

function requireExactDueAt(input: TaskTemporalPresentationInput): string {
  if (!input.dueAt) {
    throw new Error(`task temporal state '${input.temporalState}' requires due_at`);
  }
  return input.dueAt;
}

function requireDueDate(input: TaskTemporalPresentationInput): string {
  if (!input.dueDate) {
    throw new Error(`task temporal state '${input.temporalState}' requires due_date`);
  }
  return input.dueDate;
}

function dueLabelForClosed(
  input: TaskTemporalPresentationInput,
  options: TaskTemporalFormatOptions
): string {
  if (input.dueAt) return formatExactDueAt(input.dueAt, options);
  return input.dueDate ?? '-';
}

export function presentTaskTemporal(
  input: TaskTemporalPresentationInput,
  options: TaskTemporalFormatOptions = {}
): TaskTemporalPresentation {
  switch (input.temporalState) {
    case 'closed':
      return {
        category: 'closed',
        badgeLabel: 'Closed',
        dueLabel: dueLabelForClosed(input, options),
        fact: 'Schedule closed',
      };
    case 'exact_upcoming': {
      const dueLabel = formatExactDueAt(requireExactDueAt(input), options);
      return { category: 'upcoming', badgeLabel: 'Upcoming', dueLabel, fact: `Due ${dueLabel}` };
    }
    case 'exact_overdue': {
      const dueLabel = formatExactDueAt(requireExactDueAt(input), options);
      return {
        category: 'overdue',
        badgeLabel: 'Overdue',
        dueLabel,
        fact: `Overdue since ${dueLabel}`,
      };
    }
    case 'date_upcoming': {
      const dueLabel = requireDueDate(input);
      return { category: 'upcoming', badgeLabel: 'Upcoming', dueLabel, fact: `Due ${dueLabel}` };
    }
    case 'date_due': {
      const dueLabel = requireDueDate(input);
      return {
        category: 'due',
        badgeLabel: 'Due today',
        dueLabel,
        fact: `Due today (${dueLabel})`,
      };
    }
    case 'date_overdue': {
      const dueLabel = requireDueDate(input);
      return {
        category: 'overdue',
        badgeLabel: 'Overdue',
        dueLabel,
        fact: `Overdue since ${dueLabel}`,
      };
    }
    case 'unscheduled':
      return {
        category: 'unscheduled',
        badgeLabel: 'Unscheduled',
        dueLabel: '-',
        fact: 'No due date',
      };
    default:
      throw new Error(`unknown task temporal_state: ${String(input.temporalState)}`);
  }
}
