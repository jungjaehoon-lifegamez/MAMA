/**
 * Tests for Swarm Task Learner
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { SwarmTaskLearner } from '../../src/multi-agent/swarm/swarm-task-learner.js';
import type {
  SwarmTaskRunner,
  TaskExecutionResult,
} from '../../src/multi-agent/swarm/swarm-task-runner.js';

describe('SwarmTaskLearner', () => {
  let mockRunner: SwarmTaskRunner;
  let mockSaveFn: ReturnType<typeof vi.fn>;
  let learner: SwarmTaskLearner;

  beforeEach(() => {
    // Create mock SwarmTaskRunner using EventEmitter
    mockRunner = new EventEmitter() as unknown as SwarmTaskRunner;

    // Create mock save function
    mockSaveFn = vi.fn().mockResolvedValue({ success: true, id: 'decision_123' });
  });

  describe('start / stop', () => {
    it('should start listening to events', () => {
      learner = new SwarmTaskLearner(mockRunner, {
        enabled: true,
        verbose: false,
        saveFn: mockSaveFn,
      });

      expect(mockRunner.listenerCount('task-completed')).toBe(0);
      expect(mockRunner.listenerCount('task-failed')).toBe(0);

      learner.start();

      expect(mockRunner.listenerCount('task-completed')).toBe(1);
      expect(mockRunner.listenerCount('task-failed')).toBe(1);
    });

    it('should stop listening to events', () => {
      learner = new SwarmTaskLearner(mockRunner, {
        enabled: true,
        saveFn: mockSaveFn,
      });

      learner.start();
      expect(mockRunner.listenerCount('task-completed')).toBe(1);

      learner.stop();

      expect(mockRunner.listenerCount('task-completed')).toBe(0);
      expect(mockRunner.listenerCount('task-failed')).toBe(0);
    });

    it('should be idempotent on duplicate start()', () => {
      learner = new SwarmTaskLearner(mockRunner, {
        enabled: true,
        saveFn: mockSaveFn,
      });

      learner.start();
      learner.start(); // Duplicate

      // Should still have only 1 listener per event
      expect(mockRunner.listenerCount('task-completed')).toBe(1);
      expect(mockRunner.listenerCount('task-failed')).toBe(1);
    });

    it('should be idempotent on duplicate stop()', () => {
      learner = new SwarmTaskLearner(mockRunner, {
        enabled: true,
        saveFn: mockSaveFn,
      });

      learner.start();
      learner.stop();
      learner.stop(); // Duplicate

      expect(mockRunner.listenerCount('task-completed')).toBe(0);
    });

    it('should handle stop() without start()', () => {
      learner = new SwarmTaskLearner(mockRunner, {
        enabled: true,
        saveFn: mockSaveFn,
      });

      // Should not throw
      expect(() => learner.stop()).not.toThrow();
    });

    it('should not start when enabled=false', () => {
      learner = new SwarmTaskLearner(mockRunner, {
        enabled: false,
        saveFn: mockSaveFn,
      });

      learner.start();

      // Should not register any listeners
      expect(mockRunner.listenerCount('task-completed')).toBe(0);
      expect(mockRunner.listenerCount('task-failed')).toBe(0);
    });
  });

  describe('task-completed event', () => {
    it('should save task-completed to MAMA DB', async () => {
      learner = new SwarmTaskLearner(mockRunner, {
        enabled: true,
        verbose: false,
        saveFn: mockSaveFn,
      });
      learner.start();

      const result: TaskExecutionResult = {
        taskId: '12345678-1234-1234-1234-123456789abc',
        agentId: 'developer',
        status: 'completed',
        result: 'Task executed successfully',
      };

      mockRunner.emit('task-completed', result);

      // Wait for async save
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockSaveFn).toHaveBeenCalledOnce();
      expect(mockSaveFn).toHaveBeenCalledWith({
        type: 'decision',
        topic: 'swarm:developer:completed',
        decision: 'Task executed successfully',
        outcome: 'success',
        confidence: 0.8,
      });
    });

    it('should truncate long results to 200 characters', async () => {
      learner = new SwarmTaskLearner(mockRunner, {
        enabled: true,
        saveFn: mockSaveFn,
      });
      learner.start();

      const longResult = 'A'.repeat(250);
      const result: TaskExecutionResult = {
        taskId: 'task-id',
        agentId: 'developer',
        status: 'completed',
        result: longResult,
      };

      mockRunner.emit('task-completed', result);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const savedDecision = (mockSaveFn.mock.calls[0][0] as { decision: string }).decision;
      expect(savedDecision.length).toBe(200);
      expect(savedDecision).toContain('...');
    });

    it('should use default message when result is empty', async () => {
      learner = new SwarmTaskLearner(mockRunner, {
        enabled: true,
        saveFn: mockSaveFn,
      });
      learner.start();

      const result: TaskExecutionResult = {
        taskId: 'task-id',
        agentId: 'developer',
        status: 'completed',
      };

      mockRunner.emit('task-completed', result);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockSaveFn).toHaveBeenCalledWith({
        type: 'decision',
        topic: 'swarm:developer:completed',
        decision: 'Task completed',
        outcome: 'success',
        confidence: 0.8,
      });
    });
  });

  describe('task-failed event', () => {
    it('should save task-failed to MAMA DB with reasoning', async () => {
      learner = new SwarmTaskLearner(mockRunner, {
        enabled: true,
        verbose: false,
        saveFn: mockSaveFn,
      });
      learner.start();

      const result: TaskExecutionResult = {
        taskId: 'fail-task-12345678',
        agentId: 'developer',
        status: 'failed',
        error: 'Network timeout occurred',
        retryCount: 3,
      };

      mockRunner.emit('task-failed', result);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockSaveFn).toHaveBeenCalledOnce();
      expect(mockSaveFn).toHaveBeenCalledWith({
        type: 'decision',
        topic: 'swarm:developer:failed',
        decision: 'Task fail-tas failed after 3 retries',
        reasoning: 'Network timeout occurred',
        outcome: 'failed',
        confidence: 0.9,
      });
    });

    it('should handle missing error message', async () => {
      learner = new SwarmTaskLearner(mockRunner, {
        enabled: true,
        saveFn: mockSaveFn,
      });
      learner.start();

      const result: TaskExecutionResult = {
        taskId: 'task-id',
        agentId: 'developer',
        status: 'failed',
      };

      mockRunner.emit('task-failed', result);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const savedParams = mockSaveFn.mock.calls[0][0];
      expect(savedParams.reasoning).toBe('Unknown error');
    });

    it('should handle retryCount = 0', async () => {
      learner = new SwarmTaskLearner(mockRunner, {
        enabled: true,
        saveFn: mockSaveFn,
      });
      learner.start();

      const result: TaskExecutionResult = {
        taskId: 'task-id-12345678',
        agentId: 'developer',
        status: 'failed',
        error: 'Failed',
        retryCount: 0,
      };

      mockRunner.emit('task-failed', result);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const savedParams = mockSaveFn.mock.calls[0][0];
      expect(savedParams.decision).toBe('Task task-id- failed after 0 retries');
    });
  });

  describe('error handling', () => {
    it('should not throw when save fails', async () => {
      const errorSaveFn = vi.fn().mockRejectedValue(new Error('Database error'));
      learner = new SwarmTaskLearner(mockRunner, {
        enabled: true,
        verbose: false,
        saveFn: errorSaveFn,
      });
      learner.start();

      const result: TaskExecutionResult = {
        taskId: 'task-id',
        agentId: 'developer',
        status: 'completed',
        result: 'Success',
      };

      // Should not throw
      expect(() => mockRunner.emit('task-completed', result)).not.toThrow();

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(errorSaveFn).toHaveBeenCalledOnce();
    });

    it('should handle save returning non-success', async () => {
      const failSaveFn = vi.fn().mockResolvedValue({ success: false });
      learner = new SwarmTaskLearner(mockRunner, {
        enabled: true,
        saveFn: failSaveFn,
      });
      learner.start();

      const result: TaskExecutionResult = {
        taskId: 'task-id',
        agentId: 'developer',
        status: 'completed',
      };

      // Should not throw
      expect(() => mockRunner.emit('task-completed', result)).not.toThrow();

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(failSaveFn).toHaveBeenCalledOnce();
    });

    it('should warn in verbose mode when save returns success=false', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const failSaveFn = vi.fn().mockResolvedValue({ success: false });

      learner = new SwarmTaskLearner(mockRunner, {
        enabled: true,
        verbose: true,
        saveFn: failSaveFn,
      });
      learner.start();

      const result: TaskExecutionResult = {
        taskId: 'task-12345678',
        agentId: 'developer',
        status: 'completed',
      };

      mockRunner.emit('task-completed', result);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          '[SwarmTaskLearner] Save returned success=false for completed, task task-123'
        )
      );

      consoleWarnSpy.mockRestore();
    });
  });

  describe('enabled option', () => {
    it('should not save when enabled=false', async () => {
      learner = new SwarmTaskLearner(mockRunner, {
        enabled: false,
        saveFn: mockSaveFn,
      });
      learner.start();

      const result: TaskExecutionResult = {
        taskId: 'task-id',
        agentId: 'developer',
        status: 'completed',
      };

      mockRunner.emit('task-completed', result);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should not call save
      expect(mockSaveFn).not.toHaveBeenCalled();
    });
  });

  describe('verbose logging', () => {
    it('should log save success in verbose mode', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      learner = new SwarmTaskLearner(mockRunner, {
        enabled: true,
        verbose: true,
        saveFn: mockSaveFn,
      });
      learner.start();

      const result: TaskExecutionResult = {
        taskId: 'task-12345678',
        agentId: 'developer',
        status: 'completed',
      };

      mockRunner.emit('task-completed', result);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[SwarmTaskLearner] Saved completed for task task-123')
      );

      consoleSpy.mockRestore();
    });

    it('should log save failure in verbose mode', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSaveFn = vi.fn().mockRejectedValue(new Error('Save failed'));

      learner = new SwarmTaskLearner(mockRunner, {
        enabled: true,
        verbose: true,
        saveFn: errorSaveFn,
      });
      learner.start();

      const result: TaskExecutionResult = {
        taskId: 'task-id',
        agentId: 'developer',
        status: 'completed',
      };

      mockRunner.emit('task-completed', result);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[SwarmTaskLearner] Failed to save completed for task task-id'),
        expect.any(Error)
      );

      consoleWarnSpy.mockRestore();
    });

    it('should not log in non-verbose mode', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      learner = new SwarmTaskLearner(mockRunner, {
        enabled: true,
        verbose: false,
        saveFn: mockSaveFn,
      });
      learner.start();

      const result: TaskExecutionResult = {
        taskId: 'task-id',
        agentId: 'developer',
        status: 'completed',
      };

      mockRunner.emit('task-completed', result);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should only log "Started learning" message, not individual saves
      const logCalls = consoleSpy.mock.calls.map((call) => call[0]);
      const saveLogs = logCalls.filter((msg) => msg.includes('Saved'));
      expect(saveLogs.length).toBe(0);

      consoleSpy.mockRestore();
    });
  });

  describe('multiple events', () => {
    it('should handle multiple events in sequence', async () => {
      learner = new SwarmTaskLearner(mockRunner, {
        enabled: true,
        saveFn: mockSaveFn,
      });
      learner.start();

      const result1: TaskExecutionResult = {
        taskId: 'task-1',
        agentId: 'agent-1',
        status: 'completed',
      };

      const result2: TaskExecutionResult = {
        taskId: 'task-2',
        agentId: 'agent-2',
        status: 'failed',
        error: 'Failed',
      };

      const result3: TaskExecutionResult = {
        taskId: 'task-3',
        agentId: 'agent-1',
        status: 'completed',
        result: 'Success',
      };

      mockRunner.emit('task-completed', result1);
      mockRunner.emit('task-failed', result2);
      mockRunner.emit('task-completed', result3);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockSaveFn).toHaveBeenCalledTimes(3);
    });
  });
});
