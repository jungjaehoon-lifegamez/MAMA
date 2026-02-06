/**
 * Swarm Session Manager
 *
 * High-level API for managing Swarm multi-agent sessions.
 * Handles session creation, task registration, wave progression, and completion tracking.
 *
 * Features:
 * - Session lifecycle management
 * - Wave-based task progression
 * - Progress monitoring (completed/failed/claimed/pending)
 * - Automatic wave advancement detection
 *
 * @module swarm-manager
 * @version 1.0
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import {
  initSwarmDb,
  createTask,
  getTasksBySession,
  getPendingTasks,
  type CreateTaskParams,
} from './swarm-db.js';

/**
 * Swarm session progress summary
 */
export interface SwarmProgress {
  sessionId: string;
  totalTasks: number;
  completed: number;
  failed: number;
  claimed: number;
  pending: number;
  currentWave: number;
  totalWaves: number;
}

/**
 * Swarm Session Manager
 *
 * Manages Swarm multi-agent coordination sessions.
 * Provides high-level APIs for task registration, progress tracking, and wave advancement.
 */
export class SwarmManager {
  private db: Database.Database;
  private _closed = false;

  /**
   * Create a new SwarmManager
   *
   * @param dbPath - Path to SQLite database file
   */
  constructor(dbPath: string) {
    this.db = initSwarmDb(dbPath);
  }

  /**
   * Ensure the manager is not closed
   * @throws {Error} If manager has been closed
   */
  private ensureOpen(): void {
    if (this._closed) {
      throw new Error('SwarmManager is closed');
    }
  }

  /**
   * Create a new Swarm session
   *
   * @returns Session ID (UUID)
   */
  createSession(): string {
    return randomUUID();
  }

  /**
   * Add tasks to a session
   *
   * @param sessionId - Session ID
   * @param tasks - Array of task parameters
   * @returns Array of created task IDs
   */
  addTasks(sessionId: string, tasks: CreateTaskParams[]): string[] {
    this.ensureOpen();

    const addTasksTransaction = this.db.transaction(() => {
      const taskIds: string[] = [];

      for (const task of tasks) {
        const taskId = createTask(this.db, { ...task, session_id: sessionId });
        taskIds.push(taskId);
      }

      return taskIds;
    });

    return addTasksTransaction();
  }

  /**
   * Get session progress summary
   *
   * @param sessionId - Session ID
   * @returns Progress summary with counts and wave info
   */
  getProgress(sessionId: string): SwarmProgress {
    this.ensureOpen();
    const tasks = getTasksBySession(this.db, sessionId);

    const completed = tasks.filter((t) => t.status === 'completed').length;
    const failed = tasks.filter((t) => t.status === 'failed').length;
    const claimed = tasks.filter((t) => t.status === 'claimed').length;
    const pending = tasks.filter((t) => t.status === 'pending').length;

    const currentWave = this.getCurrentWave(sessionId);
    const totalWaves = tasks.length > 0 ? Math.max(...tasks.map((t) => t.wave)) : 0;

    return {
      sessionId,
      totalTasks: tasks.length,
      completed,
      failed,
      claimed,
      pending,
      currentWave,
      totalWaves,
    };
  }

  /**
   * Check if session is complete
   *
   * A session is complete when all tasks are either completed or failed (no pending/claimed).
   *
   * @param sessionId - Session ID
   * @returns true if all tasks are finished
   */
  isSessionComplete(sessionId: string): boolean {
    this.ensureOpen();
    const tasks = getTasksBySession(this.db, sessionId);

    if (tasks.length === 0) {
      return true; // Empty session is considered complete
    }

    return tasks.every((t) => t.status === 'completed' || t.status === 'failed');
  }

  /**
   * Get current active wave number
   *
   * Returns the lowest wave number that has pending tasks.
   * If no pending tasks exist, returns the highest wave number + 1.
   *
   * @param sessionId - Session ID
   * @returns Current wave number
   */
  getCurrentWave(sessionId: string): number {
    this.ensureOpen();
    const pendingTasks = getPendingTasks(this.db, sessionId);

    if (pendingTasks.length === 0) {
      // No pending tasks - return next wave after highest existing wave
      const allTasks = getTasksBySession(this.db, sessionId);
      if (allTasks.length === 0) return 0;
      return Math.max(...allTasks.map((t) => t.wave)) + 1;
    }

    // Return lowest wave with pending tasks (already sorted by wave in getPendingTasks)
    return pendingTasks[0].wave;
  }

  /**
   * Check if a specific wave is complete
   *
   * A wave is complete when all its tasks are either completed or failed.
   *
   * @param sessionId - Session ID
   * @param wave - Wave number to check
   * @returns true if wave is complete
   */
  isWaveComplete(sessionId: string, wave: number): boolean {
    this.ensureOpen();
    const tasks = getTasksBySession(this.db, sessionId);
    const waveTasks = tasks.filter((t) => t.wave === wave);

    if (waveTasks.length === 0) {
      return true; // No tasks in this wave = complete
    }

    return waveTasks.every((t) => t.status === 'completed' || t.status === 'failed');
  }

  /**
   * Advance to next wave
   *
   * Checks if current wave is complete, then returns the next wave number.
   * Returns null if all waves are complete.
   *
   * @param sessionId - Session ID
   * @returns Next wave number, or null if session is complete
   */
  advanceWave(sessionId: string): number | null {
    this.ensureOpen();
    const currentWave = this.getCurrentWave(sessionId);

    // Check if current wave is complete
    if (!this.isWaveComplete(sessionId, currentWave)) {
      return null; // Current wave not finished yet
    }

    // Check if there are any pending tasks in future waves
    const allTasks = getTasksBySession(this.db, sessionId);
    const futureWaves = allTasks.filter((t) => t.wave > currentWave && t.status === 'pending');

    if (futureWaves.length === 0) {
      return null; // No more waves to process
    }

    // Return the next wave with pending tasks
    return Math.min(...futureWaves.map((t) => t.wave));
  }

  /**
   * Get database instance
   *
   * @returns Database instance
   */
  getDatabase(): Database.Database {
    this.ensureOpen();
    return this.db;
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
    this._closed = true;
  }
}
