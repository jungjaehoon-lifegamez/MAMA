/**
 * Unit tests for Cron API handler
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createCronRouter, InMemoryLogStore } from '../../src/api/cron-handler.js';
import { errorHandler, notFoundHandler } from '../../src/api/error-handler.js';
import { CronScheduler } from '../../src/scheduler/index.js';

describe('Cron API', () => {
  let app: express.Express;
  let scheduler: CronScheduler;
  let logStore: InMemoryLogStore;

  beforeEach(() => {
    scheduler = new CronScheduler();
    logStore = new InMemoryLogStore();

    app = express();
    app.use(express.json());
    app.use('/api/cron', createCronRouter(scheduler, logStore));
    app.use(notFoundHandler);
    app.use(errorHandler);
  });

  afterEach(() => {
    scheduler.shutdown();
  });

  describe('GET /api/cron', () => {
    it('should return empty list when no jobs', async () => {
      const res = await request(app).get('/api/cron');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ jobs: [] });
    });

    it('should return all jobs', async () => {
      scheduler.addJob({
        id: 'job1',
        name: 'Test Job 1',
        cronExpr: '0 * * * *',
        prompt: 'Test prompt 1',
      });
      scheduler.addJob({
        id: 'job2',
        name: 'Test Job 2',
        cronExpr: '*/5 * * * *',
        prompt: 'Test prompt 2',
      });

      const res = await request(app).get('/api/cron');

      expect(res.status).toBe(200);
      expect(res.body.jobs).toHaveLength(2);
      expect(res.body.jobs.map((j: { id: string }) => j.id)).toContain('job1');
      expect(res.body.jobs.map((j: { id: string }) => j.id)).toContain('job2');
    });

    it('should return jobs in API format', async () => {
      scheduler.addJob({
        id: 'test-job',
        name: 'Test Job',
        cronExpr: '0 * * * *',
        prompt: 'Test prompt',
        enabled: true,
      });

      const res = await request(app).get('/api/cron');

      expect(res.status).toBe(200);
      const job = res.body.jobs[0];
      expect(job).toHaveProperty('id', 'test-job');
      expect(job).toHaveProperty('name', 'Test Job');
      expect(job).toHaveProperty('cron_expr', '0 * * * *');
      expect(job).toHaveProperty('prompt', 'Test prompt');
      expect(job).toHaveProperty('enabled', true);
      expect(job).toHaveProperty('next_run');
    });
  });

  describe('POST /api/cron', () => {
    it('should create a new job', async () => {
      const res = await request(app).post('/api/cron').send({
        name: 'New Job',
        cron_expr: '0 * * * *',
        prompt: 'New prompt',
      });

      expect(res.status).toBe(200);
      expect(res.body.created).toBe(true);
      expect(res.body.id).toBeDefined();

      // Verify job was added
      const jobs = scheduler.listJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].name).toBe('New Job');
    });

    it('should return 400 for missing name', async () => {
      const res = await request(app).post('/api/cron').send({
        cron_expr: '0 * * * *',
        prompt: 'Test',
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('name');
    });

    it('should return 400 for missing cron_expr', async () => {
      const res = await request(app).post('/api/cron').send({
        name: 'Test',
        prompt: 'Test',
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('cron_expr');
    });

    it('should return 400 for missing prompt', async () => {
      const res = await request(app).post('/api/cron').send({
        name: 'Test',
        cron_expr: '0 * * * *',
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('prompt');
    });

    it('should return 400 for invalid cron expression', async () => {
      const res = await request(app).post('/api/cron').send({
        name: 'Test',
        cron_expr: 'invalid',
        prompt: 'Test',
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid cron');
    });

    it('should create job with enabled=false', async () => {
      const res = await request(app).post('/api/cron').send({
        name: 'Disabled Job',
        cron_expr: '0 * * * *',
        prompt: 'Test',
        enabled: false,
      });

      expect(res.status).toBe(200);

      const job = scheduler.getJob(res.body.id);
      expect(job?.enabled).toBe(false);
    });
  });

  describe('GET /api/cron/:id', () => {
    it('should return job details', async () => {
      scheduler.addJob({
        id: 'my-job',
        name: 'My Job',
        cronExpr: '0 9 * * *',
        prompt: 'Morning prompt',
      });

      const res = await request(app).get('/api/cron/my-job');

      expect(res.status).toBe(200);
      expect(res.body.job.id).toBe('my-job');
      expect(res.body.job.name).toBe('My Job');
      expect(res.body.job.cron_expr).toBe('0 9 * * *');
    });

    it('should return 404 for non-existent job', async () => {
      const res = await request(app).get('/api/cron/nonexistent');

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });
  });

  describe('PUT /api/cron/:id', () => {
    it('should update job name', async () => {
      scheduler.addJob({
        id: 'update-job',
        name: 'Original Name',
        cronExpr: '0 * * * *',
        prompt: 'Test',
      });

      const res = await request(app).put('/api/cron/update-job').send({ name: 'Updated Name' });

      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(true);

      const job = scheduler.getJob('update-job');
      expect(job?.name).toBe('Updated Name');
    });

    it('should update cron expression', async () => {
      scheduler.addJob({
        id: 'update-job',
        name: 'Test',
        cronExpr: '0 * * * *',
        prompt: 'Test',
      });

      const res = await request(app).put('/api/cron/update-job').send({ cron_expr: '*/5 * * * *' });

      expect(res.status).toBe(200);

      const job = scheduler.getJob('update-job');
      expect(job?.cronExpr).toBe('*/5 * * * *');
    });

    it('should update enabled status', async () => {
      scheduler.addJob({
        id: 'update-job',
        name: 'Test',
        cronExpr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
      });

      const res = await request(app).put('/api/cron/update-job').send({ enabled: false });

      expect(res.status).toBe(200);

      const job = scheduler.getJob('update-job');
      expect(job?.enabled).toBe(false);
    });

    it('should return 404 for non-existent job', async () => {
      const res = await request(app).put('/api/cron/nonexistent').send({ name: 'New Name' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/cron/:id', () => {
    it('should delete job', async () => {
      scheduler.addJob({
        id: 'delete-job',
        name: 'Delete Me',
        cronExpr: '0 * * * *',
        prompt: 'Test',
      });

      const res = await request(app).delete('/api/cron/delete-job');

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);

      expect(scheduler.getJob('delete-job')).toBeNull();
    });

    it('should return 404 for non-existent job', async () => {
      const res = await request(app).delete('/api/cron/nonexistent');

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/cron/:id/run', () => {
    it('should trigger immediate execution', async () => {
      scheduler.setExecuteCallback(async () => 'result');
      scheduler.addJob({
        id: 'run-job',
        name: 'Run Now',
        cronExpr: '0 0 1 1 *',
        prompt: 'Test',
      });

      const res = await request(app).post('/api/cron/run-job/run');

      expect(res.status).toBe(200);
      expect(res.body.started).toBe(true);
      expect(res.body.execution_id).toBeDefined();
    });

    it('should return 404 for non-existent job', async () => {
      const res = await request(app).post('/api/cron/nonexistent/run');

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/cron/:id/logs', () => {
    it('should return empty logs for new job', async () => {
      scheduler.addJob({
        id: 'log-job',
        name: 'Log Test',
        cronExpr: '0 * * * *',
        prompt: 'Test',
      });

      const res = await request(app).get('/api/cron/log-job/logs');

      expect(res.status).toBe(200);
      expect(res.body.logs).toEqual([]);
    });

    it('should return logs after execution', async () => {
      scheduler.setExecuteCallback(async () => 'result');
      scheduler.addJob({
        id: 'log-job',
        name: 'Log Test',
        cronExpr: '0 * * * *',
        prompt: 'Test',
      });

      // Trigger execution
      await request(app).post('/api/cron/log-job/run');

      // Wait for async log update
      await new Promise((resolve) => setTimeout(resolve, 100));

      const res = await request(app).get('/api/cron/log-job/logs');

      expect(res.status).toBe(200);
      expect(res.body.logs).toHaveLength(1);
    });

    it('should support pagination', async () => {
      scheduler.addJob({
        id: 'log-job',
        name: 'Log Test',
        cronExpr: '0 * * * *',
        prompt: 'Test',
      });

      const res = await request(app).get('/api/cron/log-job/logs').query({ limit: 10, offset: 0 });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('logs');
    });

    it('should return 404 for non-existent job', async () => {
      const res = await request(app).get('/api/cron/nonexistent/logs');

      expect(res.status).toBe(404);
    });
  });

  describe('Content-Type', () => {
    it('should accept JSON body', async () => {
      const res = await request(app)
        .post('/api/cron')
        .set('Content-Type', 'application/json')
        .send(
          JSON.stringify({
            name: 'Test',
            cron_expr: '0 * * * *',
            prompt: 'Test',
          })
        );

      expect(res.status).toBe(200);
    });
  });
});
