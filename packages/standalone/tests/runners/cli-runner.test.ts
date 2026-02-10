/**
 * CLI Runner Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CliRunner } from '../../src/runners/cli-runner.js';

// Mock child_process with proper structure
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn(),
    exec: actual.exec,
  };
});

import { execSync } from 'child_process';

const mockExecSync = vi.mocked(execSync);

describe('CliRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should use default config', () => {
      const runner = new CliRunner();
      expect(runner.type).toBe('cli');
    });

    it('should accept custom config', () => {
      const runner = new CliRunner({
        command: 'custom-cli',
        args: ['--custom'],
        timeoutMs: 60000,
      });
      expect(runner.type).toBe('cli');
    });
  });

  describe('run', () => {
    it('should execute CLI and parse JSON response', async () => {
      mockExecSync.mockReturnValue(
        JSON.stringify({
          result: 'Hello!',
          session_id: 'test-session',
          usage: { input_tokens: 10, output_tokens: 5 },
        })
      );

      const runner = new CliRunner();
      const result = await runner.run('Hello');

      expect(mockExecSync).toHaveBeenCalled();
      expect(result.text).toBe('Hello!');
      expect(result.sessionId).toBe('test-session');
      expect(result.usage?.inputTokens).toBe(10);
      expect(result.usage?.outputTokens).toBe(5);
    });

    it('should include model argument when specified', async () => {
      mockExecSync.mockReturnValue(JSON.stringify({ result: 'Response' }));

      const runner = new CliRunner();
      await runner.run('Hello', { model: 'opus' });

      const call = mockExecSync.mock.calls[0][0] as string;
      expect(call).toContain('--model');
      expect(call).toContain('opus');
    });

    it('should include session ID when specified', async () => {
      mockExecSync.mockReturnValue(JSON.stringify({ result: 'Response' }));

      const runner = new CliRunner();
      await runner.run('Hello', { sessionId: 'my-session' });

      const call = mockExecSync.mock.calls[0][0] as string;
      expect(call).toContain('--session-id');
      expect(call).toContain('my-session');
    });

    it('should include system prompt when specified', async () => {
      mockExecSync.mockReturnValue(JSON.stringify({ result: 'Response' }));

      const runner = new CliRunner();
      await runner.run('Hello', { systemPrompt: 'Be helpful' });

      const call = mockExecSync.mock.calls[0][0] as string;
      expect(call).toContain('--append-system-prompt');
    });

    it('should throw on CLI error', async () => {
      const error = new Error('CLI failed') as Error & { status: number; stderr: string };
      error.status = 1;
      error.stderr = 'Error occurred';
      mockExecSync.mockImplementation(() => {
        throw error;
      });

      const runner = new CliRunner();
      await expect(runner.run('Hello')).rejects.toThrow('Error occurred');
    });

    it('should handle non-JSON output gracefully', async () => {
      mockExecSync.mockReturnValue('Plain text response');

      const runner = new CliRunner();
      const result = await runner.run('Hello');

      expect(result.text).toBe('Plain text response');
      expect(result.sessionId).toBeUndefined();
    });

    it('should resolve model aliases', async () => {
      mockExecSync.mockReturnValue(JSON.stringify({ result: 'Response' }));

      const runner = new CliRunner({
        modelAliases: { best: 'claude-opus-4' },
      });
      await runner.run('Hello', { model: 'best' });

      const call = mockExecSync.mock.calls[0][0] as string;
      expect(call).toContain('--model');
      expect(call).toContain('claude-opus-4');
    });
  });

  describe('parseOutput', () => {
    it('should parse result field', async () => {
      mockExecSync.mockReturnValue(JSON.stringify({ result: 'Hello!' }));

      const runner = new CliRunner();
      const result = await runner.run('Hi');
      expect(result.text).toBe('Hello!');
    });

    it('should parse response field', async () => {
      mockExecSync.mockReturnValue(JSON.stringify({ response: 'Hello!' }));

      const runner = new CliRunner();
      const result = await runner.run('Hi');
      expect(result.text).toBe('Hello!');
    });

    it('should parse text field', async () => {
      mockExecSync.mockReturnValue(JSON.stringify({ text: 'Hello!' }));

      const runner = new CliRunner();
      const result = await runner.run('Hi');
      expect(result.text).toBe('Hello!');
    });

    it('should parse conversation_id as sessionId', async () => {
      mockExecSync.mockReturnValue(
        JSON.stringify({
          result: 'Hello!',
          conversation_id: 'conv-123',
        })
      );

      const runner = new CliRunner();
      const result = await runner.run('Hi');
      expect(result.sessionId).toBe('conv-123');
    });
  });

  describe('timeout', () => {
    it('should throw on timeout', async () => {
      const error = new Error('ETIMEDOUT') as Error & { killed: boolean };
      error.killed = true;
      mockExecSync.mockImplementation(() => {
        throw error;
      });

      const runner = new CliRunner({ timeoutMs: 50 });
      await expect(runner.run('Hello')).rejects.toThrow('timeout');
    });
  });
});

describe('CliRunner.isAvailable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return true when CLI is available', async () => {
    mockExecSync.mockReturnValue('Claude Code CLI v1.0.0');

    const available = await CliRunner.isAvailable();
    expect(available).toBe(true);
  });

  it('should return false when CLI is not available', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });

    const available = await CliRunner.isAvailable();
    expect(available).toBe(false);
  });
});

describe('CliRunner.getVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return version string', async () => {
    mockExecSync.mockReturnValue('Claude Code CLI v1.0.0\n');

    const version = await CliRunner.getVersion();
    expect(version).toBe('Claude Code CLI v1.0.0');
  });

  it('should return null on error', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });

    const version = await CliRunner.getVersion();
    expect(version).toBeNull();
  });
});
