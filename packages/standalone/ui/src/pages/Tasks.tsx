import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type OperatorTask, type TaskPatch, type TaskStatus } from '../api/client';
import TaskDrawer from '../components/TaskDrawer';
import TaskRow from '../components/TaskRow';
import { updateTaskCache, type OperatorTasksCache } from '../lib/task-cache';
import { scrollTaskHashIntoView } from '../lib/task-scroll';
import { positiveTaskId } from '../lib/task-selection';
import {
  finishTaskMutation,
  startTaskMutation,
  type TaskMutationState,
} from '../lib/task-mutation-state';

const STATUS_FILTERS: Array<{ value: TaskStatus | null; label: string }> = [
  { value: null, label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'review', label: 'Review' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
];

interface MutationInput {
  task: OperatorTask;
  patch: TaskPatch;
}

export default function Tasks({
  focusTaskId,
  selectionNonce,
  onSelectTask,
}: {
  focusTaskId?: number;
  selectionNonce?: number;
  /** In-content selection change; the host turns it into `?task=<id>`. */
  onSelectTask?: (taskId: number | undefined) => void;
}) {
  const [selectedStatus, setSelectedStatus] = useState<TaskStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [mutationStates, setMutationStates] = useState<TaskMutationState>(() => new Map());
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(
    () => positiveTaskId(focusTaskId) ?? null
  );
  const [drawerOpener, setDrawerOpener] = useState<HTMLElement | null>(null);
  const [unresolvedTaskId, setUnresolvedTaskId] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const scrolledHashRef = useRef<string | null>(null);
  const firstFilterRef = useRef<HTMLButtonElement>(null);
  const query = useQuery({
    queryKey: ['operatorTasks', selectedStatus],
    queryFn: () => api.listTasks({ status: selectedStatus ?? undefined, limit: 50 }),
    refetchInterval: 30_000,
  });
  const mutation = useMutation({
    mutationFn: ({ task, patch }: MutationInput) => api.updateTask(task.id, patch),
    onMutate: ({ task }) => {
      setMutationStates((current) => startTaskMutation(current, task.id));
    },
    onSuccess: ({ task: updated }, { task }) => {
      const cachedQueries = queryClient.getQueriesData<OperatorTasksCache>({
        queryKey: ['operatorTasks'],
      });
      for (const [queryKey, cached] of cachedQueries) {
        if (!cached) {
          continue;
        }
        const status = queryKey[1] as TaskStatus | null;
        queryClient.setQueryData(queryKey, updateTaskCache(cached, status, updated));
      }
      setMutationStates((current) => finishTaskMutation(current, task.id));
      void queryClient.invalidateQueries({ queryKey: ['operatorTasks'] });
    },
    onError: (error, { task }) => {
      const message = error instanceof Error ? error.message : 'Task update failed';
      setMutationStates((current) => finishTaskMutation(current, task.id, message));
    },
  });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // A host update re-delivers the selection even when it is unchanged (the
  // same task, navigated to twice). Forget what we already scrolled to, or the
  // second navigation would be a no-op.
  useEffect(() => {
    scrolledHashRef.current = null;
  }, [focusTaskId, selectionNonce]);

  useEffect(() => {
    if (!query.data?.tasks.length) {
      return;
    }
    // The host document owns the URL; a focused task arrives as a prop and the
    // hash is only the fallback for a directly addressed page.
    scrolledHashRef.current = scrollTaskHashIntoView(
      focusTaskId === undefined ? window.location.hash : `#task-${focusTaskId}`,
      scrolledHashRef.current,
      (id) => document.getElementById(id)
    );
  }, [focusTaskId, query.data, selectionNonce]);

  // A host-delivered selection opens the drawer; anything that is not a
  // positive integer id is ignored, and the same id delivered twice still
  // counts, hence the nonce. The host cannot deselect: closing is in-content.
  useEffect(() => {
    const requested = positiveTaskId(focusTaskId);
    if (requested !== undefined) {
      setUnresolvedTaskId(null);
      setSelectedTaskId(requested);
    }
  }, [focusTaskId, selectionNonce]);

  const tasks = query.data?.tasks ?? [];
  const selectedTask =
    selectedTaskId === null ? null : (tasks.find((task) => task.id === selectedTaskId) ?? null);

  // A selected id the loaded page does not answer (outside the newest 50, moved
  // out by a status filter or a refetch, deleted) must not leave a phantom
  // selection behind. Closing silently would read as a bug, so say why.
  useEffect(() => {
    if (!query.data || selectedTaskId === null || selectedTask) {
      return;
    }
    setUnresolvedTaskId(selectedTaskId);
    setSelectedTaskId(null);
    window.queueMicrotask(() => {
      if (drawerOpener?.isConnected) {
        drawerOpener.focus();
      } else {
        firstFilterRef.current?.focus();
      }
    });
  }, [drawerOpener, query.data, selectedTask, selectedTaskId]);

  const patchTask = (task: OperatorTask, patch: TaskPatch) => {
    mutation.mutate({ task, patch });
  };

  const openDetails = (task: OperatorTask, opener: HTMLElement) => {
    setUnresolvedTaskId(null);
    setDrawerOpener(opener);
    setSelectedTaskId(task.id);
    onSelectTask?.(task.id);
  };

  const closeDetails = () => {
    setSelectedTaskId(null);
    setDrawerOpener(null);
    onSelectTask?.(undefined);
  };

  return (
    <div className="flex min-h-full min-w-0 flex-col">
      <header className="border-b border-border bg-surface px-4 py-4">
        <h1 className="text-base font-semibold text-text">Tasks</h1>
        <p className="mt-1 text-xs text-text-secondary">
          Native operator ledger with workflow and temporal state shown separately.
        </p>
      </header>

      <div className="flex-1 p-4">
        <div className="mx-auto max-w-6xl">
          <div className="mb-4 flex flex-wrap gap-2" aria-label="Filter tasks by status">
            {STATUS_FILTERS.map((filter, index) => {
              const active = selectedStatus === filter.value;
              return (
                <button
                  key={filter.label}
                  ref={index === 0 ? firstFilterRef : undefined}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSelectedStatus(filter.value)}
                  className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                    active
                      ? 'bg-agent text-on-agent hover:bg-agent-hover'
                      : 'bg-surface text-text-secondary hover:bg-surface-hover'
                  }`}
                >
                  {filter.label}
                </button>
              );
            })}
          </div>

          {unresolvedTaskId !== null && (
            <div
              role="status"
              className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-text-secondary"
            >
              <span>Task #{unresolvedTaskId} is not in the current view.</span>
              <button
                type="button"
                onClick={() => setUnresolvedTaskId(null)}
                className="shrink-0 rounded-lg border border-border bg-surface-secondary px-2 py-1 text-[11px] font-medium text-text-secondary hover:bg-surface-hover focus:ring-2 focus:ring-agent-strong"
              >
                Dismiss
              </button>
            </div>
          )}

          <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-xs)]">
            {query.isPending ? (
              <div className="px-4 py-16 text-center text-sm text-text-tertiary">
                Loading tasks...
              </div>
            ) : query.isError ? (
              <div className="px-4 py-16 text-center text-sm text-warning-text">
                {query.error instanceof Error ? query.error.message : 'Unable to load tasks'}
              </div>
            ) : query.data.tasks.length === 0 ? (
              <div className="px-4 py-16 text-center">
                <div className="text-sm font-medium text-text">No tasks found</div>
                <div className="mt-1 text-xs text-text-tertiary">
                  Try another status filter or wait for the ledger to update.
                </div>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="task-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Task</th>
                      <th>Status</th>
                      <th>Priority</th>
                      <th>Assignee</th>
                      <th>Due</th>
                      <th>Temporal</th>
                      <th>Source</th>
                      <th>Updated</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.tasks.map((task) => {
                      const mutationState = mutationStates.get(task.id);
                      return (
                        <TaskRow
                          key={task.id}
                          task={task}
                          now={now}
                          pending={mutationState?.pending === true}
                          error={mutationState?.error}
                          onPatch={patchTask}
                          onOpenDetails={openDetails}
                        />
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {selectedTask && (
        <TaskDrawer
          task={selectedTask}
          now={now}
          opener={drawerOpener}
          fallbackFocusRef={firstFilterRef}
          onDismiss={closeDetails}
        />
      )}
    </div>
  );
}
