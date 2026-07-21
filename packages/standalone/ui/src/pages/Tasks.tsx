import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type OperatorTask, type TaskPatch, type TaskStatus } from '../api/client';
import TaskRow from '../components/TaskRow';
import { updateTaskCache, type OperatorTasksCache } from '../lib/task-cache';
import { scrollTaskHashIntoView } from '../lib/task-scroll';
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

export default function Tasks() {
  const [selectedStatus, setSelectedStatus] = useState<TaskStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [mutationStates, setMutationStates] = useState<TaskMutationState>(() => new Map());
  const queryClient = useQueryClient();
  const scrolledHashRef = useRef<string | null>(null);
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

  useEffect(() => {
    if (!query.data?.tasks.length) {
      return;
    }
    scrolledHashRef.current = scrollTaskHashIntoView(
      window.location.hash,
      scrolledHashRef.current,
      (id) => document.getElementById(id)
    );
  }, [query.data]);

  const patchTask = (task: OperatorTask, patch: TaskPatch) => {
    mutation.mutate({ task, patch });
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
            {STATUS_FILTERS.map((filter) => {
              const active = selectedStatus === filter.value;
              return (
                <button
                  key={filter.label}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSelectedStatus(filter.value)}
                  className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                    active
                      ? 'bg-agent-hover text-on-agent dark:bg-agent'
                      : 'bg-surface text-text-secondary hover:bg-surface-hover'
                  }`}
                >
                  {filter.label}
                </button>
              );
            })}
          </div>

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
    </div>
  );
}
