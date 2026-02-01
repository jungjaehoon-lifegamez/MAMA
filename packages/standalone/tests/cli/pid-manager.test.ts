/**
 * Unit tests for PIDManager
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  writePid,
  readPid,
  deletePid,
  isProcessRunning,
  isDaemonRunning,
  getUptime,
  pidFileExists,
} from '../../src/cli/utils/pid-manager.js';

describe('PIDManager', () => {
  let testDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    // Create temp directory with random suffix to avoid collisions
    testDir = join(tmpdir(), `mama-pid-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });

    // Save and override HOME
    originalHome = process.env.HOME;
    process.env.HOME = testDir;
  });

  afterEach(async () => {
    // Restore HOME
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }

    // Clean up
    await rm(testDir, { recursive: true, force: true });
  });

  describe('writePid() and readPid()', () => {
    it('should write and read PID info', async () => {
      const pid = 12345;
      const beforeWrite = Date.now();

      await writePid(pid);

      const info = await readPid();
      expect(info).not.toBeNull();
      expect(info!.pid).toBe(pid);
      expect(info!.startedAt).toBeGreaterThanOrEqual(beforeWrite);
      expect(info!.startedAt).toBeLessThanOrEqual(Date.now());
    });

    it('should create directory if not exists', async () => {
      await writePid(12345);

      const pidDir = join(testDir, '.mama');
      expect(existsSync(pidDir)).toBe(true);
    });

    it('should return null if PID file not found', async () => {
      const info = await readPid();
      expect(info).toBeNull();
    });

    it('should handle legacy format (just PID number)', async () => {
      const mamaDir = join(testDir, '.mama');
      await mkdir(mamaDir, { recursive: true });
      await writeFile(join(mamaDir, 'mama.pid'), '54321');

      const info = await readPid();
      expect(info).not.toBeNull();
      expect(info!.pid).toBe(54321);
    });
  });

  describe('deletePid()', () => {
    it('should delete PID file', async () => {
      await writePid(12345);
      expect(pidFileExists()).toBe(true);

      await deletePid();
      expect(pidFileExists()).toBe(false);
    });

    it('should not throw if PID file not found', async () => {
      await expect(deletePid()).resolves.not.toThrow();
    });
  });

  describe('pidFileExists()', () => {
    it('should return false when no PID file', () => {
      expect(pidFileExists()).toBe(false);
    });

    it('should return true when PID file exists', async () => {
      await writePid(12345);
      expect(pidFileExists()).toBe(true);
    });
  });

  describe('isProcessRunning()', () => {
    it('should return true for current process', () => {
      expect(isProcessRunning(process.pid)).toBe(true);
    });

    it('should return false for non-existent PID', () => {
      // Use a very high PID that's unlikely to exist
      expect(isProcessRunning(999999999)).toBe(false);
    });
  });

  describe('isDaemonRunning()', () => {
    it('should return null if no PID file', async () => {
      const info = await isDaemonRunning();
      expect(info).toBeNull();
    });

    it('should return info if daemon is running', async () => {
      // Write current process PID (which is running)
      await writePid(process.pid);

      const info = await isDaemonRunning();
      expect(info).not.toBeNull();
      expect(info!.pid).toBe(process.pid);
    });

    it('should clean up stale PID file', async () => {
      // Write a PID that doesn't exist
      await writePid(999999999);
      expect(pidFileExists()).toBe(true);

      // Check should clean up the stale file
      const info = await isDaemonRunning();
      expect(info).toBeNull();
      expect(pidFileExists()).toBe(false);
    });
  });

  describe('getUptime()', () => {
    it('should format seconds correctly', () => {
      const now = Date.now();
      const startedAt = now - 30000; // 30 seconds ago
      expect(getUptime(startedAt)).toBe('30초');
    });

    it('should format minutes correctly', () => {
      const now = Date.now();
      const startedAt = now - (5 * 60 + 30) * 1000; // 5 minutes 30 seconds ago
      expect(getUptime(startedAt)).toBe('5분 30초');
    });

    it('should format hours correctly', () => {
      const now = Date.now();
      const startedAt = now - (2 * 60 * 60 + 15 * 60) * 1000; // 2 hours 15 minutes ago
      expect(getUptime(startedAt)).toBe('2시간 15분');
    });

    it('should format days correctly', () => {
      const now = Date.now();
      const startedAt = now - (1 * 24 * 60 * 60 + 3 * 60 * 60) * 1000; // 1 day 3 hours ago
      expect(getUptime(startedAt)).toBe('1일 3시간');
    });
  });
});
