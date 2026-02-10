/**
 * Unit tests for CronScheduler
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CronScheduler, SchedulerError } from '../../src/scheduler/index.js';
import type { JobConfig, JobEvent } from '../../src/scheduler/types.js';

describe('CronScheduler', () => {
  let scheduler: CronScheduler;

  beforeEach(() => {
    scheduler = new CronScheduler();
  });

  afterEach(() => {
    scheduler.shutdown();
  });

  describe('addJob()', () => {
    it('should add job with valid cron expression', () => {
      const config: JobConfig = {
        id: 'test-job',
        name: 'Test Job',
        cronExpr: '*/5 * * * *', // Every 5 minutes
        prompt: 'Test prompt',
      };

      const id = scheduler.addJob(config);

      expect(id).toBe('test-job');
    });

    it('should throw error for invalid cron expression', () => {
      const config: JobConfig = {
        id: 'bad-job',
        name: 'Bad Job',
        cronExpr: 'invalid cron',
        prompt: 'Test prompt',
      };

      expect(() => scheduler.addJob(config)).toThrow(SchedulerError);
      expect(() => scheduler.addJob(config)).toThrow(/Invalid cron expression/);
    });

    it('should throw error for duplicate job id', () => {
      const config: JobConfig = {
        id: 'duplicate-job',
        name: 'Job 1',
        cronExpr: '0 * * * *',
        prompt: 'Test',
      };

      scheduler.addJob(config);

      expect(() => scheduler.addJob({ ...config, name: 'Job 2' })).toThrow(SchedulerError);
      expect(() => scheduler.addJob({ ...config, name: 'Job 2' })).toThrow(/already exists/);
    });

    it('should default enabled to true', () => {
      const config: JobConfig = {
        id: 'test-job',
        name: 'Test',
        cronExpr: '0 * * * *',
        prompt: 'Test',
      };

      scheduler.addJob(config);
      const job = scheduler.getJob('test-job');

      expect(job?.enabled).toBe(true);
    });

    it('should respect enabled option', () => {
      const config: JobConfig = {
        id: 'disabled-job',
        name: 'Disabled',
        cronExpr: '0 * * * *',
        prompt: 'Test',
        enabled: false,
      };

      scheduler.addJob(config);
      const job = scheduler.getJob('disabled-job');

      expect(job?.enabled).toBe(false);
    });

    it('should calculate next run time', () => {
      const config: JobConfig = {
        id: 'test-job',
        name: 'Test',
        cronExpr: '0 * * * *', // Every hour at minute 0
        prompt: 'Test',
      };

      scheduler.addJob(config);
      const job = scheduler.getJob('test-job');

      expect(job?.nextRun).toBeInstanceOf(Date);
      expect(job?.nextRun!.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('removeJob()', () => {
    it('should remove existing job', () => {
      scheduler.addJob({
        id: 'to-remove',
        name: 'Remove Me',
        cronExpr: '0 * * * *',
        prompt: 'Test',
      });

      scheduler.removeJob('to-remove');

      expect(scheduler.getJob('to-remove')).toBeNull();
    });

    it('should throw error for non-existent job', () => {
      expect(() => scheduler.removeJob('nonexistent')).toThrow(SchedulerError);
      expect(() => scheduler.removeJob('nonexistent')).toThrow(/not found/);
    });
  });

  describe('enableJob() and disableJob()', () => {
    it('should enable disabled job', () => {
      scheduler.addJob({
        id: 'toggle-job',
        name: 'Toggle',
        cronExpr: '0 * * * *',
        prompt: 'Test',
        enabled: false,
      });

      scheduler.enableJob('toggle-job');
      const job = scheduler.getJob('toggle-job');

      expect(job?.enabled).toBe(true);
      expect(job?.nextRun).toBeInstanceOf(Date);
    });

    it('should disable enabled job', () => {
      scheduler.addJob({
        id: 'toggle-job',
        name: 'Toggle',
        cronExpr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
      });

      scheduler.disableJob('toggle-job');
      const job = scheduler.getJob('toggle-job');

      expect(job?.enabled).toBe(false);
      expect(job?.nextRun).toBeUndefined();
    });

    it('should throw error for non-existent job', () => {
      expect(() => scheduler.enableJob('nonexistent')).toThrow(SchedulerError);
      expect(() => scheduler.disableJob('nonexistent')).toThrow(SchedulerError);
    });
  });

  describe('listJobs()', () => {
    it('should return empty array when no jobs', () => {
      expect(scheduler.listJobs()).toHaveLength(0);
    });

    it('should return all jobs', () => {
      scheduler.addJob({
        id: 'job1',
        name: 'Job 1',
        cronExpr: '0 * * * *',
        prompt: 'Test 1',
      });
      scheduler.addJob({
        id: 'job2',
        name: 'Job 2',
        cronExpr: '*/5 * * * *',
        prompt: 'Test 2',
      });

      const jobs = scheduler.listJobs();

      expect(jobs).toHaveLength(2);
      expect(jobs.map((j) => j.id)).toContain('job1');
      expect(jobs.map((j) => j.id)).toContain('job2');
    });

    it('should not expose internal task object', () => {
      scheduler.addJob({
        id: 'job1',
        name: 'Job 1',
        cronExpr: '0 * * * *',
        prompt: 'Test',
      });

      const jobs = scheduler.listJobs();

      // @ts-expect-error - task should not be present
      expect(jobs[0].task).toBeUndefined();
    });
  });

  describe('getJob()', () => {
    it('should return null for non-existent job', () => {
      expect(scheduler.getJob('nonexistent')).toBeNull();
    });

    it('should return job info', () => {
      scheduler.addJob({
        id: 'my-job',
        name: 'My Job',
        cronExpr: '0 * * * *',
        prompt: 'Test prompt',
      });

      const job = scheduler.getJob('my-job');

      expect(job).not.toBeNull();
      expect(job!.id).toBe('my-job');
      expect(job!.name).toBe('My Job');
      expect(job!.cronExpr).toBe('0 * * * *');
      expect(job!.prompt).toBe('Test prompt');
    });
  });

  describe('runNow()', () => {
    it('should execute job immediately', async () => {
      let executed = false;
      scheduler.setExecuteCallback(async () => {
        executed = true;
        return 'result';
      });

      scheduler.addJob({
        id: 'run-now-job',
        name: 'Run Now',
        cronExpr: '0 0 1 1 *', // Far future
        prompt: 'Execute me',
      });

      const result = await scheduler.runNow('run-now-job');

      expect(executed).toBe(true);
      expect(result.success).toBe(true);
    });

    it('should throw error for non-existent job', async () => {
      await expect(scheduler.runNow('nonexistent')).rejects.toThrow(SchedulerError);
    });

    it('should update lastRun after execution', async () => {
      scheduler.setExecuteCallback(async () => 'result');
      scheduler.addJob({
        id: 'track-job',
        name: 'Track',
        cronExpr: '0 * * * *',
        prompt: 'Test',
      });

      const beforeRun = Date.now();
      await scheduler.runNow('track-job');
      const job = scheduler.getJob('track-job');

      expect(job?.lastRun).toBeInstanceOf(Date);
      expect(job?.lastRun!.getTime()).toBeGreaterThanOrEqual(beforeRun);
    });

    it('should handle execution errors', async () => {
      scheduler.setExecuteCallback(async () => {
        throw new Error('Execution failed');
      });

      scheduler.addJob({
        id: 'error-job',
        name: 'Error',
        cronExpr: '0 * * * *',
        prompt: 'Test',
      });

      const result = await scheduler.runNow('error-job');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Execution failed');
    });
  });

  describe('concurrent execution prevention', () => {
    it('should skip if job is already running', async () => {
      let runCount = 0;
      scheduler.setExecuteCallback(async () => {
        runCount++;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return 'result';
      });

      scheduler.addJob({
        id: 'concurrent-job',
        name: 'Concurrent',
        cronExpr: '0 * * * *',
        prompt: 'Test',
      });

      // Start two executions simultaneously
      const promise1 = scheduler.runNow('concurrent-job');
      const promise2 = scheduler.runNow('concurrent-job');

      const [result1, result2] = await Promise.all([promise1, promise2]);

      // One should succeed, one should be skipped
      expect(runCount).toBe(1);
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(false);
      expect(result2.error).toBe('Job is already running');
    });

    it('should report running state via isJobRunning', async () => {
      let resolveExecution: () => void;
      const executionPromise = new Promise<void>((resolve) => {
        resolveExecution = resolve;
      });

      scheduler.setExecuteCallback(async () => {
        await executionPromise;
        return 'result';
      });

      scheduler.addJob({
        id: 'running-check-job',
        name: 'Running Check',
        cronExpr: '0 * * * *',
        prompt: 'Test',
      });

      // Start execution
      const runPromise = scheduler.runNow('running-check-job');

      // Check running state
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(scheduler.isJobRunning('running-check-job')).toBe(true);

      // Complete execution
      resolveExecution!();
      await runPromise;

      expect(scheduler.isJobRunning('running-check-job')).toBe(false);
    });
  });

  describe('event handling', () => {
    it('should emit started event', async () => {
      const events: JobEvent[] = [];
      scheduler.onEvent((event) => events.push(event));
      scheduler.setExecuteCallback(async () => 'result');

      scheduler.addJob({
        id: 'event-job',
        name: 'Event',
        cronExpr: '0 * * * *',
        prompt: 'Test',
      });

      await scheduler.runNow('event-job');

      const startedEvent = events.find((e) => e.type === 'started');
      expect(startedEvent).toBeDefined();
      expect(startedEvent!.jobId).toBe('event-job');
    });

    it('should emit completed event on success', async () => {
      const events: JobEvent[] = [];
      scheduler.onEvent((event) => events.push(event));
      scheduler.setExecuteCallback(async () => 'result');

      scheduler.addJob({
        id: 'event-job',
        name: 'Event',
        cronExpr: '0 * * * *',
        prompt: 'Test',
      });

      await scheduler.runNow('event-job');

      const completedEvent = events.find((e) => e.type === 'completed');
      expect(completedEvent).toBeDefined();
      expect(completedEvent!.result?.success).toBe(true);
    });

    it('should emit failed event on error', async () => {
      const events: JobEvent[] = [];
      scheduler.onEvent((event) => events.push(event));
      scheduler.setExecuteCallback(async () => {
        throw new Error('Test error');
      });

      scheduler.addJob({
        id: 'fail-job',
        name: 'Fail',
        cronExpr: '0 * * * *',
        prompt: 'Test',
      });

      await scheduler.runNow('fail-job');

      const failedEvent = events.find((e) => e.type === 'failed');
      expect(failedEvent).toBeDefined();
      expect(failedEvent!.result?.success).toBe(false);
    });

    it('should emit skipped event when job is running', async () => {
      const events: JobEvent[] = [];
      scheduler.onEvent((event) => events.push(event));
      scheduler.setExecuteCallback(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return 'result';
      });

      scheduler.addJob({
        id: 'skip-job',
        name: 'Skip',
        cronExpr: '0 * * * *',
        prompt: 'Test',
      });

      // Start two executions
      const promise1 = scheduler.runNow('skip-job');
      const promise2 = scheduler.runNow('skip-job');
      await Promise.all([promise1, promise2]);

      const skippedEvent = events.find((e) => e.type === 'skipped');
      expect(skippedEvent).toBeDefined();
      expect(skippedEvent!.reason).toBe('Job is already running');
    });
  });

  describe('calculateNextRun()', () => {
    it('should calculate next run for hourly job', () => {
      const nextRun = scheduler.calculateNextRun('0 * * * *');

      expect(nextRun).toBeInstanceOf(Date);
      expect(nextRun.getMinutes()).toBe(0);
      expect(nextRun.getTime()).toBeGreaterThan(Date.now());
    });

    it('should calculate next run for daily job', () => {
      const nextRun = scheduler.calculateNextRun('0 9 * * *'); // Daily at 9 AM

      expect(nextRun).toBeInstanceOf(Date);
      expect(nextRun.getHours()).toBe(9);
      expect(nextRun.getMinutes()).toBe(0);
    });
  });

  describe('static validate()', () => {
    it('should return true for valid expressions', () => {
      expect(CronScheduler.validate('* * * * *')).toBe(true);
      expect(CronScheduler.validate('*/5 * * * *')).toBe(true);
      expect(CronScheduler.validate('0 9 * * 1-5')).toBe(true);
      expect(CronScheduler.validate('0 0 1 * *')).toBe(true);
    });

    it('should return false for invalid expressions', () => {
      expect(CronScheduler.validate('invalid')).toBe(false);
      expect(CronScheduler.validate('* * * *')).toBe(false); // Too few fields
      expect(CronScheduler.validate('60 * * * *')).toBe(false); // Invalid minute
    });
  });

  describe('shutdown()', () => {
    it('should stop all jobs', () => {
      scheduler.addJob({
        id: 'job1',
        name: 'Job 1',
        cronExpr: '0 * * * *',
        prompt: 'Test',
      });
      scheduler.addJob({
        id: 'job2',
        name: 'Job 2',
        cronExpr: '*/5 * * * *',
        prompt: 'Test',
      });

      scheduler.shutdown();

      expect(scheduler.listJobs()).toHaveLength(0);
    });
  });
});
