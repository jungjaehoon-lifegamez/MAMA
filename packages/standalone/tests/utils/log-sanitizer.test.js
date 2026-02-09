/**
 * Unit tests for log sanitizer utility
 */

import { describe, it, expect, vi } from 'vitest';
import {
  maskBotId,
  maskUserId,
  redactToken,
  sanitizeString,
  sanitizeForLogging,
  safeLog,
  createSafeLogger,
} from '../../src/utils/log-sanitizer.ts';

describe('Log Sanitizer', () => {
  describe('maskBotId', () => {
    it('should mask valid Bot IDs', () => {
      expect(maskBotId('B1234567890')).toBe('B123****');
      expect(maskBotId('BABCDEFGHIJ')).toBe('BABC****');
    });

    it('should handle invalid inputs gracefully', () => {
      expect(maskBotId('')).toBe('');
      expect(maskBotId('short')).toBe('short');
      expect(maskBotId('U1234567890')).toBe('U1234567890'); // User ID, not Bot ID
      expect(maskBotId(null)).toBe(null);
      expect(maskBotId(undefined)).toBe(undefined);
    });
  });

  describe('maskUserId', () => {
    it('should mask valid User IDs', () => {
      expect(maskUserId('U1234567890')).toBe('U123****');
      expect(maskUserId('UABCDEFGHIJ')).toBe('UABC****');
      expect(maskUserId('W1234567890')).toBe('W1234567890'); // Workspace IDs are not masked by this function
    });

    it('should handle invalid inputs gracefully', () => {
      expect(maskUserId('')).toBe('');
      expect(maskUserId('short')).toBe('short');
      expect(maskUserId('B1234567890')).toBe('B1234567890'); // Bot ID, not User ID
      expect(maskUserId(null)).toBe(null);
      expect(maskUserId(undefined)).toBe(undefined);
    });
  });

  describe('redactToken', () => {
    it('should redact Slack tokens', () => {
      expect(redactToken('xoxb-1234567890-abcdefghij')).toBe('xoxb-123***[REDACTED]***');
      expect(redactToken('xapp-1-ABC-DEF-xyz')).toBe('xapp-1-A***[REDACTED]***');
      expect(redactToken('xoxp-user-token')).toBe('xoxp-use***[REDACTED]***');
    });

    it('should handle non-token strings', () => {
      expect(redactToken('normal-string')).toBe('normal-string');
      expect(redactToken('not-a-token')).toBe('not-a-token');
      expect(redactToken('')).toBe('');
      expect(redactToken(null)).toBe(null);
      expect(redactToken(undefined)).toBe(undefined);
    });
  });

  describe('sanitizeString', () => {
    it('should sanitize Bot IDs by default', () => {
      const input = 'Bot B1234567890 sent a message';
      const result = sanitizeString(input);
      expect(result).toBe('Bot B123**** sent a message');
    });

    it('should sanitize User IDs by default', () => {
      const input = 'User U1234567890 mentioned W0987654321';
      const result = sanitizeString(input);
      expect(result).toBe('User U123**** mentioned W0987654321');
    });

    it('should sanitize tokens by default', () => {
      const input = 'Token: xoxb-1234567890-abcdefghij';
      const result = sanitizeString(input);
      expect(result).toBe('Token: xoxb-123***[REDACTED]***');
    });

    it('should apply custom patterns', () => {
      const input = 'Password: secret123';
      const options = {
        customPatterns: [{ pattern: /Password:\s*\w+/g, replacement: 'Password: [REDACTED]' }],
      };
      const result = sanitizeString(input, options);
      expect(result).toBe('Password: [REDACTED]');
    });

    it('should respect sanitization options', () => {
      const input = 'Bot B1234567890 with token xoxb-test-token';

      const resultNoBots = sanitizeString(input, { maskBotIds: false });
      expect(resultNoBots).toContain('B1234567890');
      expect(resultNoBots).toContain('***[REDACTED]***');

      const resultNoTokens = sanitizeString(input, { redactTokens: false });
      expect(resultNoTokens).toContain('B123****');
      expect(resultNoTokens).toContain('xoxb-test-token');
    });
  });

  describe('sanitizeForLogging', () => {
    it('should sanitize simple objects', () => {
      const input = {
        botId: 'B1234567890',
        userId: 'U1234567890',
        token: 'xoxb-secret-token',
        message: 'Hello world',
      };

      const result = sanitizeForLogging(input);

      expect(result.botId).toBe('B123****');
      expect(result.userId).toBe('U123****');
      expect(result.token).toContain('***[REDACTED]***');
      expect(result.message).toBe('Hello world');
    });

    it('should sanitize nested objects', () => {
      const input = {
        user: {
          id: 'U1234567890',
          name: 'TestUser',
        },
        bot: {
          id: 'B1234567890',
          token: 'xoxb-secret',
        },
      };

      const result = sanitizeForLogging(input);

      expect(result.user.id).toBe('U123****');
      expect(result.user.name).toBe('TestUser');
      expect(result.bot.id).toBe('B123****');
      expect(result.bot.token).toContain('***[REDACTED]***');
    });

    it('should handle arrays', () => {
      const input = ['U1234567890', 'B1234567890', 'normal-string'];
      const result = sanitizeForLogging(input);

      expect(result).toEqual(['U123****', 'B123****', 'normal-string']);
    });

    it('should handle primitive values', () => {
      expect(sanitizeForLogging('U1234567890')).toBe('U123****');
      expect(sanitizeForLogging(123)).toBe(123);
      expect(sanitizeForLogging(true)).toBe(true);
      expect(sanitizeForLogging(null)).toBe(null);
      expect(sanitizeForLogging(undefined)).toBe(undefined);
    });
  });

  describe('safeLog', () => {
    it('should sanitize log arguments', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      try {
        safeLog('User B1234567890 logged in', { token: 'xoxb-secret' });

        expect(consoleSpy).toHaveBeenCalledWith('User B123**** logged in', {
          token: expect.stringContaining('***[REDACTED]***'),
        });
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });

  describe('createSafeLogger', () => {
    it('should create a logger with prefix', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      try {
        const logger = createSafeLogger('TestComponent');
        logger.log('User U1234567890 performed action');

        expect(consoleSpy).toHaveBeenCalledWith('[TestComponent] User U123**** performed action');
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('should sanitize error logs', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        const logger = createSafeLogger('ErrorTest');
        logger.error('Failed to authenticate bot B1234567890', { token: 'xoxb-secret' });

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          '[ErrorTest] Failed to authenticate bot B123****',
          { token: expect.stringContaining('***[REDACTED]***') }
        );
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });
  });

  describe('Edge cases', () => {
    it('should handle circular references', () => {
      const obj = { name: 'test' };
      obj.self = obj; // Create circular reference

      // Should not throw, may stringify differently
      expect(() => sanitizeForLogging(obj)).not.toThrow();
    });

    it('should handle very long IDs', () => {
      const longId = 'B' + 'A'.repeat(50);
      const result = maskBotId(longId);
      expect(result).toBe('BAAA****');
    });

    it('should handle mixed content', () => {
      const input = 'Bot B1234567890 with token xoxb-test and user U0987654321 said "hello"';
      const result = sanitizeString(input);

      expect(result).toContain('B123****');
      expect(result).toContain('U098****');
      expect(result).toContain('***[REDACTED]***');
      expect(result).toContain('said "hello"');
    });
  });
});
