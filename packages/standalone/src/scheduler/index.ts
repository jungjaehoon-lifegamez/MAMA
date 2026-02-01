/**
 * Scheduler Module for MAMA Standalone
 *
 * Exports:
 * - CronScheduler - Main scheduler class
 * - JobLock - Concurrent execution prevention
 * - ScheduleStore - SQLite persistence for schedules
 * - Recovery - Server startup recovery utilities
 * - Types - All type definitions
 */

export { CronScheduler } from './cron-scheduler.js';
export { JobLock } from './job-lock.js';
export type { LockInfo } from './job-lock.js';

// Token Keep-Alive
export { TokenKeepAlive } from './token-keep-alive.js';
export type { TokenKeepAliveOptions } from './token-keep-alive.js';

// Persistence
export { ScheduleStore } from './schedule-store.js';
export type {
  Schedule,
  ScheduleLog,
  CreateScheduleInput,
  UpdateScheduleInput,
} from './schedule-store.js';

// Recovery
export { recoverSchedules, syncSchedulerState, createPersistenceHandler } from './recovery.js';
export type { RecoveryResult, RecoveryOptions } from './recovery.js';

// Export types
export type {
  JobStatus,
  JobConfig,
  CronJob,
  JobResult,
  SchedulerOptions,
  JobEventType,
  JobEvent,
  JobEventHandler,
  SchedulerErrorCode,
} from './types.js';

export { SchedulerError } from './types.js';
