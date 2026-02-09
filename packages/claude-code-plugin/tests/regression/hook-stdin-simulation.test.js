/**
 * Regression Test: Hook Stdin Simulation
 *
 * Story M4.2: Regression & Simulation Harness
 * AC #3: Stdin-based hook simulation feeds JSON payloads via stdin
 *        and verifies PreToolUse contract checking and feature guards.
 *
 * @date 2026-02-09
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PRETOOLUSE_HOOK = path.join(__dirname, '../../scripts/pretooluse-hook.js');

/**
 * Execute hook script with JSON data piped to stdin
 * @param {string} scriptPath - Path to hook script
 * @param {Object} stdinData - Data to write as JSON to stdin
 * @param {Object} env - Environment variables
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number, latency: number}>}
 */
function execHookWithStdin(scriptPath, stdinData, env = {}, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const start = Date.now();

    const child = spawn('node', [scriptPath], {
      env: {
        ...process.env,
        ...env,
        MAMA_FORCE_TIER_3: 'true',
      },
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdin.write(JSON.stringify(stdinData));
    child.stdin.end();

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const latency = Date.now() - start;
      resolve({ stdout, stderr, exitCode: code, latency });
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      const latency = Date.now() - start;
      resolve({ stdout: '', stderr: error.message, exitCode: 1, latency });
    });
  });
}

describe('Story M4.2: Hook Stdin Simulation - Regression Harness', () => {
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // PreToolUse: Tool Routing via Stdin
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('PreToolUse: Tool Routing via Stdin', () => {
    it('should allow Read tool freely', async () => {
      const result = await execHookWithStdin(
        PRETOOLUSE_HOOK,
        {
          tool_name: 'Read',
          tool_input: {
            file_path: '/home/deck/project/MAMA/packages/claude-code-plugin/src/core/embeddings.js',
          },
        },
        {}
      );

      expect(result.exitCode).toBe(0);
      // Read now allows freely (OMC handles rules injection)
      expect(result.stderr).toContain('allow');
    });

    it('should allow Grep tool freely', async () => {
      const result = await execHookWithStdin(
        PRETOOLUSE_HOOK,
        {
          tool_name: 'Grep',
          tool_input: { pattern: 'test' },
        },
        {}
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('allow');
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Feature Guard: MAMA_DISABLE_HOOKS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('Feature Guard: MAMA_DISABLE_HOOKS', () => {
    it('should output contracts disabled when MAMA_DISABLE_HOOKS=true', async () => {
      const result = await execHookWithStdin(
        PRETOOLUSE_HOOK,
        { tool_name: 'Edit', tool_input: { file_path: '/path/to/test.js' } },
        { MAMA_DISABLE_HOOKS: 'true' }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('contracts disabled');
    });
  });
});
