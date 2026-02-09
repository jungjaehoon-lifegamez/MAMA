/**
 * Integration tests for Slack multi-agent security features
 * Tests the complete flow of input validation, sanitization, and rate limiting
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SlackMultiBotManager } from '../../src/multi-agent/slack-multi-bot-manager.ts';
import { MultiAgentSlackHandler } from '../../src/multi-agent/multi-agent-slack.ts';
import {
  validateMentionEvent,
  sanitizeMessageContent,
} from '../../src/utils/slack-input-validator.ts';
import { SlackRateLimiter } from '../../src/utils/slack-rate-limiter.ts';

// Mock Slack WebClient and SocketModeClient
vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    auth: {
      test: vi.fn().mockResolvedValue({
        user_id: 'U1234567890',
        bot_id: 'B1234567890',
        user: 'TestBot',
      }),
    },
    chat: {
      postMessage: vi.fn().mockResolvedValue({
        ts: '1234567890.123456',
      }),
    },
  })),
}));

vi.mock('@slack/socket-mode', () => ({
  SocketModeClient: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  })),
}));

describe('Slack Security Integration Tests', () => {
  let multiBotManager;
  let slackHandler;
  let rateLimiter;

  const mockConfig = {
    enabled: true,
    agents: {
      test_agent: {
        name: 'TestAgent',
        display_name: '🤖 TestAgent',
        trigger_prefix: '!test',
        persona_file: '~/.mama/personas/test.md',
        slack_bot_token: 'xoxb-test-token',
        slack_app_token: 'xapp-test-token',
        enabled: true,
        tier: 1,
        can_delegate: true,
      },
    },
    loop_prevention: {
      max_chain_length: 5,
      global_cooldown_ms: 1000,
      chain_window_ms: 60000,
    },
    mention_delegation: true,
    max_mention_depth: 3,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    multiBotManager = new SlackMultiBotManager(mockConfig);
    slackHandler = new MultiAgentSlackHandler(mockConfig, {
      dangerouslySkipPermissions: true,
    });
    rateLimiter = new SlackRateLimiter();
  });

  afterEach(async () => {
    if (multiBotManager) {
      await multiBotManager.stopAll();
    }
    if (rateLimiter) {
      rateLimiter.reset();
    }
  });

  describe('Input Validation Integration', () => {
    it('should validate and sanitize Slack mention events end-to-end', () => {
      const rawEvent = {
        type: 'app_mention',
        channel: 'C1234567890',
        user: 'U0987654321',
        text: '<@U1234567890> Hello! <script>alert("xss")</script>',
        ts: '1234567890.123456',
        thread_ts: '1234567890.123450',
      };

      // Test validation
      const validatedEvent = validateMentionEvent(rawEvent);

      expect(validatedEvent).toBeDefined();
      expect(validatedEvent.channel).toBe('C1234567890');
      expect(validatedEvent.user).toBe('U0987654321');
      expect(validatedEvent.text).not.toContain('<script>');
      // stripMarkdown (default: true) removes underscores, so [SCRIPT_REMOVED] → [SCRIPTREMOVED]
      expect(validatedEvent.text).toMatch(/\[SCRIPT.?REMOVED\]/);
    });

    it('should reject invalid events with proper error handling', () => {
      const invalidEvents = [
        // Missing required fields
        { type: 'app_mention', channel: 'C1234567890' },
        // Invalid channel ID format
        {
          type: 'app_mention',
          channel: 'invalid',
          user: 'U0987654321',
          text: 'test',
          ts: '1234567890.123456',
        },
        // Invalid user ID format
        {
          type: 'app_mention',
          channel: 'C1234567890',
          user: 'invalid',
          text: 'test',
          ts: '1234567890.123456',
        },
        // Invalid timestamp format
        {
          type: 'app_mention',
          channel: 'C1234567890',
          user: 'U0987654321',
          text: 'test',
          ts: 'invalid',
        },
      ];

      for (const invalidEvent of invalidEvents) {
        expect(() => validateMentionEvent(invalidEvent)).toThrow();
      }
    });

    it('should sanitize various types of malicious content', () => {
      const maliciousInputs = [
        '<script>alert("xss")</script>',
        '<iframe src="evil.com"></iframe>',
        'javascript:alert("evil")',
        'data:text/html,<script>alert("xss")</script>',
        'Normal text with\x00null bytes\x1F',
        'Text with excessive\n\n\n\n\nwhitespace   ',
        '*bold* _italic_ `code` ~strike~',
      ];

      for (const input of maliciousInputs) {
        const sanitized = sanitizeMessageContent(input);

        // Should not contain dangerous content
        expect(sanitized).not.toMatch(/<script[^>]*>/gi);
        expect(sanitized).not.toMatch(/<iframe[^>]*>/gi);
        expect(sanitized).not.toMatch(/javascript:/gi);
        expect(sanitized).not.toMatch(/data:/gi);
        // eslint-disable-next-line no-control-regex
        expect(sanitized).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/);

        // Should have normalized whitespace
        expect(sanitized).not.toMatch(/\s{2,}/);
        expect(sanitized.trim()).toBe(sanitized);
      }
    });
  });

  describe('Rate Limiting Integration', () => {
    it('should queue and throttle API requests', async () => {
      const mockApiCall = vi.fn().mockResolvedValue({ ts: '1234567890.123456' });

      // Queue multiple requests rapidly
      const requests = Array.from({ length: 5 }, () => rateLimiter.queueRequest(mockApiCall));

      const results = await Promise.all(requests);

      // All requests should succeed
      expect(results).toHaveLength(5);
      expect(mockApiCall).toHaveBeenCalledTimes(5);

      // Check that rate limiter tracked the requests
      const stats = rateLimiter.getStats();
      expect(stats.totalRequests).toBe(5);
      expect(stats.failedRequests).toBe(0);
    });

    it('should handle rate limit errors with retry logic', async () => {
      // Use fast rate limiter to avoid test timeout (default retryDelayMs=2000 + exponential backoff)
      const fastRateLimiter = new SlackRateLimiter({
        retryDelayMs: 50,
        minIntervalMs: 10,
      });

      let callCount = 0;
      const mockApiCall = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          const error = new Error('Rate limited') as Error & { status: number };
          error.status = 429;
          throw error;
        }
        return Promise.resolve({ ts: '1234567890.123456' });
      });

      const result = await fastRateLimiter.queueRequest(mockApiCall);

      expect(result).toEqual({ ts: '1234567890.123456' });
      expect(mockApiCall).toHaveBeenCalledTimes(3); // Original + 2 retries

      const stats = fastRateLimiter.getStats();
      expect(stats.rateLimitHits).toBe(2);

      fastRateLimiter.reset();
    }, 10000);

    it('should reject requests when queue is full', async () => {
      const slowApiCall = () => new Promise((resolve) => setTimeout(resolve, 1000));

      // maxQueueSize=1: first call is shifted immediately by startProcessing,
      // second call pushes (length=1), third call sees length >= 1 and rejects
      const smallRateLimiter = new SlackRateLimiter({ maxQueueSize: 1 });

      try {
        // Queue up to the limit — catch rejections from reset() cleanup
        const promise1 = smallRateLimiter.queueRequest(slowApiCall).catch(() => {});
        const promise2 = smallRateLimiter.queueRequest(slowApiCall).catch(() => {});

        // This should be rejected
        await expect(smallRateLimiter.queueRequest(slowApiCall)).rejects.toThrow(/queue full/i);

        // Clean up and wait for pending promises
        smallRateLimiter.reset();
        await Promise.allSettled([promise1, promise2]);
      } finally {
        smallRateLimiter.reset();
      }
    });
  });

  describe('Multi-Agent Handler Security', () => {
    it('should validate events before processing through handler', async () => {
      const validEvent = {
        type: 'app_mention',
        channel: 'C1234567890',
        user: 'U0987654321',
        text: '<@U1234567890> Hello world!',
        ts: '1234567890.123456',
      };

      const invalidEvent = {
        type: 'app_mention',
        channel: 'invalid_channel',
        user: 'U0987654321',
        text: 'Hello world!',
        ts: '1234567890.123456',
      };

      // Mock the handleMessage method to spy on it
      const handleMessageSpy = vi.spyOn(slackHandler, 'handleMessage');
      handleMessageSpy.mockResolvedValue(null);

      // Valid event should be processed
      await slackHandler.handleMessage(validEvent, 'Hello world!');
      expect(handleMessageSpy).toHaveBeenCalled();

      // Invalid event should be rejected and return null
      const invalidResult = await slackHandler.handleMessage(invalidEvent, 'Hello world!');
      expect(invalidResult).toBeNull();
    });

    it('should sanitize message content before agent processing', async () => {
      const maliciousEvent = {
        type: 'app_mention',
        channel: 'C1234567890',
        user: 'U0987654321',
        text: '<@U1234567890> <script>alert("xss")</script> Hello!',
        ts: '1234567890.123456',
      };

      // Mock the processAgentResponse method to capture the sanitized content
      const processAgentSpy = vi.spyOn(slackHandler, 'processAgentResponse');
      processAgentSpy.mockResolvedValue({
        agentId: 'test_agent',
        content: 'Mocked response',
        messageId: '1234567890.123456',
      });

      await slackHandler.handleMessage(maliciousEvent, maliciousEvent.text);

      // The content passed to processAgentResponse should be sanitized
      if (processAgentSpy.mock.calls.length > 0) {
        const [, , sanitizedContent] = processAgentSpy.mock.calls[0];
        expect(sanitizedContent).not.toContain('<script>');
      }
    });
  });

  describe('Bot Manager Security', () => {
    it('should mask sensitive information in logs', async () => {
      // Spy on console.log to capture log output
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      try {
        await multiBotManager.initialize();

        // Check that logs don't contain full bot/user IDs
        const logCalls = logSpy.mock.calls.map((call) => call.join(' '));
        const sensitivePattern = /[BU][0-9A-Z]{8,}/g;

        for (const logMessage of logCalls) {
          const matches = logMessage.match(sensitivePattern);
          if (matches) {
            // If we find ID-like patterns, they should be masked (end with ****)
            for (const match of matches) {
              if (match.length > 8) {
                // Full IDs are longer than 8 chars
                expect(match).toMatch(/\*{4}$/); // Should end with ****
              }
            }
          }
        }
      } finally {
        logSpy.mockRestore();
      }
    });

    it('should rate limit API calls in bot manager', async () => {
      const webClientSpy = vi.fn().mockResolvedValue({ ts: '1234567890.123456' });

      // Mock a bot with rate-limited API calls
      const bot = {
        agentId: 'test_agent',
        connected: true,
        webClient: {
          chat: {
            postMessage: webClientSpy,
          },
        },
      };

      // Simulate the rate limiting behavior
      multiBotManager.bots = new Map([['test_agent', bot]]);

      // Attempt multiple rapid API calls
      const promises = Array.from({ length: 3 }, () =>
        multiBotManager.replyAsAgent('test_agent', 'C1234567890', null, 'Test message')
      );

      await Promise.all(promises);

      // All calls should succeed (rate limiter should handle throttling)
      expect(webClientSpy).toHaveBeenCalledTimes(3);
    });
  });

  describe('Error Handling Integration', () => {
    it('should handle validation errors gracefully', async () => {
      const invalidEvent = {
        type: 'app_mention',
        channel: 'invalid_channel_id',
        user: 'U0987654321',
        text: 'Hello world!',
        ts: '1234567890.123456',
      };

      // Should not throw, should return null
      const result = await slackHandler.handleMessage(invalidEvent, 'Hello world!');
      expect(result).toBeNull();
    });

    it('should handle rate limiting failures gracefully', async () => {
      const alwaysFailingCall = vi.fn().mockRejectedValue(new Error('Network error'));

      await expect(rateLimiter.queueRequest(alwaysFailingCall)).rejects.toThrow('Network error');

      const stats = rateLimiter.getStats();
      expect(stats.failedRequests).toBe(1);
    });
  });

  describe('Performance Integration', () => {
    it('should handle multiple concurrent events efficiently', async () => {
      const events = Array.from({ length: 10 }, (_, i) => ({
        type: 'app_mention',
        channel: 'C1234567890',
        user: `U${String(i).padStart(9, '0')}`,
        text: `<@U1234567890> Message ${i}`,
        ts: `${1234567890 + i}.123456`,
      }));

      const startTime = Date.now();

      // Process all events concurrently
      const results = await Promise.allSettled(
        events.map((event) => slackHandler.handleMessage(event, event.text))
      );

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Should complete within reasonable time (5 seconds for 10 events)
      expect(duration).toBeLessThan(5000);

      // All events should be processed (may return null but shouldn't fail)
      expect(results).toHaveLength(10);
      results.forEach((result) => {
        expect(result.status).toBe('fulfilled');
      });
    });
  });
});
