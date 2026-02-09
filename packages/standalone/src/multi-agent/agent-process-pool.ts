/**
 * Agent Process Pool
 *
 * Manages a pool of concurrent Claude CLI processes per agent for parallel task execution.
 * Replaces 1-agent-1-process limitation with configurable pool sizes.
 *
 * Features:
 * - Per-agent process pools with configurable pool_size
 * - Automatic process reuse when idle
 * - Pool capacity management (throws when full)
 * - Idle timeout cleanup for unused processes
 * - Pool status monitoring
 *
 * @module agent-process-pool
 * @version 1.0
 */

import type { PersistentClaudeProcess } from '../agent/persistent-cli-process.js';

/**
 * Pool status for an agent
 */
export interface PoolStatus {
  /** Total processes in pool */
  total: number;
  /** Processes currently handling requests */
  busy: number;
  /** Idle processes available for reuse */
  idle: number;
}

/**
 * Configuration options for AgentProcessPool
 */
export interface AgentProcessPoolOptions {
  /** Default pool size per agent (default: 1) */
  defaultPoolSize?: number;
  /** Per-agent pool size overrides */
  agentPoolSizes?: Record<string, number>;
  /** Idle timeout in ms — unused processes auto-terminate (default: 600000 = 10min) */
  idleTimeoutMs?: number;
  /** Hung timeout in ms — busy processes exceeding this are killed (default: 900000 = 15min) */
  hungTimeoutMs?: number;
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Wraps a process with metadata for pool management
 */
interface PooledProcess {
  process: PersistentClaudeProcess;
  agentId: string;
  busy: boolean;
  lastUsedAt: number;
  channelKey: string;
}

/**
 * Agent Process Pool
 *
 * Manages pools of PersistentClaudeProcess instances per agent.
 * Enables parallel task execution by maintaining multiple processes.
 *
 * @example
 * ```typescript
 * const pool = new AgentProcessPool({
 *   defaultPoolSize: 3,
 *   agentPoolSizes: { developer: 5 },
 *   idleTimeoutMs: 300000
 * });
 *
 * const { process, isNew } = await pool.getAvailableProcess(
 *   'developer',
 *   'source:channel:developer',
 *   async () => new PersistentClaudeProcess({ sessionId: 'abc' })
 * );
 *
 * // Use process...
 * pool.releaseProcess('developer', process);
 * ```
 */
export class AgentProcessPool {
  /** Map<agentId, PooledProcess[]> */
  private pools: Map<string, PooledProcess[]> = new Map();
  private options: Required<AgentProcessPoolOptions>;

  constructor(options?: AgentProcessPoolOptions) {
    this.options = {
      defaultPoolSize: options?.defaultPoolSize ?? 1,
      agentPoolSizes: options?.agentPoolSizes ?? {},
      idleTimeoutMs: options?.idleTimeoutMs ?? 600000, // 10 minutes
      hungTimeoutMs: options?.hungTimeoutMs ?? 900000, // 15 minutes
      verbose: options?.verbose ?? false,
    };
  }

  /**
   * Get an available (idle) process for an agent, or create new one if under pool_size limit
   *
   * @param agentId - Agent ID
   * @param channelKey - Channel key for process creation
   * @param createProcess - Factory function to create new PersistentClaudeProcess
   * @returns { process, isNew } — isNew=true if a new process was created
   * @throws Error if pool is full (all busy, at max capacity)
   */
  async getAvailableProcess(
    agentId: string,
    channelKey: string,
    createProcess: () => Promise<PersistentClaudeProcess>
  ): Promise<{ process: PersistentClaudeProcess; isNew: boolean }> {
    const pool = this.pools.get(agentId) || [];
    const maxSize = this.getPoolSize(agentId);

    // 1. Find idle process (ready to accept new requests)
    // busy: AgentProcessPool internal flag (tracks claim/release cycle)
    // isReady(): actual CLI process state (idle vs busy/dead)
    // Both must be satisfied: pool has released it AND process is actually idle
    const idleEntry = pool.find((p) => !p.busy && p.process.isReady());
    if (idleEntry) {
      idleEntry.busy = true;
      idleEntry.lastUsedAt = Date.now();
      idleEntry.channelKey = channelKey;

      if (this.options.verbose) {
        console.log(
          `[AgentProcessPool] Reusing idle process for agent ${agentId} (${this.getPoolStatus(agentId).busy}/${maxSize} busy)`
        );
      }

      return { process: idleEntry.process, isNew: false };
    }

    // 2. Create new process if under limit
    if (pool.length < maxSize) {
      const newProcess = await createProcess();
      const entry: PooledProcess = {
        process: newProcess,
        agentId,
        busy: true,
        lastUsedAt: Date.now(),
        channelKey,
      };
      pool.push(entry);
      this.pools.set(agentId, pool);

      if (this.options.verbose) {
        console.log(
          `[AgentProcessPool] Created new process for agent ${agentId} (pool: ${pool.length}/${maxSize})`
        );
      }

      return { process: newProcess, isNew: true };
    }

    // 3. Pool full — all processes busy
    throw new Error(
      `[AgentProcessPool] Pool full for agent ${agentId} (${maxSize}/${maxSize} busy)`
    );
  }

  /**
   * Release a process back to the pool (mark as idle)
   *
   * @param agentId - Agent ID
   * @param process - Process to release
   */
  releaseProcess(agentId: string, process: PersistentClaudeProcess): void {
    const pool = this.pools.get(agentId);
    if (!pool) {
      if (this.options.verbose) {
        console.warn(`[AgentProcessPool] No pool found for agent ${agentId}, ignoring release`);
      }
      return;
    }

    const entry = pool.find((p) => p.process === process);
    if (!entry) {
      if (this.options.verbose) {
        console.warn(
          `[AgentProcessPool] Process not found in pool for agent ${agentId}, ignoring release`
        );
      }
      return;
    }

    entry.busy = false;
    entry.lastUsedAt = Date.now();

    if (this.options.verbose) {
      const status = this.getPoolStatus(agentId);
      console.log(
        `[AgentProcessPool] Released process for agent ${agentId} (${status.busy}/${status.total} busy)`
      );
    }
  }

  /**
   * Get pool status for an agent
   *
   * @param agentId - Agent ID
   * @returns Pool status { total, busy, idle }
   */
  getPoolStatus(agentId: string): PoolStatus {
    const pool = this.pools.get(agentId) || [];
    const busy = pool.filter((p) => p.busy).length;
    const total = pool.length;
    const idle = total - busy;

    return { total, busy, idle };
  }

  /**
   * Get pool size limit for an agent
   *
   * @param agentId - Agent ID
   * @returns Pool size (from agentPoolSizes override or defaultPoolSize)
   */
  getPoolSize(agentId: string): number {
    return this.options.agentPoolSizes[agentId] ?? this.options.defaultPoolSize;
  }

  /**
   * Stop all processes for an agent
   *
   * @param agentId - Agent ID to stop
   */
  stopAgent(agentId: string): void {
    const pool = this.pools.get(agentId);
    if (!pool) {
      return;
    }

    for (const entry of pool) {
      entry.process.stop();
    }

    this.pools.delete(agentId);

    if (this.options.verbose) {
      console.log(`[AgentProcessPool] Stopped all processes for agent ${agentId}`);
    }
  }

  /**
   * Stop all processes in all pools
   */
  stopAll(): void {
    const agentCount = this.pools.size;
    let processCount = 0;

    for (const pool of this.pools.values()) {
      for (const entry of pool) {
        entry.process.stop();
        processCount++;
      }
    }

    this.pools.clear();

    if (this.options.verbose) {
      console.log(
        `[AgentProcessPool] Stopped all processes (${processCount} processes, ${agentCount} agents)`
      );
    }
  }

  /**
   * Clean up idle processes that exceeded timeout
   *
   * Call this periodically to free up resources.
   *
   * @returns Number of processes cleaned up
   */
  cleanupIdleProcesses(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [agentId, pool] of this.pools) {
      const remaining = pool.filter((entry) => {
        if (!entry.busy && now - entry.lastUsedAt > this.options.idleTimeoutMs) {
          entry.process.stop();
          cleaned++;
          return false; // remove from pool
        }
        return true;
      });

      if (remaining.length === 0) {
        // Pool is empty, remove it entirely
        this.pools.delete(agentId);
      } else {
        this.pools.set(agentId, remaining);
      }
    }

    if (this.options.verbose && cleaned > 0) {
      console.log(`[AgentProcessPool] Cleaned up ${cleaned} idle processes`);
    }

    return cleaned;
  }

  /**
   * Clean up hung processes (busy for too long)
   *
   * Call this periodically to kill processes that are stuck.
   *
   * @returns Number of processes cleaned up
   */
  cleanupHungProcesses(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [agentId, pool] of this.pools) {
      const remaining = pool.filter((entry) => {
        if (entry.busy && now - entry.lastUsedAt > this.options.hungTimeoutMs) {
          console.warn(
            `[AgentProcessPool] Hung process detected for agent ${agentId} (busy for ${Math.floor((now - entry.lastUsedAt) / 1000)}s), killing`
          );
          entry.process.stop();
          cleaned++;
          return false; // remove from pool
        }
        return true;
      });

      if (remaining.length === 0) {
        // Pool is empty, remove it entirely
        this.pools.delete(agentId);
      } else {
        this.pools.set(agentId, remaining);
      }
    }

    if (this.options.verbose && cleaned > 0) {
      console.log(`[AgentProcessPool] Cleaned up ${cleaned} hung processes`);
    }

    return cleaned;
  }

  /**
   * Get pool statuses for all agents
   *
   * @returns Map<agentId, PoolStatus>
   */
  /**
   * Check if an agent has busy processes matching a channel key prefix
   *
   * @param agentId - Agent ID
   * @param channelKeyPrefix - Channel key prefix to match (e.g. "discord:123:")
   * @returns true if any busy process matches the prefix
   */
  hasBusyProcessForChannel(agentId: string, channelKeyPrefix: string): boolean {
    const pool = this.pools.get(agentId);
    if (!pool) return false;
    return pool.some((p) => p.busy && p.channelKey.startsWith(channelKeyPrefix));
  }

  getAllPoolStatuses(): Map<string, PoolStatus> {
    const statuses = new Map<string, PoolStatus>();
    for (const agentId of this.pools.keys()) {
      statuses.set(agentId, this.getPoolStatus(agentId));
    }
    return statuses;
  }
}
