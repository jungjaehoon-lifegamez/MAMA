/**
 * Tests for Swarm Event Reporter
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  SwarmEventReporter,
  type MessageSender,
} from '../../src/multi-agent/swarm/swarm-event-reporter.js';
import type {
  SwarmTaskRunner,
  TaskExecutionResult,
} from '../../src/multi-agent/swarm/swarm-task-runner.js';

describe('SwarmEventReporter', () => {
  let mockRunner: SwarmTaskRunner;
  let mockSendMessage: MessageSender;
  let reporter: SwarmEventReporter;

  beforeEach(() => {
    // Create mock SwarmTaskRunner using EventEmitter
    mockRunner = new EventEmitter() as unknown as SwarmTaskRunner;

    // Create mock sendMessage callback
    mockSendMessage = vi.fn().mockResolvedValue(undefined);

    // Create reporter instance
    reporter = new SwarmEventReporter(mockRunner, {
      sendMessage: mockSendMessage,
      channelId: 'test-channel-123',
      verbose: false,
    });
  });

  describe('start / stop', () => {
    it('should start listening to events', () => {
      expect(mockRunner.listenerCount('task-completed')).toBe(0);
      expect(mockRunner.listenerCount('task-failed')).toBe(0);
      expect(mockRunner.listenerCount('task-retried')).toBe(0);
      expect(mockRunner.listenerCount('session-complete')).toBe(0);
      expect(mockRunner.listenerCount('file-conflict')).toBe(0);

      reporter.start();

      expect(mockRunner.listenerCount('task-completed')).toBe(1);
      expect(mockRunner.listenerCount('task-failed')).toBe(1);
      expect(mockRunner.listenerCount('task-retried')).toBe(1);
      expect(mockRunner.listenerCount('session-complete')).toBe(1);
      expect(mockRunner.listenerCount('file-conflict')).toBe(1);
    });

    it('should stop listening to events', () => {
      reporter.start();
      expect(mockRunner.listenerCount('task-completed')).toBe(1);

      reporter.stop();

      expect(mockRunner.listenerCount('task-completed')).toBe(0);
      expect(mockRunner.listenerCount('task-failed')).toBe(0);
      expect(mockRunner.listenerCount('task-retried')).toBe(0);
      expect(mockRunner.listenerCount('session-complete')).toBe(0);
      expect(mockRunner.listenerCount('file-conflict')).toBe(0);
    });

    it('should be idempotent on duplicate start()', () => {
      reporter.start();
      reporter.start(); // Duplicate

      // Should still have only 1 listener per event
      expect(mockRunner.listenerCount('task-completed')).toBe(1);
      expect(mockRunner.listenerCount('task-failed')).toBe(1);
    });

    it('should be idempotent on duplicate stop()', () => {
      reporter.start();
      reporter.stop();
      reporter.stop(); // Duplicate

      expect(mockRunner.listenerCount('task-completed')).toBe(0);
    });

    it('should handle stop() without start()', () => {
      // Should not throw
      expect(() => reporter.stop()).not.toThrow();
    });
  });

  describe('task-completed event', () => {
    it('should format and send task-completed message', async () => {
      reporter.start();

      const result: TaskExecutionResult = {
        taskId: '12345678-1234-1234-1234-123456789abc',
        agentId: 'developer',
        status: 'completed',
        result: 'Task executed successfully',
      };

      mockRunner.emit('task-completed', result);

      // Wait for async sendMessage
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockSendMessage).toHaveBeenCalledOnce();
      expect(mockSendMessage).toHaveBeenCalledWith(
        'test-channel-123',
        expect.stringContaining('✅ Task `12345678` completed by agent `developer`')
      );
    });

    it('should include result preview in verbose mode', async () => {
      reporter = new SwarmEventReporter(mockRunner, {
        sendMessage: mockSendMessage,
        channelId: 'test-channel-123',
        verbose: true,
      });
      reporter.start();

      const result: TaskExecutionResult = {
        taskId: '12345678-abcd',
        agentId: 'tester',
        status: 'completed',
        result:
          'This is a very long result message that should be truncated to 80 characters maximum for readability',
      };

      mockRunner.emit('task-completed', result);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const message = (mockSendMessage as any).mock.calls[0][1];
      expect(message).toContain(
        'This is a very long result message that should be truncated to 80 characters '
      );
    });

    it('should not include result in non-verbose mode', async () => {
      reporter.start();

      const result: TaskExecutionResult = {
        taskId: 'abc123',
        agentId: 'developer',
        status: 'completed',
        result: 'Some result',
      };

      mockRunner.emit('task-completed', result);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const message = (mockSendMessage as any).mock.calls[0][1];
      expect(message).not.toContain('Some result');
    });
  });

  describe('task-failed event', () => {
    it('should format and send task-failed message', async () => {
      reporter.start();

      const result: TaskExecutionResult = {
        taskId: 'fail-task-12345678',
        agentId: 'developer',
        status: 'failed',
        error: 'Execution failed due to network error',
      };

      mockRunner.emit('task-failed', result);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockSendMessage).toHaveBeenCalledOnce();
      expect(mockSendMessage).toHaveBeenCalledWith(
        'test-channel-123',
        expect.stringContaining('❌ Task `fail-tas` failed')
      );
      expect((mockSendMessage as any).mock.calls[0][1]).toContain(
        'Error: Execution failed due to network error'
      );
    });

    it('should truncate long error messages', async () => {
      reporter.start();

      const longError = 'A'.repeat(150);
      const result: TaskExecutionResult = {
        taskId: 'task-id',
        agentId: 'developer',
        status: 'failed',
        error: longError,
      };

      mockRunner.emit('task-failed', result);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const message = (mockSendMessage as any).mock.calls[0][1];
      expect(message.length).toBeLessThan(200); // Should be truncated
      expect(message).toContain('...');
    });

    it('should include agentId in verbose mode', async () => {
      reporter = new SwarmEventReporter(mockRunner, {
        sendMessage: mockSendMessage,
        channelId: 'test-channel-123',
        verbose: true,
      });
      reporter.start();

      const result: TaskExecutionResult = {
        taskId: 'task-id',
        agentId: 'test-agent',
        status: 'failed',
        error: 'Failed',
      };

      mockRunner.emit('task-failed', result);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const message = (mockSendMessage as any).mock.calls[0][1];
      expect(message).toContain('Agent: `test-agent`');
    });
  });

  describe('task-retried event', () => {
    it('should format and send task-retried message', async () => {
      reporter.start();

      const result: TaskExecutionResult = {
        taskId: 'retry-task-12345678',
        agentId: 'developer',
        status: 'failed',
        error: 'Execution failed',
        retryCount: 1,
      };

      mockRunner.emit('task-retried', result, 1, 3);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockSendMessage).toHaveBeenCalledOnce();
      const message = (mockSendMessage as any).mock.calls[0][1];
      expect(message).toContain('🔄 Task `retry-ta` retrying (attempt 1/3)');
    });

    it('should include error in verbose mode', async () => {
      reporter = new SwarmEventReporter(mockRunner, {
        sendMessage: mockSendMessage,
        channelId: 'test-channel-123',
        verbose: true,
      });
      reporter.start();

      const result: TaskExecutionResult = {
        taskId: 'task-id',
        agentId: 'developer',
        status: 'failed',
        error: 'Network timeout occurred while processing the request',
        retryCount: 2,
      };

      mockRunner.emit('task-retried', result, 2, 3);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const message = (mockSendMessage as any).mock.calls[0][1];
      expect(message).toContain('🔄 Task `task-id` retrying (attempt 2/3)');
      expect(message).toContain('Error: Network timeout occurred while processing the request');
    });

    it('should not include error in non-verbose mode', async () => {
      reporter.start();

      const result: TaskExecutionResult = {
        taskId: 'task-id',
        agentId: 'developer',
        status: 'failed',
        error: 'Some error',
        retryCount: 1,
      };

      mockRunner.emit('task-retried', result, 1, 3);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const message = (mockSendMessage as any).mock.calls[0][1];
      expect(message).not.toContain('Some error');
    });
  });

  describe('task-deferred event', () => {
    it('should format and send task-deferred message', async () => {
      reporter.start();

      const result: TaskExecutionResult = {
        taskId: 'deferred-task-12345678',
        agentId: 'developer',
        status: 'failed',
        error: 'Agent process busy, task deferred',
      };

      mockRunner.emit('task-deferred', result);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockSendMessage).toHaveBeenCalledOnce();
      const message = (mockSendMessage as any).mock.calls[0][1];
      expect(message).toContain('⏸️ Task `deferred` deferred — agent `developer` busy');
    });

    it('should include error reason in verbose mode', async () => {
      reporter = new SwarmEventReporter(mockRunner, {
        sendMessage: mockSendMessage,
        channelId: 'test-channel-123',
        verbose: true,
      });
      reporter.start();

      const result: TaskExecutionResult = {
        taskId: 'task-id',
        agentId: 'developer',
        status: 'failed',
        error: 'Agent process busy, task deferred',
      };

      mockRunner.emit('task-deferred', result);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const message = (mockSendMessage as any).mock.calls[0][1];
      expect(message).toContain('⏸️ Task `task-id` deferred — agent `developer` busy');
      expect(message).toContain('Reason: Agent process busy, task deferred');
    });
  });

  describe('session-complete event', () => {
    it('should format and send session-complete message', async () => {
      reporter.start();

      mockRunner.emit('session-complete', 'session-12345678-abcd-1234');
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockSendMessage).toHaveBeenCalledOnce();
      const message = (mockSendMessage as any).mock.calls[0][1];
      expect(message).toContain('🏁 Session');
      expect(message).toContain('complete — all tasks finished');
    });
  });

  describe('file-conflict event', () => {
    it('should format and send file-conflict message', async () => {
      reporter.start();

      mockRunner.emit(
        'file-conflict',
        'task-12345678',
        ['file1.ts', 'file2.ts'],
        ['conflicting-task-abcd1234']
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockSendMessage).toHaveBeenCalledOnce();
      const message = (mockSendMessage as any).mock.calls[0][1];
      expect(message).toContain('⚠️ File conflict: task `task-123` shares files with `conflict`');
    });

    it('should include file list in verbose mode', async () => {
      reporter = new SwarmEventReporter(mockRunner, {
        sendMessage: mockSendMessage,
        channelId: 'test-channel-123',
        verbose: true,
      });
      reporter.start();

      mockRunner.emit(
        'file-conflict',
        'task-id',
        ['file1.ts', 'file2.ts', 'file3.ts'],
        ['task-a', 'task-b']
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      const message = (mockSendMessage as any).mock.calls[0][1];
      expect(message).toContain('Files: file1.ts, file2.ts, file3.ts');
    });

    it('should truncate file list when more than 5 files', async () => {
      reporter = new SwarmEventReporter(mockRunner, {
        sendMessage: mockSendMessage,
        channelId: 'test-channel-123',
        verbose: true,
      });
      reporter.start();

      const manyFiles = [
        'file1.ts',
        'file2.ts',
        'file3.ts',
        'file4.ts',
        'file5.ts',
        'file6.ts',
        'file7.ts',
      ];
      mockRunner.emit('file-conflict', 'task-id', manyFiles, ['task-a']);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const message = (mockSendMessage as any).mock.calls[0][1];
      expect(message).toContain('(+2 more)');
    });
  });

  describe('message length enforcement', () => {
    it('should enforce 1800 character limit', async () => {
      reporter.start();

      const veryLongError = 'A'.repeat(2000);
      const result: TaskExecutionResult = {
        taskId: 'task-id',
        agentId: 'developer',
        status: 'failed',
        error: veryLongError,
      };

      mockRunner.emit('task-failed', result);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const message = (mockSendMessage as any).mock.calls[0][1];
      expect(message.length).toBeLessThanOrEqual(1800);
    });
  });

  describe('error handling', () => {
    it('should not throw when sendMessage fails', async () => {
      const errorSendMessage = vi.fn().mockRejectedValue(new Error('Network error'));
      reporter = new SwarmEventReporter(mockRunner, {
        sendMessage: errorSendMessage,
        channelId: 'test-channel-123',
        verbose: false,
      });
      reporter.start();

      const result: TaskExecutionResult = {
        taskId: 'task-id',
        agentId: 'developer',
        status: 'completed',
      };

      // Should not throw
      expect(() => mockRunner.emit('task-completed', result)).not.toThrow();

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(errorSendMessage).toHaveBeenCalledOnce();
    });
  });

  describe('multiple events', () => {
    it('should handle multiple events in sequence', async () => {
      reporter.start();

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

      mockRunner.emit('task-completed', result1);
      mockRunner.emit('task-failed', result2);
      mockRunner.emit('session-complete', 'session-123');

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockSendMessage).toHaveBeenCalledTimes(3);
    });
  });
});
