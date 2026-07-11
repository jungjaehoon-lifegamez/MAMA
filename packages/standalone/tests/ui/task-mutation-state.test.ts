import { describe, expect, it } from 'vitest';
import {
  finishTaskMutation,
  startTaskMutation,
  type TaskMutationState,
} from '../../ui/src/lib/task-mutation-state';

describe('task mutation state', () => {
  it('tracks concurrent pending mutations by task id', () => {
    let state: TaskMutationState = new Map();

    state = startTaskMutation(state, 1);
    state = startTaskMutation(state, 2);
    state = finishTaskMutation(state, 1);

    expect(state.get(1)).toBeUndefined();
    expect(state.get(2)).toEqual({ pending: true });
  });

  it('keeps an error associated with only the failed task', () => {
    let state: TaskMutationState = new Map();

    state = startTaskMutation(state, 1);
    state = startTaskMutation(state, 2);
    state = finishTaskMutation(state, 1, 'Task update failed');

    expect(state.get(1)).toEqual({ pending: false, error: 'Task update failed' });
    expect(state.get(2)).toEqual({ pending: true });
  });
});
