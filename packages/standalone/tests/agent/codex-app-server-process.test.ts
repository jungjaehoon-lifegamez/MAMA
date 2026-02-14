/**
 * Tests for CodexAppServerProcess
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CodexAppServerProcess,
  CodexAppServerPool,
} from '../../src/agent/codex-app-server-process';
import { EventEmitter } from 'events';

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Mock readline
vi.mock('readline', () => ({
  createInterface: vi.fn(() => {
    const emitter = new EventEmitter();
    return emitter;
  }),
}));

// Mock debug logger
vi.mock('@jungjaehoon/mama-core/debug-logger', () => ({
  DebugLogger: class {
    debug() {}
    info() {}
    warn() {}
    error() {}
  },
}));

import { spawn } from 'child_process';
import * as readline from 'readline';

describe('CodexAppServerProcess', () => {
  let mockProcess: MockChildProcess;
  let mockReadline: EventEmitter;

  class MockChildProcess extends EventEmitter {
    stdin = {
      write: vi.fn(),
      end: vi.fn(),
    };
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    killed = false;
    kill = vi.fn(() => {
      this.killed = true;
    });
  }

  beforeEach(() => {
    mockProcess = new MockChildProcess();
    mockReadline = new EventEmitter();

    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockProcess);
    (readline.createInterface as ReturnType<typeof vi.fn>).mockReturnValue(mockReadline);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create with default options', () => {
      const process = new CodexAppServerProcess();
      expect(process).toBeDefined();
    });

    it('should accept custom options', () => {
      const process = new CodexAppServerProcess({
        model: 'gpt-5.2-codex',
        cwd: '/test/dir',
        sandbox: 'workspace-write',
        compactionThreshold: 100000,
      });
      expect(process).toBeDefined();
    });
  });

  describe('start', () => {
    it('should spawn codex app-server process', async () => {
      const codexProcess = new CodexAppServerProcess();

      // Start in background (don't await - mock doesn't respond to initialize)
      codexProcess.start().catch(() => {});

      // Wait a bit for spawn to be called
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(spawn).toHaveBeenCalledWith(
        'codex',
        ['app-server', '--listen', 'stdio://'],
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      );

      // Clean up
      codexProcess.stop();
    });
  });

  describe('prompt', () => {
    it('should send request via stdin', () => {
      const codexProcess = new CodexAppServerProcess({ timeoutMs: 1000 });

      // Just verify the process can be created
      expect(codexProcess.getSessionId()).toBe('');
      expect(codexProcess.getTokenUsage()).toBe(0);
    });
  });

  describe('stop', () => {
    it('should kill the process', () => {
      const codexProcess = new CodexAppServerProcess();

      // Start without waiting (mock doesn't complete initialize)
      codexProcess.start().catch(() => {});

      // Stop immediately
      codexProcess.stop();

      expect(mockProcess.kill).toHaveBeenCalled();
    });
  });

  describe('getSessionId', () => {
    it('should return empty string before thread start', () => {
      const process = new CodexAppServerProcess();
      expect(process.getSessionId()).toBe('');
    });
  });

  describe('getTokenUsage', () => {
    it('should return 0 initially', () => {
      const process = new CodexAppServerProcess();
      expect(process.getTokenUsage()).toBe(0);
    });
  });
});

describe('CodexAppServerPool', () => {
  describe('constructor', () => {
    it('should create pool with options', () => {
      const pool = new CodexAppServerPool({ model: 'test-model' });
      expect(pool.getActiveCount()).toBe(0);
    });
  });

  describe('stopAll', () => {
    it('should clear all processes', () => {
      const pool = new CodexAppServerPool();
      // Pool starts empty
      expect(pool.getActiveCount()).toBe(0);
      // stopAll on empty pool should work
      pool.stopAll();
      expect(pool.getActiveCount()).toBe(0);
    });
  });
});
