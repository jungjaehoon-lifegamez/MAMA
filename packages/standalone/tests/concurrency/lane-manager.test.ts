/**
 * LaneManager Tests
 *
 * Tests for the lane-based concurrency system
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  LaneManager,
  getGlobalLaneManager,
  resetGlobalLaneManager,
} from '../../src/concurrency/lane-manager.js';

// Helper to create delay
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Silent logger for tests
const silentLogger = {
  debug: () => {},
  warn: () => {},
  error: () => {},
};

describe('LaneManager', () => {
  beforeEach(() => {
    resetGlobalLaneManager();
  });

  describe('basic enqueue', () => {
    it('should execute a single task', async () => {
      const manager = new LaneManager({ logger: silentLogger });
      const result = await manager.enqueue('test', async () => 'hello');
      expect(result).toBe('hello');
    });

    it('should return task result correctly', async () => {
      const manager = new LaneManager({ logger: silentLogger });
      const result = await manager.enqueue('test', async () => {
        return { value: 42, status: 'ok' };
      });
      expect(result).toEqual({ value: 42, status: 'ok' });
    });

    it('should propagate errors', async () => {
      const manager = new LaneManager({ logger: silentLogger });
      await expect(
        manager.enqueue('test', async () => {
          throw new Error('Task failed');
        })
      ).rejects.toThrow('Task failed');
    });
  });

  describe('sequential execution (same lane)', () => {
    it('should execute tasks in same lane sequentially', async () => {
      const manager = new LaneManager({ logger: silentLogger });
      const order: number[] = [];

      const task1 = manager.enqueue('session:user1', async () => {
        await delay(30);
        order.push(1);
        return 1;
      });

      const task2 = manager.enqueue('session:user1', async () => {
        order.push(2);
        return 2;
      });

      const task3 = manager.enqueue('session:user1', async () => {
        order.push(3);
        return 3;
      });

      await Promise.all([task1, task2, task3]);

      // Should be strictly sequential
      expect(order).toEqual([1, 2, 3]);
    });

    it('should continue processing after task failure', async () => {
      const manager = new LaneManager({ logger: silentLogger });
      const executionOrder: number[] = [];

      const task1 = manager
        .enqueue('session:user1', async () => {
          executionOrder.push(1);
          throw new Error('fail');
        })
        .catch(() => {
          // Error caught, but task 1 was still executed first
        });

      const task2 = manager.enqueue('session:user1', async () => {
        executionOrder.push(2);
        return 'success';
      });

      await Promise.all([task1, task2]);

      // Task 1 should run before task 2, even though it throws
      expect(executionOrder).toEqual([1, 2]);
    });
  });

  describe('parallel execution (different lanes)', () => {
    it('should execute tasks in different lanes in parallel', async () => {
      const manager = new LaneManager({ logger: silentLogger });
      const order: string[] = [];

      // user1 task takes longer
      const task1 = manager.enqueue('session:user1', async () => {
        await delay(50);
        order.push('user1');
      });

      // user2 task is fast
      const task2 = manager.enqueue('session:user2', async () => {
        order.push('user2');
      });

      await Promise.all([task1, task2]);

      // user2 should finish first (parallel execution)
      expect(order[0]).toBe('user2');
      expect(order[1]).toBe('user1');
    });
  });

  describe('resolveSessionLane', () => {
    it('should prefix with session:', () => {
      const manager = new LaneManager();
      expect(manager.resolveSessionLane('user1')).toBe('session:user1');
    });

    it('should not double-prefix', () => {
      const manager = new LaneManager();
      expect(manager.resolveSessionLane('session:user1')).toBe('session:user1');
    });

    it('should use main for empty string', () => {
      const manager = new LaneManager();
      expect(manager.resolveSessionLane('')).toBe('session:main');
    });

    it('should handle complex session keys', () => {
      const manager = new LaneManager();
      expect(manager.resolveSessionLane('discord:123:456')).toBe('session:discord:123:456');
    });
  });

  describe('resolveGlobalLane', () => {
    it('should return main for undefined', () => {
      const manager = new LaneManager();
      expect(manager.resolveGlobalLane()).toBe('main');
    });

    it('should return main for empty string', () => {
      const manager = new LaneManager();
      expect(manager.resolveGlobalLane('')).toBe('main');
    });

    it('should return custom lane name', () => {
      const manager = new LaneManager();
      expect(manager.resolveGlobalLane('api')).toBe('api');
    });
  });

  describe('enqueueWithSession (2-stage queueing)', () => {
    it('should perform 2-stage queueing', async () => {
      const manager = new LaneManager({ logger: silentLogger });
      const executionOrder: string[] = [];

      const task1 = manager.enqueueWithSession('user1', async () => {
        await delay(30);
        executionOrder.push('user1-task1');
      });

      const task2 = manager.enqueueWithSession('user1', async () => {
        executionOrder.push('user1-task2');
      });

      const task3 = manager.enqueueWithSession('user2', async () => {
        executionOrder.push('user2-task1');
      });

      await Promise.all([task1, task2, task3]);

      // Global lane serializes everything (maxConcurrent=1)
      // Order: user1-task1 first enters global, then user2-task1 waits,
      // then user1-task2 waits behind user1-task1 in session lane
      expect(executionOrder[0]).toBe('user1-task1');
    });

    it('should maintain session order in 2-stage queueing', async () => {
      const manager = new LaneManager({ logger: silentLogger });
      const user1Tasks: number[] = [];

      const promises = [];
      for (let i = 1; i <= 5; i++) {
        promises.push(
          manager.enqueueWithSession('user1', async () => {
            user1Tasks.push(i);
          })
        );
      }

      await Promise.all(promises);

      // All user1 tasks should be in order
      expect(user1Tasks).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe('setLaneMaxConcurrent', () => {
    it('should allow changing max concurrent', async () => {
      const manager = new LaneManager({ logger: silentLogger });
      manager.setLaneMaxConcurrent('main', 2);

      const concurrentCalls: number[] = [];
      let currentConcurrent = 0;

      const createTask = () => async () => {
        currentConcurrent++;
        concurrentCalls.push(currentConcurrent);
        await delay(30);
        currentConcurrent--;
      };

      await Promise.all([
        manager.enqueue('main', createTask()),
        manager.enqueue('main', createTask()),
        manager.enqueue('main', createTask()),
      ]);

      // With maxConcurrent=2, we should see max 2 concurrent
      expect(Math.max(...concurrentCalls)).toBe(2);
    });

    it('should enforce minimum of 1', () => {
      const manager = new LaneManager({ logger: silentLogger });
      manager.setLaneMaxConcurrent('main', 0);

      const stats = manager.getStats();
      expect(stats.get('main')?.maxConcurrent).toBe(1);
    });
  });

  describe('getQueueSize', () => {
    it('should return 0 for non-existent lane', () => {
      const manager = new LaneManager({ logger: silentLogger });
      expect(manager.getQueueSize('nonexistent')).toBe(0);
    });

    it('should include active and queued tasks', async () => {
      const manager = new LaneManager({ logger: silentLogger });
      let resolveTask: () => void;
      const blockingTask = new Promise<void>((resolve) => {
        resolveTask = resolve;
      });

      // Start a blocking task
      const task1 = manager.enqueue('test', async () => {
        await blockingTask;
      });

      // Queue more tasks
      const task2 = manager.enqueue('test', async () => {});
      const task3 = manager.enqueue('test', async () => {});

      // Wait a tick for tasks to be processed
      await delay(10);

      // Should have 1 active + 2 queued = 3
      expect(manager.getQueueSize('test')).toBe(3);

      // Cleanup
      resolveTask!();
      await Promise.all([task1, task2, task3]);
    });
  });

  describe('getTotalQueueSize', () => {
    it('should sum all lanes', async () => {
      const manager = new LaneManager({ logger: silentLogger });
      let resolveTask: () => void;
      const blockingTask = new Promise<void>((resolve) => {
        resolveTask = resolve;
      });

      const task1 = manager.enqueue('lane1', async () => {
        await blockingTask;
      });
      const task2 = manager.enqueue('lane1', async () => {});
      const task3 = manager.enqueue('lane2', async () => {
        await blockingTask;
      });

      await delay(10);

      // lane1: 1 active + 1 queued, lane2: 1 active = 3 total
      expect(manager.getTotalQueueSize()).toBe(3);

      resolveTask!();
      await Promise.all([task1, task2, task3]);
    });
  });

  describe('clearLane', () => {
    it('should remove pending tasks', async () => {
      const manager = new LaneManager({ logger: silentLogger });
      let resolveTask: () => void;
      const blockingTask = new Promise<void>((resolve) => {
        resolveTask = resolve;
      });

      const task1 = manager.enqueue('test', async () => {
        await blockingTask;
      });

      const task2Promise = manager.enqueue('test', async () => {
        return 'task2';
      });

      const task3Promise = manager.enqueue('test', async () => {
        return 'task3';
      });

      await delay(10);

      const removed = manager.clearLane('test');
      expect(removed).toBe(2);

      // Pending tasks should reject
      await expect(task2Promise).rejects.toThrow('Lane cleared');
      await expect(task3Promise).rejects.toThrow('Lane cleared');

      // Active task should continue
      resolveTask!();
      await task1;
    });

    it('should return 0 for non-existent lane', () => {
      const manager = new LaneManager({ logger: silentLogger });
      expect(manager.clearLane('nonexistent')).toBe(0);
    });
  });

  describe('warning callback', () => {
    it('should call onWait when wait exceeds threshold', async () => {
      const manager = new LaneManager({
        logger: silentLogger,
        warnAfterMs: 20, // Low threshold for testing
      });

      let resolveTask: () => void;
      const blockingTask = new Promise<void>((resolve) => {
        resolveTask = resolve;
      });

      const onWait = vi.fn();

      const task1 = manager.enqueue('test', async () => {
        await blockingTask;
      });

      const task2 = manager.enqueue('test', async () => {}, { onWait });

      // Wait longer than threshold
      await delay(50);

      resolveTask!();
      await Promise.all([task1, task2]);

      expect(onWait).toHaveBeenCalled();
      expect(onWait.mock.calls[0][0]).toBeGreaterThanOrEqual(20);
    });
  });

  describe('getLanes', () => {
    it('should return all lane names', async () => {
      const manager = new LaneManager({ logger: silentLogger });

      await manager.enqueue('lane1', async () => {});
      await manager.enqueue('lane2', async () => {});
      await manager.enqueue('lane3', async () => {});

      const lanes = manager.getLanes();
      expect(lanes).toContain('lane1');
      expect(lanes).toContain('lane2');
      expect(lanes).toContain('lane3');
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', async () => {
      const manager = new LaneManager({ logger: silentLogger });
      let resolveTask: () => void;
      const blockingTask = new Promise<void>((resolve) => {
        resolveTask = resolve;
      });

      const task1 = manager.enqueue('test', async () => {
        await blockingTask;
      });
      const task2 = manager.enqueue('test', async () => {});

      await delay(10);

      const stats = manager.getStats();
      const testStats = stats.get('test');

      expect(testStats?.active).toBe(1);
      expect(testStats?.queued).toBe(1);
      expect(testStats?.maxConcurrent).toBe(1);

      resolveTask!();
      await Promise.all([task1, task2]);
    });
  });

  describe('global singleton', () => {
    it('should return same instance', () => {
      const manager1 = getGlobalLaneManager();
      const manager2 = getGlobalLaneManager();
      expect(manager1).toBe(manager2);
    });

    it('should reset correctly', () => {
      const manager1 = getGlobalLaneManager();
      resetGlobalLaneManager();
      const manager2 = getGlobalLaneManager();
      expect(manager1).not.toBe(manager2);
    });
  });
});
