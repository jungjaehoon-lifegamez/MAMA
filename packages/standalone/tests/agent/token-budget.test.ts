/**
 * Unit tests for Token Budget Enforcement (STORY-008)
 *
 * Uses forceFallbackMode() for deterministic token counts.
 * Fallback: countTokens(text) = Math.ceil(byteLength * 0.4)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  TokenBudgetExceededError,
  calculateBudget,
  enforceBudget,
  getModelLimit,
} from '../../src/agent/token-budget.js';
import { forceFallbackMode, resetTokenEstimator } from '../../src/agent/token-estimator.js';

describe('TokenBudget', () => {
  beforeEach(() => {
    resetTokenEstimator();
    forceFallbackMode();
  });

  describe('getModelLimit()', () => {
    it('should return 180K for claude models', () => {
      expect(getModelLimit('claude-sonnet-4-6')).toBe(180_000);
      expect(getModelLimit('claude-opus-4-5-20251101')).toBe(180_000);
    });

    it('should return 120K for codex models', () => {
      expect(getModelLimit('codex-mini-latest')).toBe(120_000);
    });

    it('should return 120K for gpt models', () => {
      expect(getModelLimit('gpt-5.3-codex')).toBe(120_000);
    });

    it('should be case-insensitive', () => {
      expect(getModelLimit('Claude-Sonnet-4-6')).toBe(180_000);
    });

    it('should return 120K for unknown models (fail-closed)', () => {
      expect(getModelLimit('unknown-model-xyz')).toBe(120_000);
    });
  });

  describe('calculateBudget()', () => {
    it('should break down tokens by category', () => {
      // 100 chars → 40 tokens each in fallback mode
      const budget = calculateBudget(
        'claude-sonnet-4-6',
        'x'.repeat(100),
        'y'.repeat(100),
        'z'.repeat(100)
      );
      expect(budget.systemTokens).toBe(40);
      expect(budget.toolsTokens).toBe(40);
      expect(budget.historyTokens).toBe(40);
      expect(budget.totalTokens).toBe(120);
      expect(budget.limitTokens).toBe(180_000);
      expect(budget.withinBudget).toBe(true);
      expect(budget.model).toBe('claude-sonnet-4-6');
    });

    it('should handle empty tools and history', () => {
      const budget = calculateBudget('claude-sonnet-4-6', 'hello');
      expect(budget.toolsTokens).toBe(0);
      expect(budget.historyTokens).toBe(0);
      expect(budget.totalTokens).toBe(budget.systemTokens);
    });

    it('should report not within budget when over limit', () => {
      // Force over limit: need > 180K tokens in fallback = > 450K chars
      // Use smaller model limit approach: codex = 120K tokens → need > 300K chars
      // Actually just test with a small custom scenario
      // 500000 chars → 200000 tokens > 180000 claude limit
      const budget = calculateBudget('claude-sonnet-4-6', 'x'.repeat(500_000));
      expect(budget.withinBudget).toBe(false);
      expect(budget.totalTokens).toBe(200_000);
    });
  });

  describe('enforceBudget()', () => {
    it('should return budget when within limit', () => {
      const budget = enforceBudget('claude-sonnet-4-6', 'hello world');
      expect(budget.withinBudget).toBe(true);
    });

    it('should throw TokenBudgetExceededError when over limit', () => {
      expect(() => {
        enforceBudget('claude-sonnet-4-6', 'x'.repeat(500_000));
      }).toThrow(TokenBudgetExceededError);
    });

    it('should include budget details in error', () => {
      try {
        enforceBudget('claude-sonnet-4-6', 'x'.repeat(500_000), 'y'.repeat(100));
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(TokenBudgetExceededError);
        const e = err as TokenBudgetExceededError;
        expect(e.code).toBe('TOKEN_BUDGET_EXCEEDED');
        expect(e.budget.model).toBe('claude-sonnet-4-6');
        expect(e.budget.limitTokens).toBe(180_000);
        expect(e.budget.systemTokens).toBe(200_000);
        expect(e.budget.toolsTokens).toBe(40);
        expect(e.budget.totalTokens).toBeGreaterThan(180_000);
      }
    });

    it('should include readable error message', () => {
      try {
        enforceBudget('codex-mini-latest', 'x'.repeat(400_000));
        expect.fail('Should have thrown');
      } catch (err) {
        const e = err as TokenBudgetExceededError;
        expect(e.message).toContain('codex-mini-latest');
        expect(e.message).toContain('120000 limit');
        expect(e.message).toContain('system=');
        expect(e.message).toContain('tools=');
        expect(e.message).toContain('history=');
      }
    });
  });
});
