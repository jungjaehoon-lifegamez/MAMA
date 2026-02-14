/**
 * Tests for PostToolUse Hook
 *
 * Redesigned Feb 2026:
 * - Lightweight reminder for future Claude sessions
 * - No pattern detection - Claude decides what to save
 * - Shows on first edit only per session
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.join(__dirname, '../../scripts/posttooluse-hook.js');

const HOOK_TIMEOUT = 5000;

// Unique session dir for test isolation
let testSessionDir;

beforeEach(() => {
  testSessionDir = path.join(os.tmpdir(), `mama-sessions-test-${Date.now()}`);
});

afterEach(() => {
  if (testSessionDir && fs.existsSync(testSessionDir)) {
    fs.rmSync(testSessionDir, { recursive: true, force: true });
  }
});

function execHook(input, env = {}, sessionDir = null) {
  return new Promise((resolve) => {
    const child = spawn('node', [SCRIPT_PATH], {
      env: {
        ...process.env,
        MAMA_FORCE_TIER_3: 'true',
        ...(sessionDir ? { SESSION_DIR: sessionDir } : {}),
        ...env,
      },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      resolve({ exitCode: -1, stdout, stderr: stderr + '\n[TIMEOUT]', timedOut: true });
    }, HOOK_TIMEOUT);

    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        exitCode: -1,
        stdout,
        stderr: stderr + `\n[SPAWN_ERROR] ${err.message}`,
        spawnError: true,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (!timedOut) {
        resolve({ exitCode: code, stdout, stderr });
      }
    });

    if (input) {
      child.stdin.write(JSON.stringify(input));
    }
    child.stdin.end();
  });
}

describe('Story M2.3: PostToolUse Hook', () => {
  describe('Hook Structure', () => {
    it('should be executable script with shebang', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
    });

    it('should define CODE_TOOLS set for Edit/Write', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      expect(content).toContain('CODE_TOOLS');
      expect(content).toContain('Edit');
      expect(content).toContain('Write');
    });

    it('should use shared file-filter helper', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      expect(content).toContain('hook-file-filter');
      expect(content).toContain('shouldProcessFile');
    });

    it('should use session-state for first-edit tracking', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      expect(content).toContain('session-state');
      expect(content).toContain('isFirstEdit');
      expect(content).toContain('markFileEdited');
    });

    it('should have purpose-driven reminder message', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      expect(content).toContain('Reminder');
      expect(content).toContain('future Claude sessions');
      expect(content).toContain('/mama:decision');
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
    });

    it('should exit silently for non-code files', async () => {
      const result = await execHook({
        tool_name: 'Edit',
        tool_input: { file_path: '/path/to/README.md' },
      });

      expect(result.exitCode).toBe(0);
    });

    it('should execute quickly and show reminder on first edit', async () => {
      const start = Date.now();

      const result = await execHook(
        {
          tool_name: 'Edit',
          tool_input: {
            file_path: '/path/to/unique-test-file.js',
            new_string: 'const x = 1;',
          },
        },
        {},
        testSessionDir
      );

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(500);
      // Verify the reminder path was exercised (exit 2 + stderr contains reminder)
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Reminder');
    });
  });

  describe('Message Format', () => {
    it('should suggest including file paths in reasoning', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      expect(content).toContain('file paths in reasoning');
    });

    it('should be a lightweight hint, not intrusive', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
      // No STRONGLY, MUST, ACTION REQUIRED
      expect(content).not.toContain('MUST');
      expect(content).not.toContain('ACTION REQUIRED');
    });
  });
});
