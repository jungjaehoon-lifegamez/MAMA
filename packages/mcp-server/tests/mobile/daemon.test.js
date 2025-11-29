/**
 * @fileoverview Tests for ClaudeDaemon class
 * @module tests/mobile/daemon.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

const { spawn } = await import('child_process');
const { ClaudeDaemon, ANSI_REGEX } = await import('../../src/mobile/daemon.js');

describe('ClaudeDaemon', () => {
  let daemon;
  let mockProcess;
  let mockStdin;
  let mockStdout;
  let mockStderr;

  beforeEach(() => {
    // Create mock streams
    mockStdin = {
      write: vi.fn(),
    };
    mockStdout = new EventEmitter();
    mockStderr = new EventEmitter();

    // Create mock process
    mockProcess = new EventEmitter();
    mockProcess.stdin = mockStdin;
    mockProcess.stdout = mockStdout;
    mockProcess.stderr = mockStderr;
    mockProcess.pid = 12345;
    mockProcess.kill = vi.fn();

    spawn.mockReturnValue(mockProcess);

    daemon = new ClaudeDaemon('/test/project', 'session_test');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with projectDir and sessionId', () => {
      expect(daemon.projectDir).toBe('/test/project');
      expect(daemon.sessionId).toBe('session_test');
      expect(daemon.process).toBeNull();
      expect(daemon.pid).toBeNull();
      expect(daemon.isRunning).toBe(false);
    });

    it('should extend EventEmitter', () => {
      expect(daemon).toBeInstanceOf(EventEmitter);
    });
  });

  describe('spawn()', () => {
    it('should spawn claude with correct arguments', async () => {
      daemon.spawn();

      // Simulate successful spawn
      await vi.waitFor(() => expect(spawn).toHaveBeenCalled());

      expect(spawn).toHaveBeenCalledWith(
        'claude',
        ['--dangerously-skip-permissions'],
        expect.objectContaining({
          cwd: '/test/project',
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
        })
      );
    });

    it('should store process PID', async () => {
      daemon.spawn();

      await vi.waitFor(() => {
        expect(daemon.pid).toBe(12345);
      });
    });

    it('should set isRunning to true', async () => {
      daemon.spawn();

      await vi.waitFor(() => {
        expect(daemon.isRunning).toBe(true);
      });
    });

    it('should throw if already running', async () => {
      daemon.isRunning = true;

      await expect(daemon.spawn()).rejects.toThrow('Daemon is already running');
    });

    it('should emit error on spawn failure', async () => {
      const errorHandler = vi.fn();
      daemon.on('error', errorHandler);

      spawn.mockImplementation(() => {
        throw new Error('Spawn failed');
      });

      await expect(daemon.spawn()).rejects.toThrow('Spawn failed');
      expect(errorHandler).toHaveBeenCalled();
    });
  });

  describe('send()', () => {
    beforeEach(async () => {
      daemon.spawn();
      await vi.waitFor(() => expect(daemon.isRunning).toBe(true));
    });

    it('should write message with newline to stdin', () => {
      daemon.send('Hello Claude');

      expect(mockStdin.write).toHaveBeenCalledWith('Hello Claude\n');
    });

    it('should not add extra newline if message already ends with one', () => {
      daemon.send('Hello Claude\n');

      expect(mockStdin.write).toHaveBeenCalledWith('Hello Claude\n');
    });

    it('should throw if daemon is not running', () => {
      daemon.isRunning = false;

      expect(() => daemon.send('test')).toThrow('Daemon is not running');
    });
  });

  describe('stdout handling', () => {
    beforeEach(async () => {
      daemon.spawn();
      await vi.waitFor(() => expect(daemon.isRunning).toBe(true));
    });

    it('should emit output event on stdout data', () => {
      const outputHandler = vi.fn();
      daemon.on('output', outputHandler);

      mockStdout.emit('data', Buffer.from('Hello from Claude'));

      expect(outputHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'stdout',
          text: 'Hello from Claude',
          sessionId: 'session_test',
        })
      );
    });

    it('should strip ANSI escape codes', () => {
      const outputHandler = vi.fn();
      daemon.on('output', outputHandler);

      // Text with ANSI color codes
      mockStdout.emit('data', Buffer.from('\x1b[32mColored\x1b[0m text'));

      expect(outputHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Colored text',
        })
      );
    });

    it('should include raw text with ANSI codes', () => {
      const outputHandler = vi.fn();
      daemon.on('output', outputHandler);

      const rawText = '\x1b[32mColored\x1b[0m text';
      mockStdout.emit('data', Buffer.from(rawText));

      expect(outputHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          raw: rawText,
        })
      );
    });
  });

  describe('kill()', () => {
    beforeEach(async () => {
      daemon.spawn();
      await vi.waitFor(() => expect(daemon.isRunning).toBe(true));
    });

    it('should call process.kill with SIGTERM by default', () => {
      daemon.kill();

      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('should call process.kill with custom signal', () => {
      daemon.kill('SIGKILL');

      expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('should set isRunning to false', () => {
      daemon.kill();

      expect(daemon.isRunning).toBe(false);
    });

    it('should emit exit event', () => {
      const exitHandler = vi.fn();
      daemon.on('exit', exitHandler);

      daemon.kill();

      expect(exitHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          signal: 'SIGTERM',
          sessionId: 'session_test',
          manual: true,
        })
      );
    });

    it('should handle no process gracefully', () => {
      daemon.process = null;

      expect(() => daemon.kill()).not.toThrow();
    });
  });

  describe('ANSI_REGEX', () => {
    it('should match common ANSI escape codes', () => {
      expect('\x1b[32m'.replace(ANSI_REGEX, '')).toBe('');
      expect('\x1b[0m'.replace(ANSI_REGEX, '')).toBe('');
      expect('\x1b[1;31m'.replace(ANSI_REGEX, '')).toBe('');
    });

    it('should preserve non-ANSI text', () => {
      expect('Hello World'.replace(ANSI_REGEX, '')).toBe('Hello World');
    });
  });

  describe('isActive()', () => {
    it('should return false when not running', () => {
      expect(daemon.isActive()).toBe(false);
    });

    it('should return true when running', async () => {
      daemon.spawn();
      await vi.waitFor(() => expect(daemon.isRunning).toBe(true));

      expect(daemon.isActive()).toBe(true);
    });
  });

  describe('getPid()', () => {
    it('should return null when not spawned', () => {
      expect(daemon.getPid()).toBeNull();
    });

    it('should return PID when spawned', async () => {
      daemon.spawn();
      await vi.waitFor(() => expect(daemon.pid).toBe(12345));

      expect(daemon.getPid()).toBe(12345);
    });
  });
});
