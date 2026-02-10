/**
 * Tests for Wave Execution Engine
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SwarmManager } from '../../src/multi-agent/swarm/swarm-manager.js';
import { executeWaves, executeWave } from '../../src/multi-agent/swarm/wave-engine.js';
import type { Wave, TaskExecutor } from '../../src/multi-agent/swarm/wave-engine.js';
import type { CreateTaskParams } from '../../src/multi-agent/swarm/swarm-db.js';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync, existsSync } from 'fs';

describe('Wave Engine', () => {
  let manager: SwarmManager;
  let dbPath: string;
  let sessionId: string;

  beforeEach(() => {
    // Create temporary DB file and manager
    dbPath = join(tmpdir(), `wave-engine-test-${randomUUID()}.db`);
    manager = new SwarmManager(dbPath);
    sessionId = manager.createSession();
  });

  afterEach(() => {
    manager.close();
    if (existsSync(dbPath)) {
      unlinkSync(dbPath);
    }
  });

  describe('executeWaves', () => {
    it('should execute single wave with one task', async () => {
      // Create task in DB
      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Test task', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      // Mock executor
      const executor: TaskExecutor = vi.fn().mockResolvedValue('Task completed');

      // Execute wave
      const waves: Wave[] = [
        {
          wave: 1,
          tasks: [
            {
              id: taskId,
              agentId: 'agent1',
              description: 'Test task',
              category: 'test',
            },
          ],
        },
      ];

      const result = await executeWaves(waves, manager, sessionId, executor);

      expect(result.totalWaves).toBe(1);
      expect(result.completedWaves).toBe(1);
      expect(result.totalTasks).toBe(1);
      expect(result.completed).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);
      expect(executor).toHaveBeenCalledOnce();
      expect(result.results[0].status).toBe('completed');
      expect(result.results[0].result).toBe('Task completed');
    });

    it('should execute multiple waves sequentially', async () => {
      // Create tasks in DB
      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Wave 1 Task', category: 'test', wave: 1 },
        { session_id: sessionId, description: 'Wave 2 Task', category: 'test', wave: 2 },
        { session_id: sessionId, description: 'Wave 3 Task', category: 'test', wave: 3 },
      ];
      const [task1Id, task2Id, task3Id] = manager.addTasks(sessionId, taskParams);

      const executionOrder: number[] = [];
      const executor: TaskExecutor = vi.fn().mockImplementation(async (task) => {
        const waveMatch = task.description.match(/Wave (\d+)/);
        const waveNum = waveMatch ? parseInt(waveMatch[1]) : 0;
        executionOrder.push(waveNum);
        return `Completed ${task.description}`;
      });

      const waves: Wave[] = [
        {
          wave: 1,
          tasks: [{ id: task1Id, agentId: 'agent1', description: 'Wave 1 Task', category: 'test' }],
        },
        {
          wave: 2,
          tasks: [{ id: task2Id, agentId: 'agent1', description: 'Wave 2 Task', category: 'test' }],
        },
        {
          wave: 3,
          tasks: [{ id: task3Id, agentId: 'agent1', description: 'Wave 3 Task', category: 'test' }],
        },
      ];

      const result = await executeWaves(waves, manager, sessionId, executor);

      expect(result.completedWaves).toBe(3);
      expect(result.completed).toBe(3);
      expect(executionOrder).toEqual([1, 2, 3]); // Sequential execution
    });

    it('should execute tasks in parallel within same wave', async () => {
      // Create tasks in DB
      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Task 1', category: 'test', wave: 1 },
        { session_id: sessionId, description: 'Task 2', category: 'test', wave: 1 },
        { session_id: sessionId, description: 'Task 3', category: 'test', wave: 1 },
      ];
      const taskIds = manager.addTasks(sessionId, taskParams);

      const startTimes = new Map<string, number>();
      const executor: TaskExecutor = vi.fn().mockImplementation(async (task) => {
        startTimes.set(task.id, Date.now());
        await new Promise((resolve) => setTimeout(resolve, 50)); // Simulate work
        return 'Done';
      });

      const waves: Wave[] = [
        {
          wave: 1,
          tasks: taskIds.map((id, idx) => ({
            id,
            agentId: `agent${idx + 1}`,
            description: `Task ${idx + 1}`,
            category: 'test',
          })),
        },
      ];

      const result = await executeWaves(waves, manager, sessionId, executor);

      expect(result.completed).toBe(3);

      // Check parallel execution (all should start within short time window)
      const times = Array.from(startTimes.values());
      const maxDiff = Math.max(...times) - Math.min(...times);
      expect(maxDiff).toBeLessThan(100); // All started within 100ms
    });

    it('should handle task execution failure (fail-forward)', async () => {
      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Success task', category: 'test', wave: 1 },
        { session_id: sessionId, description: 'Failing task', category: 'test', wave: 1 },
      ];
      const [successId, failId] = manager.addTasks(sessionId, taskParams);

      const executor: TaskExecutor = vi.fn().mockImplementation(async (task) => {
        if (task.description === 'Failing task') {
          throw new Error('Task failed');
        }
        return 'Success';
      });

      const waves: Wave[] = [
        {
          wave: 1,
          tasks: [
            { id: successId, agentId: 'agent1', description: 'Success task', category: 'test' },
            { id: failId, agentId: 'agent2', description: 'Failing task', category: 'test' },
          ],
        },
      ];

      const result = await executeWaves(waves, manager, sessionId, executor);

      expect(result.completed).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.results).toHaveLength(2);

      const successResult = result.results.find((r) => r.taskId === successId);
      const failResult = result.results.find((r) => r.taskId === failId);

      expect(successResult?.status).toBe('completed');
      expect(failResult?.status).toBe('failed');
      expect(failResult?.error).toBe('Task failed');
    });

    it('should handle empty wave', async () => {
      const executor: TaskExecutor = vi.fn();

      const waves: Wave[] = [
        {
          wave: 1,
          tasks: [],
        },
      ];

      const result = await executeWaves(waves, manager, sessionId, executor);

      expect(result.totalWaves).toBe(1);
      expect(result.completedWaves).toBe(1);
      expect(result.totalTasks).toBe(0);
      expect(result.completed).toBe(0);
      expect(executor).not.toHaveBeenCalled();
    });

    it('should skip already claimed tasks', async () => {
      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Task 1', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      // Pre-claim the task
      const db = manager.getDatabase();
      db.prepare(
        `UPDATE swarm_tasks SET status = 'claimed', claimed_by = 'other-agent' WHERE id = ?`
      ).run(taskId);

      const executor: TaskExecutor = vi.fn().mockResolvedValue('Done');

      const waves: Wave[] = [
        {
          wave: 1,
          tasks: [{ id: taskId, agentId: 'agent1', description: 'Task 1', category: 'test' }],
        },
      ];

      const result = await executeWaves(waves, manager, sessionId, executor);

      expect(result.skipped).toBe(1);
      expect(result.completed).toBe(0);
      expect(executor).not.toHaveBeenCalled();
      expect(result.results[0].status).toBe('skipped');
    });

    it('should sort waves by wave number', async () => {
      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Wave 3', category: 'test', wave: 3 },
        { session_id: sessionId, description: 'Wave 1', category: 'test', wave: 1 },
        { session_id: sessionId, description: 'Wave 2', category: 'test', wave: 2 },
      ];
      const [task3Id, task1Id, task2Id] = manager.addTasks(sessionId, taskParams);

      const executionOrder: number[] = [];
      const executor: TaskExecutor = vi.fn().mockImplementation(async (task) => {
        const waveNum = parseInt(task.description.split(' ')[1]);
        executionOrder.push(waveNum);
        return 'Done';
      });

      // Pass waves in random order
      const waves: Wave[] = [
        {
          wave: 3,
          tasks: [{ id: task3Id, agentId: 'agent1', description: 'Wave 3', category: 'test' }],
        },
        {
          wave: 1,
          tasks: [{ id: task1Id, agentId: 'agent1', description: 'Wave 1', category: 'test' }],
        },
        {
          wave: 2,
          tasks: [{ id: task2Id, agentId: 'agent1', description: 'Wave 2', category: 'test' }],
        },
      ];

      await executeWaves(waves, manager, sessionId, executor);

      expect(executionOrder).toEqual([1, 2, 3]); // Should execute in sorted order
    });

    it('should continue to next wave after failure', async () => {
      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Wave 1 fail', category: 'test', wave: 1 },
        { session_id: sessionId, description: 'Wave 2 success', category: 'test', wave: 2 },
      ];
      const [task1Id, task2Id] = manager.addTasks(sessionId, taskParams);

      const executor: TaskExecutor = vi.fn().mockImplementation(async (task) => {
        if (task.description.includes('fail')) {
          throw new Error('Failed');
        }
        return 'Success';
      });

      const waves: Wave[] = [
        {
          wave: 1,
          tasks: [{ id: task1Id, agentId: 'agent1', description: 'Wave 1 fail', category: 'test' }],
        },
        {
          wave: 2,
          tasks: [
            { id: task2Id, agentId: 'agent1', description: 'Wave 2 success', category: 'test' },
          ],
        },
      ];

      const result = await executeWaves(waves, manager, sessionId, executor);

      expect(result.completedWaves).toBe(2); // Both waves attempted
      expect(result.failed).toBe(1);
      expect(result.completed).toBe(1);
    });
  });

  describe('executeWave', () => {
    it('should execute single wave', async () => {
      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Task', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      const executor: TaskExecutor = vi.fn().mockResolvedValue('Done');

      const wave: Wave = {
        wave: 1,
        tasks: [{ id: taskId, agentId: 'agent1', description: 'Task', category: 'test' }],
      };

      const result = await executeWave(wave, manager, sessionId, executor);

      expect(result.totalWaves).toBe(1);
      expect(result.completed).toBe(1);
    });

    it('should be equivalent to executeWaves with single wave', async () => {
      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Task', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      const executor1: TaskExecutor = vi.fn().mockResolvedValue('Result1');
      const executor2: TaskExecutor = vi.fn().mockResolvedValue('Result2');

      const wave: Wave = {
        wave: 1,
        tasks: [{ id: taskId, agentId: 'agent1', description: 'Task', category: 'test' }],
      };

      // Create second task for second execution (can't claim same task twice)
      const [taskId2] = manager.addTasks(sessionId, [
        { session_id: sessionId, description: 'Task2', category: 'test', wave: 1 },
      ]);
      const wave2 = { ...wave, tasks: [{ ...wave.tasks[0], id: taskId2 }] };

      const result1 = await executeWave(wave, manager, sessionId, executor1);
      const result2 = await executeWaves([wave2], manager, sessionId, executor2);

      expect(result1.totalWaves).toBe(result2.totalWaves);
      expect(result1.completedWaves).toBe(result2.completedWaves);
    });
  });
});
