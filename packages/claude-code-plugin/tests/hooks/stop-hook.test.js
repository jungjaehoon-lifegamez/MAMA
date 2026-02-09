/**
 * Tests for Stop Hook - Auto-Continuation Detection
 *
 * Tests: incomplete detection, completion markers, truncation heuristic,
 * continuation prompt building, max retries, feature gating.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const hookPath = path.join(__dirname, '../../scripts/stop-hook.js');
const hook = require(hookPath);

const originalEnv = { ...process.env };

describe('Stop Hook - Auto-Continuation Detection', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Hook Structure', () => {
    it('should export required functions', () => {
      expect(hook).toHaveProperty('isIncomplete');
      expect(hook).toHaveProperty('hasCompletionMarker');
      expect(hook).toHaveProperty('buildContinuationPrompt');
      expect(typeof hook.isIncomplete).toBe('function');
      expect(typeof hook.hasCompletionMarker).toBe('function');
      expect(typeof hook.buildContinuationPrompt).toBe('function');
    });

    it('should be executable script with shebang', () => {
      const content = fs.readFileSync(hookPath, 'utf8');
      expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
    });

    it('should export INCOMPLETE_PATTERNS and COMPLETION_MARKERS', () => {
      expect(Array.isArray(hook.INCOMPLETE_PATTERNS)).toBe(true);
      expect(Array.isArray(hook.COMPLETION_MARKERS)).toBe(true);
      expect(hook.INCOMPLETE_PATTERNS.length).toBeGreaterThan(0);
      expect(hook.COMPLETION_MARKERS.length).toBeGreaterThan(0);
    });
  });

  describe('Incomplete Detection: Explicit Patterns', () => {
    it('should detect "I\'ll continue" pattern', () => {
      expect(hook.isIncomplete("I'll continue with the next step")).toBe(true);
    });

    it('should detect "to be continued" pattern', () => {
      expect(hook.isIncomplete('To be continued in the next message')).toBe(true);
    });

    it('should detect "let me continue" pattern', () => {
      expect(hook.isIncomplete('Let me continue from where I left off')).toBe(true);
    });

    it('should detect Korean continuation pattern "계속하겠"', () => {
      expect(hook.isIncomplete('다음에 계속하겠습니다')).toBe(true);
    });

    it('should detect Korean continuation pattern "계속할게"', () => {
      expect(hook.isIncomplete('계속할게요')).toBe(true);
    });

    it('should detect Korean pattern "이어서"', () => {
      expect(hook.isIncomplete('이어서 작업하겠습니다')).toBe(true);
    });

    it('should detect Korean pattern "다음으로"', () => {
      expect(hook.isIncomplete('다음으로 넘어가겠습니다')).toBe(true);
    });

    it('should not detect incomplete in normal short response', () => {
      expect(hook.isIncomplete('The function works correctly.')).toBe(false);
    });
  });

  describe('Incomplete Detection: Truncation Heuristic', () => {
    it('should detect truncation when response >= 1800 chars without terminal punctuation', () => {
      const longText = 'a'.repeat(1800) + ' and then we';
      expect(hook.isIncomplete(longText)).toBe(true);
    });

    it('should not detect truncation when response ends with period', () => {
      const longText = 'a'.repeat(1800) + ' completed.';
      expect(hook.isIncomplete(longText)).toBe(false);
    });

    it('should not detect truncation when response ends with question mark', () => {
      const longText = 'a'.repeat(1800) + ' correct?';
      expect(hook.isIncomplete(longText)).toBe(false);
    });

    it('should not detect truncation when response ends with exclamation', () => {
      const longText = 'a'.repeat(1800) + ' done!';
      expect(hook.isIncomplete(longText)).toBe(false);
    });

    it('should not detect truncation for short responses', () => {
      expect(hook.isIncomplete('Short response without punctuation')).toBe(false);
    });

    it('should handle trailing whitespace in truncation check', () => {
      const longText = 'a'.repeat(1800) + ' incomplete   \n  ';
      expect(hook.isIncomplete(longText)).toBe(true);
    });
  });

  describe('Completion Markers', () => {
    it('should detect "DONE" in last 3 lines', () => {
      expect(hook.hasCompletionMarker('Line 1\nLine 2\nDONE')).toBe(true);
    });

    it('should detect "FINISHED" in last 3 lines', () => {
      expect(hook.hasCompletionMarker('Line 1\nFINISHED\nLine 3')).toBe(true);
    });

    it('should detect "TASK_COMPLETE" in last 3 lines', () => {
      expect(hook.hasCompletionMarker('Some work\nTASK_COMPLETE')).toBe(true);
    });

    it('should detect completion marker case-insensitively', () => {
      expect(hook.hasCompletionMarker('Some work\ndone\n')).toBe(true);
    });

    it('should not detect marker if beyond last 3 lines', () => {
      expect(hook.hasCompletionMarker('DONE\nLine 2\nLine 3\nLine 4\nLine 5')).toBe(false);
    });

    it('should not detect marker in empty response', () => {
      expect(hook.hasCompletionMarker('')).toBe(false);
    });
  });

  describe('Continuation Prompt', () => {
    it('should build prompt with tail of previous response', () => {
      const response = 'Previous response content here';
      const prompt = hook.buildContinuationPrompt(response);
      expect(prompt).toContain('Continue from where you left off');
      expect(prompt).toContain(response);
      expect(prompt).toContain('DONE');
    });

    it('should truncate long responses to last 200 chars', () => {
      const response = 'x'.repeat(300);
      const prompt = hook.buildContinuationPrompt(response);
      // Should contain the last 200 chars, not the full 300
      expect(prompt).not.toContain('x'.repeat(300));
      expect(prompt).toContain('x'.repeat(200));
    });

    it('should include completion marker instructions', () => {
      const prompt = hook.buildContinuationPrompt('some text');
      expect(prompt).toContain('FINISHED');
      expect(prompt).toContain('TASK_COMPLETE');
    });
  });

  describe('Feature Gating', () => {
    it('should check memory feature flag', () => {
      const content = fs.readFileSync(hookPath, 'utf8');
      expect(content).toContain("features.has('memory')");
    });

    it('should check recursion guard env var', () => {
      const content = fs.readFileSync(hookPath, 'utf8');
      expect(content).toContain('MAMA_STOP_HOOK_ACTIVE');
    });

    it('should track max retries', () => {
      const content = fs.readFileSync(hookPath, 'utf8');
      expect(content).toContain('MAX_RETRIES');
      expect(content).toContain('state.retries');
    });
  });
});
