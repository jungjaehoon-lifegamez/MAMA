/**
 * Swarm Task Queue Database
 *
 * SQLite-based task queue for Swarm multi-agent coordination.
 * Provides atomic task claiming, dependency tracking, and lease expiration.
 *
 * Features:
 * - Atomic task claiming with transactions
 * - Wave-based task sequencing
 * - File ownership tracking (conflict detection)
 * - Dependency resolution (task DAG)
 * - Stale lease expiration (fault tolerance)
 *
 * @module swarm-db
 * @version 1.0
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

/**
 * Swarm task record
 */
export interface SwarmTask {
  id: string;
  session_id: string;
  description: string;
  category: string;
  priority: number;
  wave: number;
  status: 'pending' | 'claimed' | 'completed' | 'failed';
  claimed_by: string | null;
  claimed_at: number | null;
  completed_at: number | null;
  result: string | null;
  files_owned: string | null; // JSON array
  depends_on: string | null; // JSON array of task IDs
  retry_count: number;
}

/**
 * Parameters for creating a new task
 */
export interface CreateTaskParams {
  session_id: string;
  description: string;
  category: string;
  priority?: number;
  wave: number;
  files_owned?: string[];
  depends_on?: string[];
}

/**
 * Initialize Swarm database
 *
 * Creates swarm_tasks table if not exists.
 * Does NOT use WAL mode to avoid conflicts with existing databases.
 *
 * @param dbPath - Path to SQLite database file
 * @returns Database instance
 * @throws {Error} If database file cannot be opened (invalid path, permissions, etc.)
 */
export function initSwarmDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // Create swarm_tasks table
  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS swarm_tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      priority INTEGER DEFAULT 0,
      wave INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      claimed_by TEXT,
      claimed_at INTEGER,
      completed_at INTEGER,
      result TEXT,
      files_owned TEXT,
      depends_on TEXT,
      retry_count INTEGER DEFAULT 0
    )
  `
  ).run();

  // Create indexes for common queries
  // Indexes are created with IF NOT EXISTS to avoid errors on repeated initialization
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_swarm_session ON swarm_tasks(session_id)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_swarm_status ON swarm_tasks(status)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_swarm_wave ON swarm_tasks(wave)`).run();

  return db;
}

/**
 * Create a new task
 *
 * @param db - Database instance
 * @param params - Task parameters
 * @returns Task ID (UUID)
 */
export function createTask(db: Database.Database, params: CreateTaskParams): string {
  const id = randomUUID();
  const priority = params.priority ?? 0;
  const files_owned = params.files_owned ? JSON.stringify(params.files_owned) : null;
  const depends_on = params.depends_on ? JSON.stringify(params.depends_on) : null;

  db.prepare(
    `
    INSERT INTO swarm_tasks (
      id, session_id, description, category, priority, wave, files_owned, depends_on
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    id,
    params.session_id,
    params.description,
    params.category,
    priority,
    params.wave,
    files_owned,
    depends_on
  );

  return id;
}

/**
 * Atomically claim a task
 *
 * Uses transaction to ensure only one agent can claim a task.
 * Verifies task is 'pending' before claiming.
 *
 * @param db - Database instance
 * @param taskId - Task ID to claim
 * @param agentId - Agent claiming the task
 * @returns true if claimed successfully, false if already claimed
 */
export function claimTask(db: Database.Database, taskId: string, agentId: string): boolean {
  const claim = db.transaction(() => {
    // Check if task exists and is pending
    const task = db.prepare(`SELECT status FROM swarm_tasks WHERE id = ?`).get(taskId) as
      | { status: 'pending' | 'claimed' | 'completed' | 'failed' }
      | undefined;

    if (!task || task.status !== 'pending') {
      return false;
    }

    // Atomically claim the task
    const now = Date.now();
    const result = db
      .prepare(
        `
      UPDATE swarm_tasks
      SET status = 'claimed', claimed_by = ?, claimed_at = ?
      WHERE id = ? AND status = 'pending'
    `
      )
      .run(agentId, now, taskId);

    return result.changes > 0;
  });

  return claim();
}

/**
 * Mark a task as completed
 *
 * @param db - Database instance
 * @param taskId - Task ID
 * @param result - Optional result data (JSON string or plain text)
 * @returns true if updated successfully
 */
export function completeTask(db: Database.Database, taskId: string, result?: string): boolean {
  const now = Date.now();
  const updateResult = db
    .prepare(
      `
    UPDATE swarm_tasks
    SET status = 'completed', completed_at = ?, result = ?
    WHERE id = ? AND status = 'claimed'
  `
    )
    .run(now, result ?? null, taskId);

  return updateResult.changes > 0;
}

/**
 * Mark a task as failed
 *
 * @param db - Database instance
 * @param taskId - Task ID
 * @param result - Optional error message or failure details
 * @returns true if updated successfully
 */
export function failTask(db: Database.Database, taskId: string, result?: string): boolean {
  const now = Date.now();
  const updateResult = db
    .prepare(
      `
    UPDATE swarm_tasks
    SET status = 'failed', completed_at = ?, result = ?
    WHERE id = ? AND status = 'claimed'
  `
    )
    .run(now, result ?? null, taskId);

  return updateResult.changes > 0;
}

/**
 * Mark a pending task as failed (for dependency propagation)
 *
 * Used when a task's dependency fails and the task hasn't been claimed yet.
 *
 * @param db - Database instance
 * @param taskId - Task ID
 * @param result - Optional error message or failure details
 * @returns true if updated successfully
 */
export function failPendingTask(db: Database.Database, taskId: string, result?: string): boolean {
  const now = Date.now();
  const updateResult = db
    .prepare(
      `
    UPDATE swarm_tasks
    SET status = 'failed', completed_at = ?, result = ?
    WHERE id = ? AND status = 'pending'
  `
    )
    .run(now, result ?? null, taskId);

  return updateResult.changes > 0;
}

/**
 * Retry a failed task
 *
 * Resets task status to pending and increments retry_count.
 * Used for automatic retry on task failure.
 *
 * @param db - Database instance
 * @param taskId - Task ID
 * @returns true if task was reset to pending
 */
export function retryTask(db: Database.Database, taskId: string): boolean {
  const result = db
    .prepare(
      `
    UPDATE swarm_tasks
    SET status = 'pending', claimed_by = NULL, claimed_at = NULL, retry_count = retry_count + 1
    WHERE id = ? AND (status = 'claimed' OR status = 'failed')
  `
    )
    .run(taskId);

  return result.changes > 0;
}

/**
 * Get all tasks for a session
 *
 * @param db - Database instance
 * @param sessionId - Session ID
 * @returns Array of tasks
 */
export function getTasksBySession(db: Database.Database, sessionId: string): SwarmTask[] {
  return db
    .prepare(`SELECT * FROM swarm_tasks WHERE session_id = ? ORDER BY wave, priority DESC`)
    .all(sessionId) as SwarmTask[];
}

/**
 * Get pending tasks for a session
 *
 * Optionally filter by wave number.
 *
 * @param db - Database instance
 * @param sessionId - Session ID
 * @param wave - Optional wave number filter
 * @returns Array of pending tasks
 */
export function getPendingTasks(
  db: Database.Database,
  sessionId: string,
  wave?: number
): SwarmTask[] {
  if (wave !== undefined) {
    return db
      .prepare(
        `SELECT * FROM swarm_tasks WHERE session_id = ? AND status = 'pending' AND wave = ? ORDER BY priority DESC`
      )
      .all(sessionId, wave) as SwarmTask[];
  }

  return db
    .prepare(
      `SELECT * FROM swarm_tasks WHERE session_id = ? AND status = 'pending' ORDER BY wave, priority DESC`
    )
    .all(sessionId) as SwarmTask[];
}

/**
 * Expire stale claimed tasks
 *
 * Returns claimed tasks older than maxAgeMs to pending status.
 * This handles agent crashes or hung processes.
 *
 * @param db - Database instance
 * @param maxAgeMs - Maximum age for claimed tasks (default: 15 minutes)
 * @returns Number of expired tasks
 */
export function expireStaleLeases(
  db: Database.Database,
  maxAgeMs: number = 15 * 60 * 1000
): number {
  const expireThreshold = Date.now() - maxAgeMs;

  const result = db
    .prepare(
      `
    UPDATE swarm_tasks
    SET status = 'pending', claimed_by = NULL, claimed_at = NULL
    WHERE status = 'claimed' AND claimed_at < ?
  `
    )
    .run(expireThreshold);

  return result.changes;
}

/**
 * Parse files_owned JSON array from task record
 *
 * @param task - Swarm task record
 * @returns Array of file paths, or empty array if null/invalid
 */
export function parseFilesOwned(task: SwarmTask): string[] {
  if (!task.files_owned) {
    return [];
  }

  try {
    const parsed = JSON.parse(task.files_owned);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Parse depends_on JSON array from task record
 *
 * @param task - Swarm task record
 * @returns Array of task IDs, or empty array if null/invalid
 */
export function parseDependsOn(task: SwarmTask): string[] {
  if (!task.depends_on) {
    return [];
  }

  try {
    const parsed = JSON.parse(task.depends_on);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
