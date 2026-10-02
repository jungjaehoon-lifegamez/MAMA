import type { OperatorTask, TaskStatus } from '../api/client';
import { presentTaskTemporal, type TaskTemporalCategory } from '../lib/task-temporal';
import { formatRelativeTime } from '../lib/time';

const STATUS_CLASSES: Record<TaskStatus, string> = {
  pending: 'bg-surface-secondary text-text-secondary',
  in_progress: 'bg-agent-light text-agent-strong',
  review: 'bg-warning-soft text-warning-text',
  blocked: 'bg-warning-soft text-warning-text',
  done: 'bg-success-soft text-success-text',
  cancelled: 'bg-surface-secondary text-text-secondary',
};

const PRIORITY_CLASSES = {
  high: 'bg-warning-soft text-warning-text',
  normal: 'bg-surface-secondary text-text-secondary',
  low: 'bg-surface-secondary text-text-secondary',
};

const TEMPORAL_CLASSES: Record<TaskTemporalCategory, string> = {
  closed: 'bg-surface-secondary text-text-tertiary',
  upcoming: 'bg-agent-light text-agent-strong',
  due: 'bg-warning-soft text-warning-text',
  overdue: 'bg-danger/10 text-danger',
  unscheduled: 'bg-surface-secondary text-text-tertiary',
};

interface TaskRowProps {
  task: OperatorTask;
  now: number;
  onOpenDetails: (task: OperatorTask, opener: HTMLElement) => void;
}

function statusLabel(status: TaskStatus): string {
  return status.replace('_', ' ');
}

export default function TaskRow({ task, now, onOpenDetails }: TaskRowProps) {
  const unconfirmed = task.auto_created && !task.confirmed;
  const temporal = presentTaskTemporal({
    temporalState: task.temporal_state,
    dueAt: task.due_at,
    dueDate: task.due_date,
  });

  return (
    <tr id={`task-${task.id}`} className="scroll-mt-4 border-b border-border last:border-0">
      <td className="px-3 py-3 text-xs font-medium text-text-secondary whitespace-nowrap">
        #{task.id}
      </td>
      <td className="px-3 py-3 min-w-56">
        <div className="text-sm font-medium text-text">{task.title}</div>
        {unconfirmed && (
          <div className="mt-0.5 text-[11px] font-medium text-warning-text">(unconfirmed)</div>
        )}
        {task.latest_event && (
          <div className="mt-1 max-w-80 truncate text-[11px] text-text-secondary">
            {task.latest_event}
          </div>
        )}
      </td>
      <td className="px-3 py-3 whitespace-nowrap">
        <span
          className={`rounded-full px-2 py-1 text-xs font-medium ${STATUS_CLASSES[task.status]}`}
        >
          {statusLabel(task.status)}
        </span>
      </td>
      <td className="px-3 py-3 whitespace-nowrap">
        <span
          className={`rounded-full px-2 py-1 text-xs font-medium ${PRIORITY_CLASSES[task.priority]}`}
        >
          {task.priority}
        </span>
      </td>
      <td className="px-3 py-3 text-xs text-text-secondary whitespace-nowrap">
        {task.assignee || 'unassigned'}
      </td>
      <td className="px-3 py-3 text-xs text-text-secondary whitespace-nowrap">
        <div>{temporal.dueLabel}</div>
      </td>
      <td className="px-3 py-3 text-xs text-text-secondary whitespace-nowrap">
        <span
          className={`rounded-full px-2 py-1 text-[11px] font-medium ${TEMPORAL_CLASSES[temporal.category]}`}
        >
          {temporal.badgeLabel}
        </span>
        <div className="text-[11px] text-text-secondary">{temporal.fact}</div>
      </td>
      <td className="px-3 py-3 max-w-48 truncate text-xs text-text-secondary">
        {task.source_channel || '-'}
      </td>
      <td className="px-3 py-3 text-xs text-text-secondary whitespace-nowrap">
        {formatRelativeTime(now, task.updated_at)}
      </td>
      <td className="px-3 py-3 whitespace-nowrap">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label={`View details for task ${task.id}`}
            onClick={(event) => onOpenDetails(task, event.currentTarget)}
            className="rounded-lg border border-border bg-surface-secondary px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-hover focus:ring-2 focus:ring-agent-strong"
          >
            View details
          </button>
        </div>
      </td>
    </tr>
  );
}
