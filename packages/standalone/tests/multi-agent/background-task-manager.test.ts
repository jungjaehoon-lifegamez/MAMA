import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  BackgroundTaskManager,
  type BackgroundTask,
  type BackgroundTaskSubmitOptions,
  type BackgroundTaskEvent,
} from '../../src/multi-agent/background-task-manager.js';

function makeSubmitOpts(
  overrides: Partial<BackgroundTaskSubmitOptions> = {}
): BackgroundTaskSubmitOptions {
  return {
    description: overrides.description ?? 'Test task',
    prompt: overrides.prompt ?? 'Do the thing',
    agentId: overrides.agentId ?? 'developer',
    requestedBy: overrides.requestedBy ?? 'conductor',
    channelId: overrides.channelId ?? 'ch-1',
    source: overrides.source ?? 'discord',
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

type TaskExecutorFn = (agentId: string, prompt: string) => Promise<string>;

function mockExecutor(impl?: TaskExecutorFn): ReturnType<typeof vi.fn> & TaskExecutorFn {
  return (impl ? vi.fn(impl) : vi.fn().mockResolvedValue('result')) as ReturnType<typeof vi.fn> &
    TaskExecutorFn;
}

function neverResolveExecutor(): ReturnType<typeof vi.fn> & TaskExecutorFn {
  return vi.fn().mockReturnValue(new Promise(() => {})) as ReturnType<typeof vi.fn> &
    TaskExecutorFn;
}

describe('Story BTM-1: BackgroundTaskManager', () => {
  let executor: ReturnType<typeof vi.fn> & TaskExecutorFn;
  let manager: BackgroundTaskManager;

  beforeEach(() => {
    executor = mockExecutor();
    manager = new BackgroundTaskManager(executor, {
      maxConcurrentPerAgent: 2,
      maxTotalConcurrent: 5,
      staleTimeoutMs: 5000,
      maxQueueSize: 20,
    });
  });

  afterEach(() => {
    manager.removeAllListeners();
  });

  describe('AC #1: submit() creates a pending task', () => {
    it('should return a task with bg_ prefix ID', () => {
      const task = manager.submit(makeSubmitOpts());
      expect(task.id).toMatch(/^bg_[a-f0-9]{8}$/);
    });

    it('should return a task with status pending', () => {
      const task = manager.submit(makeSubmitOpts());
      expect(task.status).toBe('pending');
    });

    it('should copy all fields from submit options', () => {
      const opts = makeSubmitOpts({
        description: 'Auth fix',
        prompt: 'Fix JWT bug',
        agentId: 'reviewer',
        requestedBy: 'pm',
        channelId: 'ch-99',
        source: 'slack',
      });
      const task = manager.submit(opts);
      expect(task.description).toBe('Auth fix');
      expect(task.prompt).toBe('Fix JWT bug');
      expect(task.agentId).toBe('reviewer');
      expect(task.requestedBy).toBe('pm');
      expect(task.channelId).toBe('ch-99');
      expect(task.source).toBe('slack');
    });

    it('should set queuedAt to current time', () => {
      const before = Date.now();
      const task = manager.submit(makeSubmitOpts());
      const after = Date.now();
      expect(task.queuedAt).toBeGreaterThanOrEqual(before);
      expect(task.queuedAt).toBeLessThanOrEqual(after);
    });

    it('should add task to the pending queue', () => {
      manager.submit(makeSubmitOpts());
      const queued = manager.getQueuedTasks();
      expect(queued).toHaveLength(1);
    });

    it('should increment totalSubmitted in stats', () => {
      manager.submit(makeSubmitOpts());
      manager.submit(makeSubmitOpts());
      expect(manager.getStats().totalSubmitted).toBe(2);
    });

    it('should trigger queue processing via microtask', async () => {
      manager.submit(makeSubmitOpts());
      await flushMicrotasks();
      expect(executor).toHaveBeenCalledOnce();
    });
  });

  describe('AC #2: submit() throws when queue is full', () => {
    it('should throw when pending queue reaches maxQueueSize', () => {
      const smallManager = new BackgroundTaskManager(neverResolveExecutor(), {
        maxQueueSize: 3,
        maxTotalConcurrent: 0,
      });

      smallManager.submit(makeSubmitOpts());
      smallManager.submit(makeSubmitOpts());
      smallManager.submit(makeSubmitOpts());

      expect(() => smallManager.submit(makeSubmitOpts())).toThrow(/Queue full/);
    });

    it('should include queue size in error message', () => {
      const smallManager = new BackgroundTaskManager(neverResolveExecutor(), {
        maxQueueSize: 2,
        maxTotalConcurrent: 0,
      });
      smallManager.submit(makeSubmitOpts());
      smallManager.submit(makeSubmitOpts());

      expect(() => smallManager.submit(makeSubmitOpts())).toThrow('2/2');
    });
  });

  describe('AC #3: Queue processing respects maxConcurrentPerAgent', () => {
    it('should not start more tasks for an agent than maxConcurrentPerAgent', async () => {
      const neverResolve = neverResolveExecutor();
      const mgr = new BackgroundTaskManager(neverResolve, {
        maxConcurrentPerAgent: 2,
        maxTotalConcurrent: 10,
        maxQueueSize: 10,
      });

      mgr.submit(makeSubmitOpts({ agentId: 'dev' }));
      mgr.submit(makeSubmitOpts({ agentId: 'dev' }));
      mgr.submit(makeSubmitOpts({ agentId: 'dev' }));
      await flushMicrotasks();

      expect(mgr.getRunningTasks()).toHaveLength(2);
      expect(mgr.getQueuedTasks()).toHaveLength(1);
    });

    it('should allow different agents to run concurrently', async () => {
      const neverResolve = neverResolveExecutor();
      const mgr = new BackgroundTaskManager(neverResolve, {
        maxConcurrentPerAgent: 1,
        maxTotalConcurrent: 10,
        maxQueueSize: 10,
      });

      mgr.submit(makeSubmitOpts({ agentId: 'dev' }));
      mgr.submit(makeSubmitOpts({ agentId: 'reviewer' }));
      await flushMicrotasks();

      expect(mgr.getRunningTasks()).toHaveLength(2);
    });
  });

  describe('AC #4: Queue processing respects maxTotalConcurrent', () => {
    it('should not exceed maxTotalConcurrent across all agents', async () => {
      const neverResolve = neverResolveExecutor();
      const mgr = new BackgroundTaskManager(neverResolve, {
        maxConcurrentPerAgent: 5,
        maxTotalConcurrent: 2,
        maxQueueSize: 10,
      });

      mgr.submit(makeSubmitOpts({ agentId: 'a' }));
      mgr.submit(makeSubmitOpts({ agentId: 'b' }));
      mgr.submit(makeSubmitOpts({ agentId: 'c' }));
      await flushMicrotasks();

      expect(mgr.getRunningTasks()).toHaveLength(2);
      expect(mgr.getQueuedTasks()).toHaveLength(1);
    });
  });

  describe('AC #5: Task lifecycle pending → running → completed', () => {
    it('should transition from pending to running', async () => {
      const task = manager.submit(makeSubmitOpts());
      expect(task.status).toBe('pending');
      await flushMicrotasks();
      expect(task.status).toBe('running');
    });

    it('should set startedAt when task starts running', async () => {
      const task = manager.submit(makeSubmitOpts());
      await flushMicrotasks();
      expect(task.startedAt).toBeDefined();
      expect(task.startedAt).toBeGreaterThan(0);
    });

    it('should transition to completed on executor success', async () => {
      executor.mockResolvedValue('done!');
      const task = manager.submit(makeSubmitOpts());
      await flushMicrotasks();
      await vi.waitFor(() => {
        expect(task.status).toBe('completed');
      });
      expect(task.result).toBe('done!');
      expect(task.completedAt).toBeDefined();
      expect(task.duration).toBeDefined();
    });
  });

  describe('AC #6: Task lifecycle pending → running → failed', () => {
    it('should transition to failed on executor rejection', async () => {
      executor.mockRejectedValue(new Error('boom'));
      const task = manager.submit(makeSubmitOpts());
      await flushMicrotasks();
      await vi.waitFor(() => {
        expect(task.status).toBe('failed');
      });
      expect(task.error).toBe('boom');
      expect(task.completedAt).toBeDefined();
      expect(task.duration).toBeDefined();
    });

    it('should handle non-Error rejection values', async () => {
      executor.mockRejectedValue('string error');
      const task = manager.submit(makeSubmitOpts());
      await flushMicrotasks();
      await vi.waitFor(() => {
        expect(task.status).toBe('failed');
      });
      expect(task.error).toBe('string error');
    });
  });

  describe('AC #7: cancelTask() for pending tasks', () => {
    it('should cancel a pending task and remove from queue', () => {
      const neverResolve = neverResolveExecutor();
      const mgr = new BackgroundTaskManager(neverResolve, {
        maxTotalConcurrent: 0,
        maxQueueSize: 10,
      });
      const task = mgr.submit(makeSubmitOpts());
      const result = mgr.cancelTask(task.id);
      expect(result).toBe(true);
      expect(task.status).toBe('failed');
      expect(task.error).toBe('Cancelled');
      expect(mgr.getQueuedTasks()).toHaveLength(0);
    });

    it('should set completedAt on cancelled pending task', () => {
      const neverResolve = neverResolveExecutor();
      const mgr = new BackgroundTaskManager(neverResolve, {
        maxTotalConcurrent: 0,
        maxQueueSize: 10,
      });
      const task = mgr.submit(makeSubmitOpts());
      mgr.cancelTask(task.id);
      expect(task.completedAt).toBeDefined();
    });
  });

  describe('AC #8: cancelTask() for running tasks', () => {
    it('should cancel a running task and mark as failed', async () => {
      const neverResolve = neverResolveExecutor();
      const mgr = new BackgroundTaskManager(neverResolve, {
        maxConcurrentPerAgent: 5,
        maxTotalConcurrent: 5,
        maxQueueSize: 10,
      });
      const task = mgr.submit(makeSubmitOpts());
      await flushMicrotasks();
      expect(task.status).toBe('running');

      const result = mgr.cancelTask(task.id);
      expect(result).toBe(true);
      expect(task.status).toBe('failed');
      expect(task.error).toBe('Cancelled');
      expect(mgr.getRunningTasks()).toHaveLength(0);
    });

    it('should compute duration for cancelled running task', async () => {
      const neverResolve = neverResolveExecutor();
      const mgr = new BackgroundTaskManager(neverResolve, {
        maxConcurrentPerAgent: 5,
        maxTotalConcurrent: 5,
        maxQueueSize: 10,
      });
      const task = mgr.submit(makeSubmitOpts());
      await flushMicrotasks();
      mgr.cancelTask(task.id);
      expect(task.duration).toBeDefined();
      expect(task.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('AC #9: cancelTask() returns false for terminal/unknown tasks', () => {
    it('should return false for completed task', async () => {
      executor.mockResolvedValue('ok');
      const task = manager.submit(makeSubmitOpts());
      await flushMicrotasks();
      await vi.waitFor(() => {
        expect(task.status).toBe('completed');
      });
      expect(manager.cancelTask(task.id)).toBe(false);
    });

    it('should return false for already failed task', async () => {
      executor.mockRejectedValue(new Error('err'));
      const task = manager.submit(makeSubmitOpts());
      await flushMicrotasks();
      await vi.waitFor(() => {
        expect(task.status).toBe('failed');
      });
      expect(manager.cancelTask(task.id)).toBe(false);
    });

    it('should return false for unknown task ID', () => {
      expect(manager.cancelTask('bg_nonexistent')).toBe(false);
    });
  });

  describe('AC #10: getTask() returns task by ID', () => {
    it('should return the task when it exists', () => {
      const task = manager.submit(makeSubmitOpts());
      expect(manager.getTask(task.id)).toBe(task);
    });

    it('should return undefined for unknown ID', () => {
      expect(manager.getTask('bg_nope')).toBeUndefined();
    });
  });

  describe('AC #11: getResult() returns result for completed tasks', () => {
    it('should return result string for completed task', async () => {
      executor.mockResolvedValue('analysis done');
      const task = manager.submit(makeSubmitOpts());
      await flushMicrotasks();
      await vi.waitFor(() => {
        expect(task.status).toBe('completed');
      });
      expect(manager.getResult(task.id)).toBe('analysis done');
    });

    it('should return undefined for pending task', () => {
      const neverResolve = neverResolveExecutor();
      const mgr = new BackgroundTaskManager(neverResolve, {
        maxTotalConcurrent: 0,
        maxQueueSize: 10,
      });
      const task = mgr.submit(makeSubmitOpts());
      expect(mgr.getResult(task.id)).toBeUndefined();
    });

    it('should return undefined for failed task', async () => {
      executor.mockRejectedValue(new Error('fail'));
      const task = manager.submit(makeSubmitOpts());
      await flushMicrotasks();
      await vi.waitFor(() => {
        expect(task.status).toBe('failed');
      });
      expect(manager.getResult(task.id)).toBeUndefined();
    });

    it('should return undefined for unknown task ID', () => {
      expect(manager.getResult('bg_unknown')).toBeUndefined();
    });
  });

  describe('AC #12: getQueuedTasks() returns pending tasks in order', () => {
    it('should return tasks in FIFO queue order', () => {
      const neverResolve = neverResolveExecutor();
      const mgr = new BackgroundTaskManager(neverResolve, {
        maxTotalConcurrent: 0,
        maxQueueSize: 10,
      });

      const t1 = mgr.submit(makeSubmitOpts({ description: 'first' }));
      const t2 = mgr.submit(makeSubmitOpts({ description: 'second' }));
      const t3 = mgr.submit(makeSubmitOpts({ description: 'third' }));

      const queued = mgr.getQueuedTasks();
      expect(queued).toHaveLength(3);
      expect(queued[0].id).toBe(t1.id);
      expect(queued[1].id).toBe(t2.id);
      expect(queued[2].id).toBe(t3.id);
    });

    it('should return empty array when no pending tasks', () => {
      expect(manager.getQueuedTasks()).toHaveLength(0);
    });
  });

  describe('AC #13: getRunningTasks() returns running tasks', () => {
    it('should return tasks that are currently running', async () => {
      const neverResolve = neverResolveExecutor();
      const mgr = new BackgroundTaskManager(neverResolve, {
        maxConcurrentPerAgent: 5,
        maxTotalConcurrent: 5,
        maxQueueSize: 10,
      });
      mgr.submit(makeSubmitOpts());
      mgr.submit(makeSubmitOpts());
      await flushMicrotasks();

      const running = mgr.getRunningTasks();
      expect(running).toHaveLength(2);
      expect(running.every((t) => t.status === 'running')).toBe(true);
    });

    it('should return empty array when nothing is running', () => {
      expect(manager.getRunningTasks()).toHaveLength(0);
    });
  });

  describe('AC #14: getCompletedTasks() returns newest first', () => {
    it('should return completed tasks in reverse chronological order', async () => {
      const resolvers: Array<(v: string) => void> = [];
      executor.mockImplementation(() => {
        return new Promise<string>((resolve) => {
          resolvers.push(resolve);
        });
      });
      const t1 = manager.submit(makeSubmitOpts({ description: 'first' }));
      const t2 = manager.submit(makeSubmitOpts({ description: 'second' }));
      await flushMicrotasks();

      resolvers[0]('r1');
      await vi.waitFor(() => expect(t1.status).toBe('completed'));

      resolvers[1]('r2');
      await vi.waitFor(() => expect(t2.status).toBe('completed'));

      const completed = manager.getCompletedTasks();
      expect(completed).toHaveLength(2);
      expect(completed[0].id).toBe(t2.id);
      expect(completed[1].id).toBe(t1.id);
    });

    it('should include failed tasks in completed list', async () => {
      executor.mockRejectedValue(new Error('err'));
      const task = manager.submit(makeSubmitOpts());
      await flushMicrotasks();
      await vi.waitFor(() => expect(task.status).toBe('failed'));

      const completed = manager.getCompletedTasks();
      expect(completed).toHaveLength(1);
      expect(completed[0].status).toBe('failed');
    });
  });

  describe('AC #15: getStats() returns correct counts', () => {
    it('should count pending, running, completed, failed, totalSubmitted', async () => {
      const resolvers: Array<(v: string) => void> = [];
      const rejectors: Array<(e: Error) => void> = [];
      let callIndex = 0;
      executor.mockImplementation(() => {
        return new Promise<string>((resolve, reject) => {
          if (callIndex === 0) {
            resolvers.push(resolve);
          } else {
            rejectors.push(reject);
          }
          callIndex++;
        });
      });

      manager.submit(makeSubmitOpts());
      manager.submit(makeSubmitOpts());
      await flushMicrotasks();

      resolvers[0]('ok');
      await vi.waitFor(() => {
        const stats = manager.getStats();
        expect(stats.completed).toBe(1);
      });

      rejectors[0](new Error('fail'));
      await vi.waitFor(() => {
        const stats = manager.getStats();
        expect(stats.failed).toBe(1);
      });

      const stats = manager.getStats();
      expect(stats.pending).toBe(0);
      expect(stats.running).toBe(0);
      expect(stats.completed).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.totalSubmitted).toBe(2);
    });

    it('should return all zeros for fresh manager', () => {
      const stats = manager.getStats();
      expect(stats).toEqual({
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
        totalSubmitted: 0,
      });
    });
  });

  describe('AC #16: cleanupStale() marks stale running tasks as failed', () => {
    it('should mark stale tasks as failed', async () => {
      const neverResolve = neverResolveExecutor();
      const mgr = new BackgroundTaskManager(neverResolve, {
        staleTimeoutMs: 100,
        maxConcurrentPerAgent: 5,
        maxTotalConcurrent: 5,
        maxQueueSize: 10,
      });

      const task = mgr.submit(makeSubmitOpts());
      await flushMicrotasks();
      expect(task.status).toBe('running');

      await new Promise((r) => setTimeout(r, 150));

      const cleaned = mgr.cleanupStale();
      expect(cleaned).toBe(1);
      expect(task.status).toBe('failed');
      expect(task.error).toContain('Stale');
    });

    it('should not touch tasks within stale timeout', async () => {
      const neverResolve = neverResolveExecutor();
      const mgr = new BackgroundTaskManager(neverResolve, {
        staleTimeoutMs: 60000,
        maxConcurrentPerAgent: 5,
        maxTotalConcurrent: 5,
        maxQueueSize: 10,
      });

      mgr.submit(makeSubmitOpts());
      await flushMicrotasks();

      const cleaned = mgr.cleanupStale();
      expect(cleaned).toBe(0);
    });

    it('should emit task-failed for stale tasks', async () => {
      const neverResolve = neverResolveExecutor();
      const mgr = new BackgroundTaskManager(neverResolve, {
        staleTimeoutMs: 100,
        maxConcurrentPerAgent: 5,
        maxTotalConcurrent: 5,
        maxQueueSize: 10,
      });

      mgr.submit(makeSubmitOpts());
      await flushMicrotasks();

      const failedHandler = vi.fn();
      mgr.on('task-failed', failedHandler);

      await new Promise((r) => setTimeout(r, 150));
      mgr.cleanupStale();

      expect(failedHandler).toHaveBeenCalledOnce();
    });

    it('should remove stale tasks from runningSet', async () => {
      const neverResolve = neverResolveExecutor();
      const mgr = new BackgroundTaskManager(neverResolve, {
        staleTimeoutMs: 100,
        maxConcurrentPerAgent: 5,
        maxTotalConcurrent: 5,
        maxQueueSize: 10,
      });

      mgr.submit(makeSubmitOpts());
      await flushMicrotasks();
      expect(mgr.getRunningTasks()).toHaveLength(1);

      await new Promise((r) => setTimeout(r, 150));
      mgr.cleanupStale();
      expect(mgr.getRunningTasks()).toHaveLength(0);
    });
  });

  describe('AC #17: Event emissions', () => {
    it('should emit task-started when task begins executing', async () => {
      const handler = vi.fn();
      manager.on('task-started', handler);

      manager.submit(makeSubmitOpts());
      await flushMicrotasks();

      expect(handler).toHaveBeenCalledOnce();
      const event: BackgroundTaskEvent = handler.mock.calls[0][0];
      expect(event.task.status).toBe('running');
    });

    it('should emit task-completed with result', async () => {
      executor.mockResolvedValue('my result');
      const handler = vi.fn();
      manager.on('task-completed', handler);

      const task = manager.submit(makeSubmitOpts());
      await flushMicrotasks();
      await vi.waitFor(() => expect(task.status).toBe('completed'));

      expect(handler).toHaveBeenCalledOnce();
      const event: BackgroundTaskEvent = handler.mock.calls[0][0];
      expect(event.task.result).toBe('my result');
      expect(event.task.status).toBe('completed');
    });

    it('should emit task-failed with error', async () => {
      executor.mockRejectedValue(new Error('test error'));
      const handler = vi.fn();
      manager.on('task-failed', handler);

      const task = manager.submit(makeSubmitOpts());
      await flushMicrotasks();
      await vi.waitFor(() => expect(task.status).toBe('failed'));

      expect(handler).toHaveBeenCalledOnce();
      const event: BackgroundTaskEvent = handler.mock.calls[0][0];
      expect(event.task.error).toBe('test error');
      expect(event.task.status).toBe('failed');
    });

    it('should emit task-failed when a pending task is cancelled', () => {
      const neverResolve = neverResolveExecutor();
      const mgr = new BackgroundTaskManager(neverResolve, {
        maxTotalConcurrent: 0,
        maxQueueSize: 10,
      });
      const handler = vi.fn();
      mgr.on('task-failed', handler);

      const task = mgr.submit(makeSubmitOpts());
      mgr.cancelTask(task.id);

      expect(handler).toHaveBeenCalledOnce();
      const event: BackgroundTaskEvent = handler.mock.calls[0][0];
      expect(event.task.error).toBe('Cancelled');
    });
  });

  describe('AC #18: Completed retention evicts oldest when exceeding 50', () => {
    it('should evict oldest completed tasks beyond 50', async () => {
      const resolveAll: ((v: string) => void)[] = [];
      const evictExecutor = mockExecutor((_agentId: string, _prompt: string) => {
        return new Promise<string>((resolve) => {
          resolveAll.push(resolve);
        });
      });
      const mgr = new BackgroundTaskManager(evictExecutor, {
        maxConcurrentPerAgent: 60,
        maxTotalConcurrent: 60,
        maxQueueSize: 60,
      });

      const tasks: BackgroundTask[] = [];
      for (let i = 0; i < 55; i++) {
        tasks.push(mgr.submit(makeSubmitOpts({ description: `task-${i}` })));
        await flushMicrotasks();
      }

      for (let i = 0; i < resolveAll.length; i++) {
        resolveAll[i](`result-${i}`);
      }

      await vi.waitFor(() => {
        const completed = mgr.getCompletedTasks();
        expect(completed.length).toBe(50);
      });

      const firstTask = tasks[0];
      expect(mgr.getTask(firstTask.id)).toBeUndefined();
    });
  });

  describe('AC #19: Concurrent execution', () => {
    it('should run multiple tasks in parallel up to limits', async () => {
      const neverResolve = neverResolveExecutor();
      const mgr = new BackgroundTaskManager(neverResolve, {
        maxConcurrentPerAgent: 5,
        maxTotalConcurrent: 3,
        maxQueueSize: 10,
      });

      for (let i = 0; i < 5; i++) {
        mgr.submit(makeSubmitOpts({ agentId: `agent-${i}` }));
      }
      await flushMicrotasks();

      expect(mgr.getRunningTasks()).toHaveLength(3);
      expect(mgr.getQueuedTasks()).toHaveLength(2);
    });
  });

  describe('AC #20: _processQueue dequeues next when running completes', () => {
    it('should start queued tasks when running tasks complete', async () => {
      const resolvers: Array<(v: string) => void> = [];
      executor.mockImplementation(() => {
        return new Promise<string>((resolve) => {
          resolvers.push(resolve);
        });
      });

      const mgr = new BackgroundTaskManager(executor, {
        maxConcurrentPerAgent: 5,
        maxTotalConcurrent: 1,
        maxQueueSize: 10,
      });

      const t1 = mgr.submit(makeSubmitOpts({ description: 'task-1' }));
      const t2 = mgr.submit(makeSubmitOpts({ description: 'task-2' }));
      await flushMicrotasks();

      expect(t1.status).toBe('running');
      expect(t2.status).toBe('pending');

      resolvers[0]('done-1');
      await vi.waitFor(() => expect(t1.status).toBe('completed'));
      await vi.waitFor(() => expect(t2.status).toBe('running'));
    });

    it('should dequeue after stale cleanup frees slots', async () => {
      const neverResolve = neverResolveExecutor();
      const mgr = new BackgroundTaskManager(neverResolve, {
        staleTimeoutMs: 100,
        maxConcurrentPerAgent: 5,
        maxTotalConcurrent: 1,
        maxQueueSize: 10,
      });

      mgr.submit(makeSubmitOpts({ description: 'stale-task' }));
      mgr.submit(makeSubmitOpts({ description: 'queued-task' }));
      await flushMicrotasks();

      expect(mgr.getRunningTasks()).toHaveLength(1);
      expect(mgr.getQueuedTasks()).toHaveLength(1);

      await new Promise((r) => setTimeout(r, 150));
      mgr.cleanupStale();

      await flushMicrotasks();
      expect(mgr.getRunningTasks()).toHaveLength(1);
      expect(mgr.getRunningTasks()[0].description).toBe('queued-task');
    });
  });

  describe('AC #21: Edge cases', () => {
    it('should generate unique IDs for each task', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const task = manager.submit(makeSubmitOpts());
        ids.add(task.id);
      }
      expect(ids.size).toBe(20);
    });

    it('should pass correct agentId and prompt to executor', async () => {
      manager.submit(makeSubmitOpts({ agentId: 'myAgent', prompt: 'myPrompt' }));
      await flushMicrotasks();
      expect(executor).toHaveBeenCalledWith('myAgent', 'myPrompt');
    });

    it('should not complete a task that was already cancelled', async () => {
      let taskResolve: (v: string) => void;
      executor.mockImplementation(() => {
        return new Promise<string>((resolve) => {
          taskResolve = resolve;
        });
      });

      const task = manager.submit(makeSubmitOpts());
      await flushMicrotasks();
      expect(task.status).toBe('running');

      manager.cancelTask(task.id);
      expect(task.status).toBe('failed');

      taskResolve!('late result');
      await flushMicrotasks();
      expect(task.status).toBe('failed');
      expect(task.result).toBeUndefined();
    });
  });
});
