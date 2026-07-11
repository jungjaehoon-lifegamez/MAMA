export interface TaskMutationStatus {
  pending: boolean;
  error?: string;
}

export type TaskMutationState = Map<number, TaskMutationStatus>;

export function startTaskMutation(state: TaskMutationState, taskId: number): TaskMutationState {
  const next = new Map(state);
  next.set(taskId, { pending: true });
  return next;
}

export function finishTaskMutation(
  state: TaskMutationState,
  taskId: number,
  error?: string
): TaskMutationState {
  const next = new Map(state);
  if (error) {
    next.set(taskId, { pending: false, error });
  } else {
    next.delete(taskId);
  }
  return next;
}
