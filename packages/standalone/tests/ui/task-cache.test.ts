import { describe, expect, it } from 'vitest';
import type { OperatorTask } from '../../ui/src/api/client';
import { updateTaskCache } from '../../ui/src/lib/task-cache';

function task(id: number, status: OperatorTask['status']): OperatorTask {
  return {
    id,
    title: `Task ${id}`,
    status,
    priority: 'normal',
    assignee: null,
    due_date: null,
    source_channel: null,
    latest_event: null,
    auto_created: false,
    confirmed: true,
    created_at: 1,
    updated_at: 2,
  };
}

describe('updateTaskCache', () => {
  it('moves an updated task between status caches and replaces it in the all cache', () => {
    const pendingTask = task(1, 'pending');
    const otherPendingTask = task(2, 'pending');
    const updatedTask = { ...pendingTask, status: 'done' as const, updated_at: 3 };

    expect(updateTaskCache({ tasks: [pendingTask, otherPendingTask] }, null, updatedTask)).toEqual({
      tasks: [updatedTask, otherPendingTask],
    });
    expect(
      updateTaskCache({ tasks: [pendingTask, otherPendingTask] }, 'pending', updatedTask)
    ).toEqual({
      tasks: [otherPendingTask],
    });
    expect(updateTaskCache({ tasks: [] }, 'done', updatedTask)).toEqual({
      tasks: [updatedTask],
    });
  });

  it('does not insert an updated task into an unrelated populated status cache', () => {
    const reviewTask = task(2, 'review');

    expect(updateTaskCache({ tasks: [reviewTask] }, 'review', task(1, 'done'))).toEqual({
      tasks: [reviewTask],
    });
  });
});
