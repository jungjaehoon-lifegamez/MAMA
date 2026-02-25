/**
 * Unit tests for PromptSizeMonitor
 *
 * Uses forceFallbackMode() for deterministic token counts.
 * Fallback formula: Math.ceil(byteLength * 0.4)
 * For ASCII 'x': countTokens('x'.repeat(N)) = Math.ceil(N * 0.4)
 *
 * Token thresholds (defaults): warn=3750, truncate=6250, hard_limit=10000
 * Char equivalents in fallback: warn≈9375, truncate≈15625, hard≈25000
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PromptSizeMonitor } from '../../src/agent/prompt-size-monitor.js';
import type { PromptLayer } from '../../src/agent/prompt-size-monitor.js';
import { forceFallbackMode, resetTokenEstimator } from '../../src/agent/token-estimator.js';

describe('PromptSizeMonitor', () => {
  let monitor: PromptSizeMonitor;

  beforeEach(() => {
    resetTokenEstimator();
    forceFallbackMode();
    monitor = new PromptSizeMonitor();
  });

  // ─────────────────────────────────────────────────────
  // check()
  // ─────────────────────────────────────────────────────
  describe('check()', () => {
    it('should report within budget and no warning when under WARN threshold', () => {
      // 5000 chars → 2000 tokens (< 3750 warn)
      const layers: PromptLayer[] = [{ name: 'core', content: 'x'.repeat(5000), priority: 1 }];
      const result = monitor.check(layers);
      expect(result.withinBudget).toBe(true);
      expect(result.warning).toBeNull();
      expect(result.totalChars).toBe(5000);
      expect(result.totalTokens).toBe(2000);
      expect(result.truncatedLayers).toEqual([]);
    });

    it('should set warning but remain within budget when over WARN but under TRUNCATE', () => {
      // 10000 chars → 4000 tokens (> 3750 warn, < 6250 truncate)
      const layers: PromptLayer[] = [{ name: 'core', content: 'x'.repeat(10000), priority: 1 }];
      const result = monitor.check(layers);
      expect(result.withinBudget).toBe(true);
      expect(result.warning).not.toBeNull();
      expect(result.warning).toContain('approaching limit');
      expect(result.warning).toContain('4000 tokens');
    });

    it('should report not within budget when over TRUNCATE threshold', () => {
      // 16000 chars → 6400 tokens (> 6250 truncate, < 10000 hard)
      const layers: PromptLayer[] = [{ name: 'core', content: 'x'.repeat(16000), priority: 1 }];
      const result = monitor.check(layers);
      expect(result.withinBudget).toBe(false);
      expect(result.warning).not.toBeNull();
      expect(result.warning).toContain('exceeds truncation threshold');
    });

    it('should mention force truncation when over HARD_LIMIT', () => {
      // 26000 chars → 10400 tokens (> 10000 hard)
      const layers: PromptLayer[] = [{ name: 'core', content: 'x'.repeat(26000), priority: 1 }];
      const result = monitor.check(layers);
      expect(result.withinBudget).toBe(false);
      expect(result.warning).not.toBeNull();
      expect(result.warning).toContain('Force truncation required');
    });

    it('should calculate totalChars and totalTokens across multiple layers', () => {
      const layers: PromptLayer[] = [
        { name: 'a', content: 'x'.repeat(3000), priority: 1 },
        { name: 'b', content: 'x'.repeat(2000), priority: 2 },
        { name: 'c', content: 'x'.repeat(1000), priority: 3 },
      ];
      const result = monitor.check(layers);
      expect(result.totalChars).toBe(6000);
      // 6000 chars → Math.ceil(6000 * 0.4) = 2400 tokens
      expect(result.totalTokens).toBe(2400);
    });

    it('should include estimatedTokens for backward compatibility', () => {
      const layers: PromptLayer[] = [{ name: 'core', content: 'x'.repeat(4000), priority: 1 }];
      const result = monitor.check(layers);
      // estimatedTokens uses chars/4 heuristic
      expect(result.estimatedTokens).toBe(1000);
    });
  });

  // ─────────────────────────────────────────────────────
  // estimateTokens() (deprecated, backward compat)
  // ─────────────────────────────────────────────────────
  describe('estimateTokens()', () => {
    it('should estimate 1000 tokens for 4000 chars', () => {
      expect(monitor.estimateTokens(4000)).toBe(1000);
    });

    it('should round up for non-exact divisions', () => {
      expect(monitor.estimateTokens(4001)).toBe(1001);
      expect(monitor.estimateTokens(1)).toBe(1);
    });

    it('should return 0 for 0 chars', () => {
      expect(monitor.estimateTokens(0)).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────
  // enforce()
  // ─────────────────────────────────────────────────────
  describe('enforce()', () => {
    it('should return layers unchanged when under budget', () => {
      // 2000 chars → 800 tokens (< 6250 truncate)
      const layers: PromptLayer[] = [
        { name: 'core', content: 'x'.repeat(1000), priority: 1 },
        { name: 'rules', content: 'y'.repeat(1000), priority: 5 },
      ];
      const { layers: result, result: monitorResult } = monitor.enforce(layers);
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('x'.repeat(1000));
      expect(result[1].content).toBe('y'.repeat(1000));
      expect(monitorResult.truncatedLayers).toEqual([]);
    });

    it('should truncate highest priority number first when over budget', () => {
      // 10000+10000+10000 = 30000 chars → 12000 tokens (> 6250 truncate)
      const layers: PromptLayer[] = [
        { name: 'core', content: 'x'.repeat(10000), priority: 1 },
        { name: 'agents', content: 'a'.repeat(10000), priority: 4 },
        { name: 'keywords', content: 'k'.repeat(10000), priority: 6 },
      ];
      const { result: monitorResult } = monitor.enforce(layers);
      // keywords (priority 6) should be truncated first
      expect(monitorResult.truncatedLayers).toContain('keywords');
    });

    it('should never truncate priority 1 layers', () => {
      // 20000+5000 = 25000 chars → 10000 tokens (> 6250 truncate)
      const layers: PromptLayer[] = [
        { name: 'claude-md', content: 'x'.repeat(20000), priority: 1 },
        { name: 'rules', content: 'r'.repeat(5000), priority: 5 },
      ];
      const { layers: result, result: monitorResult } = monitor.enforce(layers);
      const coreLayer = result.find((l) => l.name === 'claude-md');
      expect(coreLayer).toBeDefined();
      expect(coreLayer!.content).toBe('x'.repeat(20000));
      expect(monitorResult.truncatedLayers).toContain('rules');
      expect(monitorResult.truncatedLayers).not.toContain('claude-md');
    });

    it('should partially truncate large layer when full removal is unnecessary', () => {
      // 3000+8000 = 11000 chars → 4400 tokens, enforce with maxTokens=3000
      const layers: PromptLayer[] = [
        { name: 'core', content: 'x'.repeat(3000), priority: 1 },
        { name: 'big-rule', content: 'B'.repeat(8000), priority: 5 },
      ];
      const { layers: result, result: monitorResult } = monitor.enforce(layers, 3000);
      const bigRule = result.find((l) => l.name === 'big-rule');
      expect(bigRule).toBeDefined();
      expect(bigRule!.content.length).toBeLessThan(8000);
      expect(bigRule!.content).toContain('truncated');
      expect(monitorResult.truncatedLayers).toContain('big-rule');
    });

    it('should return correct truncatedLayers list', () => {
      // 5000+3000+3000+3000+5000 = 19000 chars → 7600 tokens (> 6250 truncate)
      const layers: PromptLayer[] = [
        { name: 'core', content: 'x'.repeat(5000), priority: 1 },
        { name: 'tools', content: 't'.repeat(3000), priority: 2 },
        { name: 'agents', content: 'a'.repeat(3000), priority: 4 },
        { name: 'rules', content: 'r'.repeat(3000), priority: 5 },
        { name: 'keywords', content: 'k'.repeat(5000), priority: 6 },
      ];
      const { result: monitorResult } = monitor.enforce(layers);
      // keywords (priority 6, 2000 tokens) should be truncated first
      expect(monitorResult.truncatedLayers).toContain('keywords');
    });

    it('should filter out fully emptied layers from result', () => {
      // 14000+2000+4000 = 20000 chars → 8000 tokens (> 6250 truncate, excess=1750 tokens)
      // small-ephemeral: 2000 chars → 800 tokens <= 1750 excess → fully removed
      const layers: PromptLayer[] = [
        { name: 'core', content: 'x'.repeat(14000), priority: 1 },
        { name: 'small-ephemeral', content: 'e'.repeat(2000), priority: 6 },
        { name: 'medium-rule', content: 'm'.repeat(4000), priority: 5 },
      ];
      const { layers: result } = monitor.enforce(layers);
      const ephem = result.find((l) => l.name === 'small-ephemeral');
      expect(ephem).toBeUndefined();
    });

    it('should handle custom maxTokens parameter', () => {
      // 5000+5000 = 10000 chars → 4000 tokens
      const layers: PromptLayer[] = [
        { name: 'core', content: 'x'.repeat(5000), priority: 1 },
        { name: 'rules', content: 'r'.repeat(5000), priority: 5 },
      ];
      // Under default 6250 but over custom 3000
      const { result: monitorResult } = monitor.enforce(layers, 3000);
      expect(monitorResult.truncatedLayers.length).toBeGreaterThan(0);
    });

    it('should report still-exceeding warning when priority-1 layers alone exceed limit', () => {
      // 20000+1000 = 21000 chars → 8400 tokens (> 6250 truncate)
      // After removing rules (400 tokens), core alone is 8000 tokens > 6250
      const layers: PromptLayer[] = [
        { name: 'core', content: 'x'.repeat(20000), priority: 1 },
        { name: 'rules', content: 'r'.repeat(1000), priority: 5 },
      ];
      const { result: monitorResult } = monitor.enforce(layers);
      expect(monitorResult.withinBudget).toBe(false);
      expect(monitorResult.warning).toContain('still exceeds limit');
    });
  });
});
