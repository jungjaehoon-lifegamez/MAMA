/**
 * Unit tests for PromptSizeMonitor
 *
 * Story: System prompt size monitoring and priority-based truncation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PromptSizeMonitor } from '../../src/agent/prompt-size-monitor.js';
import type { PromptLayer } from '../../src/agent/prompt-size-monitor.js';

describe('PromptSizeMonitor', () => {
  let monitor: PromptSizeMonitor;

  beforeEach(() => {
    monitor = new PromptSizeMonitor();
  });

  // ─────────────────────────────────────────────────────
  // check()
  // ─────────────────────────────────────────────────────
  describe('check()', () => {
    it('should report within budget and no warning when under WARN threshold', () => {
      const layers: PromptLayer[] = [{ name: 'core', content: 'x'.repeat(5000), priority: 1 }];
      const result = monitor.check(layers);
      expect(result.withinBudget).toBe(true);
      expect(result.warning).toBeNull();
      expect(result.totalChars).toBe(5000);
      expect(result.truncatedLayers).toEqual([]);
    });

    it('should set warning but remain within budget when over WARN but under TRUNCATE', () => {
      // WARN_CHARS = 15000, TRUNCATE_CHARS = 25000
      const layers: PromptLayer[] = [{ name: 'core', content: 'x'.repeat(16000), priority: 1 }];
      const result = monitor.check(layers);
      expect(result.withinBudget).toBe(true);
      expect(result.warning).not.toBeNull();
      expect(result.warning).toContain('approaching limit');
      expect(result.warning).toContain('16000');
    });

    it('should report not within budget when over TRUNCATE threshold', () => {
      // TRUNCATE_CHARS = 25000
      const layers: PromptLayer[] = [{ name: 'core', content: 'x'.repeat(26000), priority: 1 }];
      const result = monitor.check(layers);
      expect(result.withinBudget).toBe(false);
      expect(result.warning).not.toBeNull();
      expect(result.warning).toContain('exceeds truncation threshold');
    });

    it('should mention force truncation when over HARD_LIMIT', () => {
      // HARD_LIMIT_CHARS = 40000
      const layers: PromptLayer[] = [{ name: 'core', content: 'x'.repeat(41000), priority: 1 }];
      const result = monitor.check(layers);
      expect(result.withinBudget).toBe(false);
      expect(result.warning).not.toBeNull();
      expect(result.warning).toContain('Force truncation required');
    });

    it('should calculate totalChars across multiple layers', () => {
      const layers: PromptLayer[] = [
        { name: 'a', content: 'x'.repeat(3000), priority: 1 },
        { name: 'b', content: 'x'.repeat(2000), priority: 2 },
        { name: 'c', content: 'x'.repeat(1000), priority: 3 },
      ];
      const result = monitor.check(layers);
      expect(result.totalChars).toBe(6000);
    });
  });

  // ─────────────────────────────────────────────────────
  // estimateTokens()
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
      // maxChars defaults to TRUNCATE_CHARS (25000)
      const layers: PromptLayer[] = [
        { name: 'core', content: 'x'.repeat(10000), priority: 1 },
        { name: 'agents', content: 'a'.repeat(10000), priority: 4 },
        { name: 'keywords', content: 'k'.repeat(10000), priority: 6 },
      ];
      // Total: 30000, over 25000 threshold
      const { result: monitorResult } = monitor.enforce(layers);
      // keywords (priority 6) should be truncated first
      expect(monitorResult.truncatedLayers).toContain('keywords');
    });

    it('should never truncate priority 1 layers', () => {
      const layers: PromptLayer[] = [
        { name: 'claude-md', content: 'x'.repeat(30000), priority: 1 },
        { name: 'rules', content: 'r'.repeat(5000), priority: 5 },
      ];
      // Total: 35000, over 25000 threshold
      // Only rules can be truncated (priority > 1)
      const { layers: result, result: monitorResult } = monitor.enforce(layers);
      // claude-md should survive
      const coreLayer = result.find((l) => l.name === 'claude-md');
      expect(coreLayer).toBeDefined();
      expect(coreLayer!.content).toBe('x'.repeat(30000));
      expect(monitorResult.truncatedLayers).toContain('rules');
      expect(monitorResult.truncatedLayers).not.toContain('claude-md');
    });

    it('should partially truncate large layer when full removal is unnecessary', () => {
      // Set a custom maxChars to make the test precise
      const layers: PromptLayer[] = [
        { name: 'core', content: 'x'.repeat(5000), priority: 1 },
        { name: 'big-rule', content: 'B'.repeat(10000), priority: 5 },
      ];
      // Total: 15000, enforce with maxChars=10000
      const { layers: result, result: monitorResult } = monitor.enforce(layers, 10000);

      // big-rule should be partially truncated, not fully removed
      const bigRule = result.find((l) => l.name === 'big-rule');
      expect(bigRule).toBeDefined();
      expect(bigRule!.content.length).toBeLessThan(10000);
      expect(bigRule!.content).toContain('truncated');
      expect(monitorResult.truncatedLayers).toContain('big-rule');
    });

    it('should return correct truncatedLayers list', () => {
      const layers: PromptLayer[] = [
        { name: 'core', content: 'x'.repeat(10000), priority: 1 },
        { name: 'tools', content: 't'.repeat(5000), priority: 2 },
        { name: 'agents', content: 'a'.repeat(5000), priority: 4 },
        { name: 'rules', content: 'r'.repeat(5000), priority: 5 },
        { name: 'keywords', content: 'k'.repeat(8000), priority: 6 },
      ];
      // Total: 33000, threshold: 25000, excess: 8000
      const { result: monitorResult } = monitor.enforce(layers);
      // keywords (priority 6, 8000 chars) should be truncated first
      expect(monitorResult.truncatedLayers).toContain('keywords');
      // The 8000-char keywords layer fully covers the 8000 excess
    });

    it('should filter out fully emptied layers from result', () => {
      const layers: PromptLayer[] = [
        { name: 'core', content: 'x'.repeat(20000), priority: 1 },
        { name: 'small-ephemeral', content: 'e'.repeat(3000), priority: 6 },
        { name: 'medium-rule', content: 'm'.repeat(5000), priority: 5 },
      ];
      // Total: 28000, threshold: 25000, excess: 3000
      // small-ephemeral (priority 6, 3000 chars) <= excess (3000), fully removed
      const { layers: result } = monitor.enforce(layers);
      const ephem = result.find((l) => l.name === 'small-ephemeral');
      expect(ephem).toBeUndefined();
    });

    it('should handle custom maxChars parameter', () => {
      const layers: PromptLayer[] = [
        { name: 'core', content: 'x'.repeat(5000), priority: 1 },
        { name: 'rules', content: 'r'.repeat(5000), priority: 5 },
      ];
      // Under default threshold but over custom 8000
      const { result: monitorResult } = monitor.enforce(layers, 8000);
      expect(monitorResult.truncatedLayers.length).toBeGreaterThan(0);
    });

    it('should report still-exceeding warning when priority-1 layers alone exceed limit', () => {
      const layers: PromptLayer[] = [
        { name: 'core', content: 'x'.repeat(30000), priority: 1 },
        { name: 'rules', content: 'r'.repeat(1000), priority: 5 },
      ];
      // After removing rules (1000 chars), core alone is 30000 > 25000
      const { result: monitorResult } = monitor.enforce(layers);
      expect(monitorResult.withinBudget).toBe(false);
      expect(monitorResult.warning).toContain('still exceeds limit');
    });
  });
});
