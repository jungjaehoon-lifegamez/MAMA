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
  retryTask,
  deferTask,
  getTasksBySession,
} from './swarm-db.js';
import { AgentProcessManager } from '../agent-process-manager.js';
import type { AgentRuntimeProcess } from '../runtime-process.js';
import type { ContextInjector } from '../../gateways/context-injector.js';
import type { SwarmAntiPatternDetector } from './swarm-anti-pattern-detector.js';

/**
 * Result of executing a single task
 */
export interface TaskExecutionResult {
  taskId: string;
  agentId: string;
  status: 'completed' | 'failed' | 'deferred' | 'retrying';
  result?: string;
  error?: string;
  warnings?: string[];
  retryCount?: number;
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
  private contextInjector?: ContextInjector;

  // Prevent concurrent pollAndExecute for the same session
  private pollingSessionIds: Set<string> = new Set();

  // Auto-checkpoint settings (F6)
  private enableAutoCheckpoint: boolean = false;
  private checkpointDebounceMs: number = 5000;
  private checkpointFailCounts: Map<string, number> = new Map();
  private checkpointTimers: Map<string, NodeJS.Timeout> = new Map();
  private antiPatternDetector?: SwarmAntiPatternDetector;
  private maxRetries = 3;

  constructor(
    swarmManager: SwarmManager,
    agentProcessManager: AgentProcessManager,
    options?: {
      pollingIntervalMs?: number;
      contextInjector?: ContextInjector;
      antiPatternDetector?: SwarmAntiPatternDetector;
      maxRetries?: number;
      enableAutoCheckpoint?: boolean;
      checkpointDebounceMs?: number;
    }
  ) {
    super();
    this.swarmManager = swarmManager;
    this.agentProcessManager = agentProcessManager;
    if (options?.pollingIntervalMs !== undefined) {
      this.pollingIntervalMs = options.pollingIntervalMs;
    }
    if (options?.contextInjector) {
      this.contextInjector = options.contextInjector;
    }
    if (options?.antiPatternDetector) {
      this.antiPatternDetector = options.antiPatternDetector;
    }
    if (options?.maxRetries !== undefined) {
      this.maxRetries = options.maxRetries;
    }
    if (options?.enableAutoCheckpoint !== undefined) {
      this.enableAutoCheckpoint = options.enableAutoCheckpoint;
    }
    if (options?.checkpointDebounceMs !== undefined) {
      this.checkpointDebounceMs = options.checkpointDebounceMs;
    }

    // Setup auto-checkpoint listeners (F6)
    if (this.enableAutoCheckpoint) {
      this.setupAutoCheckpoint();
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

    // Clear debounce timer (F6)
    const checkpointTimer = this.checkpointTimers.get(sessionId);
    if (checkpointTimer) {
      clearTimeout(checkpointTimer);
      this.checkpointTimers.delete(sessionId);
    }
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
    if (!task.category) {
      console.warn(`[SwarmTaskRunner] Task ${task.id} has no category. Defaulting to 'developer'`);
    }
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

    // Prevent concurrent polling for the same session
    if (this.pollingSessionIds.has(sessionId)) {
      console.log(
        `[SwarmTaskRunner] Polling already in progress for session ${sessionId}, skipping`
      );
      return;
    }

    this.pollingSessionIds.add(sessionId);
    try {
      await this.pollAndExecuteInternal(sessionId);
    } finally {
      this.pollingSessionIds.delete(sessionId);
    }
  }

  /**
   * Internal poll logic (extracted for concurrency guard)
   */
  private async pollAndExecuteInternal(sessionId: string): Promise<void> {
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

    // Cleanup idle & hung processes
    const agentPool = this.agentProcessManager.getAgentProcessPool();
    const idleCleaned = agentPool.cleanupIdleProcesses();
    const hungCleaned = agentPool.cleanupHungProcesses();
    if (idleCleaned > 0 || hungCleaned > 0) {
      console.log(
        `[SwarmTaskRunner] Cleaned up ${idleCleaned} idle + ${hungCleaned} hung processes`
      );
    }

    // Log pool status (only if pools exist)
    const statuses = agentPool.getAllPoolStatuses();
    if (statuses.size > 0) {
      for (const [agentId, status] of statuses) {
        console.log(
          `[SwarmTaskRunner] Pool status: agent=${agentId} busy=${status.busy}/${status.total}`
        );
      }
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
      if (!task.category) {
        console.warn(
          `[SwarmTaskRunner] Task ${task.id} has no category. Defaulting to 'developer'`
        );
      }

      // Try to claim the task
      const claimed = claimTask(db, task.id, agentId);
      if (!claimed) {
        continue; // Already claimed by another runner
      }

      // Execute the task asynchronously (don't wait)
      this.executeTask(task, 'swarm', 'auto-' + sessionId).catch((error) => {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[SwarmTaskRunner] Error executing task ${task.id}:`, errorMsg);

        // Ensure task is marked as failed in DB if executeTask didn't handle it
        // (executeTask's catch block should handle this, but this is a safety net)
        try {
          const taskStatus = db
            .prepare('SELECT status FROM swarm_tasks WHERE id = ?')
            .get(task.id) as { status: string } | undefined;

          if (taskStatus && taskStatus.status !== 'failed' && taskStatus.status !== 'completed') {
            console.warn(
              `[SwarmTaskRunner] Task ${task.id} in unexpected state after error: ${taskStatus.status}, marking as failed`
            );
            failTask(db, task.id, errorMsg);
          }
        } catch (dbError) {
          console.error(`[SwarmTaskRunner] Failed to verify task status:`, dbError);
        }

        // Emit task-failed event for monitoring
        this.emit('task-failed', {
          taskId: task.id,
          agentId: task.category || 'developer',
          status: 'failed' as const,
          error: errorMsg,
        });
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
    if (!task.category) {
      console.warn(`[SwarmTaskRunner] Task ${task.id} has no category. Defaulting to 'developer'`);
    }

    let process: AgentRuntimeProcess | undefined; // Declare in outer scope for catch block access

    try {
      console.log(`[SwarmTaskRunner] Executing task ${task.id}: ${task.description}`);

      // Inject MAMA context if available
      let enrichedDescription = task.description;
      if (this.contextInjector) {
        try {
          const context = await this.contextInjector.getRelevantContext(task.description);
          if (context.hasContext) {
            enrichedDescription = `${context.prompt}\n\n---\n\nTask:\n${task.description}`;
            console.log(
              `[SwarmTaskRunner] Injected ${context.decisions.length} related decisions into task ${task.id}`
            );
          }
        } catch (error) {
          // Graceful fallback - log error but continue with original description
          console.warn(`[SwarmTaskRunner] Failed to inject context for task ${task.id}:`, error);
        }
      }

      // Anti-pattern detection
      if (this.antiPatternDetector) {
        try {
          const warnings = await this.antiPatternDetector.detect(agentId, task.description);
          if (warnings.length > 0) {
            const warningText = this.antiPatternDetector.formatWarnings(warnings);
            enrichedDescription = `${warningText}\n\n---\n\n${enrichedDescription}`;
            console.log(
              `[SwarmTaskRunner] Injected ${warnings.length} anti-pattern warnings for agent ${agentId}`
            );
          }
        } catch (error) {
          console.warn(
            `[SwarmTaskRunner] Anti-pattern detection failed for task ${task.id}:`,
            error
          );
        }
      }

      // Get agent process
      process = await this.agentProcessManager.getProcess(source, channelId, agentId);

      // Busy Guard: defer task if agent process is not ready
      if (!process.isReady()) {
        deferTask(db, task.id);

        // Release process back to pool (we didn't use it)
        this.agentProcessManager.releaseProcess(agentId, process);

        const deferredResult: TaskExecutionResult = {
          taskId: task.id,
          agentId,
          status: 'deferred',
          error: 'Agent process busy, task deferred',
        };
        console.log(`[SwarmTaskRunner] Task ${task.id} deferred — agent ${agentId} busy`);
        this.emit('task-deferred', deferredResult);
        return deferredResult;
      }

      // Send enriched task description to agent
      const promptResult = await process.sendMessage(enrichedDescription);

      // Mark task as completed
      const resultText = promptResult.response || 'Task completed';
      completeTask(db, task.id, resultText);

      // Release process back to pool
      this.agentProcessManager.releaseProcess(agentId, process);

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
      // Check retry count
      const errorMsg = error instanceof Error ? error.message : String(error);
      const currentTask = db
        .prepare('SELECT retry_count FROM swarm_tasks WHERE id = ?')
        .get(task.id) as { retry_count: number } | undefined;
      const retryCount = currentTask?.retry_count ?? 0;

      // Release process back to pool (error occurred after getting process)
      if (process) {
        this.agentProcessManager.releaseProcess(agentId, process);
      }

      if (retryCount < this.maxRetries) {
        // Retry the task
        retryTask(db, task.id);
        const retriedResult: TaskExecutionResult = {
          taskId: task.id,
          agentId,
          status: 'retrying',
          error: errorMsg,
          retryCount: retryCount + 1,
        };

        console.log(
          `[SwarmTaskRunner] Task ${task.id} will be retried (attempt ${retryCount + 1}/${this.maxRetries})`
        );
        this.emit('task-retried', retriedResult, retryCount + 1, this.maxRetries);

        return retriedResult;
      } else {
        // Max retries reached, mark as failed
        failTask(db, task.id, errorMsg);

        const result: TaskExecutionResult = {
          taskId: task.id,
          agentId,
          status: 'failed',
          error: errorMsg,
          retryCount,
        };

        console.error(
          `[SwarmTaskRunner] Task ${task.id} failed after ${retryCount} retries:`,
          errorMsg
        );
        this.emit('task-failed', result);

        return result;
      }
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

    // Check for circular dependencies (self-reference and transitive cycles)
    if (dependencies.includes(task.id)) {
      console.warn(`[SwarmTaskRunner] Circular dependency detected for task ${task.id}`);
      return false;
    }
    // DFS cycle detection: walk dependency graph with visited set
    const visited = new Set<string>();
    const stack = [...dependencies];
    while (stack.length > 0) {
      const depId = stack.pop()!;
      if (depId === task.id) {
        console.warn(
          `[SwarmTaskRunner] Transitive circular dependency: task ${task.id} → ... → ${task.id}`
        );
        return false;
      }
      if (visited.has(depId)) continue;
      visited.add(depId);
      const depTask = db.prepare('SELECT depends_on FROM swarm_tasks WHERE id = ?').get(depId) as
        | { depends_on: string | null }
        | undefined;
      if (depTask?.depends_on) {
        for (const transitive of parseDependsOn(depTask)) {
          stack.push(transitive);
        }
      }
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
   * Setup auto-checkpoint listeners (F6)
   */
  private setupAutoCheckpoint(): void {
    // session-complete: immediate checkpoint (no debounce)
    this.on('session-complete', async (sessionId: string) => {
      try {
        await this.saveSessionCheckpoint(sessionId, true);
        // Reset fail counter on success
        this.checkpointFailCounts.delete(sessionId);
      } catch (err) {
        const failCount = (this.checkpointFailCounts.get(sessionId) || 0) + 1;
        this.checkpointFailCounts.set(sessionId, failCount);

        if (failCount >= 3) {
          console.warn(
            `[SwarmTaskRunner] Checkpoint failed ${failCount} times for session ${sessionId}. Continuing without checkpoint.`,
            err
          );
        } else {
          console.warn(
            `[SwarmTaskRunner] Failed to save checkpoint for session ${sessionId}:`,
            err
          );
        }
      }
    });

    // task-completed / task-failed: debounced checkpoint
    const handleTaskEvent = async (result: TaskExecutionResult) => {
      if (!result) return;

      // Extract sessionId from taskId (format: {sessionId}-task-{N})
      const match = result.taskId.match(/^(.+)-task-\d+$/);
      if (!match) return;

      const sessionId = match[1];
      this.scheduleCheckpoint(sessionId);
    };

    this.on('task-completed', handleTaskEvent);
    this.on('task-failed', handleTaskEvent);
  }

  /**
   * Schedule a debounced checkpoint save (F6)
   */
  private scheduleCheckpoint(sessionId: string): void {
    // Clear existing timer
    const existingTimer = this.checkpointTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Schedule new timer
    const timer = setTimeout(async () => {
      try {
        await this.saveSessionCheckpoint(sessionId, false);
        this.checkpointTimers.delete(sessionId);
        // Reset fail counter on success
        this.checkpointFailCounts.delete(sessionId);
      } catch (err) {
        const failCount = (this.checkpointFailCounts.get(sessionId) || 0) + 1;
        this.checkpointFailCounts.set(sessionId, failCount);

        if (failCount >= 3) {
          console.warn(
            `[SwarmTaskRunner] Checkpoint failed ${failCount} times for session ${sessionId}. Continuing without checkpoint.`,
            err
          );
        } else {
          console.warn(`[SwarmTaskRunner] Failed to save debounced checkpoint:`, err);
        }
      }
    }, this.checkpointDebounceMs);

    this.checkpointTimers.set(sessionId, timer);
  }

  /**
   * Save session checkpoint to MAMA (F6)
   */
  private async saveSessionCheckpoint(sessionId: string, isComplete: boolean): Promise<void> {
    const db = this.swarmManager.getDatabase();

    // Get all tasks for this session
    const allTasks = getTasksBySession(db, sessionId);

    const completed = allTasks.filter((t) => t.status === 'completed').length;
    const failed = allTasks.filter((t) => t.status === 'failed').length;
    const total = allTasks.length;

    // Build summary
    const summary = isComplete
      ? `Swarm session ${sessionId} completed. ${completed}/${total} tasks succeeded.`
      : `Swarm session ${sessionId} progress: ${completed}/${total} tasks completed.`;

    // Collect open files (files_owned from active tasks)
    const activeTasks = allTasks.filter((t) => t.status === 'claimed' || t.status === 'completed');
    const openFiles: string[] = [];
    for (const task of activeTasks) {
      if (task.files_owned) {
        const files = parseFilesOwned(task);
        openFiles.push(...files);
      }
    }

    // Build next steps (list failed tasks if any)
    let nextSteps = '';
    if (failed > 0) {
      const failedTasks = allTasks.filter((t) => t.status === 'failed');
      const failedDescriptions = failedTasks.map((t) => `- ${t.description}`).slice(0, 5);
      nextSteps = `Failed tasks (${failed}):\n${failedDescriptions.join('\n')}`;
    }

    // Save checkpoint via swarm-mama-adapter
    const { saveSwarmCheckpoint } = await import('./swarm-mama-adapter.js');
    await saveSwarmCheckpoint(sessionId, summary, openFiles, nextSteps);
  }

  /**
   * Stop all sessions
   */
  stopAll(): void {
    console.log(`[SwarmTaskRunner] Stopping all sessions (${this.sessions.size})`);
    for (const sessionId of Array.from(this.sessions.keys())) {
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
