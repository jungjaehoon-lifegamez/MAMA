/**
 * Cron Scheduler for MAMA Standalone
 *
 * Schedules and executes jobs based on cron expressions.
 * Uses node-cron for scheduling and cron-parser for next run calculation.
 */

import cron from 'node-cron';
import cronParser from 'cron-parser';

import { JobLock } from './job-lock.js';
import type {
  CronJob,
  JobConfig,
  JobResult,
  JobEvent,
  JobEventHandler,
  SchedulerOptions,
} from './types.js';
import { SchedulerError } from './types.js';

/**
 * Internal job representation with cron task
 */
interface InternalJob extends CronJob {
  task?: cron.ScheduledTask;
}

/**
 * Default scheduler options
 */
const DEFAULT_OPTIONS: Required<SchedulerOptions> = {
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  runMissedOnStartup: false,
  maxConcurrent: 1,
};

export class CronScheduler {
  private readonly jobs: Map<string, InternalJob> = new Map();
  private readonly lock: JobLock;
  private readonly options: Required<SchedulerOptions>;
  private readonly eventHandlers: JobEventHandler[] = [];
  private executeCallback?: (prompt: string) => Promise<string>;

  constructor(options: SchedulerOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.lock = new JobLock();
  }

  /**
   * Set the execution callback (typically AgentLoop.run)
   *
   * @param callback - Function to execute for each job
   */
  setExecuteCallback(callback: (prompt: string) => Promise<string>): void {
    this.executeCallback = callback;
  }

  /**
   * Add a job to the scheduler
   *
   * @param config - Job configuration
   * @returns Job ID
   * @throws SchedulerError if cron expression is invalid or job already exists
   */
  addJob(config: JobConfig): string {
    // Check if job already exists
    if (this.jobs.has(config.id)) {
      throw new SchedulerError(`Job already exists: ${config.id}`, 'JOB_EXISTS');
    }

    // Validate cron expression
    if (!cron.validate(config.cronExpr)) {
      throw new SchedulerError(`Invalid cron expression: ${config.cronExpr}`, 'INVALID_CRON');
    }

    // Create job
    const job: InternalJob = {
      ...config,
      enabled: config.enabled ?? true,
      isRunning: false,
      nextRun: this.calculateNextRun(config.cronExpr),
    };

    // Schedule cron task
    const task = cron.schedule(
      config.cronExpr,
      () => {
        void this.executeJob(config.id);
      },
      {
        scheduled: job.enabled,
        timezone: this.options.timezone,
      }
    );

    job.task = task;
    this.jobs.set(config.id, job);

    return config.id;
  }

  /**
   * Remove a job from the scheduler
   *
   * @param jobId - Job identifier
   * @throws SchedulerError if job not found
   */
  removeJob(jobId: string): void {
    const job = this.jobs.get(jobId);

    if (!job) {
      throw new SchedulerError(`Job not found: ${jobId}`, 'JOB_NOT_FOUND');
    }

    // Stop and destroy the cron task
    if (job.task) {
      job.task.stop();
    }

    // Release any held locks
    this.lock.release(jobId);

    this.jobs.delete(jobId);
  }

  /**
   * Enable a job
   *
   * @param jobId - Job identifier
   * @throws SchedulerError if job not found
   */
  enableJob(jobId: string): void {
    const job = this.jobs.get(jobId);

    if (!job) {
      throw new SchedulerError(`Job not found: ${jobId}`, 'JOB_NOT_FOUND');
    }

    if (job.task) {
      job.task.start();
    }
    job.enabled = true;
    job.nextRun = this.calculateNextRun(job.cronExpr);
  }

  /**
   * Disable a job
   *
   * @param jobId - Job identifier
   * @throws SchedulerError if job not found
   */
  disableJob(jobId: string): void {
    const job = this.jobs.get(jobId);

    if (!job) {
      throw new SchedulerError(`Job not found: ${jobId}`, 'JOB_NOT_FOUND');
    }

    if (job.task) {
      job.task.stop();
    }
    job.enabled = false;
    job.nextRun = undefined;
  }

  /**
   * Execute a job immediately
   *
   * @param jobId - Job identifier
   * @throws SchedulerError if job not found
   */
  async runNow(jobId: string): Promise<JobResult> {
    const job = this.jobs.get(jobId);

    if (!job) {
      throw new SchedulerError(`Job not found: ${jobId}`, 'JOB_NOT_FOUND');
    }

    return this.executeJob(jobId);
  }

  /**
   * Get a job by ID
   *
   * @param jobId - Job identifier
   * @returns Job info (without internal task object)
   */
  getJob(jobId: string): CronJob | null {
    const job = this.jobs.get(jobId);
    if (!job) {
      return null;
    }
    return this.toPublicJob(job);
  }

  /**
   * List all jobs
   *
   * @returns Array of job info (without internal task objects)
   */
  listJobs(): CronJob[] {
    return Array.from(this.jobs.values()).map((job) => this.toPublicJob(job));
  }

  /**
   * Check if a job is currently running
   *
   * @param jobId - Job identifier
   */
  isJobRunning(jobId: string): boolean {
    return this.lock.isLocked(jobId);
  }

  /**
   * Add an event handler
   *
   * @param handler - Event handler function
   */
  onEvent(handler: JobEventHandler): void {
    this.eventHandlers.push(handler);
  }

  /**
   * Calculate next run time for a cron expression
   *
   * @param cronExpr - Cron expression
   * @returns Next run date
   */
  calculateNextRun(cronExpr: string): Date {
    try {
      const interval = cronParser.parseExpression(cronExpr, {
        tz: this.options.timezone,
      });
      return interval.next().toDate();
    } catch {
      // If parsing fails, return a far future date
      return new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    }
  }

  /**
   * Stop all jobs and clean up
   */
  shutdown(): void {
    for (const [jobId, job] of this.jobs) {
      if (job.task) {
        job.task.stop();
      }
      this.lock.release(jobId);
    }
    this.jobs.clear();
  }

  /**
   * Execute a job
   *
   * @param jobId - Job identifier
   */
  private async executeJob(jobId: string): Promise<JobResult> {
    const job = this.jobs.get(jobId);

    if (!job) {
      throw new SchedulerError(`Job not found: ${jobId}`, 'JOB_NOT_FOUND');
    }

    // Try to acquire lock
    if (!this.lock.acquire(jobId)) {
      this.emitEvent({
        type: 'skipped',
        jobId,
        timestamp: new Date(),
        reason: 'Job is already running',
      });

      return {
        success: false,
        startedAt: new Date(),
        completedAt: new Date(),
        duration: 0,
        error: 'Job is already running',
      };
    }

    const startedAt = new Date();
    job.isRunning = true;
    job.lastRun = startedAt;

    this.emitEvent({
      type: 'started',
      jobId,
      timestamp: startedAt,
    });

    let result: JobResult;

    try {
      let response: string | undefined;

      if (this.executeCallback) {
        response = await this.executeCallback(job.prompt);
      }

      const completedAt = new Date();
      result = {
        success: true,
        startedAt,
        completedAt,
        duration: completedAt.getTime() - startedAt.getTime(),
        response,
      };

      this.emitEvent({
        type: 'completed',
        jobId,
        timestamp: completedAt,
        result,
      });
    } catch (error) {
      const completedAt = new Date();
      result = {
        success: false,
        startedAt,
        completedAt,
        duration: completedAt.getTime() - startedAt.getTime(),
        error: error instanceof Error ? error.message : String(error),
      };

      this.emitEvent({
        type: 'failed',
        jobId,
        timestamp: completedAt,
        result,
      });
    } finally {
      job.isRunning = false;
      job.lastResult = result!;
      job.nextRun = job.enabled ? this.calculateNextRun(job.cronExpr) : undefined;
      this.lock.release(jobId);
    }

    return result;
  }

  /**
   * Convert internal job to public job (without task)
   */
  private toPublicJob(job: InternalJob): CronJob {
    const { task, ...publicJob } = job;
    return publicJob;
  }

  /**
   * Emit an event to all handlers
   */
  private emitEvent(event: JobEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        // Ignore handler errors
      }
    }
  }

  /**
   * Validate a cron expression
   *
   * @param cronExpr - Cron expression to validate
   * @returns true if valid
   */
  static validate(cronExpr: string): boolean {
    return cron.validate(cronExpr);
  }
}
