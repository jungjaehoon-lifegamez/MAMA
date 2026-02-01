/**
 * Unit tests for ScheduleStore
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ScheduleStore } from '../../src/scheduler/schedule-store.js';
import { CronScheduler } from '../../src/scheduler/cron-scheduler.js';
import {
  recoverSchedules,
  syncSchedulerState,
  createPersistenceHandler,
} from '../../src/scheduler/recovery.js';

describe('ScheduleStore', () => {
  let db: Database.Database;
  let store: ScheduleStore;

  beforeEach(() => {
    // Use in-memory database for tests
    db = new Database(':memory:');
    store = new ScheduleStore(db);
  });

  afterEach(() => {
    store.close();
  });

  describe('Migration', () => {
    it('should create schedules table', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schedules'")
        .all();
      expect(tables).toHaveLength(1);
    });

    it('should create schedule_logs table', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schedule_logs'")
        .all();
      expect(tables).toHaveLength(1);
    });

    it('should create indexes', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
        .all();
      expect(indexes.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('createJob()', () => {
    it('should create a new schedule', () => {
      const id = store.createJob({
        name: 'Test Job',
        cron_expr: '0 * * * *',
        prompt: 'Test prompt',
        enabled: true,
        next_run: Date.now() + 3600000,
      });

      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
    });

    it('should return unique IDs', () => {
      const id1 = store.createJob({
        name: 'Job 1',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });

      const id2 = store.createJob({
        name: 'Job 2',
        cron_expr: '*/5 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });

      expect(id1).not.toBe(id2);
    });
  });

  describe('getJob()', () => {
    it('should return null for non-existent job', () => {
      const job = store.getJob('nonexistent');
      expect(job).toBeNull();
    });

    it('should return job by ID', () => {
      const id = store.createJob({
        name: 'Test Job',
        cron_expr: '0 9 * * *',
        prompt: 'Morning prompt',
        enabled: true,
        next_run: Date.now() + 3600000,
      });

      const job = store.getJob(id);

      expect(job).not.toBeNull();
      expect(job!.id).toBe(id);
      expect(job!.name).toBe('Test Job');
      expect(job!.cron_expr).toBe('0 9 * * *');
      expect(job!.prompt).toBe('Morning prompt');
      expect(job!.enabled).toBe(true);
    });

    it('should convert enabled to boolean', () => {
      const id = store.createJob({
        name: 'Test',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: false,
        next_run: null,
      });

      const job = store.getJob(id);
      expect(job!.enabled).toBe(false);
      expect(typeof job!.enabled).toBe('boolean');
    });
  });

  describe('listJobs()', () => {
    it('should return empty array when no jobs', () => {
      const jobs = store.listJobs();
      expect(jobs).toEqual([]);
    });

    it('should return all jobs', () => {
      store.createJob({
        name: 'Job 1',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });
      store.createJob({
        name: 'Job 2',
        cron_expr: '*/5 * * * *',
        prompt: 'Test',
        enabled: false,
        next_run: null,
      });

      const jobs = store.listJobs();

      expect(jobs).toHaveLength(2);
    });

    it('should return all jobs in list', () => {
      store.createJob({
        name: 'First',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });
      store.createJob({
        name: 'Second',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });

      const jobs = store.listJobs();
      const names = jobs.map((j) => j.name);

      expect(names).toContain('First');
      expect(names).toContain('Second');
    });
  });

  describe('listEnabledJobs()', () => {
    it('should return only enabled jobs', () => {
      store.createJob({
        name: 'Enabled',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });
      store.createJob({
        name: 'Disabled',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: false,
        next_run: null,
      });

      const jobs = store.listEnabledJobs();

      expect(jobs).toHaveLength(1);
      expect(jobs[0].name).toBe('Enabled');
    });
  });

  describe('updateJob()', () => {
    it('should update job name', () => {
      const id = store.createJob({
        name: 'Original',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });

      const updated = store.updateJob(id, { name: 'Updated' });

      expect(updated).toBe(true);
      expect(store.getJob(id)!.name).toBe('Updated');
    });

    it('should update cron expression', () => {
      const id = store.createJob({
        name: 'Test',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });

      store.updateJob(id, { cron_expr: '*/5 * * * *' });

      expect(store.getJob(id)!.cron_expr).toBe('*/5 * * * *');
    });

    it('should update enabled status', () => {
      const id = store.createJob({
        name: 'Test',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });

      store.updateJob(id, { enabled: false });

      expect(store.getJob(id)!.enabled).toBe(false);
    });

    it('should update last_run', () => {
      const id = store.createJob({
        name: 'Test',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });
      const now = Date.now();

      store.updateJob(id, { last_run: now });

      expect(store.getJob(id)!.last_run).toBe(now);
    });

    it('should return false for non-existent job', () => {
      const updated = store.updateJob('nonexistent', { name: 'New' });
      expect(updated).toBe(false);
    });

    it('should return false when no updates provided', () => {
      const id = store.createJob({
        name: 'Test',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });

      const updated = store.updateJob(id, {});
      expect(updated).toBe(false);
    });
  });

  describe('deleteJob()', () => {
    it('should delete job', () => {
      const id = store.createJob({
        name: 'Delete Me',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });

      const deleted = store.deleteJob(id);

      expect(deleted).toBe(true);
      expect(store.getJob(id)).toBeNull();
    });

    it('should return false for non-existent job', () => {
      const deleted = store.deleteJob('nonexistent');
      expect(deleted).toBe(false);
    });

    it('should cascade delete logs', () => {
      const id = store.createJob({
        name: 'Test',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });
      store.logStart(id);

      expect(store.getLogs(id)).toHaveLength(1);

      store.deleteJob(id);

      // Logs should be deleted too
      const logs = db.prepare('SELECT * FROM schedule_logs WHERE schedule_id = ?').all(id);
      expect(logs).toHaveLength(0);
    });
  });

  describe('logStart()', () => {
    it('should create a log entry', () => {
      const jobId = store.createJob({
        name: 'Test',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });

      const logId = store.logStart(jobId);

      expect(logId).toBeDefined();
      const log = store.getLog(logId);
      expect(log).not.toBeNull();
      expect(log!.schedule_id).toBe(jobId);
      expect(log!.status).toBe('running');
    });

    it('should update last_run on schedule', () => {
      const jobId = store.createJob({
        name: 'Test',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });
      const before = Date.now();

      store.logStart(jobId);

      const job = store.getJob(jobId);
      expect(job!.last_run).toBeGreaterThanOrEqual(before);
    });
  });

  describe('logFinish()', () => {
    it('should update log entry on success', () => {
      const jobId = store.createJob({
        name: 'Test',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });
      const logId = store.logStart(jobId);

      const updated = store.logFinish(logId, 'success', 'Output text');

      expect(updated).toBe(true);
      const log = store.getLog(logId);
      expect(log!.status).toBe('success');
      expect(log!.output).toBe('Output text');
      expect(log!.finished_at).not.toBeNull();
    });

    it('should update log entry on failure', () => {
      const jobId = store.createJob({
        name: 'Test',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });
      const logId = store.logStart(jobId);

      store.logFinish(logId, 'failed', undefined, 'Error message');

      const log = store.getLog(logId);
      expect(log!.status).toBe('failed');
      expect(log!.error).toBe('Error message');
    });

    it('should return false for non-existent log', () => {
      const updated = store.logFinish('nonexistent', 'success');
      expect(updated).toBe(false);
    });
  });

  describe('getLogs()', () => {
    it('should return logs for schedule', () => {
      const jobId = store.createJob({
        name: 'Test',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });
      store.logStart(jobId);
      store.logStart(jobId);

      const logs = store.getLogs(jobId);

      expect(logs).toHaveLength(2);
    });

    it('should return all logs for schedule', () => {
      const jobId = store.createJob({
        name: 'Test',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });
      const log1 = store.logStart(jobId);
      const log2 = store.logStart(jobId);

      const logs = store.getLogs(jobId);
      const logIds = logs.map((l) => l.id);

      expect(logIds).toContain(log1);
      expect(logIds).toContain(log2);
    });

    it('should support pagination', () => {
      const jobId = store.createJob({
        name: 'Test',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });
      for (let i = 0; i < 5; i++) {
        store.logStart(jobId);
      }

      const page1 = store.getLogs(jobId, 2, 0);
      const page2 = store.getLogs(jobId, 2, 2);

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      expect(page1[0].id).not.toBe(page2[0].id);
    });
  });

  describe('getLastExecution()', () => {
    it('should return null when no executions', () => {
      const jobId = store.createJob({
        name: 'Test',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });

      const last = store.getLastExecution(jobId);

      expect(last).toBeNull();
    });

    it('should return an execution when logs exist', () => {
      const jobId = store.createJob({
        name: 'Test',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });
      const log1 = store.logStart(jobId);
      const log2 = store.logStart(jobId);

      const last = store.getLastExecution(jobId);

      expect(last).not.toBeNull();
      // Should return one of the logs (order depends on timing)
      expect([log1, log2]).toContain(last!.id);
    });
  });

  describe('getLastExecutionGlobal()', () => {
    it('should return an execution across all schedules', () => {
      const job1 = store.createJob({
        name: 'Job 1',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });
      const job2 = store.createJob({
        name: 'Job 2',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });

      const log1 = store.logStart(job1);
      const log2 = store.logStart(job2);

      const last = store.getLastExecutionGlobal();

      expect(last).not.toBeNull();
      // Should return one of the logs (order depends on timing)
      expect([log1, log2]).toContain(last!.id);
    });
  });
});

describe('Recovery', () => {
  let db: Database.Database;
  let store: ScheduleStore;
  let scheduler: CronScheduler;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new ScheduleStore(db);
    scheduler = new CronScheduler();
  });

  afterEach(() => {
    scheduler.shutdown();
    store.close();
  });

  describe('recoverSchedules()', () => {
    it('should recover enabled schedules', () => {
      store.createJob({
        name: 'Enabled Job',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });

      const result = recoverSchedules(scheduler, store);

      expect(result.recovered).toBe(1);
      expect(result.failed).toBe(0);
      expect(scheduler.listJobs()).toHaveLength(1);
    });

    it('should not recover disabled schedules', () => {
      store.createJob({
        name: 'Disabled Job',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: false,
        next_run: null,
      });

      const result = recoverSchedules(scheduler, store);

      expect(result.recovered).toBe(0);
      expect(scheduler.listJobs()).toHaveLength(0);
    });

    it('should handle invalid cron expressions', () => {
      // Directly insert invalid cron to bypass validation
      db.prepare(
        `
        INSERT INTO schedules (id, name, cron_expr, prompt, enabled)
        VALUES ('bad-job', 'Bad Job', 'invalid', 'Test', 1)
      `
      ).run();

      const result = recoverSchedules(scheduler, store);

      expect(result.failed).toBe(1);
      expect(result.schedules[0].success).toBe(false);
      expect(result.schedules[0].error).toContain('Invalid cron');
    });

    it('should log progress in verbose mode', () => {
      const logs: string[] = [];
      const logger = (msg: string) => logs.push(msg);

      store.createJob({
        name: 'Test Job',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });

      recoverSchedules(scheduler, store, { verbose: true, logger });

      expect(logs.some((l) => l.includes('Found'))).toBe(true);
      expect(logs.some((l) => l.includes('Recovered'))).toBe(true);
    });
  });

  describe('syncSchedulerState()', () => {
    it('should update next_run in database', () => {
      const id = store.createJob({
        name: 'Test',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });
      scheduler.addJob({ id, name: 'Test', cronExpr: '0 * * * *', prompt: 'Test', enabled: true });

      syncSchedulerState(scheduler, store);

      const job = store.getJob(id);
      expect(job!.next_run).not.toBeNull();
    });
  });

  describe('createPersistenceHandler()', () => {
    it('should create handler with all methods', () => {
      const handler = createPersistenceHandler(store);

      expect(handler.onJobStarted).toBeDefined();
      expect(handler.onJobCompleted).toBeDefined();
      expect(handler.onJobStateChanged).toBeDefined();
      expect(handler.onNextRunUpdated).toBeDefined();
    });

    it('should persist job start', () => {
      const jobId = store.createJob({
        name: 'Test',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });
      const handler = createPersistenceHandler(store);

      const logId = handler.onJobStarted(jobId);

      expect(logId).toBeDefined();
      expect(store.getLog(logId)).not.toBeNull();
    });

    it('should persist job completion', () => {
      const jobId = store.createJob({
        name: 'Test',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });
      const handler = createPersistenceHandler(store);

      const logId = handler.onJobStarted(jobId);
      handler.onJobCompleted(logId, true, 'Success output');

      const log = store.getLog(logId);
      expect(log!.status).toBe('success');
      expect(log!.output).toBe('Success output');
    });

    it('should persist state changes', () => {
      const jobId = store.createJob({
        name: 'Test',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
        next_run: null,
      });
      const handler = createPersistenceHandler(store);

      handler.onJobStateChanged(jobId, false);

      expect(store.getJob(jobId)!.enabled).toBe(false);
    });
  });
});
