/**
 * Cron API router for /api/cron endpoints
 */

import { Router } from 'express';
import { CronScheduler, ScheduleStore } from '../scheduler/index.js';
import { loadConfig, saveConfig } from '../cli/config/config-manager.js';
import {
  ApiError,
  toApiCronJob,
  type ApiCronJob,
  type CreateCronJobRequest,
  type UpdateCronJobRequest,
  type ExecutionLog,
} from './types.js';
import { asyncHandler, validateRequired } from './error-handler.js';

interface ConfigCronJob {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  enabled?: boolean;
  channel?: string;
  description?: string;
}

/**
 * Sync scheduler state to config.yaml scheduling.jobs
 */
async function syncJobsToConfig(scheduler: CronScheduler): Promise<void> {
  try {
    const config = await loadConfig();
    const configAny = config as Record<string, unknown>;
    const scheduling = (configAny.scheduling as { jobs?: ConfigCronJob[] }) || {};

    scheduling.jobs = scheduler.listJobs().map((job) => ({
      id: job.id,
      name: job.name,
      cron: job.cronExpr,
      prompt: job.prompt,
      enabled: job.enabled,
    }));

    configAny.scheduling = scheduling;
    await saveConfig(config);
  } catch (err) {
    console.warn(
      `[Cron] Failed to sync jobs to config: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Execution log store interface (to be implemented by S6)
 */
export interface ExecutionLogStore {
  /** Get logs for a specific job */
  getLogs(jobId: string, limit: number, offset: number): Promise<ExecutionLog[]>;
  /** Add a new log entry */
  addLog(jobId: string, log: ExecutionLog): Promise<void>;
  /** Update an existing log entry */
  updateLog(logId: string, updates: Partial<ExecutionLog>): Promise<void>;
}

/**
 * In-memory execution log store (placeholder until S6)
 */
export class InMemoryLogStore implements ExecutionLogStore {
  private logs: Map<string, ExecutionLog[]> = new Map();

  async getLogs(jobId: string, limit: number, offset: number): Promise<ExecutionLog[]> {
    const jobLogs = this.logs.get(jobId) || [];
    return jobLogs.slice(offset, offset + limit);
  }

  async addLog(jobId: string, log: ExecutionLog): Promise<void> {
    if (!this.logs.has(jobId)) {
      this.logs.set(jobId, []);
    }
    this.logs.get(jobId)!.unshift(log); // Most recent first
  }

  async updateLog(logId: string, updates: Partial<ExecutionLog>): Promise<void> {
    for (const logs of this.logs.values()) {
      const log = logs.find((l) => l.id === logId);
      if (log) {
        Object.assign(log, updates);
        return;
      }
    }
  }
}

/**
 * Adapter to use ScheduleStore as ExecutionLogStore
 *
 * Wraps ScheduleStore to provide ExecutionLogStore interface.
 * This allows the API handlers to use persistent SQLite storage.
 */
export class ScheduleStoreAdapter implements ExecutionLogStore {
  constructor(private store: ScheduleStore) {}

  async getLogs(jobId: string, limit: number, offset: number): Promise<ExecutionLog[]> {
    const logs = this.store.getLogs(jobId, limit, offset);
    return logs.map((log) => ({
      id: log.id,
      started_at: log.started_at,
      finished_at: log.finished_at,
      status: log.status,
      output: log.output,
      error: log.error,
    }));
  }

  async addLog(jobId: string, log: ExecutionLog): Promise<void> {
    // Use logStart for initial log creation
    const logId = this.store.logStart(jobId);

    // If the log has a specific ID, we need to track the mapping
    // For now, we just use the store's generated ID
    if (log.status !== 'running') {
      this.store.logFinish(
        logId,
        log.status === 'success' ? 'success' : 'failed',
        log.output || undefined,
        log.error || undefined
      );
    }
  }

  async updateLog(logId: string, updates: Partial<ExecutionLog>): Promise<void> {
    if (updates.status && updates.status !== 'running') {
      this.store.logFinish(
        logId,
        updates.status === 'success' ? 'success' : 'failed',
        updates.output || undefined,
        updates.error || undefined
      );
    }
  }
}

/**
 * Create cron API router
 */
export function createCronRouter(
  scheduler: CronScheduler,
  logStore: ExecutionLogStore = new InMemoryLogStore()
): Router {
  const router = Router();

  // GET /api/cron - List all jobs
  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const jobs = scheduler.listJobs();
      const apiJobs: ApiCronJob[] = jobs.map(toApiCronJob);
      res.json({ jobs: apiJobs });
    })
  );

  // POST /api/cron - Create a new job
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const body = req.body as CreateCronJobRequest;

      validateRequired(body as unknown as Record<string, unknown>, ['name', 'cron_expr', 'prompt']);

      const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      scheduler.addJob({
        id,
        name: body.name,
        cronExpr: body.cron_expr,
        prompt: body.prompt,
        enabled: body.enabled ?? true,
      });

      await syncJobsToConfig(scheduler);
      res.json({ id, created: true });
    })
  );

  // GET /api/cron/:id - Get a specific job
  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = req.params.id as string;
      const job = scheduler.getJob(id);

      if (!job) {
        throw new ApiError(`Job not found: ${id}`, 404, 'NOT_FOUND');
      }

      res.json({ job: toApiCronJob(job) });
    })
  );

  // PUT /api/cron/:id - Update a job
  router.put(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = req.params.id as string;
      const body = req.body as UpdateCronJobRequest;

      const job = scheduler.getJob(id);
      if (!job) {
        throw new ApiError(`Job not found: ${id}`, 404, 'NOT_FOUND');
      }

      // Update job - need to remove and re-add for scheduler
      // First get current values
      const currentJob = scheduler.getJob(id)!;

      // Build updated config
      const updatedConfig = {
        id: id,
        name: body.name ?? currentJob.name,
        cronExpr: body.cron_expr ?? currentJob.cronExpr,
        prompt: body.prompt ?? currentJob.prompt,
        enabled: body.enabled ?? currentJob.enabled,
      };

      // Remove old job and add updated one
      scheduler.removeJob(id);
      scheduler.addJob(updatedConfig);

      await syncJobsToConfig(scheduler);
      res.json({ updated: true });
    })
  );

  // DELETE /api/cron/:id - Delete a job
  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = req.params.id as string;

      const job = scheduler.getJob(id);
      if (!job) {
        throw new ApiError(`Job not found: ${id}`, 404, 'NOT_FOUND');
      }

      scheduler.removeJob(id);
      await syncJobsToConfig(scheduler);
      res.json({ deleted: true });
    })
  );

  // POST /api/cron/:id/run - Run job immediately
  router.post(
    '/:id/run',
    asyncHandler(async (req, res) => {
      const id = req.params.id as string;

      const job = scheduler.getJob(id);
      if (!job) {
        throw new ApiError(`Job not found: ${id}`, 404, 'NOT_FOUND');
      }

      const executionId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      // Create log entry for this execution
      const log: ExecutionLog = {
        id: executionId,
        started_at: Date.now(),
        finished_at: null,
        status: 'running',
        output: null,
        error: null,
      };
      await logStore.addLog(id, log);

      // Run the job asynchronously
      scheduler
        .runNow(id)
        .then(async (result) => {
          await logStore.updateLog(executionId, {
            finished_at: Date.now(),
            status: result.success ? 'success' : 'failed',
            output: result.success ? 'Execution completed' : null,
            error: result.error || null,
          });
        })
        .catch(async (err) => {
          await logStore.updateLog(executionId, {
            finished_at: Date.now(),
            status: 'failed',
            error: err.message,
          });
        });

      res.json({ execution_id: executionId, started: true });
    })
  );

  // GET /api/cron/:id/logs - Get execution logs
  router.get(
    '/:id/logs',
    asyncHandler(async (req, res) => {
      const id = req.params.id as string;
      const limit = parseInt(req.query.limit as string) || 20;
      const offset = parseInt(req.query.offset as string) || 0;

      const job = scheduler.getJob(id);
      if (!job) {
        throw new ApiError(`Job not found: ${id}`, 404, 'NOT_FOUND');
      }

      const logs = await logStore.getLogs(id, limit, offset);
      res.json({ logs });
    })
  );

  return router;
}
