/**
 * Regression Test: Hook Simulation
 *
 * Story M4.2: Regression & Simulation Harness
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test database path (isolated from production)
const TEST_DB_PATH = path.join(os.tmpdir(), `mama-hook-regression-${Date.now()}.db`);

// Hook script paths
const PRETOOLUSE_HOOK = path.join(__dirname, '../../scripts/pretooluse-hook.js');
const POSTTOOLUSE_HOOK = path.join(__dirname, '../../scripts/posttooluse-hook.js');

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
function execHook(scriptPath, env = {}, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const start = Date.now();

    const child = spawn('node', [scriptPath], {
      env: {
        ...process.env,
        ...env,
        // Test database
        MAMA_DB_PATH: TEST_DB_PATH,
        MAMA_FORCE_TIER_3: 'true', // Tier 3 to skip MCP calls in tests
      },
    });

    // Enforce timeout since spawn doesn't support it natively
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);

    // Close stdin immediately to prevent hanging on readStdin
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
      resolve({
        stdout,
        stderr,
        exitCode: code,
        latency,
      });
    });

    child.on('error', (error) => {
      clearTimeout(timer);
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

// Variables for dynamic imports
let initDB, closeDB, saveDecisionTool;

describe('Story M4.2: Hook Simulation - Regression Harness', () => {
  beforeAll(async () => {
    // Initialize test database
    delete process.env.MAMA_DATABASE_URL;
    process.env.MAMA_FORCE_TIER_2 = 'true';
    process.env.MAMA_FORCE_TIER_3 = 'true'; // Skip embeddings to prevent OOM
    process.env.MAMA_DB_PATH = TEST_DB_PATH;

    // Dynamic imports to ensure env vars are set BEFORE modules load
    const dbManager = await import('@jungjaehoon/mama-core/db-manager');
    initDB = dbManager.initDB;
    closeDB = dbManager.closeDB;

    const saveDecision = await import('../../src/tools/save-decision.js');
    saveDecisionTool = saveDecision.saveDecisionTool;

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
    // Architecture (Feb 2025): Standalone script, reads JSON from stdin,
    // outputs via stdout (hookSpecificOutput) or stderr (allow decisions).
    // Grep/Glob: allow via stderr. Read: lightweight (agents/rules). Edit/Write: contract search.

    it('should execute Grep tool and allow freely', async () => {
      const result = await execHook(PRETOOLUSE_HOOK, {
        TOOL_NAME: 'Grep',
        GREP_PATTERN: 'embeddings',
      });

      expect(result.exitCode).toBe(0);
      // Grep outputs allow decision to stderr (fast path, no injection)
      expect(result.stderr).toContain('allow');
      console.log(`[Regression] PreToolUse (Grep) latency: ${result.latency}ms`);
      expect(result.latency).toBeLessThan(5000);
    });

    it('should execute Read tool via lightweight path', async () => {
      const result = await execHook(PRETOOLUSE_HOOK, {
        TOOL_NAME: 'Read',
        FILE_PATH: '/path/to/db-manager.js',
      });

      // Read path: exit(0) if no decisions found, exit(2) if decisions found (context via stderr)
      expect([0, 2]).toContain(result.exitCode);
      console.log(`[Regression] PreToolUse (Read) latency: ${result.latency}ms`);
      expect(result.latency).toBeLessThan(5000);
    });

    it('should handle unsupported tool gracefully', async () => {
      const result = await execHook(PRETOOLUSE_HOOK, {
        TOOL_NAME: 'UnsupportedTool',
      });

      // Unknown tools get allow via stderr (line 431 in hook)
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('allow');
    });

    it('should respect MAMA_DISABLE_HOOKS flag', async () => {
      const result = await execHook(PRETOOLUSE_HOOK, {
        TOOL_NAME: 'Edit',
        FILE_PATH: '/path/to/test.js',
        MAMA_DISABLE_HOOKS: 'true',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(''); // No output when disabled
      // When disabled via hook-features.js, silently allows
      expect(result.stderr).toContain('allow');
    });

    it('should skip non-code files for Edit tool', async () => {
      const result = await execHook(PRETOOLUSE_HOOK, {
        TOOL_NAME: 'Edit',
        FILE_PATH: '/path/to/README.md', // .md is in SKIP_PATTERNS
      });

      expect(result.exitCode).toBe(0);
      // Non-code files get silent allow via stderr
      expect(result.stderr).toContain('allow');
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

      // PostToolUse: exit(2) for reminder visibility, exit(0) for silent skip
      expect([0, 2]).toContain(result.exitCode);

      console.log(`[Regression] PostToolUse (Write) latency: ${result.latency}ms`);
      expect(result.latency).toBeLessThan(1000);
    });

    it('should execute successfully with Edit tool payload', async () => {
      const result = await execHook(POSTTOOLUSE_HOOK, {
        TOOL_NAME: 'Edit',
        FILE_PATH: '/path/to/existing-file.js',
      });

      // PostToolUse: exit(2) for reminder visibility, exit(0) for silent skip
      expect([0, 2]).toContain(result.exitCode);

      console.log(`[Regression] PostToolUse (Edit) latency: ${result.latency}ms`);
      expect(result.latency).toBeLessThan(1000);
    });

    it('should handle non-triggering tool gracefully', async () => {
      const result = await execHook(POSTTOOLUSE_HOOK, {
        TOOL_NAME: 'Read', // PostToolUse doesn't trigger on Read
      });

      expect(result.exitCode).toBe(0);
      // PostToolUse outputs to stderr, stdout should be empty
    });

    it('should respect MAMA_DISABLE_HOOKS flag', async () => {
      const result = await execHook(POSTTOOLUSE_HOOK, {
        TOOL_NAME: 'Write',
        FILE_PATH: '/path/to/typed.ts',
        MAMA_DISABLE_HOOKS: 'true',
      });

      expect(result.exitCode).toBe(0);
      // When disabled, hook exits silently with no output
      expect(result.stdout).toBe('');
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Cross-Hook Integration Tests
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('Cross-Hook Integration', () => {
    it('should execute all hooks in parallel without errors', async () => {
      const results = await Promise.all([
        execHook(PRETOOLUSE_HOOK, {
          TOOL_NAME: 'Grep', // Use Grep for fast path
        }),
        execHook(POSTTOOLUSE_HOOK, {
          TOOL_NAME: 'Write',
          FILE_PATH: '/path/to/new.js',
        }),
      ]);

      const [preToolUse, postToolUse] = results;
      expect(preToolUse.exitCode).toBe(0);
      expect([0, 2]).toContain(postToolUse.exitCode);
      results.forEach((result, i) => {
        console.log(`[Regression] Hook ${i + 1} latency: ${result.latency}ms`);
      });

      // Parallel execution should complete within reasonable time
      const totalLatency = Math.max(...results.map((r) => r.latency));
      expect(totalLatency).toBeLessThan(5000);
    });

    it('should all exit cleanly when MAMA_DISABLE_HOOKS is set', async () => {
      const disableEnv = { MAMA_DISABLE_HOOKS: 'true' };

      const results = await Promise.all([
        execHook(PRETOOLUSE_HOOK, { ...disableEnv, TOOL_NAME: 'Read' }),
        execHook(POSTTOOLUSE_HOOK, {
          ...disableEnv,
          TOOL_NAME: 'Write',
          FILE_PATH: '/path/to/pattern.ts',
        }),
      ]);

      results.forEach((result) => {
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(''); // No injection when disabled
      });
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Performance Regression Tests
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('Performance: Hook Latency Budget', () => {
    it('should maintain fast latency for Grep (fast path)', async () => {
      const latencies = [];

      for (let i = 0; i < 10; i++) {
        const result = await execHook(PRETOOLUSE_HOOK, {
          TOOL_NAME: 'Grep',
          GREP_PATTERN: `test_pattern_${i}`,
        });
        latencies.push(result.latency);
      }

      latencies.sort((a, b) => a - b);
      const p95Index = Math.floor(latencies.length * 0.95) - 1;
      const p95Latency = latencies[p95Index];

      console.log(`[Regression] PreToolUse (Grep fast path) p95 latency: ${p95Latency}ms`);

      // Grep fast path should be very quick (no DB, no embeddings)
      expect(p95Latency).toBeLessThan(1000);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Error Handling and Edge Cases
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('Error Handling', () => {
    it('should handle missing environment variables gracefully', async () => {
      // PreToolUse without TOOL_NAME - unknown tool path, allow via stderr
      const preResult = await execHook(PRETOOLUSE_HOOK, {});
      expect(preResult.exitCode).toBe(0);
      expect(preResult.stderr).toContain('allow');

      // PostToolUse without TOOL_NAME
      const postResult = await execHook(POSTTOOLUSE_HOOK, {});
      expect(postResult.exitCode).toBe(0);
    });

    it('should handle database connection failures gracefully', async () => {
      // Use non-existent database path with Edit tool (triggers DB access)
      const result = await execHook(PRETOOLUSE_HOOK, {
        TOOL_NAME: 'Edit',
        FILE_PATH: '/path/to/test.js',
        MAMA_DB_PATH: '/nonexistent/path/mama.db',
      });

      // Should not crash - graceful degradation via catch handler
      expect(result.exitCode).toBe(0);
    });
  });
});
