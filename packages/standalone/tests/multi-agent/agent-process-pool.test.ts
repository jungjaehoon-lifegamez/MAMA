/**
 * Tests for Agent Process Pool
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AgentProcessPool,
  type AgentProcessPoolOptions,
  type PoolStatus,
} from '../../src/multi-agent/agent-process-pool.js';
import type { PersistentClaudeProcess } from '../../src/agent/persistent-cli-process.js';

describe('AgentProcessPool', () => {
  let pool: AgentProcessPool;
  let mockProcessFactory: ReturnType<typeof vi.fn>;

  // Helper to create mock PersistentClaudeProcess
  const createMockProcess = (ready = true, alive = true): PersistentClaudeProcess => {
    return {
      isReady: vi.fn().mockReturnValue(ready),
      isAlive: vi.fn().mockReturnValue(alive),
      stop: vi.fn(),
      sendMessage: vi.fn(),
      getState: vi.fn().mockReturnValue(ready ? 'idle' : 'busy'),
    } as unknown as PersistentClaudeProcess;
  };

  beforeEach(() => {
    mockProcessFactory = vi.fn();
  });

  describe('constructor', () => {
    it('should use default values', () => {
      pool = new AgentProcessPool();

      expect(pool.getPoolSize('developer')).toBe(1); // defaultPoolSize = 1
    });

    it('should accept custom defaultPoolSize', () => {
      pool = new AgentProcessPool({
        defaultPoolSize: 3,
      });

      expect(pool.getPoolSize('developer')).toBe(3);
    });

    it('should accept agentPoolSizes overrides', () => {
      pool = new AgentProcessPool({
        defaultPoolSize: 2,
        agentPoolSizes: {
          developer: 5,
          tester: 3,
        },
      });

      expect(pool.getPoolSize('developer')).toBe(5);
      expect(pool.getPoolSize('tester')).toBe(3);
      expect(pool.getPoolSize('reviewer')).toBe(2); // fallback to default
    });

    it('should accept custom idleTimeoutMs', () => {
      pool = new AgentProcessPool({
        idleTimeoutMs: 300000, // 5 minutes
      });

      // Timeout is internal, we'll test it via cleanupIdleProcesses()
      expect(pool).toBeDefined();
    });
  });

  describe('getAvailableProcess()', () => {
    it('should create new process when pool is empty (isNew=true)', async () => {
      pool = new AgentProcessPool({ defaultPoolSize: 3 });
      const mockProcess = createMockProcess();
      mockProcessFactory.mockResolvedValue(mockProcess);

      const result = await pool.getAvailableProcess('developer', 'channel-1', mockProcessFactory);

      expect(result.isNew).toBe(true);
      expect(result.process).toBe(mockProcess);
      expect(mockProcessFactory).toHaveBeenCalledOnce();

      const status = pool.getPoolStatus('developer');
      expect(status.total).toBe(1);
      expect(status.busy).toBe(1);
      expect(status.idle).toBe(0);
    });

    it('should reuse idle process when available (isNew=false)', async () => {
      pool = new AgentProcessPool({ defaultPoolSize: 3 });
      const mockProcess = createMockProcess();
      mockProcessFactory.mockResolvedValue(mockProcess);

      // Get process
      const first = await pool.getAvailableProcess('developer', 'channel-1', mockProcessFactory);
      expect(first.isNew).toBe(true);

      // Release it
      pool.releaseProcess('developer', first.process);

      // Get again - should reuse
      const second = await pool.getAvailableProcess('developer', 'channel-1', mockProcessFactory);
      expect(second.isNew).toBe(false);
      expect(second.process).toBe(first.process);
      expect(mockProcessFactory).toHaveBeenCalledOnce(); // Only called once
    });

    it('should create new process when all existing are busy (within pool limit)', async () => {
      pool = new AgentProcessPool({ defaultPoolSize: 3 });
      const mockProcess1 = createMockProcess();
      const mockProcess2 = createMockProcess();

      mockProcessFactory.mockResolvedValueOnce(mockProcess1).mockResolvedValueOnce(mockProcess2);

      // Get first process
      const first = await pool.getAvailableProcess('developer', 'channel-1', mockProcessFactory);
      expect(first.isNew).toBe(true);
      expect(first.process).toBe(mockProcess1);

      // Don't release - get second (should create new)
      const second = await pool.getAvailableProcess('developer', 'channel-2', mockProcessFactory);
      expect(second.isNew).toBe(true);
      expect(second.process).toBe(mockProcess2);
      expect(mockProcessFactory).toHaveBeenCalledTimes(2);

      const status = pool.getPoolStatus('developer');
      expect(status.total).toBe(2);
      expect(status.busy).toBe(2);
    });

    it('should throw error when pool is full (all busy)', async () => {
      pool = new AgentProcessPool({ defaultPoolSize: 2 });
      const mockProcess1 = createMockProcess();
      const mockProcess2 = createMockProcess();

      mockProcessFactory.mockResolvedValueOnce(mockProcess1).mockResolvedValueOnce(mockProcess2);

      // Fill pool
      await pool.getAvailableProcess('developer', 'channel-1', mockProcessFactory);
      await pool.getAvailableProcess('developer', 'channel-2', mockProcessFactory);

      // Try to get third (pool full)
      await expect(
        pool.getAvailableProcess('developer', 'channel-3', mockProcessFactory)
      ).rejects.toThrow('[AgentProcessPool] Pool full for agent developer (2/2 busy)');
    });

    it('should skip non-ready processes when finding idle', async () => {
      pool = new AgentProcessPool({ defaultPoolSize: 3 });
      const mockProcess1 = createMockProcess(false); // not ready
      const mockProcess2 = createMockProcess(true); // ready

      mockProcessFactory.mockResolvedValueOnce(mockProcess1).mockResolvedValueOnce(mockProcess2);

      // Get first process
      const first = await pool.getAvailableProcess('developer', 'channel-1', mockProcessFactory);
      pool.releaseProcess('developer', first.process);

      // Mark first as not ready (busy state)
      mockProcess1.isReady.mockReturnValue(false);

      // Get second - should create new instead of reusing first
      const second = await pool.getAvailableProcess('developer', 'channel-2', mockProcessFactory);
      expect(second.isNew).toBe(true);
      expect(second.process).toBe(mockProcess2);
    });
  });

  describe('releaseProcess()', () => {
    it('should mark process as idle (busy=false)', async () => {
      pool = new AgentProcessPool({ defaultPoolSize: 3 });
      const mockProcess = createMockProcess();
      mockProcessFactory.mockResolvedValue(mockProcess);

      const result = await pool.getAvailableProcess('developer', 'channel-1', mockProcessFactory);
      expect(pool.getPoolStatus('developer').busy).toBe(1);

      pool.releaseProcess('developer', result.process);

      const status = pool.getPoolStatus('developer');
      expect(status.busy).toBe(0);
      expect(status.idle).toBe(1);
    });

    it('should ignore release for process not in pool', () => {
      pool = new AgentProcessPool();
      const mockProcess = createMockProcess();

      // Should not throw
      expect(() => pool.releaseProcess('developer', mockProcess)).not.toThrow();
    });

    it('should ignore release when pool does not exist for agent', () => {
      pool = new AgentProcessPool();
      const mockProcess = createMockProcess();

      // Should not throw
      expect(() => pool.releaseProcess('nonexistent', mockProcess)).not.toThrow();
    });
  });

  describe('getPoolStatus()', () => {
    it('should return { total: 0, busy: 0, idle: 0 } for empty pool', () => {
      pool = new AgentProcessPool();

      const status = pool.getPoolStatus('developer');

      expect(status).toEqual({ total: 0, busy: 0, idle: 0 });
    });

    it('should return accurate counts', async () => {
      pool = new AgentProcessPool({ defaultPoolSize: 5 });
      const mockProcess1 = createMockProcess();
      const mockProcess2 = createMockProcess();
      const mockProcess3 = createMockProcess();

      mockProcessFactory
        .mockResolvedValueOnce(mockProcess1)
        .mockResolvedValueOnce(mockProcess2)
        .mockResolvedValueOnce(mockProcess3);

      // Get 3 processes
      const p1 = await pool.getAvailableProcess('developer', 'ch-1', mockProcessFactory);
      const p2 = await pool.getAvailableProcess('developer', 'ch-2', mockProcessFactory);
      const p3 = await pool.getAvailableProcess('developer', 'ch-3', mockProcessFactory);

      // All busy
      expect(pool.getPoolStatus('developer')).toEqual({ total: 3, busy: 3, idle: 0 });

      // Release one
      pool.releaseProcess('developer', p1.process);
      expect(pool.getPoolStatus('developer')).toEqual({ total: 3, busy: 2, idle: 1 });

      // Release all
      pool.releaseProcess('developer', p2.process);
      pool.releaseProcess('developer', p3.process);
      expect(pool.getPoolStatus('developer')).toEqual({ total: 3, busy: 0, idle: 3 });
    });
  });

  describe('getPoolSize()', () => {
    it('should return defaultPoolSize when no override', () => {
      pool = new AgentProcessPool({ defaultPoolSize: 2 });

      expect(pool.getPoolSize('developer')).toBe(2);
    });

    it('should return agentPoolSizes override when specified', () => {
      pool = new AgentProcessPool({
        defaultPoolSize: 2,
        agentPoolSizes: {
          developer: 10,
        },
      });

      expect(pool.getPoolSize('developer')).toBe(10);
      expect(pool.getPoolSize('tester')).toBe(2);
    });
  });

  describe('stopAgent()', () => {
    it('should stop all processes for a specific agent', async () => {
      pool = new AgentProcessPool({ defaultPoolSize: 3 });
      const mockProcess1 = createMockProcess();
      const mockProcess2 = createMockProcess();

      mockProcessFactory.mockResolvedValueOnce(mockProcess1).mockResolvedValueOnce(mockProcess2);

      await pool.getAvailableProcess('developer', 'ch-1', mockProcessFactory);
      await pool.getAvailableProcess('developer', 'ch-2', mockProcessFactory);

      pool.stopAgent('developer');

      expect(mockProcess1.stop).toHaveBeenCalledOnce();
      expect(mockProcess2.stop).toHaveBeenCalledOnce();
      expect(pool.getPoolStatus('developer')).toEqual({ total: 0, busy: 0, idle: 0 });
    });

    it('should not throw when stopping nonexistent agent', () => {
      pool = new AgentProcessPool();

      expect(() => pool.stopAgent('nonexistent')).not.toThrow();
    });
  });

  describe('stopAll()', () => {
    it('should stop all processes in all pools', async () => {
      pool = new AgentProcessPool({ defaultPoolSize: 3 });
      const mockProcessDev = createMockProcess();
      const mockProcessTest = createMockProcess();

      mockProcessFactory
        .mockResolvedValueOnce(mockProcessDev)
        .mockResolvedValueOnce(mockProcessTest);

      await pool.getAvailableProcess('developer', 'ch-1', mockProcessFactory);
      await pool.getAvailableProcess('tester', 'ch-2', mockProcessFactory);

      pool.stopAll();

      expect(mockProcessDev.stop).toHaveBeenCalledOnce();
      expect(mockProcessTest.stop).toHaveBeenCalledOnce();
      expect(pool.getPoolStatus('developer')).toEqual({ total: 0, busy: 0, idle: 0 });
      expect(pool.getPoolStatus('tester')).toEqual({ total: 0, busy: 0, idle: 0 });
    });

    it('should not throw when no pools exist', () => {
      pool = new AgentProcessPool();

      expect(() => pool.stopAll()).not.toThrow();
    });
  });

  describe('cleanupIdleProcesses()', () => {
    it('should remove idle processes that exceeded timeout', async () => {
      pool = new AgentProcessPool({
        defaultPoolSize: 3,
        idleTimeoutMs: 100, // 100ms timeout
      });
      const mockProcess = createMockProcess();
      mockProcessFactory.mockResolvedValue(mockProcess);

      // Get and release process
      const result = await pool.getAvailableProcess('developer', 'ch-1', mockProcessFactory);
      pool.releaseProcess('developer', result.process);

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, 150));

      const cleaned = pool.cleanupIdleProcesses();

      expect(cleaned).toBe(1);
      expect(mockProcess.stop).toHaveBeenCalledOnce();
      expect(pool.getPoolStatus('developer')).toEqual({ total: 0, busy: 0, idle: 0 });
    });

    it('should keep processes that are still within timeout', async () => {
      pool = new AgentProcessPool({
        defaultPoolSize: 3,
        idleTimeoutMs: 10000, // 10 seconds
      });
      const mockProcess = createMockProcess();
      mockProcessFactory.mockResolvedValue(mockProcess);

      // Get and release process
      const result = await pool.getAvailableProcess('developer', 'ch-1', mockProcessFactory);
      pool.releaseProcess('developer', result.process);

      // Immediate cleanup (within timeout)
      const cleaned = pool.cleanupIdleProcesses();

      expect(cleaned).toBe(0);
      expect(mockProcess.stop).not.toHaveBeenCalled();
      expect(pool.getPoolStatus('developer')).toEqual({ total: 1, busy: 0, idle: 1 });
    });

    it('should not clean busy processes even if old', async () => {
      pool = new AgentProcessPool({
        defaultPoolSize: 3,
        idleTimeoutMs: 100,
      });
      const mockProcess = createMockProcess();
      mockProcessFactory.mockResolvedValue(mockProcess);

      // Get process (busy, don't release)
      await pool.getAvailableProcess('developer', 'ch-1', mockProcessFactory);

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, 150));

      const cleaned = pool.cleanupIdleProcesses();

      expect(cleaned).toBe(0);
      expect(mockProcess.stop).not.toHaveBeenCalled();
      expect(pool.getPoolStatus('developer')).toEqual({ total: 1, busy: 1, idle: 0 });
    });

    it('should return 0 when no processes to clean', () => {
      pool = new AgentProcessPool();

      const cleaned = pool.cleanupIdleProcesses();

      expect(cleaned).toBe(0);
    });

    it('should clean multiple idle processes across agents', async () => {
      pool = new AgentProcessPool({
        defaultPoolSize: 3,
        idleTimeoutMs: 100,
      });
      const mockProcessDev = createMockProcess();
      const mockProcessTest = createMockProcess();

      mockProcessFactory
        .mockResolvedValueOnce(mockProcessDev)
        .mockResolvedValueOnce(mockProcessTest);

      // Get and release for both agents
      const dev = await pool.getAvailableProcess('developer', 'ch-1', mockProcessFactory);
      const test = await pool.getAvailableProcess('tester', 'ch-2', mockProcessFactory);
      pool.releaseProcess('developer', dev.process);
      pool.releaseProcess('tester', test.process);

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, 150));

      const cleaned = pool.cleanupIdleProcesses();

      expect(cleaned).toBe(2);
      expect(mockProcessDev.stop).toHaveBeenCalledOnce();
      expect(mockProcessTest.stop).toHaveBeenCalledOnce();
    });
  });

  describe('backward compatibility (pool_size=1)', () => {
    it('should behave like single process when pool_size=1', async () => {
      pool = new AgentProcessPool({ defaultPoolSize: 1 });
      const mockProcess = createMockProcess();
      mockProcessFactory.mockResolvedValue(mockProcess);

      // Get process
      const first = await pool.getAvailableProcess('developer', 'ch-1', mockProcessFactory);
      expect(first.isNew).toBe(true);

      // Try to get second (pool full)
      await expect(
        pool.getAvailableProcess('developer', 'ch-2', mockProcessFactory)
      ).rejects.toThrow('Pool full');

      // Release and get again (should reuse)
      pool.releaseProcess('developer', first.process);
      const second = await pool.getAvailableProcess('developer', 'ch-3', mockProcessFactory);
      expect(second.isNew).toBe(false);
      expect(second.process).toBe(first.process);
    });
  });
});
