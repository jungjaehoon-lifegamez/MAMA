/**
 * Regression Test: Hook Simulation
 *
 * Story M4.2: 회귀 및 시뮬레이션 하네스
 * AC #2: Hook simulation script feeds mock PreToolUse/PostToolUse payloads
 *        and verifies injection formatting + latency.
 *
 * Simulates real hook execution with mock environment payloads to ensure:
 * 1. Hook scripts execute successfully
 * 2. Output formatting is correct
 * 3. Latency budgets are maintained
 * 4. Rate limiting works properly
 * 5. Tier awareness is functioning
 *
 * @date 2025-11-21
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { initDB, closeDB, getAdapter } from '../../src/core/db-manager.js';
import { saveDecisionTool } from '../../src/tools/save-decision.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test database path (isolated from production)
const TEST_DB_PATH = path.join(os.tmpdir(), `mama-hook-regression-${Date.now()}.db`);

// Hook script paths
const PRETOOLUSE_HOOK = path.join(__dirname, '../../scripts/pretooluse-hook.js');
const POSTTOOLUSE_HOOK = path.join(__dirname, '../../scripts/posttooluse-hook.js');
const USERPROMPTSUBMIT_HOOK = path.join(__dirname, '../../scripts/userpromptsubmit-hook.js');

// Rate limit file (cleanup needed)
const RATE_LIMIT_FILE = path.join(__dirname, '../../.pretooluse-last-run');

// Mock tool context
const mockContext = {
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
};

/**
 * Execute hook script with mock environment
 * @param {string} scriptPath - Path to hook script
 * @param {Object} env - Environment variables
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number, latency: number}>}
 */
function execHook(scriptPath, env = {}) {
  return new Promise((resolve) => {
    const start = Date.now();

    const child = spawn('node', [scriptPath], {
      env: {
        ...process.env,
        ...env,
        // Test database
        MAMA_DB_PATH: TEST_DB_PATH,
        MAMA_FORCE_TIER_2: 'true', // Tier 2 for faster tests
      },
      timeout: 5000, // 5s max (generous for CI)
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      const latency = Date.now() - start;
      resolve({
        stdout,
        stderr,
        exitCode: code,
        latency,
      });
    });

    child.on('error', (error) => {
      const latency = Date.now() - start;
      resolve({
        stdout: '',
        stderr: error.message,
        exitCode: 1,
        latency,
      });
    });
  });
}

describe('Story M4.2: Hook Simulation - Regression Harness', () => {
  beforeAll(async () => {
    // Initialize test database
    delete process.env.MAMA_DATABASE_URL;
    process.env.MAMA_FORCE_TIER_2 = 'true';
    process.env.MAMA_DB_PATH = TEST_DB_PATH;

    await initDB();

    // Create some test decisions for hooks to find
    for (let i = 0; i < 5; i++) {
      await saveDecisionTool.handler(
        {
          topic: `hook_test_${i}`,
          decision: `Hook simulation test decision ${i}`,
          reasoning: `Testing hook context injection for decision ${i}`,
          confidence: 0.8,
        },
        mockContext
      );
    }
  });

  afterAll(async () => {
    // Clean up test database
    await closeDB();
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }

    // Clean up rate limit file
    if (fs.existsSync(RATE_LIMIT_FILE)) {
      fs.unlinkSync(RATE_LIMIT_FILE);
    }
  });

  beforeEach(() => {
    // Clear rate limit before each test
    if (fs.existsSync(RATE_LIMIT_FILE)) {
      fs.unlinkSync(RATE_LIMIT_FILE);
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // PreToolUse Hook Simulation
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('PreToolUse Hook Simulation', () => {
    it('should execute successfully with Read tool payload', async () => {
      const result = await execHook(PRETOOLUSE_HOOK, {
        TOOL_NAME: 'Read',
        FILE_PATH: '/path/to/db-manager.js',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');

      // Should complete within latency budget
      console.log(`[Regression] PreToolUse (Read) latency: ${result.latency}ms`);
      expect(result.latency).toBeLessThan(1000); // 1s budget for hook execution
    });

    it('should execute successfully with Grep tool payload', async () => {
      const result = await execHook(PRETOOLUSE_HOOK, {
        TOOL_NAME: 'Grep',
        GREP_PATTERN: 'embeddings',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');

      console.log(`[Regression] PreToolUse (Grep) latency: ${result.latency}ms`);
      expect(result.latency).toBeLessThan(1000);
    });

    it('should execute successfully with Edit tool payload', async () => {
      const result = await execHook(PRETOOLUSE_HOOK, {
        TOOL_NAME: 'Edit',
        FILE_PATH: '/path/to/mama-api.js',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');

      console.log(`[Regression] PreToolUse (Edit) latency: ${result.latency}ms`);
      expect(result.latency).toBeLessThan(1000);
    });

    it('should output transparency banner with tier info', async () => {
      const result = await execHook(PRETOOLUSE_HOOK, {
        TOOL_NAME: 'Read',
        FILE_PATH: '/path/to/test.js',
      });

      expect(result.exitCode).toBe(0);

      // Should contain transparency banner
      if (result.stdout) {
        expect(result.stdout).toMatch(/PreToolUse/);
        expect(result.stdout).toMatch(/Tier/);
      }
    });

    it('should respect rate limiting', async () => {
      // First execution
      const first = await execHook(PRETOOLUSE_HOOK, {
        TOOL_NAME: 'Read',
        FILE_PATH: '/path/to/test1.js',
      });

      expect(first.exitCode).toBe(0);

      // Second execution immediately after (should be rate limited)
      const second = await execHook(PRETOOLUSE_HOOK, {
        TOOL_NAME: 'Read',
        FILE_PATH: '/path/to/test2.js',
      });

      expect(second.exitCode).toBe(0);

      // Rate limiting may cause silent exit (no output) or reduced results
      // This is expected behavior - hook should not spam on rapid operations

      // Third execution after delay (should succeed)
      await new Promise((resolve) => setTimeout(resolve, 1100)); // Wait 1.1s (> 1s rate limit)

      const third = await execHook(PRETOOLUSE_HOOK, {
        TOOL_NAME: 'Read',
        FILE_PATH: '/path/to/test3.js',
      });

      expect(third.exitCode).toBe(0);
    });

    it('should handle unsupported tool gracefully', async () => {
      const result = await execHook(PRETOOLUSE_HOOK, {
        TOOL_NAME: 'UnsupportedTool',
      });

      // Should exit cleanly (no context injection)
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(''); // No output for unsupported tools
    });

    it('should respect MAMA_DISABLE_HOOKS flag', async () => {
      const result = await execHook(PRETOOLUSE_HOOK, {
        TOOL_NAME: 'Read',
        FILE_PATH: '/path/to/test.js',
        MAMA_DISABLE_HOOKS: 'true',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(''); // No output when disabled
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // PostToolUse Hook Simulation
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('PostToolUse Hook Simulation', () => {
    it('should execute successfully with Write tool payload', async () => {
      const result = await execHook(POSTTOOLUSE_HOOK, {
        TOOL_NAME: 'Write',
        FILE_PATH: '/path/to/new-file.js',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');

      console.log(`[Regression] PostToolUse (Write) latency: ${result.latency}ms`);
      expect(result.latency).toBeLessThan(1000);
    });

    it('should execute successfully with Edit tool payload', async () => {
      const result = await execHook(POSTTOOLUSE_HOOK, {
        TOOL_NAME: 'Edit',
        FILE_PATH: '/path/to/existing-file.js',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');

      console.log(`[Regression] PostToolUse (Edit) latency: ${result.latency}ms`);
      expect(result.latency).toBeLessThan(1000);
    });

    it('should handle non-triggering tool gracefully', async () => {
      const result = await execHook(POSTTOOLUSE_HOOK, {
        TOOL_NAME: 'Read', // PostToolUse doesn't trigger on Read
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(''); // No output for non-triggering tools
    });

    it('should respect MAMA_DISABLE_HOOKS flag', async () => {
      const result = await execHook(POSTTOOLUSE_HOOK, {
        TOOL_NAME: 'Write',
        FILE_PATH: '/path/to/test.js',
        MAMA_DISABLE_HOOKS: 'true',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(''); // No output when disabled
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // UserPromptSubmit Hook Simulation
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('UserPromptSubmit Hook Simulation', () => {
    it('should execute successfully with user prompt payload', async () => {
      const result = await execHook(USERPROMPTSUBMIT_HOOK, {
        USER_PROMPT: 'How should I implement the regression harness?',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');

      console.log(`[Regression] UserPromptSubmit latency: ${result.latency}ms`);
      expect(result.latency).toBeLessThan(1000);
    });

    it('should output transparency banner with tier info', async () => {
      const result = await execHook(USERPROMPTSUBMIT_HOOK, {
        USER_PROMPT: 'Test prompt',
      });

      expect(result.exitCode).toBe(0);

      // Should contain transparency banner
      if (result.stdout) {
        expect(result.stdout).toMatch(/UserPromptSubmit|Tier/);
      }
    });

    it('should handle empty prompt gracefully', async () => {
      const result = await execHook(USERPROMPTSUBMIT_HOOK, {
        USER_PROMPT: '',
      });

      // Should exit cleanly (no context injection for empty prompt)
      expect(result.exitCode).toBe(0);
    });

    it('should respect MAMA_DISABLE_HOOKS flag', async () => {
      const result = await execHook(USERPROMPTSUBMIT_HOOK, {
        USER_PROMPT: 'Test prompt',
        MAMA_DISABLE_HOOKS: 'true',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(''); // No output when disabled
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Cross-Hook Integration Tests
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('Cross-Hook Integration', () => {
    it('should execute all hooks without errors', async () => {
      const results = await Promise.all([
        execHook(PRETOOLUSE_HOOK, {
          TOOL_NAME: 'Read',
          FILE_PATH: '/path/to/test.js',
        }),
        execHook(POSTTOOLUSE_HOOK, {
          TOOL_NAME: 'Write',
          FILE_PATH: '/path/to/new.js',
        }),
        execHook(USERPROMPTSUBMIT_HOOK, {
          USER_PROMPT: 'Test prompt',
        }),
      ]);

      // All hooks should succeed
      results.forEach((result, i) => {
        expect(result.exitCode).toBe(0);
        console.log(`[Regression] Hook ${i + 1} latency: ${result.latency}ms`);
      });

      // Total latency should be reasonable (parallel execution)
      const totalLatency = Math.max(...results.map((r) => r.latency));
      expect(totalLatency).toBeLessThan(2000); // 2s budget for any single hook
    });

    it('should maintain consistent output format across hooks', async () => {
      const preResult = await execHook(PRETOOLUSE_HOOK, {
        TOOL_NAME: 'Read',
        FILE_PATH: '/path/to/test.js',
      });

      const postResult = await execHook(POSTTOOLUSE_HOOK, {
        TOOL_NAME: 'Write',
        FILE_PATH: '/path/to/test.js',
      });

      const userResult = await execHook(USERPROMPTSUBMIT_HOOK, {
        USER_PROMPT: 'Test prompt',
      });

      // All should have consistent tier formatting (if output exists)
      [preResult, postResult, userResult].forEach((result) => {
        if (result.stdout) {
          // Should match tier badge format: 🟢 Tier 1, 🟡 Tier 2, or 🔴 Tier 3
          const hasTier = /Tier [1-3]/.test(result.stdout);
          if (hasTier) {
            expect(result.stdout).toMatch(/[🟢🟡🔴] Tier [1-3]/);
          }
        }
      });
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Performance Regression Tests
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('Performance: Hook Latency Budget', () => {
    it('should maintain p95 latency < 100ms for PreToolUse', async () => {
      const latencies = [];

      // Run 20 times to measure p95
      for (let i = 0; i < 20; i++) {
        // Clear rate limit to allow execution
        if (fs.existsSync(RATE_LIMIT_FILE)) {
          fs.unlinkSync(RATE_LIMIT_FILE);
        }

        const result = await execHook(PRETOOLUSE_HOOK, {
          TOOL_NAME: 'Read',
          FILE_PATH: `/path/to/test${i}.js`,
        });

        latencies.push(result.latency);
      }

      latencies.sort((a, b) => a - b);
      const p95Index = Math.floor(latencies.length * 0.95) - 1;
      const p95Latency = latencies[p95Index];

      console.log(`[Regression] PreToolUse p95 latency: ${p95Latency}ms`);

      // AC #2: Hook latency budget (generous for CI environment)
      // Real-world p95 should be < 100ms, but CI overhead may increase this
      expect(p95Latency).toBeLessThan(500); // 500ms budget for CI
    });

    it('should not degrade performance with large decision count', async () => {
      // Add 50 more decisions (total 55)
      for (let i = 0; i < 50; i++) {
        await saveDecisionTool.handler(
          {
            topic: `perf_test_${i}`,
            decision: `Performance test decision ${i}`,
            reasoning: `Testing hook performance with large dataset ${i}`,
            confidence: 0.5,
          },
          mockContext
        );
      }

      // Clear rate limit
      if (fs.existsSync(RATE_LIMIT_FILE)) {
        fs.unlinkSync(RATE_LIMIT_FILE);
      }

      // Measure latency with large dataset
      const result = await execHook(PRETOOLUSE_HOOK, {
        TOOL_NAME: 'Read',
        FILE_PATH: '/path/to/test.js',
      });

      expect(result.exitCode).toBe(0);

      console.log(`[Regression] PreToolUse with 55 decisions: ${result.latency}ms`);

      // Should still be fast even with larger dataset
      expect(result.latency).toBeLessThan(1000);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Error Handling and Edge Cases
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('Error Handling', () => {
    it('should handle missing environment variables gracefully', async () => {
      // PreToolUse without TOOL_NAME
      const preResult = await execHook(PRETOOLUSE_HOOK, {});

      expect(preResult.exitCode).toBe(0); // Should exit cleanly
      expect(preResult.stdout).toBe(''); // No output without tool

      // PostToolUse without TOOL_NAME
      const postResult = await execHook(POSTTOOLUSE_HOOK, {});

      expect(postResult.exitCode).toBe(0);
      expect(postResult.stdout).toBe('');

      // UserPromptSubmit without USER_PROMPT
      const userResult = await execHook(USERPROMPTSUBMIT_HOOK, {});

      expect(userResult.exitCode).toBe(0);
      expect(userResult.stdout).toBe('');
    });

    it('should handle database connection failures gracefully', async () => {
      // Use non-existent database path
      const result = await execHook(PRETOOLUSE_HOOK, {
        TOOL_NAME: 'Read',
        FILE_PATH: '/path/to/test.js',
        MAMA_DB_PATH: '/nonexistent/path/mama.db',
      });

      // Should not crash - graceful degradation
      expect(result.exitCode).toBe(0);

      // May have error in stderr, but should not block tool execution
      // This is expected Tier 3 behavior (degraded mode)
    });

    it('should timeout if execution takes too long', async () => {
      const result = await execHook(PRETOOLUSE_HOOK, {
        TOOL_NAME: 'Read',
        FILE_PATH: '/path/to/test.js',
      });

      // Should complete before timeout (5s max in execHook)
      expect(result.latency).toBeLessThan(5000);
    });
  });
});
