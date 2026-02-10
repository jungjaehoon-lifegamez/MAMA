import { describe, it, expect, beforeEach } from 'vitest';
import { StopContinuationHandler } from '../../src/agent/stop-continuation-handler.js';

describe('StopContinuationHandler', () => {
  let handler: StopContinuationHandler;

  describe('analyzeResponse() - disabled handler', () => {
    beforeEach(() => {
      handler = new StopContinuationHandler({ enabled: false });
    });

    it('should return disabled decision when handler is disabled', () => {
      const decision = handler.analyzeResponse('channel1', 'Some response');
      expect(decision.shouldContinue).toBe(false);
      expect(decision.reason).toBe('disabled');
      expect(decision.attempt).toBe(0);
      expect(decision.maxRetriesReached).toBe(false);
    });

    it('should not set continuationPrompt when disabled', () => {
      const decision = handler.analyzeResponse('channel1', 'Some response');
      expect(decision.continuationPrompt).toBeUndefined();
    });
  });

  describe('analyzeResponse() - completion markers', () => {
    beforeEach(() => {
      handler = new StopContinuationHandler({ enabled: true });
    });

    it('should detect DONE marker in last 3 lines', () => {
      const response = 'Line 1\nLine 2\nDONE';
      const decision = handler.analyzeResponse('channel1', response);
      expect(decision.shouldContinue).toBe(false);
      expect(decision.reason).toBe('complete');
    });

    it('should detect FINISHED marker in last 3 lines', () => {
      const response = 'Line 1\nLine 2\nFINISHED';
      const decision = handler.analyzeResponse('channel1', response);
      expect(decision.shouldContinue).toBe(false);
      expect(decision.reason).toBe('complete');
    });

    it('should detect ✅ marker in last 3 lines', () => {
      const response = 'Line 1\nLine 2\n✅';
      const decision = handler.analyzeResponse('channel1', response);
      expect(decision.shouldContinue).toBe(false);
      expect(decision.reason).toBe('complete');
    });

    it('should detect TASK_COMPLETE marker in last 3 lines', () => {
      const response = 'Line 1\nLine 2\nTASK_COMPLETE';
      const decision = handler.analyzeResponse('channel1', response);
      expect(decision.shouldContinue).toBe(false);
      expect(decision.reason).toBe('complete');
    });

    it('should be case-insensitive for markers', () => {
      const response = 'Line 1\nLine 2\ndone';
      const decision = handler.analyzeResponse('channel1', response);
      expect(decision.shouldContinue).toBe(false);
      expect(decision.reason).toBe('complete');
    });

    it('should check only last 3 lines for markers', () => {
      const response = 'DONE\nLine 2\nLine 3\nLine 4\nLine 5';
      const decision = handler.analyzeResponse('channel1', response);
      expect(decision.shouldContinue).toBe(false);
      expect(decision.reason).toBe('normal_completion');
    });

    it('should reset channel state when completion marker found', () => {
      handler.analyzeResponse('channel1', 'Line 1\nLine 2\nDONE');
      expect(handler.getAttemptCount('channel1')).toBe(0);
      expect(handler.isStopped('channel1')).toBe(false);
    });
  });

  describe('analyzeResponse() - English incomplete patterns', () => {
    beforeEach(() => {
      handler = new StopContinuationHandler({ enabled: true });
    });

    it('should detect "I\'ll continue" pattern', () => {
      const response = "Some text. I'll continue with the next part.";
      const decision = handler.analyzeResponse('channel1', response);
      expect(decision.shouldContinue).toBe(true);
      expect(decision.reason).toBe('incomplete_response');
    });

    it('should detect "let me continue" pattern', () => {
      const response = 'Some text. Let me continue with more details.';
      const decision = handler.analyzeResponse('channel1', response);
      expect(decision.shouldContinue).toBe(true);
      expect(decision.reason).toBe('incomplete_response');
    });

    it('should detect "to be continued" pattern', () => {
      const response = 'Some text. To be continued...';
      const decision = handler.analyzeResponse('channel1', response);
      expect(decision.shouldContinue).toBe(true);
      expect(decision.reason).toBe('incomplete_response');
    });

    it('should be case-insensitive for English patterns', () => {
      const response = "Some text. I'LL CONTINUE with more.";
      const decision = handler.analyzeResponse('channel1', response);
      expect(decision.shouldContinue).toBe(true);
      expect(decision.reason).toBe('incomplete_response');
    });

    it('should increment attempt count on incomplete pattern', () => {
      handler.analyzeResponse('channel1', "I'll continue with more.");
      expect(handler.getAttemptCount('channel1')).toBe(1);
    });
  });

  describe('analyzeResponse() - Korean incomplete patterns', () => {
    beforeEach(() => {
      handler = new StopContinuationHandler({ enabled: true });
    });

    it('should detect 계속하겠 pattern', () => {
      const response = '일부 텍스트. 계속하겠습니다.';
      const decision = handler.analyzeResponse('channel1', response);
      expect(decision.shouldContinue).toBe(true);
      expect(decision.reason).toBe('incomplete_response');
    });

    it('should detect 계속할게 pattern', () => {
      const response = '일부 텍스트. 계속할게요.';
      const decision = handler.analyzeResponse('channel1', response);
      expect(decision.shouldContinue).toBe(true);
      expect(decision.reason).toBe('incomplete_response');
    });

    it('should detect 이어서 pattern', () => {
      const response = '일부 텍스트. 이어서 계속하겠습니다.';
      const decision = handler.analyzeResponse('channel1', response);
      expect(decision.shouldContinue).toBe(true);
      expect(decision.reason).toBe('incomplete_response');
    });

    it('should detect 다음으로 pattern', () => {
      const response = '일부 텍스트. 다음으로 진행하겠습니다.';
      const decision = handler.analyzeResponse('channel1', response);
      expect(decision.shouldContinue).toBe(true);
      expect(decision.reason).toBe('incomplete_response');
    });
  });

  describe('analyzeResponse() - truncation detection', () => {
    beforeEach(() => {
      handler = new StopContinuationHandler({ enabled: true });
    });

    it('should detect truncation when response >= 1800 chars without terminal punctuation', () => {
      const longText = 'a'.repeat(1800);
      const decision = handler.analyzeResponse('channel1', longText);
      expect(decision.shouldContinue).toBe(true);
      expect(decision.reason).toBe('incomplete_response');
    });

    it('should not trigger truncation for responses < 1800 chars', () => {
      const shortText = 'a'.repeat(1799);
      const decision = handler.analyzeResponse('channel1', shortText);
      expect(decision.shouldContinue).toBe(false);
      expect(decision.reason).toBe('normal_completion');
    });

    it('should not trigger truncation if response ends with period', () => {
      const longText = 'a'.repeat(1800) + '.';
      const decision = handler.analyzeResponse('channel1', longText);
      expect(decision.shouldContinue).toBe(false);
      expect(decision.reason).toBe('normal_completion');
    });

    it('should not trigger truncation if response ends with exclamation mark', () => {
      const longText = 'a'.repeat(1800) + '!';
      const decision = handler.analyzeResponse('channel1', longText);
      expect(decision.shouldContinue).toBe(false);
      expect(decision.reason).toBe('normal_completion');
    });

    it('should not trigger truncation if response ends with question mark', () => {
      const longText = 'a'.repeat(1800) + '?';
      const decision = handler.analyzeResponse('channel1', longText);
      expect(decision.shouldContinue).toBe(false);
      expect(decision.reason).toBe('normal_completion');
    });

    it('should not trigger truncation if response ends with Chinese period', () => {
      const longText = 'a'.repeat(1800) + '。';
      const decision = handler.analyzeResponse('channel1', longText);
      expect(decision.shouldContinue).toBe(false);
      expect(decision.reason).toBe('normal_completion');
    });

    it('should not trigger truncation if response ends with ellipsis', () => {
      const longText = 'a'.repeat(1800) + '…';
      const decision = handler.analyzeResponse('channel1', longText);
      expect(decision.shouldContinue).toBe(false);
      expect(decision.reason).toBe('normal_completion');
    });

    it('should ignore trailing whitespace when checking terminal punctuation', () => {
      const longText = 'a'.repeat(1800) + '.   \n  ';
      const decision = handler.analyzeResponse('channel1', longText);
      expect(decision.shouldContinue).toBe(false);
      expect(decision.reason).toBe('normal_completion');
    });
  });

  describe('analyzeResponse() - max retries', () => {
    beforeEach(() => {
      handler = new StopContinuationHandler({ enabled: true, maxRetries: 3 });
    });

    it('should return maxRetriesReached after N attempts', () => {
      handler.analyzeResponse('channel1', "I'll continue");
      handler.analyzeResponse('channel1', "I'll continue");
      handler.analyzeResponse('channel1', "I'll continue");
      const decision = handler.analyzeResponse('channel1', "I'll continue");
      expect(decision.shouldContinue).toBe(false);
      expect(decision.reason).toBe('max_retries_reached');
      expect(decision.maxRetriesReached).toBe(true);
    });

    it('should reset channel after max retries reached', () => {
      handler.analyzeResponse('channel1', "I'll continue");
      handler.analyzeResponse('channel1', "I'll continue");
      handler.analyzeResponse('channel1', "I'll continue");
      handler.analyzeResponse('channel1', "I'll continue");
      expect(handler.getAttemptCount('channel1')).toBe(0);
    });

    it('should respect custom maxRetries config', () => {
      const customHandler = new StopContinuationHandler({ enabled: true, maxRetries: 2 });
      customHandler.analyzeResponse('channel1', "I'll continue");
      customHandler.analyzeResponse('channel1', "I'll continue");
      const decision = customHandler.analyzeResponse('channel1', "I'll continue");
      expect(decision.reason).toBe('max_retries_reached');
    });

    it('should set maxRetriesReached flag when at limit', () => {
      handler.analyzeResponse('channel1', "I'll continue");
      handler.analyzeResponse('channel1', "I'll continue");
      const decision = handler.analyzeResponse('channel1', "I'll continue");
      expect(decision.maxRetriesReached).toBe(true);
    });
  });

  describe('analyzeResponse() - per-channel state isolation', () => {
    beforeEach(() => {
      handler = new StopContinuationHandler({ enabled: true, maxRetries: 3 });
    });

    it('should track attempts separately for different channels', () => {
      handler.analyzeResponse('channel1', "I'll continue");
      handler.analyzeResponse('channel2', "I'll continue");
      expect(handler.getAttemptCount('channel1')).toBe(1);
      expect(handler.getAttemptCount('channel2')).toBe(1);
    });

    it('should not interfere with other channels when one reaches max retries', () => {
      handler.analyzeResponse('channel1', "I'll continue");
      handler.analyzeResponse('channel1', "I'll continue");
      handler.analyzeResponse('channel1', "I'll continue");
      handler.analyzeResponse('channel1', "I'll continue");
      expect(handler.getAttemptCount('channel1')).toBe(0);
      expect(handler.getAttemptCount('channel2')).toBe(0);
    });

    it('should maintain separate stopped state for channels', () => {
      handler.markStopped('channel1');
      expect(handler.isStopped('channel1')).toBe(true);
      expect(handler.isStopped('channel2')).toBe(false);
    });
  });

  describe('markStopped()', () => {
    beforeEach(() => {
      handler = new StopContinuationHandler({ enabled: true });
    });

    it('should prevent continuation when channel is manually stopped', () => {
      handler.markStopped('channel1');
      const decision = handler.analyzeResponse('channel1', "I'll continue");
      expect(decision.shouldContinue).toBe(false);
      expect(decision.reason).toBe('manually_stopped');
    });

    it('should return manually_stopped reason', () => {
      handler.markStopped('channel1');
      const decision = handler.analyzeResponse('channel1', 'Some response');
      expect(decision.reason).toBe('manually_stopped');
    });

    it('should preserve attempt count when manually stopped', () => {
      handler.analyzeResponse('channel1', "I'll continue");
      handler.markStopped('channel1');
      const decision = handler.analyzeResponse('channel1', "I'll continue");
      expect(decision.attempt).toBe(1);
    });
  });

  describe('resetChannel()', () => {
    beforeEach(() => {
      handler = new StopContinuationHandler({ enabled: true });
    });

    it('should clear attempts for a channel', () => {
      handler.analyzeResponse('channel1', "I'll continue");
      handler.resetChannel('channel1');
      expect(handler.getAttemptCount('channel1')).toBe(0);
    });

    it('should clear stopped state for a channel', () => {
      handler.markStopped('channel1');
      handler.resetChannel('channel1');
      expect(handler.isStopped('channel1')).toBe(false);
    });

    it('should clear both attempts and stopped state', () => {
      handler.analyzeResponse('channel1', "I'll continue");
      handler.markStopped('channel1');
      handler.resetChannel('channel1');
      expect(handler.getAttemptCount('channel1')).toBe(0);
      expect(handler.isStopped('channel1')).toBe(false);
    });

    it('should not affect other channels', () => {
      handler.analyzeResponse('channel1', "I'll continue");
      handler.analyzeResponse('channel2', "I'll continue");
      handler.resetChannel('channel1');
      expect(handler.getAttemptCount('channel1')).toBe(0);
      expect(handler.getAttemptCount('channel2')).toBe(1);
    });
  });

  describe('isEnabled()', () => {
    it('should return true when enabled', () => {
      handler = new StopContinuationHandler({ enabled: true });
      expect(handler.isEnabled()).toBe(true);
    });

    it('should return false when disabled', () => {
      handler = new StopContinuationHandler({ enabled: false });
      expect(handler.isEnabled()).toBe(false);
    });

    it('should default to false', () => {
      handler = new StopContinuationHandler();
      expect(handler.isEnabled()).toBe(false);
    });
  });

  describe('getAttemptCount()', () => {
    beforeEach(() => {
      handler = new StopContinuationHandler({ enabled: true });
    });

    it('should return 0 for unknown channel', () => {
      expect(handler.getAttemptCount('unknown')).toBe(0);
    });

    it('should track attempt count correctly', () => {
      handler.analyzeResponse('channel1', "I'll continue");
      expect(handler.getAttemptCount('channel1')).toBe(1);
      handler.analyzeResponse('channel1', "I'll continue");
      expect(handler.getAttemptCount('channel1')).toBe(2);
    });

    it('should return 0 after reset', () => {
      handler.analyzeResponse('channel1', "I'll continue");
      handler.resetChannel('channel1');
      expect(handler.getAttemptCount('channel1')).toBe(0);
    });
  });

  describe('isStopped()', () => {
    beforeEach(() => {
      handler = new StopContinuationHandler({ enabled: true });
    });

    it('should return false for unknown channel', () => {
      expect(handler.isStopped('unknown')).toBe(false);
    });

    it('should return true when channel is manually stopped', () => {
      handler.markStopped('channel1');
      expect(handler.isStopped('channel1')).toBe(true);
    });

    it('should return false after reset', () => {
      handler.markStopped('channel1');
      handler.resetChannel('channel1');
      expect(handler.isStopped('channel1')).toBe(false);
    });
  });

  describe('buildContinuationPrompt()', () => {
    beforeEach(() => {
      handler = new StopContinuationHandler({ enabled: true });
    });

    it('should include tail of previous response', () => {
      const response = "I'll continue with more details.";
      const decision = handler.analyzeResponse('channel1', response);
      expect(decision.continuationPrompt).toContain(response);
    });

    it('should include last 200 characters for long responses', () => {
      const longText = 'a'.repeat(1800);
      const decision = handler.analyzeResponse('channel1', longText);
      expect(decision.continuationPrompt).toContain('a'.repeat(200));
    });

    it('should include full response for short incomplete responses', () => {
      const shortText = "I'll continue with more.";
      const decision = handler.analyzeResponse('channel1', shortText);
      expect(decision.continuationPrompt).toContain(shortText);
    });

    it('should include instruction to end with completion marker', () => {
      const response = "I'll continue.";
      const decision = handler.analyzeResponse('channel1', response);
      expect(decision.continuationPrompt).toContain('"DONE"');
      expect(decision.continuationPrompt).toContain('"FINISHED"');
    });

    it('should include context markers', () => {
      const response = "I'll continue.";
      const decision = handler.analyzeResponse('channel1', response);
      expect(decision.continuationPrompt).toContain('---');
      expect(decision.continuationPrompt).toContain('Continue from where you left off');
    });
  });

  describe('normal completion', () => {
    beforeEach(() => {
      handler = new StopContinuationHandler({ enabled: true });
    });

    it('should return normal_completion for complete response', () => {
      const response = 'This is a complete response.';
      const decision = handler.analyzeResponse('channel1', response);
      expect(decision.shouldContinue).toBe(false);
      expect(decision.reason).toBe('normal_completion');
    });

    it('should reset channel state on normal completion', () => {
      handler.analyzeResponse('channel1', "I'll continue");
      handler.analyzeResponse('channel1', 'This is complete.');
      expect(handler.getAttemptCount('channel1')).toBe(0);
    });

    it('should not set continuationPrompt on normal completion', () => {
      const decision = handler.analyzeResponse('channel1', 'Complete response.');
      expect(decision.continuationPrompt).toBeUndefined();
    });

    it('should set attempt to 0 on normal completion', () => {
      const decision = handler.analyzeResponse('channel1', 'Complete response.');
      expect(decision.attempt).toBe(0);
    });
  });

  describe('constructor defaults', () => {
    it('should use default config when none provided', () => {
      handler = new StopContinuationHandler();
      expect(handler.isEnabled()).toBe(false);
    });

    it('should merge partial config with defaults', () => {
      handler = new StopContinuationHandler({ enabled: true });
      expect(handler.isEnabled()).toBe(true);
    });

    it('should respect custom maxRetries', () => {
      handler = new StopContinuationHandler({ enabled: true, maxRetries: 5 });
      handler.analyzeResponse('channel1', "I'll continue");
      handler.analyzeResponse('channel1', "I'll continue");
      handler.analyzeResponse('channel1', "I'll continue");
      handler.analyzeResponse('channel1', "I'll continue");
      handler.analyzeResponse('channel1', "I'll continue");
      const decision = handler.analyzeResponse('channel1', "I'll continue");
      expect(decision.reason).toBe('max_retries_reached');
    });

    it('should respect custom completionMarkers', () => {
      handler = new StopContinuationHandler({
        enabled: true,
        completionMarkers: ['FINISHED', 'END'],
      });
      const decision = handler.analyzeResponse('channel1', 'Line 1\nLine 2\nFINISHED');
      expect(decision.reason).toBe('complete');
    });
  });

  describe('decision object structure', () => {
    beforeEach(() => {
      handler = new StopContinuationHandler({ enabled: true });
    });

    it('should always include shouldContinue', () => {
      const decision = handler.analyzeResponse('channel1', 'test');
      expect(decision).toHaveProperty('shouldContinue');
      expect(typeof decision.shouldContinue).toBe('boolean');
    });

    it('should always include reason', () => {
      const decision = handler.analyzeResponse('channel1', 'test');
      expect(decision).toHaveProperty('reason');
      expect(typeof decision.reason).toBe('string');
    });

    it('should always include attempt', () => {
      const decision = handler.analyzeResponse('channel1', 'test');
      expect(decision).toHaveProperty('attempt');
      expect(typeof decision.attempt).toBe('number');
    });

    it('should always include maxRetriesReached', () => {
      const decision = handler.analyzeResponse('channel1', 'test');
      expect(decision).toHaveProperty('maxRetriesReached');
      expect(typeof decision.maxRetriesReached).toBe('boolean');
    });

    it('should only include continuationPrompt when shouldContinue is true', () => {
      const incompleteDecision = handler.analyzeResponse('channel1', "I'll continue");
      expect(incompleteDecision.continuationPrompt).toBeDefined();

      const completeDecision = handler.analyzeResponse('channel2', 'Complete.');
      expect(completeDecision.continuationPrompt).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    beforeEach(() => {
      handler = new StopContinuationHandler({ enabled: true });
    });

    it('should handle empty response', () => {
      const decision = handler.analyzeResponse('channel1', '');
      expect(decision.shouldContinue).toBe(false);
      expect(decision.reason).toBe('normal_completion');
    });

    it('should handle response with only whitespace', () => {
      const decision = handler.analyzeResponse('channel1', '   \n  \t  ');
      expect(decision.shouldContinue).toBe(false);
      expect(decision.reason).toBe('normal_completion');
    });

    it('should handle response with only newlines', () => {
      const decision = handler.analyzeResponse('channel1', '\n\n\n');
      expect(decision.shouldContinue).toBe(false);
      expect(decision.reason).toBe('normal_completion');
    });

    it('should handle very long channel keys', () => {
      const longKey = 'a'.repeat(1000);
      const _decision = handler.analyzeResponse(longKey, 'test');
      expect(handler.getAttemptCount(longKey)).toBe(0);
    });

    it('should handle special characters in response', () => {
      const response = '!@#$%^&*()_+-=[]{}|;:,.<>?';
      const decision = handler.analyzeResponse('channel1', response);
      expect(decision.shouldContinue).toBe(false);
    });

    it('should handle mixed language response', () => {
      const response = "English text 한글 텍스트 I'll continue";
      const decision = handler.analyzeResponse('channel1', response);
      expect(decision.shouldContinue).toBe(true);
      expect(decision.reason).toBe('incomplete_response');
    });
  });
});
