import type { OperatorTask, TaskPatch, TaskStatus } from '../api/client';
import { presentTaskTemporal, type TaskTemporalCategory } from '../lib/task-temporal';
import { formatRelativeTime } from '../lib/time';

const TASK_STATUSES: TaskStatus[] = [
  'pending',
  'in_progress',
  'review',
  'blocked',
  'done',
  'cancelled',
];

const STATUS_CLASSES: Record<TaskStatus, string> = {
  pending: 'bg-surface-secondary text-text-secondary',
  in_progress: 'bg-agent-light text-agent-hover dark:text-agent',
  review: 'bg-warning-soft text-warning-text',
  blocked: 'bg-warning-soft text-warning-text',
  done: 'bg-success-soft text-success-text',
  cancelled: 'bg-surface-secondary text-text-secondary dark:text-text-tertiary',
};

const PRIORITY_CLASSES = {
  high: 'bg-warning-soft text-warning-text',
  normal: 'bg-surface-secondary text-text-secondary',
  low: 'bg-surface-secondary text-text-secondary dark:text-text-tertiary',
};

const TEMPORAL_CLASSES: Record<TaskTemporalCategory, string> = {
  closed: 'bg-surface-secondary text-text-tertiary',
  upcoming: 'bg-agent-light text-agent-hover dark:text-agent',
  due: 'bg-warning-soft text-warning-text',
  overdue: 'bg-danger/10 text-danger',
  unscheduled: 'bg-surface-secondary text-text-tertiary',
};

interface TaskRowProps {
  task: OperatorTask;
  now: number;
  pending: boolean;
  error?: string;
  onPatch: (task: OperatorTask, patch: TaskPatch) => void;
}

function statusLabel(status: TaskStatus): string {
  return status.replace('_', ' ');
}

export default function TaskRow({ task, now, pending, error, onPatch }: TaskRowProps) {
  const unconfirmed = task.auto_created && !task.confirmed;
  const temporal = presentTaskTemporal({
    temporalState: task.temporal_state,
    dueAt: task.due_at,
    dueDate: task.due_date,
  });

  return (
    <tr id={`task-${task.id}`} className="scroll-mt-4 border-b border-border last:border-0">
      <td className="px-3 py-3 text-xs font-medium text-text-secondary dark:text-text-tertiary whitespace-nowrap">
        #{task.id}
      </td>
      <td className="px-3 py-3 min-w-56">
        <div className="text-sm font-medium text-text">{task.title}</div>
        {unconfirmed && (
          <div className="mt-0.5 text-[11px] font-medium text-warning-text">(unconfirmed)</div>
        )}
        {task.latest_event && (
          <div className="mt-1 max-w-80 truncate text-[11px] text-text-secondary dark:text-text-tertiary">
            {task.latest_event}
          </div>
        )}
      </td>
      <td className="px-3 py-3 whitespace-nowrap">
        <select
          aria-label={`Status for task ${task.id}`}
          value={task.status}
          disabled={pending}
          onChange={(event) => onPatch(task, { status: event.target.value as TaskStatus })}
          className={`rounded-full border-0 px-2 py-1 text-xs font-medium disabled:opacity-50 ${STATUS_CLASSES[task.status]}`}
        >
          {TASK_STATUSES.map((status) => (
            <option key={status} value={status}>
              {statusLabel(status)}
            </option>
          ))}
        </select>
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
        <div className="text-[11px] text-text-secondary dark:text-text-tertiary">
          {temporal.fact}
        </div>
      </td>
      <td className="px-3 py-3 max-w-48 truncate text-xs text-text-secondary">
        {task.source_channel || '-'}
      </td>
      <td className="px-3 py-3 text-xs text-text-secondary dark:text-text-tertiary whitespace-nowrap">
        {formatRelativeTime(now, task.updated_at)}
      </td>
      <td className="px-3 py-3 whitespace-nowrap">
        {unconfirmed && (
          <button
            type="button"
            disabled={pending}
            onClick={() => onPatch(task, { confirmed: true })}
            className="rounded-lg bg-agent-hover px-2.5 py-1.5 text-xs font-medium text-on-agent hover:bg-agent-hover dark:bg-agent disabled:opacity-50"
          >
            {pending ? 'Saving...' : 'Approve'}
          </button>
        )}
        {error && (
          <div
            role="alert"
            className="mt-1 max-w-48 whitespace-normal text-[11px] text-warning-text"
          >
            {error}
          </div>
        )}
      </td>
    </tr>
  );
}
