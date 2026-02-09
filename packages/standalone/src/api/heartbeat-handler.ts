/**
 * Heartbeat API router for /api/heartbeat endpoints
 */

import { Router } from 'express';
import { CronScheduler } from '../scheduler/index.js';
import type { HeartbeatStatusResponse, TriggerHeartbeatRequest, LastExecution } from './types.js';
import { asyncHandler } from './error-handler.js';
import type { ExecutionLogStore } from './cron-handler.js';

/**
 * Default heartbeat prompt for scheduled reports
 */
export const DEFAULT_HEARTBEAT_PROMPT = `🚨 Comprehensive Report Checklist:
1. Load MAMA: load_checkpoint
2. Data collection: Search recent activity
3. Write report: Generate summary
4. Send to messenger (if configured)
5. Save to MAMA: checkpoint`;

/**
 * Heartbeat execution tracker interface
 */
export interface HeartbeatTracker {
  /** Get the last heartbeat execution */
  getLastExecution(): Promise<LastExecution | null>;
  /** Record a heartbeat execution */
  recordExecution(execution: LastExecution): Promise<void>;
}

/**
 * In-memory heartbeat tracker (placeholder until S6)
 */
export class InMemoryHeartbeatTracker implements HeartbeatTracker {
  private lastExecution: LastExecution | null = null;

  async getLastExecution(): Promise<LastExecution | null> {
    return this.lastExecution;
  }

  async recordExecution(execution: LastExecution): Promise<void> {
    this.lastExecution = execution;
  }
}

/**
 * Options for creating heartbeat router
 */
export interface HeartbeatRouterOptions {
  /** Scheduler instance */
  scheduler: CronScheduler;
  /** Log store for execution logs */
  logStore: ExecutionLogStore;
  /** Heartbeat tracker */
  tracker?: HeartbeatTracker;
  /** Heartbeat execution callback */
  onHeartbeat?: (prompt: string) => Promise<{ success: boolean; error?: string }>;
}

/**
 * Create heartbeat API router
 */
export function createHeartbeatRouter(options: HeartbeatRouterOptions): Router {
  const { scheduler, tracker = new InMemoryHeartbeatTracker(), onHeartbeat } = options;

  const router = Router();

  // GET /api/heartbeat - Get heartbeat status
  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const jobs = scheduler.listJobs();
      const activeJobs = jobs.filter((j) => j.enabled).length;
      const lastExecution = await tracker.getLastExecution();

      const response: HeartbeatStatusResponse = {
        status: activeJobs > 0 ? 'active' : 'inactive',
        active_jobs: activeJobs,
        last_execution: lastExecution,
      };

      res.json(response);
    })
  );

  // POST /api/heartbeat - Trigger manual heartbeat
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const body = req.body as TriggerHeartbeatRequest;
      const prompt = body.prompt || DEFAULT_HEARTBEAT_PROMPT;

      const executionId = `heartbeat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const startedAt = Date.now();

      // Execute heartbeat asynchronously
      if (onHeartbeat) {
        // Run asynchronously and track result
        onHeartbeat(prompt)
          .then(async (result) => {
            const execution: LastExecution = {
              id: executionId,
              started_at: startedAt,
              status: result.success ? 'success' : 'failed',
            };
            await tracker.recordExecution(execution);
          })
          .catch(async () => {
            const execution: LastExecution = {
              id: executionId,
              started_at: startedAt,
              status: 'failed',
            };
            await tracker.recordExecution(execution);
          });
      } else {
        // No handler, just record as pending
        // The caller is responsible for executing the heartbeat
        const execution: LastExecution = {
          id: executionId,
          started_at: startedAt,
          status: 'success', // Assume success if no handler
        };
        await tracker.recordExecution(execution);
      }

      res.json({ execution_id: executionId, started: true });
    })
  );

  return router;
}
