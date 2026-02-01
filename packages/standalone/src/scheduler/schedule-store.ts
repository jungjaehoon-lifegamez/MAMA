/**
 * Schedule persistence store using SQLite
 *
 * Stores cron job definitions and execution logs in SQLite database.
 * Supports server restart recovery and execution history tracking.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

// ============================================================================
// Types
// ============================================================================

/**
 * Persisted schedule (cron job) definition
 */
export interface Schedule {
  id: string;
  name: string;
  cron_expr: string;
  prompt: string;
  enabled: boolean;
  last_run: number | null;
  next_run: number | null;
  created_at: number;
}

/**
 * Schedule execution log entry
 */
export interface ScheduleLog {
  id: string;
  schedule_id: string;
  started_at: number;
  finished_at: number | null;
  status: 'running' | 'success' | 'failed';
  output: string | null;
  error: string | null;
}

/**
 * Input for creating a new schedule
 */
export type CreateScheduleInput = Omit<Schedule, 'id' | 'created_at' | 'last_run'>;

/**
 * Input for updating a schedule
 */
export type UpdateScheduleInput = Partial<Omit<Schedule, 'id' | 'created_at'>>;

// ============================================================================
// Database row types (internal)
// ============================================================================

interface ScheduleRow {
  id: string;
  name: string;
  cron_expr: string;
  prompt: string;
  enabled: number; // SQLite stores as 0/1
  last_run: number | null;
  next_run: number | null;
  created_at: number;
}

interface ScheduleLogRow {
  id: string;
  schedule_id: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  output: string | null;
  error: string | null;
}

// ============================================================================
// ScheduleStore Class
// ============================================================================

/**
 * SQLite-backed store for schedules and execution logs
 */
export class ScheduleStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.runMigration();
  }

  /**
   * Run database migration to create tables
   */
  private runMigration(): void {
    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');

    this.db.exec(`
      -- schedules table
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cron_expr TEXT NOT NULL,
        prompt TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        last_run INTEGER,
        next_run INTEGER,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      );

      -- schedule_logs table
      CREATE TABLE IF NOT EXISTS schedule_logs (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL,
        output TEXT,
        error TEXT
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled);
      CREATE INDEX IF NOT EXISTS idx_schedule_logs_schedule ON schedule_logs(schedule_id);
      CREATE INDEX IF NOT EXISTS idx_schedule_logs_started ON schedule_logs(started_at DESC);
    `);
  }

  // ==========================================================================
  // Schedule CRUD Operations
  // ==========================================================================

  /**
   * Create a new schedule
   */
  createJob(input: CreateScheduleInput): string {
    const id = randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO schedules (id, name, cron_expr, prompt, enabled, next_run)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, input.name, input.cron_expr, input.prompt, input.enabled ? 1 : 0, input.next_run);
    return id;
  }

  /**
   * Get a schedule by ID
   */
  getJob(id: string): Schedule | null {
    const stmt = this.db.prepare('SELECT * FROM schedules WHERE id = ?');
    const row = stmt.get(id) as ScheduleRow | undefined;
    return row ? this.rowToSchedule(row) : null;
  }

  /**
   * List all schedules
   */
  listJobs(): Schedule[] {
    const stmt = this.db.prepare('SELECT * FROM schedules ORDER BY created_at DESC');
    const rows = stmt.all() as ScheduleRow[];
    return rows.map((row) => this.rowToSchedule(row));
  }

  /**
   * List only enabled schedules
   */
  listEnabledJobs(): Schedule[] {
    const stmt = this.db.prepare(
      'SELECT * FROM schedules WHERE enabled = 1 ORDER BY created_at DESC'
    );
    const rows = stmt.all() as ScheduleRow[];
    return rows.map((row) => this.rowToSchedule(row));
  }

  /**
   * Update a schedule
   */
  updateJob(id: string, updates: UpdateScheduleInput): boolean {
    const fields: string[] = [];
    const values: (string | number | null)[] = [];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.cron_expr !== undefined) {
      fields.push('cron_expr = ?');
      values.push(updates.cron_expr);
    }
    if (updates.prompt !== undefined) {
      fields.push('prompt = ?');
      values.push(updates.prompt);
    }
    if (updates.enabled !== undefined) {
      fields.push('enabled = ?');
      values.push(updates.enabled ? 1 : 0);
    }
    if (updates.last_run !== undefined) {
      fields.push('last_run = ?');
      values.push(updates.last_run);
    }
    if (updates.next_run !== undefined) {
      fields.push('next_run = ?');
      values.push(updates.next_run);
    }

    if (fields.length === 0) return false;

    values.push(id);
    const stmt = this.db.prepare(`UPDATE schedules SET ${fields.join(', ')} WHERE id = ?`);
    const result = stmt.run(...values);
    return result.changes > 0;
  }

  /**
   * Delete a schedule (cascade deletes logs)
   */
  deleteJob(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM schedules WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  // ==========================================================================
  // Log Operations
  // ==========================================================================

  /**
   * Log the start of a schedule execution
   */
  logStart(scheduleId: string): string {
    const id = randomUUID();
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO schedule_logs (id, schedule_id, started_at, status)
      VALUES (?, ?, ?, 'running')
    `);
    stmt.run(id, scheduleId, now);

    // Update last_run on schedule
    this.updateJob(scheduleId, { last_run: now });

    return id;
  }

  /**
   * Log the finish of a schedule execution
   */
  logFinish(logId: string, status: 'success' | 'failed', output?: string, error?: string): boolean {
    const stmt = this.db.prepare(`
      UPDATE schedule_logs
      SET finished_at = ?, status = ?, output = ?, error = ?
      WHERE id = ?
    `);
    const result = stmt.run(Date.now(), status, output || null, error || null, logId);
    return result.changes > 0;
  }

  /**
   * Get execution logs for a schedule
   */
  getLogs(scheduleId: string, limit = 20, offset = 0): ScheduleLog[] {
    const stmt = this.db.prepare(`
      SELECT * FROM schedule_logs
      WHERE schedule_id = ?
      ORDER BY started_at DESC
      LIMIT ? OFFSET ?
    `);
    const rows = stmt.all(scheduleId, limit, offset) as ScheduleLogRow[];
    return rows.map((row) => this.rowToLog(row));
  }

  /**
   * Get the last execution for a schedule
   */
  getLastExecution(scheduleId: string): ScheduleLog | null {
    const stmt = this.db.prepare(`
      SELECT * FROM schedule_logs
      WHERE schedule_id = ?
      ORDER BY started_at DESC
      LIMIT 1
    `);
    const row = stmt.get(scheduleId) as ScheduleLogRow | undefined;
    return row ? this.rowToLog(row) : null;
  }

  /**
   * Get the last execution across all schedules (for heartbeat status)
   */
  getLastExecutionGlobal(): ScheduleLog | null {
    const stmt = this.db.prepare(`
      SELECT * FROM schedule_logs
      ORDER BY started_at DESC
      LIMIT 1
    `);
    const row = stmt.get() as ScheduleLogRow | undefined;
    return row ? this.rowToLog(row) : null;
  }

  /**
   * Get a specific log entry by ID
   */
  getLog(logId: string): ScheduleLog | null {
    const stmt = this.db.prepare('SELECT * FROM schedule_logs WHERE id = ?');
    const row = stmt.get(logId) as ScheduleLogRow | undefined;
    return row ? this.rowToLog(row) : null;
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Convert database row to Schedule object
   */
  private rowToSchedule(row: ScheduleRow): Schedule {
    return {
      id: row.id,
      name: row.name,
      cron_expr: row.cron_expr,
      prompt: row.prompt,
      enabled: row.enabled === 1,
      last_run: row.last_run,
      next_run: row.next_run,
      created_at: row.created_at,
    };
  }

  /**
   * Convert database row to ScheduleLog object
   */
  private rowToLog(row: ScheduleLogRow): ScheduleLog {
    return {
      id: row.id,
      schedule_id: row.schedule_id,
      started_at: row.started_at,
      finished_at: row.finished_at,
      status: row.status as 'running' | 'success' | 'failed',
      output: row.output,
      error: row.error,
    };
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}
