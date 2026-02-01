/**
 * Unit tests for Heartbeat API handler
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import {
  createHeartbeatRouter,
  InMemoryHeartbeatTracker,
  DEFAULT_HEARTBEAT_PROMPT,
} from '../../src/api/heartbeat-handler.js';
import { InMemoryLogStore } from '../../src/api/cron-handler.js';
import { errorHandler, notFoundHandler } from '../../src/api/error-handler.js';
import { CronScheduler } from '../../src/scheduler/index.js';

describe('Heartbeat API', () => {
  let app: express.Express;
  let scheduler: CronScheduler;
  let logStore: InMemoryLogStore;
  let tracker: InMemoryHeartbeatTracker;

  beforeEach(() => {
    scheduler = new CronScheduler();
    logStore = new InMemoryLogStore();
    tracker = new InMemoryHeartbeatTracker();

    app = express();
    app.use(express.json());
    app.use(
      '/api/heartbeat',
      createHeartbeatRouter({
        scheduler,
        logStore,
        tracker,
      })
    );
    app.use(notFoundHandler);
    app.use(errorHandler);
  });

  afterEach(() => {
    scheduler.shutdown();
  });

  describe('GET /api/heartbeat', () => {
    it('should return inactive status when no jobs', async () => {
      const res = await request(app).get('/api/heartbeat');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        status: 'inactive',
        active_jobs: 0,
        last_execution: null,
      });
    });

    it('should return active status when jobs are enabled', async () => {
      scheduler.addJob({
        id: 'active-job',
        name: 'Active',
        cronExpr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
      });

      const res = await request(app).get('/api/heartbeat');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');
      expect(res.body.active_jobs).toBe(1);
    });

    it('should return inactive when all jobs are disabled', async () => {
      scheduler.addJob({
        id: 'disabled-job',
        name: 'Disabled',
        cronExpr: '0 * * * *',
        prompt: 'Test',
        enabled: false,
      });

      const res = await request(app).get('/api/heartbeat');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('inactive');
      expect(res.body.active_jobs).toBe(0);
    });

    it('should return last execution info', async () => {
      await tracker.recordExecution({
        id: 'exec_123',
        started_at: Date.now(),
        status: 'success',
      });

      const res = await request(app).get('/api/heartbeat');

      expect(res.status).toBe(200);
      expect(res.body.last_execution).not.toBeNull();
      expect(res.body.last_execution.id).toBe('exec_123');
      expect(res.body.last_execution.status).toBe('success');
    });

    it('should count only enabled jobs', async () => {
      scheduler.addJob({
        id: 'job1',
        name: 'Enabled 1',
        cronExpr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
      });
      scheduler.addJob({
        id: 'job2',
        name: 'Disabled',
        cronExpr: '0 * * * *',
        prompt: 'Test',
        enabled: false,
      });
      scheduler.addJob({
        id: 'job3',
        name: 'Enabled 2',
        cronExpr: '0 * * * *',
        prompt: 'Test',
        enabled: true,
      });

      const res = await request(app).get('/api/heartbeat');

      expect(res.status).toBe(200);
      expect(res.body.active_jobs).toBe(2);
    });
  });

  describe('POST /api/heartbeat', () => {
    it('should trigger heartbeat with default prompt', async () => {
      const res = await request(app).post('/api/heartbeat').send({});

      expect(res.status).toBe(200);
      expect(res.body.started).toBe(true);
      expect(res.body.execution_id).toBeDefined();
    });

    it('should trigger heartbeat with custom prompt', async () => {
      const customPrompt = 'Custom heartbeat prompt';

      const res = await request(app).post('/api/heartbeat').send({ prompt: customPrompt });

      expect(res.status).toBe(200);
      expect(res.body.started).toBe(true);
    });

    it('should record execution after trigger', async () => {
      await request(app).post('/api/heartbeat').send({});

      // Wait for async recording
      await new Promise((resolve) => setTimeout(resolve, 50));

      const lastExecution = await tracker.getLastExecution();
      expect(lastExecution).not.toBeNull();
    });

    it('should call onHeartbeat callback if provided', async () => {
      const onHeartbeat = vi.fn().mockResolvedValue({ success: true });

      const customApp = express();
      customApp.use(express.json());
      customApp.use(
        '/api/heartbeat',
        createHeartbeatRouter({
          scheduler,
          logStore,
          tracker,
          onHeartbeat,
        })
      );

      await request(customApp).post('/api/heartbeat').send({ prompt: 'Custom prompt' });

      // Wait for async callback
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(onHeartbeat).toHaveBeenCalledWith('Custom prompt');
    });

    it('should use default prompt when no prompt provided', async () => {
      const onHeartbeat = vi.fn().mockResolvedValue({ success: true });

      const customApp = express();
      customApp.use(express.json());
      customApp.use(
        '/api/heartbeat',
        createHeartbeatRouter({
          scheduler,
          logStore,
          tracker,
          onHeartbeat,
        })
      );

      await request(customApp).post('/api/heartbeat').send({});

      // Wait for async callback
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(onHeartbeat).toHaveBeenCalledWith(DEFAULT_HEARTBEAT_PROMPT);
    });

    it('should record failed status on callback error', async () => {
      const onHeartbeat = vi.fn().mockRejectedValue(new Error('Heartbeat failed'));

      const customApp = express();
      customApp.use(express.json());
      customApp.use(
        '/api/heartbeat',
        createHeartbeatRouter({
          scheduler,
          logStore,
          tracker,
          onHeartbeat,
        })
      );

      await request(customApp).post('/api/heartbeat').send({});

      // Wait for async callback
      await new Promise((resolve) => setTimeout(resolve, 100));

      const lastExecution = await tracker.getLastExecution();
      expect(lastExecution?.status).toBe('failed');
    });
  });

  describe('InMemoryHeartbeatTracker', () => {
    it('should store and retrieve last execution', async () => {
      const execution = {
        id: 'test_exec',
        started_at: Date.now(),
        status: 'success' as const,
      };

      await tracker.recordExecution(execution);
      const retrieved = await tracker.getLastExecution();

      expect(retrieved).toEqual(execution);
    });

    it('should overwrite previous execution', async () => {
      await tracker.recordExecution({
        id: 'first',
        started_at: Date.now() - 1000,
        status: 'success',
      });

      await tracker.recordExecution({
        id: 'second',
        started_at: Date.now(),
        status: 'failed',
      });

      const lastExecution = await tracker.getLastExecution();
      expect(lastExecution?.id).toBe('second');
    });

    it('should return null when no executions', async () => {
      const freshTracker = new InMemoryHeartbeatTracker();
      const result = await freshTracker.getLastExecution();
      expect(result).toBeNull();
    });
  });

  describe('DEFAULT_HEARTBEAT_PROMPT', () => {
    it('should contain essential steps', () => {
      expect(DEFAULT_HEARTBEAT_PROMPT).toContain('load_checkpoint');
      expect(DEFAULT_HEARTBEAT_PROMPT).toContain('checkpoint');
    });
  });
});
