/**
 * Unit tests for JobLock
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { JobLock } from '../../src/scheduler/job-lock.js';

describe('JobLock', () => {
  let lock: JobLock;

  beforeEach(() => {
    lock = new JobLock();
  });

  describe('acquire()', () => {
    it('should acquire lock for new job', () => {
      expect(lock.acquire('job1')).toBe(true);
    });

    it('should fail to acquire lock if already locked', () => {
      lock.acquire('job1');
      expect(lock.acquire('job1')).toBe(false);
    });

    it('should allow acquiring locks for different jobs', () => {
      expect(lock.acquire('job1')).toBe(true);
      expect(lock.acquire('job2')).toBe(true);
    });
  });

  describe('release()', () => {
    it('should release held lock', () => {
      lock.acquire('job1');
      expect(lock.release('job1')).toBe(true);
    });

    it('should return false for non-existent lock', () => {
      expect(lock.release('nonexistent')).toBe(false);
    });

    it('should allow re-acquiring after release', () => {
      lock.acquire('job1');
      lock.release('job1');
      expect(lock.acquire('job1')).toBe(true);
    });
  });

  describe('isLocked()', () => {
    it('should return false for unlocked job', () => {
      expect(lock.isLocked('job1')).toBe(false);
    });

    it('should return true for locked job', () => {
      lock.acquire('job1');
      expect(lock.isLocked('job1')).toBe(true);
    });

    it('should return false after release', () => {
      lock.acquire('job1');
      lock.release('job1');
      expect(lock.isLocked('job1')).toBe(false);
    });
  });

  describe('timeout', () => {
    it('should expire lock after timeout', async () => {
      const lockWithTimeout = new JobLock(50); // 50ms timeout
      lockWithTimeout.acquire('job1');

      expect(lockWithTimeout.isLocked('job1')).toBe(true);

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(lockWithTimeout.isLocked('job1')).toBe(false);
    });

    it('should allow per-lock timeout override', async () => {
      lock.acquire('job1', 50); // 50ms timeout

      expect(lock.isLocked('job1')).toBe(true);

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(lock.isLocked('job1')).toBe(false);
    });
  });

  describe('getLockInfo()', () => {
    it('should return null for unlocked job', () => {
      expect(lock.getLockInfo('job1')).toBeNull();
    });

    it('should return lock info for locked job', () => {
      lock.acquire('job1');
      const info = lock.getLockInfo('job1');

      expect(info).not.toBeNull();
      expect(info!.jobId).toBe('job1');
      expect(info!.acquiredAt).toBeInstanceOf(Date);
    });
  });

  describe('getAllLocks()', () => {
    it('should return empty array when no locks', () => {
      expect(lock.getAllLocks()).toHaveLength(0);
    });

    it('should return all active locks', () => {
      lock.acquire('job1');
      lock.acquire('job2');

      const locks = lock.getAllLocks();
      expect(locks).toHaveLength(2);
      expect(locks.map((l) => l.jobId)).toContain('job1');
      expect(locks.map((l) => l.jobId)).toContain('job2');
    });
  });

  describe('releaseAll()', () => {
    it('should release all locks', () => {
      lock.acquire('job1');
      lock.acquire('job2');
      lock.acquire('job3');

      lock.releaseAll();

      expect(lock.size).toBe(0);
      expect(lock.isLocked('job1')).toBe(false);
      expect(lock.isLocked('job2')).toBe(false);
      expect(lock.isLocked('job3')).toBe(false);
    });
  });

  describe('size', () => {
    it('should return 0 when no locks', () => {
      expect(lock.size).toBe(0);
    });

    it('should return count of active locks', () => {
      lock.acquire('job1');
      lock.acquire('job2');
      expect(lock.size).toBe(2);

      lock.release('job1');
      expect(lock.size).toBe(1);
    });
  });

  describe('withLock()', () => {
    it('should execute function with lock', async () => {
      let executed = false;

      await lock.withLock('job1', async () => {
        executed = true;
        expect(lock.isLocked('job1')).toBe(true);
      });

      expect(executed).toBe(true);
      expect(lock.isLocked('job1')).toBe(false);
    });

    it('should release lock even on error', async () => {
      try {
        await lock.withLock('job1', async () => {
          throw new Error('Test error');
        });
      } catch {
        // Expected
      }

      expect(lock.isLocked('job1')).toBe(false);
    });

    it('should throw if lock cannot be acquired', async () => {
      lock.acquire('job1');

      await expect(lock.withLock('job1', async () => {})).rejects.toThrow('Failed to acquire lock');
    });

    it('should return function result', async () => {
      const result = await lock.withLock('job1', async () => {
        return 'success';
      });

      expect(result).toBe('success');
    });
  });
});
