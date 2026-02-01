/**
 * Job Lock for preventing concurrent execution
 *
 * Simple in-memory lock mechanism for single-process environments.
 * For multi-process scenarios, use a distributed lock (Redis, etc.)
 */

/**
 * Lock information
 */
export interface LockInfo {
  /** Job ID */
  jobId: string;
  /** When lock was acquired */
  acquiredAt: Date;
  /** Lock timeout in ms (0 = no timeout) */
  timeout: number;
}

export class JobLock {
  private locks: Map<string, LockInfo> = new Map();
  private readonly defaultTimeout: number;

  /**
   * Create a new JobLock instance
   *
   * @param defaultTimeout - Default lock timeout in ms (0 = no timeout)
   */
  constructor(defaultTimeout = 0) {
    this.defaultTimeout = defaultTimeout;
  }

  /**
   * Attempt to acquire a lock for a job
   *
   * @param jobId - Job identifier
   * @param timeout - Lock timeout in ms (overrides default)
   * @returns true if lock acquired, false if already locked
   */
  acquire(jobId: string, timeout?: number): boolean {
    // Check if already locked
    if (this.isLocked(jobId)) {
      return false;
    }

    // Acquire lock
    this.locks.set(jobId, {
      jobId,
      acquiredAt: new Date(),
      timeout: timeout ?? this.defaultTimeout,
    });

    return true;
  }

  /**
   * Release a lock for a job
   *
   * @param jobId - Job identifier
   * @returns true if lock was released, false if not locked
   */
  release(jobId: string): boolean {
    return this.locks.delete(jobId);
  }

  /**
   * Check if a job is currently locked
   *
   * Also handles timeout expiration.
   *
   * @param jobId - Job identifier
   * @returns true if locked, false otherwise
   */
  isLocked(jobId: string): boolean {
    const lock = this.locks.get(jobId);

    if (!lock) {
      return false;
    }

    // Check for timeout expiration
    if (lock.timeout > 0) {
      const elapsed = Date.now() - lock.acquiredAt.getTime();
      if (elapsed >= lock.timeout) {
        // Lock expired, release it
        this.locks.delete(jobId);
        return false;
      }
    }

    return true;
  }

  /**
   * Get lock information for a job
   *
   * @param jobId - Job identifier
   * @returns Lock info or null if not locked
   */
  getLockInfo(jobId: string): LockInfo | null {
    if (!this.isLocked(jobId)) {
      return null;
    }
    return this.locks.get(jobId) ?? null;
  }

  /**
   * Get all currently held locks
   *
   * @returns Array of lock info
   */
  getAllLocks(): LockInfo[] {
    // Filter out expired locks
    const activeLocks: LockInfo[] = [];

    for (const [jobId, lock] of this.locks) {
      if (this.isLocked(jobId)) {
        activeLocks.push(lock);
      }
    }

    return activeLocks;
  }

  /**
   * Release all locks
   */
  releaseAll(): void {
    this.locks.clear();
  }

  /**
   * Get the number of currently held locks
   */
  get size(): number {
    return this.getAllLocks().length;
  }

  /**
   * Execute a function with a lock
   *
   * Automatically acquires and releases lock around the function.
   *
   * @param jobId - Job identifier
   * @param fn - Function to execute
   * @param timeout - Lock timeout in ms
   * @returns Result of the function
   * @throws Error if lock cannot be acquired
   */
  async withLock<T>(jobId: string, fn: () => Promise<T>, timeout?: number): Promise<T> {
    if (!this.acquire(jobId, timeout)) {
      throw new Error(`Failed to acquire lock for job: ${jobId}`);
    }

    try {
      return await fn();
    } finally {
      this.release(jobId);
    }
  }
}
