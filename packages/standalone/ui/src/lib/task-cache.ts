import type { OperatorTask, TaskStatus } from '../api/client';

export interface OperatorTasksCache {
  tasks: OperatorTask[];
}

export function updateTaskCache(
  cached: OperatorTasksCache,
  status: TaskStatus | null,
  updated: OperatorTask
): OperatorTasksCache {
  const existingIndex = cached.tasks.findIndex((task) => task.id === updated.id);
  const matchesFilter = status === null || status === updated.status;

  if (!matchesFilter) {
    return existingIndex === -1
      ? cached
      : { tasks: cached.tasks.filter((task) => task.id !== updated.id) };
  }

  if (existingIndex === -1) return { tasks: [updated, ...cached.tasks] };
  return {
    tasks: cached.tasks.map((task) => (task.id === updated.id ? updated : task)),
  };
}
