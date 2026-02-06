/**
 * Tests for TaskContinuationEnforcer
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TaskContinuationEnforcer } from '../../src/multi-agent/task-continuation.js';
import type { TaskContinuationConfig } from '../../src/multi-agent/types.js';

describe('TaskContinuationEnforcer', () => {
  let enforcer: TaskContinuationEnforcer;
  const defaultConfig: TaskContinuationConfig = {
    enabled: true,
    max_retries: 3,
  };

  beforeEach(() => {
    enforcer = new TaskContinuationEnforcer(defaultConfig);
  });

  describe('analyzeResponse - completion markers', () => {
    it('should detect "DONE" as complete', () => {
      const result = enforcer.analyzeResponse('agent1', 'ch1', 'Task is DONE.');
      expect(result.isComplete).toBe(true);
      expect(result.reason).toBe('completion_marker_found');
    });

    it('should detect "완료" as complete', () => {
      const result = enforcer.analyzeResponse('agent1', 'ch1', '작업 완료했습니다.');
      expect(result.isComplete).toBe(true);
      expect(result.reason).toBe('completion_marker_found');
    });

    it('should detect "✅" as complete', () => {
      const result = enforcer.analyzeResponse('agent1', 'ch1', '✅ All tasks completed');
      expect(result.isComplete).toBe(true);
      expect(result.reason).toBe('completion_marker_found');
    });

    it('should detect "TASK_COMPLETE" as complete', () => {
      const result = enforcer.analyzeResponse('agent1', 'ch1', 'TASK_COMPLETE');
      expect(result.isComplete).toBe(true);
    });

    it('should detect "finished" as complete', () => {
      const result = enforcer.analyzeResponse('agent1', 'ch1', 'I have finished the task.');
      expect(result.isComplete).toBe(true);
    });

    it('should support custom completion markers', () => {
      const custom = new TaskContinuationEnforcer({
        enabled: true,
        completion_markers: ['SHIP_IT'],
      });
      const result = custom.analyzeResponse('agent1', 'ch1', 'SHIP_IT');
      expect(result.isComplete).toBe(true);
    });
  });

  describe('analyzeResponse - incomplete detection', () => {
    it('should detect "I\'ll continue" as incomplete', () => {
      const result = enforcer.analyzeResponse('agent1', 'ch1', "I'll continue with the next part");
      expect(result.isComplete).toBe(false);
      expect(result.reason).toBe('incomplete_response');
    });

    it('should detect Korean continuation pattern "계속하겠"', () => {
      const result = enforcer.analyzeResponse('agent1', 'ch1', '계속하겠습니다');
      expect(result.isComplete).toBe(false);
    });

    it('should detect Korean continuation pattern "계속할게"', () => {
      const result = enforcer.analyzeResponse('agent1', 'ch1', '계속할게요');
      expect(result.isComplete).toBe(false);
    });

    it('should detect "to be continued" as incomplete', () => {
      const result = enforcer.analyzeResponse('agent1', 'ch1', 'To be continued...');
      expect(result.isComplete).toBe(false);
    });

    it('should detect "let me continue" as incomplete', () => {
      const result = enforcer.analyzeResponse(
        'agent1',
        'ch1',
        'Let me continue with the implementation'
      );
      expect(result.isComplete).toBe(false);
    });

    it('should detect truncated responses near 1800 char limit', () => {
      // Create a response that's near the Discord limit and ends mid-sentence
      const longResponse = 'A'.repeat(1800) + ' and then we need to';
      const result = enforcer.analyzeResponse('agent1', 'ch1', longResponse);
      expect(result.isComplete).toBe(false);
    });

    it('should not flag long responses that end properly', () => {
      const longResponse = 'A'.repeat(1800) + ' and that is all.';
      const result = enforcer.analyzeResponse('agent1', 'ch1', longResponse);
      expect(result.isComplete).toBe(true);
    });
  });

  describe('analyzeResponse - normal responses', () => {
    it('should treat normal responses as complete', () => {
      const result = enforcer.analyzeResponse('agent1', 'ch1', 'Here is the code you requested.');
      expect(result.isComplete).toBe(true);
      expect(result.reason).toBe('normal_response');
    });

    it('should treat short responses as complete', () => {
      const result = enforcer.analyzeResponse('agent1', 'ch1', 'OK');
      expect(result.isComplete).toBe(true);
    });
  });

  describe('continuation attempts tracking', () => {
    it('should increment attempts on incomplete responses', () => {
      const r1 = enforcer.analyzeResponse('agent1', 'ch1', "I'll continue next");
      expect(r1.attempt).toBe(1);

      const r2 = enforcer.analyzeResponse('agent1', 'ch1', '계속하겠습니다');
      expect(r2.attempt).toBe(2);

      const r3 = enforcer.analyzeResponse('agent1', 'ch1', 'Let me continue');
      expect(r3.attempt).toBe(3);
      expect(r3.maxRetriesReached).toBe(true);
    });

    it('should reset attempts on completion', () => {
      enforcer.analyzeResponse('agent1', 'ch1', "I'll continue");
      enforcer.analyzeResponse('agent1', 'ch1', "I'll continue");
      expect(enforcer.getAttemptCount('ch1')).toBe(2);

      enforcer.analyzeResponse('agent1', 'ch1', 'DONE');
      expect(enforcer.getAttemptCount('ch1')).toBe(0);
    });

    it('should reset attempts when agent changes', () => {
      enforcer.analyzeResponse('agent1', 'ch1', "I'll continue");
      expect(enforcer.getAttemptCount('ch1')).toBe(1);

      // Different agent on same channel resets
      enforcer.analyzeResponse('agent2', 'ch1', "I'll continue");
      expect(enforcer.getAttemptCount('ch1')).toBe(1); // Reset to 0 then +1
    });

    it('should track channels independently', () => {
      enforcer.analyzeResponse('agent1', 'ch1', "I'll continue");
      enforcer.analyzeResponse('agent1', 'ch2', "I'll continue");

      expect(enforcer.getAttemptCount('ch1')).toBe(1);
      expect(enforcer.getAttemptCount('ch2')).toBe(1);
    });
  });

  describe('buildContinuationPrompt', () => {
    it('should include tail of previous response', () => {
      const prompt = enforcer.buildContinuationPrompt('Hello world, this is a test');
      expect(prompt).toContain('Hello world, this is a test');
      expect(prompt).toContain('Continue from where you left off');
      expect(prompt).toContain('DONE');
    });

    it('should truncate long responses to last 200 chars', () => {
      const longResponse = 'A'.repeat(300) + 'TAIL';
      const prompt = enforcer.buildContinuationPrompt(longResponse);
      expect(prompt).toContain('TAIL');
      // Should not contain the full 300 A's
      expect(prompt.indexOf('A'.repeat(300))).toBe(-1);
    });
  });

  describe('resetAttempts', () => {
    it('should clear attempt count for a channel', () => {
      enforcer.analyzeResponse('agent1', 'ch1', "I'll continue");
      enforcer.analyzeResponse('agent1', 'ch1', "I'll continue");
      expect(enforcer.getAttemptCount('ch1')).toBe(2);

      enforcer.resetAttempts('ch1');
      expect(enforcer.getAttemptCount('ch1')).toBe(0);
    });
  });

  describe('isEnabled', () => {
    it('should return true when enabled', () => {
      expect(enforcer.isEnabled()).toBe(true);
    });

    it('should return false when disabled', () => {
      const disabled = new TaskContinuationEnforcer({ enabled: false });
      expect(disabled.isEnabled()).toBe(false);
    });
  });

  describe('updateConfig', () => {
    it('should update max_retries', () => {
      enforcer.updateConfig({ enabled: true, max_retries: 1 });

      const r1 = enforcer.analyzeResponse('agent1', 'ch1', "I'll continue");
      expect(r1.maxRetriesReached).toBe(true);
    });

    it('should update completion markers', () => {
      enforcer.updateConfig({
        enabled: true,
        completion_markers: ['CUSTOM_DONE'],
      });

      // Old marker should not work
      const r1 = enforcer.analyzeResponse('agent1', 'ch1', 'DONE');
      expect(r1.reason).toBe('normal_response'); // Not completion_marker_found

      // New marker should work
      const r2 = enforcer.analyzeResponse('agent1', 'ch2', 'CUSTOM_DONE');
      expect(r2.isComplete).toBe(true);
      expect(r2.reason).toBe('completion_marker_found');
    });
  });
});
