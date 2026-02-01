/**
 * Schedule recovery module
 *
 * Recovers enabled schedules from the database on server startup
 * and registers them with the scheduler.
 */

import { CronScheduler } from './cron-scheduler.js';
import { ScheduleStore } from './schedule-store.js';

/**
 * Recovery result information
 */
export interface RecoveryResult {
  /** Number of schedules recovered */
  recovered: number;
  /** Number of schedules that failed to recover */
  failed: number;
  /** Details of recovered schedules */
  schedules: Array<{
    id: string;
    name: string;
    cronExpr: string;
    success: boolean;
    error?: string;
  }>;
}

/**
 * Recovery options
 */
export interface RecoveryOptions {
  /** Whether to log recovery progress */
  verbose?: boolean;
  /** Logger function (defaults to console.log) */
  logger?: (message: string) => void;
}

/**
 * Recover enabled schedules from the database and register with scheduler
 *
 * @param scheduler - The CronScheduler instance
 * @param store - The ScheduleStore instance
 * @param options - Recovery options
 * @returns Recovery result with details
 */
export function recoverSchedules(
  scheduler: CronScheduler,
  store: ScheduleStore,
  options: RecoveryOptions = {}
): RecoveryResult {
  const { verbose = false, logger = console.log } = options;

  const result: RecoveryResult = {
    recovered: 0,
    failed: 0,
    schedules: [],
  };

  // Get all enabled schedules from database
  const enabledJobs = store.listEnabledJobs();

  if (verbose) {
    logger(`Found ${enabledJobs.length} enabled schedules to recover`);
  }

  for (const job of enabledJobs) {
    const scheduleResult = {
      id: job.id,
      name: job.name,
      cronExpr: job.cron_expr,
      success: false,
      error: undefined as string | undefined,
    };

    try {
      // Register the job with the scheduler
      scheduler.addJob({
        id: job.id,
        name: job.name,
        cronExpr: job.cron_expr,
        prompt: job.prompt,
        enabled: true,
      });

      scheduleResult.success = true;
      result.recovered++;

      if (verbose) {
        logger(`  ✓ Recovered: ${job.name} (${job.cron_expr})`);
      }
    } catch (error) {
      scheduleResult.error = error instanceof Error ? error.message : String(error);
      result.failed++;

      if (verbose) {
        logger(`  ✗ Failed: ${job.name} - ${scheduleResult.error}`);
      }
    }

    result.schedules.push(scheduleResult);
  }

  if (verbose) {
    logger(`Recovery complete: ${result.recovered} recovered, ${result.failed} failed`);
  }

  return result;
}

/**
 * Sync scheduler state with database
 *
 * Updates next_run times in the database based on scheduler state.
 * Call this after recovery to ensure database reflects current scheduler state.
 *
 * @param scheduler - The CronScheduler instance
 * @param store - The ScheduleStore instance
 */
export function syncSchedulerState(scheduler: CronScheduler, store: ScheduleStore): void {
  const jobs = scheduler.listJobs();

  for (const job of jobs) {
    if (job.nextRun) {
      store.updateJob(job.id, {
        next_run: job.nextRun.getTime(),
      });
    }
  }
}

/**
 * Create a schedule store event handler that persists changes to database
 *
 * @param store - The ScheduleStore instance
 * @returns Event handler function for scheduler events
 */
export function createPersistenceHandler(store: ScheduleStore) {
  return {
    /**
     * Handle job started event
     */
    onJobStarted(jobId: string): string {
      return store.logStart(jobId);
    },

    /**
     * Handle job completed event
     */
    onJobCompleted(logId: string, success: boolean, output?: string, error?: string): void {
      store.logFinish(logId, success ? 'success' : 'failed', output, error);
    },

    /**
     * Handle job state change (enabled/disabled)
     */
    onJobStateChanged(jobId: string, enabled: boolean): void {
      store.updateJob(jobId, { enabled });
    },

    /**
     * Handle next run time update
     */
    onNextRunUpdated(jobId: string, nextRun: Date | undefined): void {
      store.updateJob(jobId, {
        next_run: nextRun ? nextRun.getTime() : null,
      });
    },
  };
}
