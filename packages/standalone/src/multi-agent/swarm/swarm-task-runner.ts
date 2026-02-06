/**
 * Swarm Task Runner
 *
 * Orchestrates automated execution of Swarm tasks by:
 * - Polling for pending tasks and executing them on agent processes
 * - Managing task dependencies (depends_on) and file conflict detection
 * - Handling both event-driven (immediate) and polling-based execution
 * - Automatically stopping sessions when complete
 *
 * Features:
 * - Dependency resolution: tasks wait for prerequisite tasks to complete
 * - File conflict warnings: detects when multiple tasks modify same files
 * - Stale lease expiration: recovers from agent crashes
 * - Event emission: task-completed, task-failed, session-complete, file-conflict
 *
 * @module swarm-task-runner
 * @version 1.0
 */

import { EventEmitter } from 'events';
import type Database from 'better-sqlite3';
import { SwarmManager } from './swarm-manager.js';
import type { SwarmTask } from './swarm-db.js';
import {
  claimTask,
  completeTask,
  failTask,
  failPendingTask,
  getPendingTasks,
  expireStaleLeases,
  parseFilesOwned,
  parseDependsOn,
} from './swarm-db.js';
import { AgentProcessManager } from '../agent-process-manager.js';

/**
 * Result of executing a single task
 */
export interface TaskExecutionResult {
  taskId: string;
  agentId: string;
  status: 'completed' | 'failed';
  result?: string;
  error?: string;
  warnings?: string[];
}

/**
 * Active session state
 */
interface SessionState {
  sessionId: string;
  intervalHandle: NodeJS.Timeout;
  isRunning: boolean;
}

/**
 * Swarm Task Runner
 *
 * Manages automated execution of swarm tasks across multiple agent processes.
 * Supports both event-driven (immediate) and polling-based execution modes.
 *
 * Events:
 * - 'task-completed': (result: TaskExecutionResult) => void
 * - 'task-failed': (result: TaskExecutionResult) => void
 * - 'session-complete': (sessionId: string) => void
 * - 'file-conflict': (taskId: string, conflictingFiles: string[], conflictingTasks: string[]) => void
 */
export class SwarmTaskRunner extends EventEmitter {
  private swarmManager: SwarmManager;
  private agentProcessManager: AgentProcessManager;
  private sessions: Map<string, SessionState> = new Map();
  private pollingIntervalMs = 30000; // 30 seconds

  constructor(
    swarmManager: SwarmManager,
    agentProcessManager: AgentProcessManager,
    options?: { pollingIntervalMs?: number }
  ) {
    super();
    this.swarmManager = swarmManager;
    this.agentProcessManager = agentProcessManager;
    if (options?.pollingIntervalMs) {
      this.pollingIntervalMs = options.pollingIntervalMs;
    }
  }

  /**
   * Start a session with automatic polling
   *
   * @param sessionId - Session ID to start
   */
  startSession(sessionId: string): void {
    if (this.sessions.has(sessionId)) {
      console.warn(`[SwarmTaskRunner] Session ${sessionId} already running`);
      return;
    }

    console.log(`[SwarmTaskRunner] Starting session ${sessionId}`);

    const intervalHandle = setInterval(() => {
      this.pollAndExecute(sessionId).catch((error) => {
        console.error(`[SwarmTaskRunner] Error in polling for session ${sessionId}:`, error);
      });
    }, this.pollingIntervalMs);

    this.sessions.set(sessionId, {
      sessionId,
      intervalHandle,
      isRunning: true,
    });

    // Execute immediately on start
    this.pollAndExecute(sessionId).catch((error) => {
      console.error(`[SwarmTaskRunner] Error in initial poll for session ${sessionId}:`, error);
    });
  }

  /**
   * Stop a session
   *
   * @param sessionId - Session ID to stop
   */
  stopSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) {
      console.warn(`[SwarmTaskRunner] Session ${sessionId} not running`);
      return;
    }

    console.log(`[SwarmTaskRunner] Stopping session ${sessionId}`);
    clearInterval(state.intervalHandle);
    this.sessions.delete(sessionId);
  }

  /**
   * Execute a specific task immediately (event-driven mode)
   *
   * Used for mention-triggered tasks that should run immediately
   * rather than waiting for the next polling cycle.
   *
   * @param sessionId - Session ID
   * @param taskId - Task ID to execute
   * @param source - Source platform (e.g., 'discord', 'slack')
   * @param channelId - Channel ID
   * @returns Execution result
   */
  async executeImmediateTask(
    sessionId: string,
    taskId: string,
    source: string,
    channelId: string
  ): Promise<TaskExecutionResult> {
    const db = this.swarmManager.getDatabase();

    // Get the task
    const task = db.prepare(`SELECT * FROM swarm_tasks WHERE id = ?`).get(taskId) as
      | SwarmTask
      | undefined;

    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    if (task.session_id !== sessionId) {
      throw new Error(`Task ${taskId} does not belong to session ${sessionId}`);
    }

    // Claim the task before execution
    const agentId = task.category || 'developer';
    const claimed = claimTask(db, task.id, agentId);
    if (!claimed) {
      throw new Error(`Task ${taskId} could not be claimed (current status: ${task.status})`);
    }

    // Execute the task
    return this.executeTask(task, source, channelId);
  }

  /**
   * Poll for pending tasks and execute them
   *
   * @param sessionId - Session ID to poll
   */
  private async pollAndExecute(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || !state.isRunning) {
      return;
    }

    // Expire stale leases first
    const db = this.swarmManager.getDatabase();
    const expired = expireStaleLeases(db);
    if (expired > 0) {
      console.log(`[SwarmTaskRunner] Expired ${expired} stale leases`);
    }

    // Check if session is complete
    if (this.swarmManager.isSessionComplete(sessionId)) {
      console.log(`[SwarmTaskRunner] Session ${sessionId} is complete`);
      this.stopSession(sessionId);
      this.emit('session-complete', sessionId);
      return;
    }

    // Get pending tasks
    const pendingTasks = getPendingTasks(db, sessionId);

    if (pendingTasks.length === 0) {
      return; // No tasks to execute
    }

    // Try to execute each pending task
    for (const task of pendingTasks) {
      // Check dependencies
      if (!this.checkDependencies(db, task)) {
        continue; // Dependencies not met, skip for now
      }

      // Check for file conflicts (warning only, doesn't block)
      const conflicts = this.checkFileConflicts(db, sessionId, task);
      if (conflicts.length > 0) {
        const conflictingFiles = conflicts.map((t) => parseFilesOwned(t)).flat();
        const conflictingTaskIds = conflicts.map((t) => t.id);
        console.warn(
          `[SwarmTaskRunner] File conflict detected for task ${task.id}: files=${conflictingFiles.join(', ')}`
        );
        this.emit('file-conflict', task.id, conflictingFiles, conflictingTaskIds);
      }

      // Determine agent ID from category
      const agentId = task.category || 'developer';

      // Try to claim the task
      const claimed = claimTask(db, task.id, agentId);
      if (!claimed) {
        continue; // Already claimed by another runner
      }

      // Execute the task asynchronously (don't wait)
      this.executeTask(task, 'swarm', 'auto-' + sessionId).catch((error) => {
        console.error(`[SwarmTaskRunner] Error executing task ${task.id}:`, error);
      });
    }
  }

  /**
   * Execute a single task
   *
   * @param task - Task to execute
   * @param source - Source platform
   * @param channelId - Channel ID
   * @returns TaskExecutionResult with status and optional error
   */
  private async executeTask(
    task: SwarmTask,
    source: string,
    channelId: string
  ): Promise<TaskExecutionResult> {
    const db = this.swarmManager.getDatabase();

    // Determine agent ID from category or use default
    const agentId = task.category || 'developer';

    try {
      console.log(`[SwarmTaskRunner] Executing task ${task.id}: ${task.description}`);

      // Get agent process
      const process = await this.agentProcessManager.getProcess(source, channelId, agentId);

      // Send task description to agent
      const promptResult = await process.sendMessage(task.description);

      // Mark task as completed
      const resultText = promptResult.response || 'Task completed';
      completeTask(db, task.id, resultText);

      const result: TaskExecutionResult = {
        taskId: task.id,
        agentId,
        status: 'completed',
        result: resultText,
      };

      console.log(`[SwarmTaskRunner] Task ${task.id} completed`);
      this.emit('task-completed', result);

      return result;
    } catch (error) {
      // Mark task as failed
      const errorMsg = error instanceof Error ? error.message : String(error);
      failTask(db, task.id, errorMsg);

      const result: TaskExecutionResult = {
        taskId: task.id,
        agentId,
        status: 'failed',
        error: errorMsg,
      };

      console.error(`[SwarmTaskRunner] Task ${task.id} failed:`, errorMsg);
      this.emit('task-failed', result);

      return result;
    }
  }

  /**
   * Check if all task dependencies are met
   *
   * @param db - Database instance
   * @param task - Task to check (avoids redundant SELECT)
   * @returns true if all dependencies are completed, false if pending/failed/missing
   */
  private checkDependencies(db: Database.Database, task: SwarmTask): boolean {
    const dependencies = parseDependsOn(task);
    if (dependencies.length === 0) {
      return true; // No dependencies
    }

    // Check for circular dependency (self-reference)
    if (dependencies.includes(task.id)) {
      console.warn(`[SwarmTaskRunner] Circular dependency detected for task ${task.id}`);
      return false;
    }

    // Check each dependency
    for (const depId of dependencies) {
      const depTask = db.prepare(`SELECT status FROM swarm_tasks WHERE id = ?`).get(depId) as
        | { status: 'pending' | 'claimed' | 'completed' | 'failed' }
        | undefined;

      if (!depTask) {
        console.warn(`[SwarmTaskRunner] Dependency task ${depId} not found`);
        return false;
      }

      if (depTask.status === 'failed') {
        // Dependency failed, mark this task as failed too
        console.log(
          `[SwarmTaskRunner] Task ${task.id} auto-failed due to failed dependency ${depId}`
        );
        failPendingTask(db, task.id, `Dependency ${depId} failed`);
        return false;
      }

      if (depTask.status !== 'completed') {
        // Dependency not yet completed
        return false;
      }
    }

    return true; // All dependencies completed
  }

  /**
   * Check for file conflicts with other claimed tasks
   *
   * @param db - Database instance
   * @param sessionId - Session ID
   * @param task - Task to check
   * @returns Array of conflicting tasks (empty if no conflicts)
   */
  private checkFileConflicts(
    db: Database.Database,
    sessionId: string,
    task: SwarmTask
  ): SwarmTask[] {
    const files = parseFilesOwned(task);
    if (files.length === 0) {
      return []; // No files to conflict
    }

    // Get all claimed tasks in this session
    const claimedTasks = db
      .prepare(`SELECT * FROM swarm_tasks WHERE session_id = ? AND status = 'claimed' AND id != ?`)
      .all(sessionId, task.id) as SwarmTask[];

    const conflicts: SwarmTask[] = [];

    for (const claimedTask of claimedTasks) {
      const claimedFiles = parseFilesOwned(claimedTask);

      // Check for intersection
      const hasConflict = files.some((file) => claimedFiles.includes(file));
      if (hasConflict) {
        conflicts.push(claimedTask);
      }
    }

    return conflicts;
  }

  /**
   * Stop all sessions
   */
  stopAll(): void {
    console.log(`[SwarmTaskRunner] Stopping all sessions (${this.sessions.size})`);
    for (const sessionId of this.sessions.keys()) {
      this.stopSession(sessionId);
    }
  }

  /**
   * Get active session count
   */
  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get active session IDs
   */
  getActiveSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }
}
