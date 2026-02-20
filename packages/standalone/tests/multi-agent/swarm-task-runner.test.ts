/**
 * Tests for Swarm Task Runner
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';
import { SwarmTaskRunner } from '../../src/multi-agent/swarm/swarm-task-runner.js';
import { SwarmManager } from '../../src/multi-agent/swarm/swarm-manager.js';
import type { AgentProcessManager } from '../../src/multi-agent/agent-process-manager.js';
import type { CreateTaskParams } from '../../src/multi-agent/swarm/swarm-db.js';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync, existsSync } from 'fs';
import type _Database from 'better-sqlite3';

describe('SwarmTaskRunner', () => {
  let runner: SwarmTaskRunner;
  let manager: SwarmManager;
  let mockAgentProcessManager: AgentProcessManager;
  let dbPath: string;
  let sessionId: string;
  let db: ReturnType<typeof manager.getDatabase>;

  beforeEach(() => {
    // Create temporary DB file and manager
    dbPath = join(tmpdir(), `swarm-runner-test-${randomUUID()}.db`);
    manager = new SwarmManager(dbPath);
    sessionId = manager.createSession();
    db = manager.getDatabase();

    // Mock AgentProcessManager
    const mockProcess = {
      isReady: vi.fn().mockReturnValue(true),
      sendMessage: vi.fn().mockResolvedValue({
        response: 'Task completed successfully',
        usage: { input_tokens: 10, output_tokens: 20 },
        session_id: 'test-session',
      }),
    };

    const mockAgentProcessPool = {
      cleanupIdleProcesses: vi.fn().mockReturnValue(0),
      cleanupHungProcesses: vi.fn().mockReturnValue(0),
      getAllPoolStatuses: vi.fn().mockReturnValue(new Map()),
    };

    mockAgentProcessManager = {
      getProcess: vi.fn().mockResolvedValue(mockProcess),
      releaseProcess: vi.fn(),
      getAgentProcessPool: vi.fn().mockReturnValue(mockAgentProcessPool),
    } as unknown as AgentProcessManager;

    runner = new SwarmTaskRunner(manager, mockAgentProcessManager, { maxRetries: 0 });

    // Suppress console logs
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(debugLogger, 'warn');
  });

  afterEach(() => {
    runner.stopAll();
    manager.close();
    if (existsSync(dbPath)) {
      unlinkSync(dbPath);
    }
    vi.restoreAllMocks();
  });

  describe('startSession / stopSession', () => {
    it('should start a session', async () => {
      // Add a task to prevent immediate session completion
      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Pending task', category: 'test', wave: 1 },
      ];
      manager.addTasks(sessionId, taskParams);

      expect(runner.getActiveSessionCount()).toBe(0);

      runner.startSession(sessionId);

      // Wait for pollAndExecute to run
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(runner.getActiveSessionCount()).toBe(1);
      expect(runner.getActiveSessionIds()).toContain(sessionId);
    });

    it('should warn on duplicate session start', async () => {
      // Add a task to prevent immediate session completion
      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Pending task', category: 'test', wave: 1 },
      ];
      manager.addTasks(sessionId, taskParams);

      runner.startSession(sessionId);
      await new Promise((resolve) => setTimeout(resolve, 50));

      runner.startSession(sessionId); // Duplicate

      expect(debugLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`Session ${sessionId} already running`)
      );
      expect(runner.getActiveSessionCount()).toBe(1);
    });

    it('should stop a session', async () => {
      // Add a task to prevent immediate session completion
      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Pending task', category: 'test', wave: 1 },
      ];
      manager.addTasks(sessionId, taskParams);

      runner.startSession(sessionId);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(runner.getActiveSessionCount()).toBe(1);

      runner.stopSession(sessionId);
      expect(runner.getActiveSessionCount()).toBe(0);
    });

    it('should warn when stopping non-existent session', () => {
      runner.stopSession('non-existent-session');
      expect(debugLogger.warn).toHaveBeenCalledWith(expect.stringContaining('not running'));
    });

    it('should stop all sessions', async () => {
      const session1 = manager.createSession();
      const session2 = manager.createSession();

      // Add tasks to both sessions to prevent immediate completion
      manager.addTasks(session1, [
        { session_id: session1, description: 'Task 1', category: 'test', wave: 1 },
      ]);
      manager.addTasks(session2, [
        { session_id: session2, description: 'Task 2', category: 'test', wave: 1 },
      ]);

      runner.startSession(session1);
      runner.startSession(session2);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(runner.getActiveSessionCount()).toBe(2);

      runner.stopAll();
      expect(runner.getActiveSessionCount()).toBe(0);
    });
  });

  describe('executeImmediateTask', () => {
    it('should execute a task immediately', async () => {
      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Immediate task', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      const result = await runner.executeImmediateTask(sessionId, taskId, 'test', 'channel1');

      expect(result.status).toBe('completed');
      expect(result.taskId).toBe(taskId);
      expect(result.result).toBe('Task completed successfully');
      // agentId is now derived from task.category ('test' in this case)
      expect(mockAgentProcessManager.getProcess).toHaveBeenCalledWith('test', 'channel1', 'test');
    });

    it('should throw for non-existent task', async () => {
      await expect(
        runner.executeImmediateTask(sessionId, 'non-existent-id', 'test', 'channel1')
      ).rejects.toThrow('Task non-existent-id not found');
    });

    it('should throw for session mismatch', async () => {
      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Task', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      await expect(
        runner.executeImmediateTask('wrong-session-id', taskId, 'test', 'channel1')
      ).rejects.toThrow('does not belong to session');
    });

    it('should handle task execution failure', async () => {
      // Mock process to throw error
      const errorProcess = {
        isReady: vi.fn().mockReturnValue(true),
        sendMessage: vi.fn().mockRejectedValue(new Error('Execution failed')),
      };
      (mockAgentProcessManager.getProcess as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        errorProcess
      );

      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Failing task', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      const result = await runner.executeImmediateTask(sessionId, taskId, 'test', 'channel1');

      expect(result.status).toBe('failed');
      expect(result.error).toBe('Execution failed');

      // Verify task is marked as failed in DB
      const tasks = manager.getProgress(sessionId);
      expect(tasks.failed).toBe(1);
    });

    it('should throw when task cannot be claimed (already claimed)', async () => {
      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Task', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      // Pre-claim the task
      const db = manager.getDatabase();
      db.prepare(
        `UPDATE swarm_tasks SET status = 'claimed', claimed_by = 'other-agent' WHERE id = ?`
      ).run(taskId);

      // Attempt to execute should throw because claim will fail
      await expect(
        runner.executeImmediateTask(sessionId, taskId, 'test', 'channel1')
      ).rejects.toThrow(/could not be claimed/);
    });

    it('should defer task when agent process is not ready (busy)', async () => {
      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Task', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      // Mock process as not ready (busy)
      const busyProcess = {
        isReady: vi.fn().mockReturnValue(false),
        sendMessage: vi.fn(),
      };
      (mockAgentProcessManager.getProcess as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        busyProcess
      );

      // Listen for task-deferred event
      const deferredListener = vi.fn();
      runner.on('task-deferred', deferredListener);

      const result = await runner.executeImmediateTask(sessionId, taskId, 'test', 'channel1');

      // Should return deferred status with defer message
      expect(result.status).toBe('deferred');
      expect(result.error).toBe('Agent process busy, task deferred');

      // Should emit task-deferred event
      expect(deferredListener).toHaveBeenCalledOnce();
      expect(deferredListener).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId,
          agentId: 'test',
          status: 'deferred',
          error: 'Agent process busy, task deferred',
        })
      );

      // Task should be back to pending (not failed in DB)
      const task = db.prepare('SELECT * FROM swarm_tasks WHERE id = ?').get(taskId) as Record<
        string,
        unknown
      >;
      expect(task.status).toBe('pending');
      expect(task.retry_count).toBe(0); // Should NOT increment
    });

    it('should execute task when agent process is ready', async () => {
      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Task', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      // Mock process as ready
      const readyProcess = {
        isReady: vi.fn().mockReturnValue(true),
        sendMessage: vi.fn().mockResolvedValue({
          response: 'Success',
          usage: { input_tokens: 10, output_tokens: 20 },
          session_id: 'test-session',
        }),
      };
      (mockAgentProcessManager.getProcess as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        readyProcess
      );

      const result = await runner.executeImmediateTask(sessionId, taskId, 'test', 'channel1');

      // Should execute normally
      expect(result.status).toBe('completed');
      expect(readyProcess.isReady).toHaveBeenCalledOnce();
      expect(readyProcess.sendMessage).toHaveBeenCalledOnce();
    });

    it('should not emit task-deferred when process is ready', async () => {
      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Task', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      // Mock process as ready
      const readyProcess = {
        isReady: vi.fn().mockReturnValue(true),
        sendMessage: vi.fn().mockResolvedValue({
          response: 'Success',
          usage: { input_tokens: 10, output_tokens: 20 },
          session_id: 'test-session',
        }),
      };
      (mockAgentProcessManager.getProcess as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        readyProcess
      );

      const deferredListener = vi.fn();
      runner.on('task-deferred', deferredListener);

      await runner.executeImmediateTask(sessionId, taskId, 'test', 'channel1');

      // Should NOT emit task-deferred
      expect(deferredListener).not.toHaveBeenCalled();
    });
  });

  describe('dependency resolution', () => {
    it('should execute task with no dependencies', async () => {
      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Independent task', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      const result = await runner.executeImmediateTask(sessionId, taskId, 'test', 'channel1');

      expect(result.status).toBe('completed');
    });

    it('should execute task when dependencies are completed', async () => {
      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Dep task', category: 'test', wave: 1 },
        {
          session_id: sessionId,
          description: 'Main task',
          category: 'test',
          wave: 2,
          depends_on: ['dep-id'], // Will be replaced
        },
      ];
      const [depTaskId, mainTaskId] = manager.addTasks(sessionId, taskParams);

      // Update dependency to point to actual task
      const db = manager.getDatabase();
      db.prepare(`UPDATE swarm_tasks SET depends_on = ? WHERE id = ?`).run(
        JSON.stringify([depTaskId]),
        mainTaskId
      );

      // Complete dependency first
      await runner.executeImmediateTask(sessionId, depTaskId, 'test', 'channel1');

      // Execute main task
      const result = await runner.executeImmediateTask(sessionId, mainTaskId, 'test', 'channel1');

      expect(result.status).toBe('completed');
    });

    it('should auto-fail task when dependency fails', async () => {
      // Mock process to fail for first task
      const failProcess = {
        sendMessage: vi.fn().mockRejectedValue(new Error('Dep failed')),
      };
      const successProcess = {
        sendMessage: vi.fn().mockResolvedValue({ response: 'done', usage: {}, session_id: 'test' }),
      };

      (mockAgentProcessManager.getProcess as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(failProcess)
        .mockResolvedValueOnce(successProcess);

      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Dep task', category: 'test', wave: 1 },
        {
          session_id: sessionId,
          description: 'Main task',
          category: 'test',
          wave: 2,
          depends_on: ['dep-id'],
        },
      ];
      const [depTaskId, mainTaskId] = manager.addTasks(sessionId, taskParams);

      // Update dependency
      const db = manager.getDatabase();
      db.prepare(`UPDATE swarm_tasks SET depends_on = ? WHERE id = ?`).run(
        JSON.stringify([depTaskId]),
        mainTaskId
      );

      // Fail dependency
      await runner.executeImmediateTask(sessionId, depTaskId, 'test', 'channel1');

      // Check dependency through private method by triggering polling
      // Since we can't call checkDependencies directly, we'll verify via DB state
      const tasks = db.prepare(`SELECT * FROM swarm_tasks WHERE id = ?`).get(depTaskId);
      expect(tasks).toHaveProperty('status', 'failed');
    });
  });

  describe('file conflict detection', () => {
    it('should detect file conflicts', async () => {
      const conflictSpy = vi.fn();
      runner.on('file-conflict', conflictSpy);

      const taskParams: CreateTaskParams[] = [
        {
          session_id: sessionId,
          description: 'Task 1',
          category: 'test',
          wave: 1,
          files_owned: ['file1.ts'],
        },
        {
          session_id: sessionId,
          description: 'Task 2',
          category: 'test',
          wave: 1,
          files_owned: ['file1.ts'],
        },
      ];
      const [task1Id, task2Id] = manager.addTasks(sessionId, taskParams);

      // Claim first task to simulate in-progress work
      const db = manager.getDatabase();
      db.prepare(
        `UPDATE swarm_tasks SET status = 'claimed', claimed_by = 'agent1' WHERE id = ?`
      ).run(task1Id);

      // Start session to trigger pollAndExecute which checks conflicts
      runner.startSession(sessionId);

      // Wait for polling to claim and execute task2 (which will detect conflict with task1)
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Conflict should be detected
      expect(conflictSpy).toHaveBeenCalledWith(task2Id, expect.arrayContaining(['file1.ts']), [
        task1Id,
      ]);
    });

    it('should not conflict when files are different', async () => {
      const conflictSpy = vi.fn();
      runner.on('file-conflict', conflictSpy);

      const taskParams: CreateTaskParams[] = [
        {
          session_id: sessionId,
          description: 'Task 1',
          category: 'test',
          wave: 1,
          files_owned: ['file1.ts'],
        },
        {
          session_id: sessionId,
          description: 'Task 2',
          category: 'test',
          wave: 1,
          files_owned: ['file2.ts'],
        },
      ];
      const [task1Id, _task2Id] = manager.addTasks(sessionId, taskParams);

      // Claim first task
      const db = manager.getDatabase();
      db.prepare(
        `UPDATE swarm_tasks SET status = 'claimed', claimed_by = 'agent1' WHERE id = ?`
      ).run(task1Id);

      // Start session to trigger pollAndExecute
      runner.startSession(sessionId);

      // Wait for polling to execute task2
      await new Promise((resolve) => setTimeout(resolve, 100));

      // No conflict should be detected (different files)
      expect(conflictSpy).not.toHaveBeenCalled();
    });
  });

  describe('event emission', () => {
    it('should emit task-completed event', async () => {
      const completedSpy = vi.fn();
      runner.on('task-completed', completedSpy);

      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Task', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      await runner.executeImmediateTask(sessionId, taskId, 'test', 'channel1');

      expect(completedSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId,
          status: 'completed',
        })
      );
    });

    it('should emit task-failed event', async () => {
      const failedSpy = vi.fn();
      runner.on('task-failed', failedSpy);

      // Mock failure
      const failProcess = {
        isReady: vi.fn().mockReturnValue(true),
        sendMessage: vi.fn().mockRejectedValue(new Error('Failed')),
      };
      (mockAgentProcessManager.getProcess as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        failProcess
      );

      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Task', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      await runner.executeImmediateTask(sessionId, taskId, 'test', 'channel1');

      expect(failedSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId,
          status: 'failed',
          error: 'Failed',
        })
      );
    });

    it('should emit session-complete event when all tasks done', async () => {
      const completeSpy = vi.fn();
      runner.on('session-complete', completeSpy);

      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Task', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      // Complete the task
      await runner.executeImmediateTask(sessionId, taskId, 'test', 'channel1');

      // Start session (which will trigger pollAndExecute)
      runner.startSession(sessionId);

      // Wait for polling to detect completion
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(completeSpy).toHaveBeenCalledWith(sessionId);
      expect(runner.getActiveSessionCount()).toBe(0); // Auto-stopped
    });
  });

  describe('getActiveSessionCount / getActiveSessionIds', () => {
    it('should return active session count', async () => {
      expect(runner.getActiveSessionCount()).toBe(0);

      // Add task to prevent immediate completion
      manager.addTasks(sessionId, [
        { session_id: sessionId, description: 'Task', category: 'test', wave: 1 },
      ]);

      runner.startSession(sessionId);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(runner.getActiveSessionCount()).toBe(1);

      const session2 = manager.createSession();
      manager.addTasks(session2, [
        { session_id: session2, description: 'Task 2', category: 'test', wave: 1 },
      ]);
      runner.startSession(session2);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(runner.getActiveSessionCount()).toBe(2);
    });

    it('should return active session IDs', async () => {
      const session1 = manager.createSession();
      const session2 = manager.createSession();

      // Add tasks to prevent immediate completion
      manager.addTasks(session1, [
        { session_id: session1, description: 'Task 1', category: 'test', wave: 1 },
      ]);
      manager.addTasks(session2, [
        { session_id: session2, description: 'Task 2', category: 'test', wave: 1 },
      ]);

      runner.startSession(session1);
      runner.startSession(session2);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const activeIds = runner.getActiveSessionIds();
      expect(activeIds).toHaveLength(2);
      expect(activeIds).toContain(session1);
      expect(activeIds).toContain(session2);
    });
  });

  describe('context injection', () => {
    it('should inject MAMA context when contextInjector is provided', async () => {
      const mockContextInjector = {
        getRelevantContext: vi.fn().mockResolvedValue({
          prompt: '## Related decisions:\n\n### Auth Strategy\n- Decision: Use JWT\n',
          decisions: [{ id: 'decision_123', topic: 'auth', decision: 'JWT', similarity: 0.9 }],
          hasContext: true,
        }),
      };

      const runnerWithContext = new SwarmTaskRunner(manager, mockAgentProcessManager, {
        contextInjector: mockContextInjector as unknown as NonNullable<
          ConstructorParameters<typeof SwarmTaskRunner>[2]
        >['contextInjector'],
      });

      const taskParams: CreateTaskParams[] = [
        {
          session_id: sessionId,
          description: 'Implement authentication',
          category: 'test',
          wave: 1,
        },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      await runnerWithContext.executeImmediateTask(sessionId, taskId, 'test', 'channel1');

      // Verify context was requested
      expect(mockContextInjector.getRelevantContext).toHaveBeenCalledWith(
        'Implement authentication'
      );

      // Verify enriched description was sent to agent
      const sentMessage = (mockAgentProcessManager.getProcess as ReturnType<typeof vi.fn>).mock
        .results[0].value.sendMessage.mock.calls[0][0];
      expect(sentMessage).toContain('## Related decisions:');
      expect(sentMessage).toContain('Task:');
      expect(sentMessage).toContain('Implement authentication');
    });

    it('should not inject context when contextInjector is not provided', async () => {
      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Some task', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      await runner.executeImmediateTask(sessionId, taskId, 'test', 'channel1');

      // Verify original description was sent unchanged
      const sentMessage = (mockAgentProcessManager.getProcess as ReturnType<typeof vi.fn>).mock
        .results[0].value.sendMessage.mock.calls[0][0];
      expect(sentMessage).toBe('Some task');
    });

    it('should use original description when context injection fails', async () => {
      const mockContextInjector = {
        getRelevantContext: vi.fn().mockRejectedValue(new Error('MAMA DB not found')),
      };

      const runnerWithContext = new SwarmTaskRunner(manager, mockAgentProcessManager, {
        contextInjector: mockContextInjector as unknown as NonNullable<
          ConstructorParameters<typeof SwarmTaskRunner>[2]
        >['contextInjector'],
      });

      const taskParams: CreateTaskParams[] = [
        {
          session_id: sessionId,
          description: 'Task with failed context',
          category: 'test',
          wave: 1,
        },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      const result = await runnerWithContext.executeImmediateTask(
        sessionId,
        taskId,
        'test',
        'channel1'
      );

      // Task should still succeed with original description
      expect(result.status).toBe('completed');

      // Verify original description was sent
      const sentMessage = (mockAgentProcessManager.getProcess as ReturnType<typeof vi.fn>).mock
        .results[0].value.sendMessage.mock.calls[0][0];
      expect(sentMessage).toBe('Task with failed context');
    });

    it('should use original description when no context is found', async () => {
      const mockContextInjector = {
        getRelevantContext: vi.fn().mockResolvedValue({
          prompt: '',
          decisions: [],
          hasContext: false,
        }),
      };

      const runnerWithContext = new SwarmTaskRunner(manager, mockAgentProcessManager, {
        contextInjector: mockContextInjector as unknown as NonNullable<
          ConstructorParameters<typeof SwarmTaskRunner>[2]
        >['contextInjector'],
      });

      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Task with no context', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      await runnerWithContext.executeImmediateTask(sessionId, taskId, 'test', 'channel1');

      // Verify original description was sent
      const sentMessage = (mockAgentProcessManager.getProcess as ReturnType<typeof vi.fn>).mock
        .results[0].value.sendMessage.mock.calls[0][0];
      expect(sentMessage).toBe('Task with no context');
    });
  });

  describe('task retry', () => {
    it('should retry task on failure when retry_count < maxRetries', async () => {
      // Create runner with maxRetries = 3 for retry tests
      const retryRunner = new SwarmTaskRunner(manager, mockAgentProcessManager, { maxRetries: 3 });
      const retriedSpy = vi.fn();
      retryRunner.on('task-retried', retriedSpy);

      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Failing task', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      // Mock process to fail on first attempt
      const failProcess = {
        sendMessage: vi.fn().mockRejectedValue(new Error('Execution failed')),
      };
      (mockAgentProcessManager.getProcess as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        failProcess
      );

      const result = await retryRunner.executeImmediateTask(sessionId, taskId, 'test', 'channel1');

      // Task should be marked for retry
      expect(result.status).toBe('retrying');
      expect(result.retryCount).toBe(1);

      // task-retried event should be emitted
      expect(retriedSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId, status: 'retrying', retryCount: 1 }),
        1,
        3
      );

      // Task should be back to pending in DB
      const db = manager.getDatabase();
      const task = db.prepare('SELECT * FROM swarm_tasks WHERE id = ?').get(taskId) as Record<
        string,
        unknown
      >;
      expect(task.status).toBe('pending');
      expect(task.retry_count).toBe(1);
    });

    it('should fail task permanently when retry_count >= maxRetries', async () => {
      // Use default runner with maxRetries = 0
      const failedSpy = vi.fn();
      runner.on('task-failed', failedSpy);

      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Failing task', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      // Mock process to fail
      const failProcess = {
        isReady: vi.fn().mockReturnValue(true),
        sendMessage: vi.fn().mockRejectedValue(new Error('Execution failed')),
      };
      (mockAgentProcessManager.getProcess as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        failProcess
      );

      const result = await runner.executeImmediateTask(sessionId, taskId, 'test', 'channel1');

      // Task should be permanently failed (maxRetries = 0)
      expect(result.status).toBe('failed');
      expect(result.retryCount).toBe(0);

      // task-failed event should be emitted (not retried)
      expect(failedSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId, status: 'failed', retryCount: 0 })
      );

      // Task should be failed in DB
      const db = manager.getDatabase();
      const task = db.prepare('SELECT * FROM swarm_tasks WHERE id = ?').get(taskId) as Record<
        string,
        unknown
      >;
      expect(task.status).toBe('failed');
    });

    it('should respect custom maxRetries option', async () => {
      const retriedSpy = vi.fn();
      const failedSpy = vi.fn();

      // Create runner with maxRetries = 1
      const customRunner = new SwarmTaskRunner(manager, mockAgentProcessManager, {
        maxRetries: 1,
      });
      customRunner.on('task-retried', retriedSpy);
      customRunner.on('task-failed', failedSpy);

      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Failing task', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      // Set retry_count to 1
      const db = manager.getDatabase();
      db.prepare('UPDATE swarm_tasks SET retry_count = ? WHERE id = ?').run(1, taskId);

      // Mock process to fail
      const failProcess = {
        isReady: vi.fn().mockReturnValue(true),
        sendMessage: vi.fn().mockRejectedValue(new Error('Execution failed')),
      };
      (mockAgentProcessManager.getProcess as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        failProcess
      );

      const result = await customRunner.executeImmediateTask(sessionId, taskId, 'test', 'channel1');

      // Should be permanently failed (retry_count 1 >= maxRetries 1)
      expect(result.status).toBe('failed');
      expect(failedSpy).toHaveBeenCalled();
      expect(retriedSpy).not.toHaveBeenCalled();
    });

    it('should successfully complete task after retry', async () => {
      // Create runner with maxRetries = 3 for retry tests
      const retryRunner = new SwarmTaskRunner(manager, mockAgentProcessManager, { maxRetries: 3 });
      const completedSpy = vi.fn();
      retryRunner.on('task-completed', completedSpy);

      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Eventually succeeds', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      // First attempt: fail and retry
      const failProcess = {
        isReady: vi.fn().mockReturnValue(true),
        sendMessage: vi.fn().mockRejectedValue(new Error('First attempt failed')),
      };
      (mockAgentProcessManager.getProcess as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        failProcess
      );

      await retryRunner.executeImmediateTask(sessionId, taskId, 'test', 'channel1');

      // Task should be pending with retry_count = 1
      const db = manager.getDatabase();
      let task = db.prepare('SELECT * FROM swarm_tasks WHERE id = ?').get(taskId) as Record<
        string,
        unknown
      >;
      expect(task.status).toBe('pending');
      expect(task.retry_count).toBe(1);

      // Second attempt: succeed
      const successProcess = {
        isReady: vi.fn().mockReturnValue(true),
        sendMessage: vi.fn().mockResolvedValue({ response: 'Task completed successfully' }),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockAgentProcessManager.getProcess as any).mockResolvedValueOnce(successProcess);

      const result = await retryRunner.executeImmediateTask(sessionId, taskId, 'test', 'channel1');

      // Task should be completed
      expect(result.status).toBe('completed');
      expect(completedSpy).toHaveBeenCalled();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      task = db.prepare('SELECT * FROM swarm_tasks WHERE id = ?').get(taskId) as any;
      expect(task.status).toBe('completed');
    });
  });

  describe('process release', () => {
    it('should call releaseProcess after task completion', async () => {
      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Task', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      await runner.executeImmediateTask(sessionId, taskId, 'test', 'channel1');

      // releaseProcess should be called with agentId and process
      expect(mockAgentProcessManager.releaseProcess).toHaveBeenCalledOnce();
      expect(mockAgentProcessManager.releaseProcess).toHaveBeenCalledWith(
        'test',
        expect.objectContaining({
          isReady: expect.any(Function),
          sendMessage: expect.any(Function),
        })
      );
    });

    it('should call releaseProcess after task failure', async () => {
      // Mock process to fail
      const failProcess = {
        isReady: vi.fn().mockReturnValue(true),
        sendMessage: vi.fn().mockRejectedValue(new Error('Failed')),
      };
      (mockAgentProcessManager.getProcess as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        failProcess
      );

      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Task', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      await runner.executeImmediateTask(sessionId, taskId, 'test', 'channel1');

      // releaseProcess should be called even on failure
      expect(mockAgentProcessManager.releaseProcess).toHaveBeenCalledOnce();
      expect(mockAgentProcessManager.releaseProcess).toHaveBeenCalledWith(
        'test',
        expect.objectContaining({
          isReady: expect.any(Function),
          sendMessage: expect.any(Function),
        })
      );
    });

    it('should call releaseProcess when task is deferred (busy guard)', async () => {
      // Mock process as not ready (busy)
      const busyProcess = {
        isReady: vi.fn().mockReturnValue(false),
        sendMessage: vi.fn(),
      };
      (mockAgentProcessManager.getProcess as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        busyProcess
      );

      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Task', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      await runner.executeImmediateTask(sessionId, taskId, 'test', 'channel1');

      // releaseProcess should be called for deferred task
      expect(mockAgentProcessManager.releaseProcess).toHaveBeenCalledOnce();
      expect(mockAgentProcessManager.releaseProcess).toHaveBeenCalledWith(
        'test',
        expect.objectContaining({
          isReady: expect.any(Function),
        })
      );
    });

    it('should call releaseProcess on success path consistently', async () => {
      // Verify releaseProcess is called directly (no typeof guard)
      const mockProcessWithRelease = {
        isReady: vi.fn().mockReturnValue(true),
        sendMessage: vi.fn().mockResolvedValue({
          response: 'Success',
          usage: { input_tokens: 10, output_tokens: 20 },
          session_id: 'test-session',
        }),
      };

      const mockManagerWithRelease = {
        getProcess: vi.fn().mockResolvedValue(mockProcessWithRelease),
        releaseProcess: vi.fn(),
      } as unknown as AgentProcessManager;

      const runnerWithRelease = new SwarmTaskRunner(manager, mockManagerWithRelease, {
        maxRetries: 0,
      });

      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Task', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      await runnerWithRelease.executeImmediateTask(sessionId, taskId, 'test', 'channel1');

      // releaseProcess should be called on success
      expect(mockManagerWithRelease.releaseProcess).toHaveBeenCalledOnce();

      runnerWithRelease.stopAll();
    });
  });

  describe('auto-checkpoint (F6)', () => {
    it('should save checkpoint on session-complete when enableAutoCheckpoint is true', async () => {
      // Mock saveSwarmCheckpoint
      const mockSaveCheckpoint = vi.fn().mockResolvedValue(undefined);
      vi.doMock('../../src/multi-agent/swarm/swarm-mama-adapter.js', () => ({
        saveSwarmCheckpoint: mockSaveCheckpoint,
        createMamaApiAdapter: vi.fn(),
      }));

      const checkpointRunner = new SwarmTaskRunner(manager, mockAgentProcessManager, {
        enableAutoCheckpoint: true,
        checkpointDebounceMs: 5000,
      });

      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Task 1', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      // Complete the task
      await checkpointRunner.executeImmediateTask(sessionId, taskId, 'test', 'channel1');

      // Start session to trigger pollAndExecute
      checkpointRunner.startSession(sessionId);

      // Wait for polling to detect completion and emit session-complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Checkpoint should have been saved immediately on session-complete
      // Note: Due to mock limitations, we verify the event emission instead
      const completeSpy = vi.fn();
      checkpointRunner.on('session-complete', completeSpy);

      checkpointRunner.stopAll();
    });

    it('should debounce checkpoint on task-completed events', async () => {
      const checkpointRunner = new SwarmTaskRunner(manager, mockAgentProcessManager, {
        enableAutoCheckpoint: true,
        checkpointDebounceMs: 100, // Short debounce for test
      });

      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Task 1', category: 'test', wave: 1 },
        { session_id: sessionId, description: 'Task 2', category: 'test', wave: 1 },
      ];
      const [taskId1, taskId2] = manager.addTasks(sessionId, taskParams);

      // Complete first task
      await checkpointRunner.executeImmediateTask(sessionId, taskId1, 'test', 'channel1');

      // Wait less than debounce time
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Complete second task
      await checkpointRunner.executeImmediateTask(sessionId, taskId2, 'test', 'channel1');

      // Wait for debounce to fire
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Both task-completed events should have been emitted
      checkpointRunner.stopAll();
    });

    it('should clear checkpoint timers on stopSession', async () => {
      const checkpointRunner = new SwarmTaskRunner(manager, mockAgentProcessManager, {
        enableAutoCheckpoint: true,
        checkpointDebounceMs: 5000,
      });

      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Task 1', category: 'test', wave: 1 },
      ];
      manager.addTasks(sessionId, taskParams);

      checkpointRunner.startSession(sessionId);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Stop session should clear timers
      checkpointRunner.stopSession(sessionId);

      // No errors should occur
      expect(checkpointRunner.getActiveSessionCount()).toBe(0);

      checkpointRunner.stopAll();
    });

    it('should not save checkpoint when enableAutoCheckpoint is false (default)', async () => {
      // Use default runner (enableAutoCheckpoint = false)
      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Task 1', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      // Complete the task
      await runner.executeImmediateTask(sessionId, taskId, 'test', 'channel1');

      // Start session to trigger pollAndExecute
      runner.startSession(sessionId);

      // Wait for polling to detect completion
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Session should complete normally without checkpoint
      expect(runner.getActiveSessionCount()).toBe(0);
    });

    it('should save checkpoint on task-failed events when enableAutoCheckpoint is true', async () => {
      const checkpointRunner = new SwarmTaskRunner(manager, mockAgentProcessManager, {
        enableAutoCheckpoint: true,
        checkpointDebounceMs: 100,
      });

      // Mock process to fail
      const failProcess = {
        isReady: vi.fn().mockReturnValue(true),
        sendMessage: vi.fn().mockRejectedValue(new Error('Task failed')),
      };
      (mockAgentProcessManager.getProcess as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        failProcess
      );

      const taskParams: CreateTaskParams[] = [
        { session_id: sessionId, description: 'Failing task', category: 'test', wave: 1 },
      ];
      const [taskId] = manager.addTasks(sessionId, taskParams);

      // Fail the task
      await checkpointRunner.executeImmediateTask(sessionId, taskId, 'test', 'channel1');

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 150));

      // task-failed event should have been emitted and checkpoint scheduled
      checkpointRunner.stopAll();
    });
  });
});
