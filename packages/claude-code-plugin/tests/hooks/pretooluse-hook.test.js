/**
 * Tests for PreToolUse Hook
 *
 * Story M2.2: PreToolUse Hook - Contract-First Development Enforcement
 * Tests hook structure, tool routing, feature gating, and contract search.
 *
 * Architecture (Feb 2025 rewrite):
 * - Standalone script reading JSON from stdin (no exports)
 * - Edit/Write: contract search via MAMA DB + embeddings
 * - Read: allow freely (OMC handles rules/AGENTS.md injection)
 * - Grep/Glob: allow freely without injection
 * - Feature gating via hook-features.js (MAMA_DISABLE_HOOKS support)
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCRIPT_PATH = path.join(__dirname, '../../scripts/pretooluse-hook.js');

/**
 * Execute the hook script with optional stdin data and env vars
 */
function execHook(stdinData = '', env = {}, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const start = Date.now();

    const child = spawn('node', [SCRIPT_PATH], {
      env: {
        ...process.env,
        MAMA_FORCE_TIER_3: 'true',
        ...env,
      },
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);

    if (stdinData) {
      child.stdin.write(stdinData);
    }
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
      resolve({
        stdout,
        stderr,
        exitCode: code,
        latency: Date.now() - start,
      });
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        stdout: '',
        stderr: error.message,
        exitCode: 1,
        latency: Date.now() - start,
      });
    });
  });
}

describe('Story M2.2: PreToolUse Hook', () => {
  describe('Hook Structure', () => {
    it('should be executable script with shebang', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');

      expect(content.startsWith('#!/usr/bin/env node')).toBe(true);

      if (process.platform !== 'win32') {
        const stats = fs.statSync(SCRIPT_PATH);
        const isExecutable = !!(stats.mode & 0o111);
        expect(isExecutable).toBe(true);
      }
    });

    it('should follow standalone main() pattern with handler export', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');

      // Script uses main() pattern with module.exports handler
      expect(content).toContain('async function main()');
      expect(content).toContain('main()');
      expect(content).toContain('module.exports');
    });
  });

  describe('AC #1: Tool Routing', () => {
    it('should read tool input from stdin JSON', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');

      expect(content).toContain('tool_input');
      expect(content).toContain('file_path');
      expect(content).toContain('JSON.parse');
    });

    it('should fall back to env vars when stdin is empty', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');

      expect(content).toContain('process.env.TOOL_NAME');
      expect(content).toContain('process.env.FILE_PATH');
    });

    it('should define code file extensions filter', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');

      expect(content).toContain('CODE_EXTENSIONS');
      expect(content).toContain('.js');
      expect(content).toContain('.ts');
      expect(content).toContain('.py');
    });

    it('should define write tools that need contract check', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');

      expect(content).toContain('WRITE_TOOLS');
      expect(content).toContain("'Edit'");
      expect(content).toContain("'Write'");
      expect(content).toContain("'NotebookEdit'");
    });

    it('should only process write tools (skip read tools)', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');

      // New design: only WRITE_TOOLS are processed, others silently pass
      expect(content).toContain('WRITE_TOOLS');
      expect(content).toContain('!WRITE_TOOLS.has');
    });

    it('should define skip patterns for non-code files', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');

      expect(content).toContain('SKIP_PATTERNS');
      expect(content).toContain('.md');
      expect(content).toContain('.json');
      expect(content).toContain('node_modules');
    });
  });

  describe('Feature Gating', () => {
    it('should use hook-features.js for feature gating', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');

      expect(content).toContain('getEnabledFeatures');
      expect(content).toContain('features.has');
    });

    it('should exit early when MAMA_DISABLE_HOOKS is set', async () => {
      const result = await execHook('', {
        MAMA_DISABLE_HOOKS: 'true',
        TOOL_NAME: 'Edit',
        FILE_PATH: '/path/to/test.js',
      });

      expect(result.exitCode).toBe(0);
      // When disabled, silently allows via stderr
      expect(result.stderr).toContain('allow');
    });

    it('should check for contracts feature', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');

      expect(content).toContain("features.has('contracts')");
    });
  });

  describe('Contract Search', () => {
    it('should define similarity threshold', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');

      expect(content).toContain('SIMILARITY_THRESHOLD');
      expect(content).toContain('SEARCH_LIMIT');
    });

    it('should use vectorSearch for contract lookup', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');

      expect(content).toContain('vectorSearch');
      expect(content).toContain('generateEmbedding');
    });

    it('should format decision output safely', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');

      // New hook uses formatDecision for safe output
      expect(content).toContain('formatDecision');
    });

    it('should include decision reference format in output', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');

      // Updated format: "Related Decisions" with module context matching
      expect(content).toContain('Related Decisions');
      expect(content).toContain('formatDecision');
      expect(content).toContain('similarity');
    });
  });

  describe('Integration', () => {
    it('should handle missing stdin gracefully', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf8');

      expect(content).toContain('JSON.parse');
      expect(content).toContain('process.exit(0)');
      expect(content).toContain('decision');
      expect(content).toContain('allow');
    });

    it('should allow Grep tool freely without injection', async () => {
      const result = await execHook(
        JSON.stringify({ tool_name: 'Grep', tool_input: { pattern: 'test' } }),
        {}
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('allow');
    });

    it('should allow Glob tool freely without injection', async () => {
      const result = await execHook(
        JSON.stringify({ tool_name: 'Glob', tool_input: { pattern: '*.js' } }),
        {}
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('allow');
    });
  });
});
