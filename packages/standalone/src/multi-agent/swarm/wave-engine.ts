/**
 * Wave Execution Engine
 *
 * Executes Wave-based task orchestration:
 * - Waves execute sequentially (Wave 1 → Wave 2 → Wave 3)
 * - Tasks within each Wave execute in parallel (Promise.all)
 * - Failed tasks don't block sibling tasks (fail-forward)
 * - Integrates with SwarmManager for task lifecycle management
 *
 * @module wave-engine
 * @version 1.0
 */

import { claimTask, completeTask, failTask } from './swarm-db.js';
import type { SwarmManager } from './swarm-manager.js';

/**
 * Single task within a Wave
 */
export interface WaveTask {
  id: string;
  agentId: string;
  description: string;
  category: string;
  files?: string[];
  dependsOn?: string[];
}

/**
 * Wave containing multiple parallel tasks
 */
export interface Wave {
  wave: number;
  tasks: WaveTask[];
}

/**
 * Result of executing a single task
 */
export interface TaskExecutionResult {
  taskId: string;
  agentId: string;
  status: 'completed' | 'failed' | 'skipped';
  result?: string;
  error?: string;
}

/**
 * Result of executing all waves
 */
export interface WaveExecutionResult {
  sessionId: string;
  totalWaves: number;
  completedWaves: number;
  totalTasks: number;
  completed: number;
  failed: number;
  skipped: number;
  results: TaskExecutionResult[];
}

/**
 * Task executor function type
 *
 * Receives a task and returns execution result as a string.
 * Implementation should handle agent invocation and error handling.
 */
export type TaskExecutor = (task: WaveTask) => Promise<string>;

/**
 * Execute all waves sequentially, tasks within each wave in parallel
 *
 * Algorithm:
 * 1. For each wave (1, 2, 3, ...):
 *    a. Claim all tasks in the wave
 *    b. Execute claimed tasks in parallel (Promise.all)
 *    c. Mark tasks as completed/failed based on results
 *    d. Continue to next wave
 * 2. Return aggregated results
 *
 * Fail-forward behavior:
 * - If a task fails, it's marked as 'failed' but doesn't block sibling tasks
 * - Next wave proceeds regardless of previous wave failures
 *
 * @param waves - Array of waves to execute
 * @param swarmManager - SwarmManager instance for DB access
 * @param sessionId - Swarm session ID
 * @param executor - Function to execute a single task
 * @returns Execution results with counts and task-level details
 */
export async function executeWaves(
  waves: Wave[],
  swarmManager: SwarmManager,
  sessionId: string,
  executor: TaskExecutor
): Promise<WaveExecutionResult> {
  const db = swarmManager.getDatabase();
  const results: TaskExecutionResult[] = [];
  let completedWaves = 0;
  let completed = 0;
  let failed = 0;
  let skipped = 0;

  // Sort waves by wave number
  const sortedWaves = [...waves].sort((a, b) => a.wave - b.wave);

  for (const wave of sortedWaves) {
    console.log(`[WaveEngine] Starting Wave ${wave.wave} with ${wave.tasks.length} tasks`);

    // Execute all tasks in this wave in parallel
    const waveResults = await Promise.all(
      wave.tasks.map(async (task) => {
        // Atomically claim the task
        const claimed = claimTask(db, task.id, task.agentId);

        if (!claimed) {
          console.log(`[WaveEngine] Task ${task.id} already claimed or completed, skipping`);
          skipped++;
          return {
            taskId: task.id,
            agentId: task.agentId,
            status: 'skipped' as const,
            error: 'Task already claimed or not available',
          };
        }

        // Execute the task
        try {
          console.log(`[WaveEngine] Agent ${task.agentId} executing task: ${task.description}`);
          const result = await executor(task);

          // Mark as completed
          completeTask(db, task.id, result);
          completed++;

          return {
            taskId: task.id,
            agentId: task.agentId,
            status: 'completed' as const,
            result,
          };
        } catch (error) {
          // Mark as failed
          const errorMsg = error instanceof Error ? error.message : String(error);
          failTask(db, task.id, errorMsg);
          failed++;

          return {
            taskId: task.id,
            agentId: task.agentId,
            status: 'failed' as const,
            error: errorMsg,
          };
        }
      })
    );

    results.push(...waveResults);
    completedWaves++;

    const succeeded = waveResults.filter((r) => r.status === 'completed').length;
    const failedCount = waveResults.filter((r) => r.status === 'failed').length;
    console.log(
      `[WaveEngine] Wave ${wave.wave} complete: ${succeeded} succeeded, ${failedCount} failed`
    );
  }

  const totalTasks = waves.reduce((sum, w) => sum + w.tasks.length, 0);

  return {
    sessionId,
    totalWaves: waves.length,
    completedWaves,
    totalTasks,
    completed,
    failed,
    skipped,
    results,
  };
}

/**
 * Execute a single wave (for incremental execution)
 *
 * Useful when you want to execute waves one at a time with manual advancement.
 *
 * @param wave - Wave to execute
 * @param swarmManager - SwarmManager instance
 * @param sessionId - Session ID
 * @param executor - Task executor function
 * @returns Execution results for this wave
 */
export async function executeWave(
  wave: Wave,
  swarmManager: SwarmManager,
  sessionId: string,
  executor: TaskExecutor
): Promise<WaveExecutionResult> {
  return executeWaves([wave], swarmManager, sessionId, executor);
}
