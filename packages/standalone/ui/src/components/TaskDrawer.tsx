import { useEffect, useRef, type RefObject } from 'react';
import type { OperatorTask, TaskStatus } from '../api/client';
import DrawerDetail from './DrawerDetail';
import { shouldShowModal } from '../lib/trigger-drawer-state';
import { lockScrollBehind } from '../lib/scroll-lock';
import { presentTaskTemporal } from '../lib/task-temporal';
import { formatRelativeTime } from '../lib/time';

const STATUS_CLASSES: Record<TaskStatus, string> = {
  pending: 'bg-surface-secondary text-text-secondary',
  in_progress: 'bg-agent-light text-agent-strong',
  review: 'bg-warning-soft text-warning-text',
  blocked: 'bg-warning-soft text-warning-text',
  done: 'bg-success-soft text-success-text',
  cancelled: 'bg-surface-secondary text-text-secondary',
};

/**
 * What the drawer says when the ledger row carries no evidence link. The
 * drawer is bounded on purpose: it shows the fields the task row already
 * persists and never fetches raw channel messages behind them.
 */
const NO_SOURCE = 'No linked source recorded';

interface TaskDrawerProps {
  task: OperatorTask;
  now: number;
  opener: HTMLElement | null;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onDismiss: () => void;
}

function absoluteTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export default function TaskDrawer({
  task,
  now,
  opener,
  fallbackFocusRef,
  onDismiss,
}: TaskDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (shouldShowModal(dialog.open)) {
      dialog.showModal();
      closeButtonRef.current?.focus();
    }

    return lockScrollBehind(dialog);
  }, [task.id]);

  const requestClose = () => {
    if (dialogRef.current?.open) {
      dialogRef.current.close();
    }
  };

  // Escape reaches the dialog as `cancel`; both paths land here, so focus
  // returns to the row button that opened the drawer either way.
  const handleClose = () => {
    onDismiss();
    window.queueMicrotask(() => {
      if (opener?.isConnected) {
        opener.focus();
      } else {
        fallbackFocusRef.current?.focus();
      }
    });
  };

  const temporal = presentTaskTemporal({
    temporalState: task.temporal_state,
    dueAt: task.due_at,
    dueDate: task.due_date,
  });

  return (
    <dialog
      ref={dialogRef}
      className="task-drawer"
      aria-labelledby="task-drawer-title"
      aria-describedby="task-drawer-description"
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onClose={handleClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          requestClose();
        }
      }}
    >
      <div className="flex h-full min-h-0 flex-col bg-surface text-text">
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id="task-drawer-title" className="break-words text-lg font-semibold text-text">
              #{task.id} {task.title}
            </h2>
            <p id="task-drawer-description" className="mt-1 text-xs text-text-secondary">
              Ledger record for this task. No channel transcript is read.
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            autoFocus
            onClick={requestClose}
            className="shrink-0 rounded-lg border border-border bg-surface-secondary px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-hover focus:ring-2 focus:ring-agent-strong"
          >
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
          <section aria-labelledby="task-status-heading">
            <h3 id="task-status-heading" className="text-sm font-semibold text-text">
              Status
            </h3>
            <dl className="mt-3 grid grid-cols-2 gap-4">
              <DrawerDetail label="Workflow status">
                <span
                  className={`rounded-full px-2 py-1 text-xs font-medium ${STATUS_CLASSES[task.status]}`}
                >
                  {task.status.replace('_', ' ')}
                </span>
              </DrawerDetail>
              <DrawerDetail label="Priority">{task.priority}</DrawerDetail>
              <DrawerDetail label="Assignee">{task.assignee || 'unassigned'}</DrawerDetail>
              <DrawerDetail label="Owner confirmation">
                {task.auto_created
                  ? task.confirmed
                    ? 'Auto-created, confirmed'
                    : 'Auto-created, unconfirmed'
                  : 'Owner-created'}
              </DrawerDetail>
            </dl>
          </section>

          <section aria-labelledby="task-schedule-heading">
            <h3 id="task-schedule-heading" className="text-sm font-semibold text-text">
              Schedule
            </h3>
            <dl className="mt-3 space-y-3">
              <DrawerDetail label="Temporal state">
                {temporal.badgeLabel} - {temporal.fact}
              </DrawerDetail>
              <DrawerDetail label="Due">{temporal.dueLabel}</DrawerDetail>
              <DrawerDetail label="Created">{absoluteTime(task.created_at)}</DrawerDetail>
              <DrawerDetail label="Updated">
                {absoluteTime(task.updated_at)} ({formatRelativeTime(now, task.updated_at)})
              </DrawerDetail>
            </dl>
          </section>

          <section aria-labelledby="task-source-heading">
            <h3 id="task-source-heading" className="text-sm font-semibold text-text">
              Source evidence
            </h3>
            <dl className="mt-3 space-y-3">
              <DrawerDetail label="Source channel">{task.source_channel || NO_SOURCE}</DrawerDetail>
            </dl>
            <p className="mt-2 text-xs text-text-secondary">
              The channel this task was recorded from. Messages are not loaded here.
            </p>
          </section>

          <section aria-labelledby="task-ledger-heading">
            <h3 id="task-ledger-heading" className="text-sm font-semibold text-text">
              Recent ledger context
            </h3>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm text-text-secondary">
              {task.latest_event || NO_SOURCE}
            </p>
          </section>
        </div>
      </div>
    </dialog>
  );
}
