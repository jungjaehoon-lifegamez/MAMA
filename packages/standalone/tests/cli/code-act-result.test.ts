import { describe, expect, it } from 'vitest';

import { serializeCodeActExecutionResult } from '../../src/cli/commands/start.js';

describe('Story CA-TERM-1: Code-Act HTTP result serialization', () => {
  describe('AC #1: terminal mutation metadata', () => {
    it('preserves terminal mutation metadata from the sandbox', () => {
      const result = serializeCodeActExecutionResult(
        {
          success: false,
          error: {
            name: 'CodeActTerminalMutationError',
            message: 'Mutation outcome is unknown',
            code: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
            retryable: false,
          },
          logs: [],
          metrics: { durationMs: 10, hostCallCount: 1, memoryUsedBytes: 0 },
        },
        [{ name: 'telegram_send', input: { chatId: 'owner' } }]
      );

      expect(result).toMatchObject({
        success: false,
        terminalCode: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
        retryable: false,
        abort: true,
        toolCalls: [{ name: 'telegram_send' }],
      });
    });
  });
});
