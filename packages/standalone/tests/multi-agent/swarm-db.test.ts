/**
 * Tests for Swarm Task Queue Database
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  initSwarmDb,
  createTask,
  claimTask,
  completeTask,
  failTask,
  getTasksBySession,
  getPendingTasks,
  expireStaleLeases,
  retryTask,
  deferTask,
} from '../../src/multi-agent/swarm/swarm-db.js';
import type { CreateTaskParams } from '../../src/multi-agent/swarm/swarm-db.js';

describe('Swarm DB', () => {
  let db: Database.Database;

  beforeEach(() => {
    // Use in-memory SQLite for each test
    db = initSwarmDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('initSwarmDb', () => {
    it('should create swarm_tasks table', () => {
      // Verify table exists by querying sqlite_master
      const tables = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='swarm_tasks'`)
        .all();
      expect(tables).toHaveLength(1);
    });

    it('should create indexes', () => {
      const indexes = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='swarm_tasks'`)
        .all() as { name: string }[];

      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_swarm_session');
      expect(indexNames).toContain('idx_swarm_status');
      expect(indexNames).toContain('idx_swarm_wave');
    });
  });

  describe('createTask', () => {
    it('should create a task with minimal params', () => {
      const params: CreateTaskParams = {
        session_id: 'session1',
        description: 'Test task',
        category: 'test',
        wave: 1,
      };

      const taskId = createTask(db, params);
      expect(taskId).toBeTruthy();
      expect(typeof taskId).toBe('string');

      // Verify task was inserted
      const tasks = getTasksBySession(db, 'session1');
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(taskId);
      expect(tasks[0].description).toBe('Test task');
      expect(tasks[0].status).toBe('pending');
    });

    it('should create a task with all params', () => {
      const params: CreateTaskParams = {
        session_id: 'session1',
        description: 'Complex task',
        category: 'implementation',
        priority: 10,
        wave: 2,
        files_owned: ['file1.ts', 'file2.ts'],
        depends_on: ['task-dep-1', 'task-dep-2'],
      };

      const taskId = createTask(db, params);
      const tasks = getTasksBySession(db, 'session1');

      expect(tasks[0].priority).toBe(10);
      expect(tasks[0].wave).toBe(2);
      expect(tasks[0].files_owned).toBe(JSON.stringify(['file1.ts', 'file2.ts']));
      expect(tasks[0].depends_on).toBe(JSON.stringify(['task-dep-1', 'task-dep-2']));
    });

    it('should default priority to 0', () => {
      const params: CreateTaskParams = {
        session_id: 'session1',
        description: 'Task without priority',
        category: 'test',
        wave: 1,
      };

      createTask(db, params);
      const tasks = getTasksBySession(db, 'session1');
      expect(tasks[0].priority).toBe(0);
    });
  });

  describe('claimTask', () => {
    it('should atomically claim a pending task', () => {
      const params: CreateTaskParams = {
        session_id: 'session1',
        description: 'Claimable task',
        category: 'test',
        wave: 1,
      };

      const taskId = createTask(db, params);
      const claimed = claimTask(db, taskId, 'agent1');

      expect(claimed).toBe(true);

      // Verify task is claimed
      const tasks = getTasksBySession(db, 'session1');
      expect(tasks[0].status).toBe('claimed');
      expect(tasks[0].claimed_by).toBe('agent1');
      expect(tasks[0].claimed_at).toBeTruthy();
    });

    it('should fail to claim already claimed task', () => {
      const params: CreateTaskParams = {
        session_id: 'session1',
        description: 'Claimable task',
        category: 'test',
        wave: 1,
      };

      const taskId = createTask(db, params);

      // First claim succeeds
      const firstClaim = claimTask(db, taskId, 'agent1');
      expect(firstClaim).toBe(true);

      // Second claim should fail
      const secondClaim = claimTask(db, taskId, 'agent2');
      expect(secondClaim).toBe(false);

      // Verify still claimed by agent1
      const tasks = getTasksBySession(db, 'session1');
      expect(tasks[0].claimed_by).toBe('agent1');
    });

    it('should fail to claim non-existent task', () => {
      const claimed = claimTask(db, 'non-existent-id', 'agent1');
      expect(claimed).toBe(false);
    });

    it('should fail to claim completed task', () => {
      const params: CreateTaskParams = {
        session_id: 'session1',
        description: 'Task to complete',
        category: 'test',
        wave: 1,
      };

      const taskId = createTask(db, params);
      claimTask(db, taskId, 'agent1');
      completeTask(db, taskId, 'Done');

      // Try to claim completed task
      const claimed = claimTask(db, taskId, 'agent2');
      expect(claimed).toBe(false);
    });
  });

  describe('completeTask', () => {
    it('should mark task as completed', () => {
      const params: CreateTaskParams = {
        session_id: 'session1',
        description: 'Task to complete',
        category: 'test',
        wave: 1,
      };

      const taskId = createTask(db, params);
      claimTask(db, taskId, 'agent1');
      const updated = completeTask(db, taskId, 'Success result');

      expect(updated).toBe(true);

      const tasks = getTasksBySession(db, 'session1');
      expect(tasks[0].status).toBe('completed');
      expect(tasks[0].result).toBe('Success result');
      expect(tasks[0].completed_at).toBeTruthy();
    });

    it('should complete task without result', () => {
      const params: CreateTaskParams = {
        session_id: 'session1',
        description: 'Task',
        category: 'test',
        wave: 1,
      };

      const taskId = createTask(db, params);
      claimTask(db, taskId, 'agent1');
      completeTask(db, taskId);

      const tasks = getTasksBySession(db, 'session1');
      expect(tasks[0].status).toBe('completed');
      expect(tasks[0].result).toBeNull();
    });

    it('should return false for non-existent task', () => {
      const updated = completeTask(db, 'non-existent-id');
      expect(updated).toBe(false);
    });
  });

  describe('failTask', () => {
    it('should mark task as failed', () => {
      const params: CreateTaskParams = {
        session_id: 'session1',
        description: 'Task to fail',
        category: 'test',
        wave: 1,
      };

      const taskId = createTask(db, params);
      claimTask(db, taskId, 'agent1');
      const updated = failTask(db, taskId, 'Error: something went wrong');

      expect(updated).toBe(true);

      const tasks = getTasksBySession(db, 'session1');
      expect(tasks[0].status).toBe('failed');
      expect(tasks[0].result).toBe('Error: something went wrong');
      expect(tasks[0].completed_at).toBeTruthy();
    });

    it('should fail task without result', () => {
      const params: CreateTaskParams = {
        session_id: 'session1',
        description: 'Task',
        category: 'test',
        wave: 1,
      };

      const taskId = createTask(db, params);
      claimTask(db, taskId, 'agent1');
      failTask(db, taskId);

      const tasks = getTasksBySession(db, 'session1');
      expect(tasks[0].status).toBe('failed');
      expect(tasks[0].result).toBeNull();
    });

    it('should return false for non-existent task', () => {
      const updated = failTask(db, 'non-existent-id');
      expect(updated).toBe(false);
    });
  });

  describe('getTasksBySession', () => {
    it('should return empty array for non-existent session', () => {
      const tasks = getTasksBySession(db, 'non-existent-session');
      expect(tasks).toEqual([]);
    });

    it('should return all tasks for a session', () => {
      createTask(db, { session_id: 'session1', description: 'Task 1', category: 'test', wave: 1 });
      createTask(db, { session_id: 'session1', description: 'Task 2', category: 'test', wave: 2 });
      createTask(db, { session_id: 'session2', description: 'Task 3', category: 'test', wave: 1 });

      const tasks = getTasksBySession(db, 'session1');
      expect(tasks).toHaveLength(2);
      expect(tasks.map((t) => t.description)).toContain('Task 1');
      expect(tasks.map((t) => t.description)).toContain('Task 2');
    });

    it('should order by wave and priority', () => {
      createTask(db, {
        session_id: 'session1',
        description: 'Low priority',
        category: 'test',
        wave: 1,
        priority: 1,
      });
      createTask(db, {
        session_id: 'session1',
        description: 'High priority',
        category: 'test',
        wave: 1,
        priority: 10,
      });
      createTask(db, {
        session_id: 'session1',
        description: 'Wave 2',
        category: 'test',
        wave: 2,
        priority: 5,
      });

      const tasks = getTasksBySession(db, 'session1');
      expect(tasks[0].description).toBe('High priority');
      expect(tasks[1].description).toBe('Low priority');
      expect(tasks[2].description).toBe('Wave 2');
    });
  });

  describe('getPendingTasks', () => {
    beforeEach(() => {
      createTask(db, {
        session_id: 'session1',
        description: 'Pending 1',
        category: 'test',
        wave: 1,
        priority: 5,
      });
      createTask(db, {
        session_id: 'session1',
        description: 'Pending 2',
        category: 'test',
        wave: 1,
        priority: 10,
      });
      createTask(db, {
        session_id: 'session1',
        description: 'Pending 3',
        category: 'test',
        wave: 2,
        priority: 3,
      });

      const taskId = createTask(db, {
        session_id: 'session1',
        description: 'Claimed task',
        category: 'test',
        wave: 1,
      });
      claimTask(db, taskId, 'agent1');
    });

    it('should return only pending tasks', () => {
      const tasks = getPendingTasks(db, 'session1');
      expect(tasks).toHaveLength(3);
      expect(tasks.every((t) => t.status === 'pending')).toBe(true);
    });

    it('should order by wave and priority', () => {
      const tasks = getPendingTasks(db, 'session1');
      expect(tasks[0].description).toBe('Pending 2'); // wave 1, priority 10
      expect(tasks[1].description).toBe('Pending 1'); // wave 1, priority 5
      expect(tasks[2].description).toBe('Pending 3'); // wave 2, priority 3
    });

    it('should filter by wave number', () => {
      const wave1Tasks = getPendingTasks(db, 'session1', 1);
      expect(wave1Tasks).toHaveLength(2);
      expect(wave1Tasks.every((t) => t.wave === 1)).toBe(true);

      const wave2Tasks = getPendingTasks(db, 'session1', 2);
      expect(wave2Tasks).toHaveLength(1);
      expect(wave2Tasks[0].description).toBe('Pending 3');
    });

    it('should return empty array for non-existent session', () => {
      const tasks = getPendingTasks(db, 'non-existent-session');
      expect(tasks).toEqual([]);
    });

    it('should return empty array for non-existent wave', () => {
      const tasks = getPendingTasks(db, 'session1', 999);
      expect(tasks).toEqual([]);
    });
  });

  describe('expireStaleLeases', () => {
    it('should expire stale claimed tasks', () => {
      const taskId = createTask(db, {
        session_id: 'session1',
        description: 'Stale task',
        category: 'test',
        wave: 1,
      });

      claimTask(db, taskId, 'agent1');

      // Manually set claimed_at to old timestamp
      const oldTimestamp = Date.now() - 10 * 60 * 1000; // 10 minutes ago
      db.prepare(`UPDATE swarm_tasks SET claimed_at = ? WHERE id = ?`).run(oldTimestamp, taskId);

      // Expire leases older than 5 minutes
      const expired = expireStaleLeases(db, 5 * 60 * 1000);
      expect(expired).toBe(1);

      // Verify task is back to pending
      const tasks = getTasksBySession(db, 'session1');
      expect(tasks[0].status).toBe('pending');
      expect(tasks[0].claimed_by).toBeNull();
      expect(tasks[0].claimed_at).toBeNull();
    });

    it('should not expire recent claimed tasks', () => {
      const taskId = createTask(db, {
        session_id: 'session1',
        description: 'Recent task',
        category: 'test',
        wave: 1,
      });

      claimTask(db, taskId, 'agent1');

      // Expire leases older than 5 minutes
      const expired = expireStaleLeases(db, 5 * 60 * 1000);
      expect(expired).toBe(0);

      // Task should still be claimed
      const tasks = getTasksBySession(db, 'session1');
      expect(tasks[0].status).toBe('claimed');
      expect(tasks[0].claimed_by).toBe('agent1');
    });

    it('should not expire completed or failed tasks', () => {
      const taskId1 = createTask(db, {
        session_id: 'session1',
        description: 'Completed task',
        category: 'test',
        wave: 1,
      });
      const taskId2 = createTask(db, {
        session_id: 'session1',
        description: 'Failed task',
        category: 'test',
        wave: 1,
      });

      claimTask(db, taskId1, 'agent1');
      claimTask(db, taskId2, 'agent2');

      // Set old timestamps
      const oldTimestamp = Date.now() - 10 * 60 * 1000;
      db.prepare(`UPDATE swarm_tasks SET claimed_at = ? WHERE id IN (?, ?)`).run(
        oldTimestamp,
        taskId1,
        taskId2
      );

      // Complete/fail tasks
      completeTask(db, taskId1);
      failTask(db, taskId2);

      // Expire should not affect completed/failed
      const expired = expireStaleLeases(db, 5 * 60 * 1000);
      expect(expired).toBe(0);
    });

    it('should expire multiple stale tasks', () => {
      const taskId1 = createTask(db, {
        session_id: 'session1',
        description: 'Stale 1',
        category: 'test',
        wave: 1,
      });
      const taskId2 = createTask(db, {
        session_id: 'session1',
        description: 'Stale 2',
        category: 'test',
        wave: 1,
      });
      const taskId3 = createTask(db, {
        session_id: 'session1',
        description: 'Recent',
        category: 'test',
        wave: 1,
      });

      claimTask(db, taskId1, 'agent1');
      claimTask(db, taskId2, 'agent2');
      claimTask(db, taskId3, 'agent3');

      // Set old timestamps for first two
      const oldTimestamp = Date.now() - 10 * 60 * 1000;
      db.prepare(`UPDATE swarm_tasks SET claimed_at = ? WHERE id IN (?, ?)`).run(
        oldTimestamp,
        taskId1,
        taskId2
      );

      const expired = expireStaleLeases(db, 5 * 60 * 1000);
      expect(expired).toBe(2);

      const tasks = getPendingTasks(db, 'session1');
      expect(tasks).toHaveLength(2); // Two expired tasks back to pending
    });

    it('should use custom maxAgeMs', () => {
      const taskId = createTask(db, {
        session_id: 'session1',
        description: 'Task',
        category: 'test',
        wave: 1,
      });
      claimTask(db, taskId, 'agent1');

      // Set claimed_at to 2 minutes ago
      const timestamp = Date.now() - 2 * 60 * 1000;
      db.prepare(`UPDATE swarm_tasks SET claimed_at = ? WHERE id = ?`).run(timestamp, taskId);

      // Expire with 1 minute threshold
      const expired = expireStaleLeases(db, 1 * 60 * 1000);
      expect(expired).toBe(1);
    });
  });

  describe('deferTask', () => {
    it('should reset claimed task to pending without incrementing retry_count', () => {
      const taskId = createTask(db, {
        session_id: 'session1',
        description: 'Test task',
        category: 'test',
        wave: 1,
      });

      // Claim the task
      claimTask(db, taskId, 'agent1');

      // Defer the task
      const success = deferTask(db, taskId);
      expect(success).toBe(true);

      // Verify task state
      const task = db.prepare('SELECT * FROM swarm_tasks WHERE id = ?').get(taskId) as any;
      expect(task.status).toBe('pending');
      expect(task.claimed_by).toBeNull();
      expect(task.claimed_at).toBeNull();
      expect(task.retry_count).toBe(0); // Should NOT increment
    });

    it('should return false when task is not claimed', () => {
      const taskId = createTask(db, {
        session_id: 'session1',
        description: 'Test task',
        category: 'test',
        wave: 1,
      });

      // Task is pending, not claimed
      const success = deferTask(db, taskId);
      expect(success).toBe(false);
    });

    it('should return false when task is failed', () => {
      const taskId = createTask(db, {
        session_id: 'session1',
        description: 'Test task',
        category: 'test',
        wave: 1,
      });

      // Claim and fail the task
      claimTask(db, taskId, 'agent1');
      failTask(db, taskId, 'Error');

      // Defer should fail (task is failed, not claimed)
      const success = deferTask(db, taskId);
      expect(success).toBe(false);
    });

    it('should return false for nonexistent task', () => {
      const success = deferTask(db, 'nonexistent-id');
      expect(success).toBe(false);
    });
  });

  describe('retryTask', () => {
    it('should reset claimed task to pending and increment retry_count', () => {
      const taskId = createTask(db, {
        session_id: 'session1',
        description: 'Test task',
        category: 'test',
        wave: 1,
      });

      // Claim the task
      claimTask(db, taskId, 'agent1');

      // Retry the task
      const success = retryTask(db, taskId);
      expect(success).toBe(true);

      // Verify task state
      const task = db.prepare('SELECT * FROM swarm_tasks WHERE id = ?').get(taskId) as any;
      expect(task.status).toBe('pending');
      expect(task.claimed_by).toBeNull();
      expect(task.claimed_at).toBeNull();
      expect(task.retry_count).toBe(1);
    });

    it('should reset failed task to pending and increment retry_count', () => {
      const taskId = createTask(db, {
        session_id: 'session1',
        description: 'Test task',
        category: 'test',
        wave: 1,
      });

      // Claim and fail the task
      claimTask(db, taskId, 'agent1');
      failTask(db, taskId, 'Some error');

      // Retry the task
      const success = retryTask(db, taskId);
      expect(success).toBe(true);

      // Verify task state
      const task = db.prepare('SELECT * FROM swarm_tasks WHERE id = ?').get(taskId) as any;
      expect(task.status).toBe('pending');
      expect(task.retry_count).toBe(1);
    });

    it('should return false when retrying pending task', () => {
      const taskId = createTask(db, {
        session_id: 'session1',
        description: 'Test task',
        category: 'test',
        wave: 1,
      });

      // Task is already pending
      const success = retryTask(db, taskId);
      expect(success).toBe(false);

      // Retry count should not change
      const task = db.prepare('SELECT * FROM swarm_tasks WHERE id = ?').get(taskId) as any;
      expect(task.retry_count).toBe(0);
    });

    it('should increment retry_count on multiple retries', () => {
      const taskId = createTask(db, {
        session_id: 'session1',
        description: 'Test task',
        category: 'test',
        wave: 1,
      });

      // First retry
      claimTask(db, taskId, 'agent1');
      retryTask(db, taskId);
      let task = db.prepare('SELECT * FROM swarm_tasks WHERE id = ?').get(taskId) as any;
      expect(task.retry_count).toBe(1);

      // Second retry
      claimTask(db, taskId, 'agent1');
      retryTask(db, taskId);
      task = db.prepare('SELECT * FROM swarm_tasks WHERE id = ?').get(taskId) as any;
      expect(task.retry_count).toBe(2);

      // Third retry
      claimTask(db, taskId, 'agent1');
      retryTask(db, taskId);
      task = db.prepare('SELECT * FROM swarm_tasks WHERE id = ?').get(taskId) as any;
      expect(task.retry_count).toBe(3);
    });
  });
});
