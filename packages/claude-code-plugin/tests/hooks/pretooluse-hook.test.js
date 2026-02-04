/**
 * Tests for PreToolUse Hook
 *
 * Story M2.2: PreToolUse Hook (Context before Read/Edit/Grep)
 * Tests AC #1, 3-5: Tool subscription, file hints, tier awareness, similarity threshold
 * Note: AC #2 (Recency Weighting) is handled server-side in mama-api.js
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mock environment for testing
const originalEnv = { ...process.env };

describe('Story M2.2: PreToolUse Hook', () => {
  beforeEach(() => {
    // Reset environment
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore environment
    process.env = originalEnv;
  });

  describe('Hook Structure', () => {
    it('should export required functions', async () => {
      const hook = await import('../../scripts/pretooluse-hook.js');

      expect(hook).toHaveProperty('main');
      expect(hook).toHaveProperty('getTierInfo');
      expect(hook).toHaveProperty('formatTransparencyLine');
      expect(hook).toHaveProperty('checkRateLimit');
      expect(hook).toHaveProperty('generateQuery');
      expect(hook).toHaveProperty('extractFileHints');
      expect(hook).toHaveProperty('searchRelatedContracts');
      expect(hook).toHaveProperty('formatContractContext');
      expect(hook).toHaveProperty('injectPreToolContext');

      expect(typeof hook.main).toBe('function');
      expect(typeof hook.getTierInfo).toBe('function');
      expect(typeof hook.formatTransparencyLine).toBe('function');
      expect(typeof hook.checkRateLimit).toBe('function');
      expect(typeof hook.generateQuery).toBe('function');
      expect(typeof hook.extractFileHints).toBe('function');
      expect(typeof hook.searchRelatedContracts).toBe('function');
      expect(typeof hook.formatContractContext).toBe('function');
      expect(typeof hook.injectPreToolContext).toBe('function');
    });

    it('should be executable script with shebang', async () => {
      const scriptPath = path.join(__dirname, '../../scripts/pretooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      expect(content.startsWith('#!/usr/bin/env node')).toBe(true);

      // Check file permissions (executable) - Unix only
      if (process.platform !== 'win32') {
        const stats = fs.statSync(scriptPath);
        const isExecutable = !!(stats.mode & 0o111);
        expect(isExecutable).toBe(true);
      }
    });
  });

  describe('AC #1: Tool Subscription', () => {
    it('should define supported tools', () => {
      const scriptPath = path.join(__dirname, '../../scripts/pretooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // Check for supported tools
      expect(content).toContain('SUPPORTED_TOOLS');
      expect(content).toContain('read_file');
      expect(content).toContain('grep');
      expect(content).toContain('apply_patch');
      expect(content).toContain('Read');
      expect(content).toContain('Edit');
      expect(content).toContain('Grep');
    });

    it('should check TOOL_NAME environment variable', () => {
      const scriptPath = path.join(__dirname, '../../scripts/pretooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      expect(content).toContain('TOOL_NAME');
      expect(content).toContain('process.env.TOOL_NAME');
    });
  });

  // AC #2: Recency Weighting - REMOVED
  // Recency scoring is implemented in MCP server (mama-api.js) using Gaussian Decay.
  // PreToolUse hook uses simple vectorSearch for fast response (<500ms target).
  // This follows MAMA's architecture: MCP server handles complex scoring,
  // hooks provide quick context injection.

  describe('AC #3: File Hints', () => {
    it('should extract file hints from decisions', async () => {
      const hook = await import('../../scripts/pretooluse-hook.js');

      const decisions = [
        {
          decision: 'Use db-manager.js for database operations',
          reasoning: 'Located in src/core/db-manager.js',
        },
        {
          decision: 'Config in config.yaml',
          reasoning: 'No file references',
        },
      ];

      const result = hook.extractFileHints(decisions, 'db-manager.js');

      // First decision should have file hints
      expect(result[0].fileHints).toBeTruthy();
      expect(result[0].fileHints).toContain('db-manager.js');

      // Second decision should have file hints too
      expect(result[1].fileHints).toBeTruthy();
      expect(result[1].fileHints).toContain('config.yaml');

      // First decision is relevant to target file
      expect(result[0].relevantToFile).toBe(true);
    });

    it('should generate query from tool context', async () => {
      const hook = await import('../../scripts/pretooluse-hook.js');

      const query1 = hook.generateQuery('read_file', '/path/to/file.js', null);
      expect(query1).toContain('file.js');
      expect(query1).toContain('read_file');

      const query2 = hook.generateQuery('grep', '/src/core/test.js', 'function.*test');
      expect(query2).toContain('function.*test');
      expect(query2).toContain('test.js');
      expect(query2).toContain('grep');
    });
  });

  describe('AC #4: Tier Status', () => {
    it('should detect tier same as M2.1', async () => {
      const hook = await import('../../scripts/pretooluse-hook.js');
      const tierInfo = hook.getTierInfo();

      // Should return tier object (same as M2.1)
      expect(tierInfo).toHaveProperty('tier');
      expect(tierInfo).toHaveProperty('vectorSearchEnabled');
      expect(tierInfo).toHaveProperty('reason');

      // Tier should be 1, 2, or 3
      expect([1, 2, 3]).toContain(tierInfo.tier);
    });

    it('should format transparency line with tool name', async () => {
      const hook = await import('../../scripts/pretooluse-hook.js');

      const tierInfo = { tier: 1, reason: 'Full features' };
      const line = hook.formatTransparencyLine(tierInfo, 150, 3, 'read_file');

      // Should contain PreToolUse identifier
      expect(line).toContain('PreToolUse');
      expect(line).toContain('read_file');

      // Should contain tier badge
      expect(line).toContain('🔍');
      expect(line).toContain('Tier 1');

      // Should contain performance
      expect(line).toContain('150ms');

      // Should contain result count
      expect(line).toContain('3 decisions');
    });
  });

  describe('AC #5: Similarity Threshold', () => {
    it('should define similarity threshold 70%', () => {
      const scriptPath = path.join(__dirname, '../../scripts/pretooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // Check SIMILARITY_THRESHOLD is defined
      const match = content.match(/SIMILARITY_THRESHOLD\s*=\s*([\d.]+)/);
      expect(match).toBeTruthy();

      const threshold = parseFloat(match[1]);
      expect(threshold).toBe(0.7); // Lower than M2.1 (0.75)
    });

    it('should use threshold in vector search', () => {
      const scriptPath = path.join(__dirname, '../../scripts/pretooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // Check threshold is passed to vectorSearch
      expect(content).toContain('vectorSearch');
      expect(content).toContain('SIMILARITY_THRESHOLD');
    });
  });

  describe('Rate Limiting', () => {
    it('should implement rate limiting', async () => {
      const hook = await import('../../scripts/pretooluse-hook.js');

      // First call should pass
      const firstCheck = hook.checkRateLimit();
      expect(typeof firstCheck).toBe('boolean');
    });

    it('should define rate limit constant', () => {
      const scriptPath = path.join(__dirname, '../../scripts/pretooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // Check RATE_LIMIT_MS is defined
      expect(content).toContain('RATE_LIMIT_MS');

      const match = content.match(/RATE_LIMIT_MS\s*=\s*(\d+)/);
      expect(match).toBeTruthy();

      const rateLimit = parseInt(match[1], 10);
      expect(rateLimit).toBeGreaterThan(0);
    });

    it('should persist rate limit state to file', () => {
      const scriptPath = path.join(__dirname, '../../scripts/pretooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // Check for rate limit file handling
      expect(content).toContain('RATE_LIMIT_FILE');
      expect(content).toContain('updateRateLimit');
      expect(content).toContain('.pretooluse-last-run');
    });
  });

  describe('Performance', () => {
    it('should define MAX_RUNTIME_MS <=3000ms', () => {
      const scriptPath = path.join(__dirname, '../../scripts/pretooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // Check MAX_RUNTIME_MS is defined and <=3000 (increased for embedding model loading)
      const match = content.match(/MAX_RUNTIME_MS\s*=\s*(\d+)/);
      expect(match).toBeTruthy();

      const maxRuntime = parseInt(match[1], 10);
      expect(maxRuntime).toBeLessThanOrEqual(3000);
    });

    it('should implement timeout handling', () => {
      const scriptPath = path.join(__dirname, '../../scripts/pretooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // Check timeout implementation with Promise.race
      expect(content).toContain('Promise.race');
      expect(content).toContain('setTimeout');
      expect(content).toContain('Hook timeout');
    });
  });

  describe('Integration', () => {
    it('should handle missing TOOL_NAME gracefully', () => {
      const scriptPath = path.join(__dirname, '../../scripts/pretooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // Verify graceful handling of missing tool name
      expect(content).toContain('TOOL_NAME');
      expect(content).toContain('process.exit(0)');
    });

    it('should respect MAMA_DISABLE_HOOKS opt-out', () => {
      const scriptPath = path.join(__dirname, '../../scripts/pretooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // Check opt-out flag handling
      expect(content).toContain('MAMA_DISABLE_HOOKS');
      expect(content).toContain('process.env.MAMA_DISABLE_HOOKS');
    });

    it('should log structured information', () => {
      const scriptPath = path.join(__dirname, '../../scripts/pretooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // Verify structured logging
      expect(content).toContain('info');
      expect(content).toContain('warn');
      expect(content).toContain('[Hook]');
      expect(content).toContain('PreToolUse');
    });

    it('should use shorter token budget than M2.1', () => {
      const scriptPath = path.join(__dirname, '../../scripts/pretooluse-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // Check TOKEN_BUDGET
      const match = content.match(/TOKEN_BUDGET\s*=\s*(\d+)/);
      expect(match).toBeTruthy();

      const budget = parseInt(match[1], 10);
      expect(budget).toBeLessThan(500); // M2.1 used 500
    });
  });
});
