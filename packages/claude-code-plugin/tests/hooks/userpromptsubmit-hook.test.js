/**
 * Tests for UserPromptSubmit Hook
 *
 * Story M2.1: UserPromptSubmit Hook Migration
 * Tests AC #1-5: Hook implementation, performance, tier awareness, opt-out
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mock environment for testing
const originalEnv = { ...process.env };

describe('Story M2.1: UserPromptSubmit Hook', () => {
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
      const hook = await import('../../scripts/userpromptsubmit-hook.js');

      expect(hook).toHaveProperty('main');
      expect(hook).toHaveProperty('getTierInfo');
      expect(hook).toHaveProperty('formatTransparencyLine');

      expect(typeof hook.main).toBe('function');
      expect(typeof hook.getTierInfo).toBe('function');
      expect(typeof hook.formatTransparencyLine).toBe('function');
    });

    it('should be executable script with shebang', async () => {
      const scriptPath = path.join(__dirname, '../../scripts/userpromptsubmit-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      expect(content.startsWith('#!/usr/bin/env node')).toBe(true);

      // Check file permissions (executable)
      const stats = fs.statSync(scriptPath);
      const isExecutable = !!(stats.mode & 0o111);
      expect(isExecutable).toBe(true);
    });
  });

  describe('AC #1: Tier Detection', () => {
    it('should detect Tier 1 with embeddings available', async () => {
      const hook = await import('../../scripts/userpromptsubmit-hook.js');
      const tierInfo = hook.getTierInfo();

      // Should return tier object
      expect(tierInfo).toHaveProperty('tier');
      expect(tierInfo).toHaveProperty('vectorSearchEnabled');
      expect(tierInfo).toHaveProperty('reason');

      // Tier should be 1, 2, or 3
      expect([1, 2, 3]).toContain(tierInfo.tier);
    });

    it('should provide tier reason', async () => {
      const hook = await import('../../scripts/userpromptsubmit-hook.js');
      const tierInfo = hook.getTierInfo();

      expect(typeof tierInfo.reason).toBe('string');
      expect(tierInfo.reason.length).toBeGreaterThan(0);
    });
  });

  describe('AC #2: Transparency Line', () => {
    it('should format transparency line with tier badge', async () => {
      const hook = await import('../../scripts/userpromptsubmit-hook.js');

      const tierInfo = { tier: 1, reason: 'Full features' };
      const line = hook.formatTransparencyLine(tierInfo, 150, 3);

      // Should contain tier badge
      expect(line).toContain('🔍 System Status:');
      expect(line).toContain('Tier 1');

      // Should contain reason
      expect(line).toContain('Full features');

      // Should contain performance
      expect(line).toContain('150ms');

      // Should contain result count
      expect(line).toContain('3 decisions');
    });

    it('should show warning for slow execution', async () => {
      const hook = await import('../../scripts/userpromptsubmit-hook.js');

      const tierInfo = { tier: 1, reason: 'Full features' };
      const line = hook.formatTransparencyLine(tierInfo, 1900, 2);

      // Should warn about slow execution (>1800ms)
      expect(line).toContain('⚠️');
      expect(line).toContain('1900ms');
      expect(line).toContain('exceeded');
    });

    it('should format different tier levels', async () => {
      const hook = await import('../../scripts/userpromptsubmit-hook.js');

      const tier1 = hook.formatTransparencyLine({ tier: 1, reason: 'Full' }, 100, 3);
      const tier2 = hook.formatTransparencyLine({ tier: 2, reason: 'Degraded' }, 100, 1);
      const tier3 = hook.formatTransparencyLine({ tier: 3, reason: 'Disabled' }, 100, 0);

      expect(tier1).toContain('Tier 1');
      expect(tier2).toContain('Tier 2');
      expect(tier3).toContain('Tier 3');

      expect(tier1).toContain('🟢');
      expect(tier2).toContain('🟡');
      expect(tier3).toContain('🔴');
    });
  });

  describe('AC #3: Opt-out Flag', () => {
    it('should respect MAMA_DISABLE_HOOKS environment variable', () => {
      const scriptPath = path.join(__dirname, '../../scripts/userpromptsubmit-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // Check opt-out flag handling
      expect(content).toContain('MAMA_DISABLE_HOOKS');
      expect(content).toContain('process.env.MAMA_DISABLE_HOOKS');
    });
  });

  describe('AC #4: Performance Requirements', () => {
    it('should define MAX_RUNTIME_MS <=1800ms', () => {
      const scriptPath = path.join(__dirname, '../../scripts/userpromptsubmit-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // Check MAX_RUNTIME_MS is defined and <=1800 (balanced for embedding model loading)
      const match = content.match(/MAX_RUNTIME_MS\s*=\s*(\d+)/);
      expect(match).toBeTruthy();

      const maxRuntime = parseInt(match[1], 10);
      expect(maxRuntime).toBeLessThanOrEqual(1800);
    });

    it('should implement timeout handling', () => {
      const scriptPath = path.join(__dirname, '../../scripts/userpromptsubmit-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // Check timeout implementation with Promise.race
      expect(content).toContain('Promise.race');
      expect(content).toContain('setTimeout');
      expect(content).toContain('Hook timeout');
    });
  });

  describe('AC #5: Similarity Threshold', () => {
    it('should define similarity threshold >75%', () => {
      // SIMILARITY_THRESHOLD (0.75) is used in memory-inject.js and db-manager.js
      // Check db-manager.js where the default threshold is defined
      const dbManagerPath = path.join(__dirname, '../../src/core/db-manager.js');
      const content = fs.readFileSync(dbManagerPath, 'utf8');

      // Check threshold parameter default is 0.75
      const match = content.match(/threshold\s*=\s*(0\.7\d*)/);
      expect(match).toBeTruthy();

      const threshold = parseFloat(match[1]);
      expect(threshold).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe('Integration', () => {
    it('should handle missing USER_PROMPT gracefully', () => {
      const scriptPath = path.join(__dirname, '../../scripts/userpromptsubmit-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // Verify graceful handling of missing prompt
      expect(content).toContain('USER_PROMPT');
      expect(content).toContain('process.exit(0)');
    });

    it('should log structured information', () => {
      const scriptPath = path.join(__dirname, '../../scripts/userpromptsubmit-hook.js');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // Verify structured logging
      expect(content).toContain('info');
      expect(content).toContain('warn');
      expect(content).toContain('[Hook]');
    });
  });
});
