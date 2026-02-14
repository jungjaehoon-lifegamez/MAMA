/**
 * Tests for PostToolUse Hook
 *
 * Redesigned Feb 2025:
 * - Contract pattern detection (interface, typed function, API, etc.)
 * - No auto-save, just smart reminders
 * - Silent pass for general code modifications
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.join(__dirname, '../../scripts/posttooluse-hook.js');

// Helper to execute hook with stdin
function execHook(input, env = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', [SCRIPT_PATH], {
      env: { ...process.env, ...env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });

    child.on('close', (code) => {
      resolve({ exitCode: code, stdout, stderr });
    });

    if (input) {
      child.stdin.write(JSON.stringify(input));
    }
    child.stdin.end();
  });
}

describe('PostToolUse Hook (Redesigned Feb 2025)', () => {
  describe('Hook Structure', () => {
    it('should be executable script with shebang', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
    });

    it('should define CODE_TOOLS set', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      expect(content).toContain('CODE_TOOLS');
      expect(content).toContain('Edit');
      expect(content).toContain('Write');
    });

    it('should define CONTRACT_PATTERNS array', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      expect(content).toContain('CONTRACT_PATTERNS');
      expect(content).toContain('interface/type');
      expect(content).toContain('typed function');
    });
  });

  describe('Contract Pattern Detection', () => {
    it('should define interface/type pattern', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      expect(content).toContain('interface/type');
      // Pattern matches: export interface X or export type X
      expect(content).toContain('(interface|type)');
    });

    it('should define typed function pattern', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      expect(content).toContain('typed function');
    });

    it('should define API decorator patterns', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      expect(content).toContain('API decorator');
      expect(content).toContain('route handler');
    });

    it('should define expects/returns patterns', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      expect(content).toContain('expects clause');
      expect(content).toContain('returns clause');
    });

    it('should define Python patterns', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      expect(content).toContain('typed Python function');
      expect(content).toContain('Python class');
    });

    it('should define Go patterns', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      expect(content).toContain('Go type');
      expect(content).toContain('Go method');
    });
  });

  describe('File Filtering', () => {
    it('should define CODE_EXTENSIONS', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      expect(content).toContain('CODE_EXTENSIONS');
      expect(content).toContain('.ts');
      expect(content).toContain('.js');
      expect(content).toContain('.py');
    });

    it('should define SKIP_PATTERNS', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      expect(content).toContain('SKIP_PATTERNS');
      expect(content).toContain('.md');
      expect(content).toContain('.json');
      expect(content).toContain('test');
    });

    it('should implement shouldProcessFile function', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      expect(content).toContain('shouldProcessFile');
      expect(content).toContain('path.extname');
    });
  });

  describe('Integration Tests', () => {
    it('should exit silently for non-code tools', async () => {
      const result = await execHook({
        tool_name: 'Read',
        tool_input: { file_path: '/path/to/test.js' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });

    it('should exit silently for non-code files', async () => {
      const result = await execHook({
        tool_name: 'Edit',
        tool_input: { file_path: '/path/to/README.md' },
      });

      expect(result.exitCode).toBe(0);
    });

    it('should exit silently when no contract patterns found', async () => {
      const result = await execHook({
        tool_name: 'Edit',
        tool_input: {
          file_path: '/path/to/test.js',
          new_string: 'console.log("hello");',
        },
      });

      expect(result.exitCode).toBe(0);
    });

    it('should detect interface pattern and prompt', async () => {
      const result = await execHook({
        tool_name: 'Write',
        tool_input: {
          file_path: '/path/to/types.ts',
          content: 'export interface UserProfile { id: string; name: string; }',
        },
      });

      expect(result.exitCode).toBe(2); // Uses exit(2) for visibility
      expect(result.stderr).toContain('Contract patterns detected');
      expect(result.stderr).toContain('interface/type');
    });

    it('should detect typed function pattern', async () => {
      const result = await execHook({
        tool_name: 'Edit',
        tool_input: {
          file_path: '/path/to/api.ts',
          new_string: 'export async function getUser(id: string): Promise<User> {',
        },
      });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Contract patterns detected');
      expect(result.stderr).toContain('typed function');
    });

    it('should detect expects clause pattern', async () => {
      const result = await execHook({
        tool_name: 'Edit',
        tool_input: {
          file_path: '/path/to/contract.ts',
          new_string: '// expects: { userId: string, data: object }',
        },
      });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('expects clause');
    });

    it('should suggest /mama:decision for saving', async () => {
      const result = await execHook({
        tool_name: 'Write',
        tool_input: {
          file_path: '/path/to/types.ts',
          content: 'export type Config = { key: string; value: any; }',
        },
      });

      expect(result.stderr).toContain('/mama:decision');
    });
  });

  describe('Performance', () => {
    it('should execute quickly without DB calls', async () => {
      const start = Date.now();

      await execHook({
        tool_name: 'Edit',
        tool_input: {
          file_path: '/path/to/test.js',
          new_string: 'const x = 1;',
        },
      });

      const elapsed = Date.now() - start;
      // Should be very fast (<100ms) since no embedding/DB calls
      expect(elapsed).toBeLessThan(500);
    });
  });
});
