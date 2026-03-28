import { describe, expect, it } from 'vitest';

import { buildMemoryAuditAckFromAgentResult } from '../../src/memory/memory-agent-ack.js';
import type { AgentLoopResult } from '../../src/agent/types.js';

function createResult(toolNames: string[], response = 'ok'): AgentLoopResult {
  return {
    response,
    turns: 1,
    history: [
      {
        role: 'assistant',
        content: toolNames.map((name, index) => ({
          type: 'tool_use' as const,
          id: `tool_${index}`,
          name,
          input: {},
        })),
      },
    ],
    totalUsage: {
      input_tokens: 1,
      output_tokens: 1,
    },
    stopReason: 'end_turn',
  };
}

describe('memory agent ack classification', () => {
  it('should mark applied when a decision count increases', () => {
    const ack = buildMemoryAuditAckFromAgentResult(createResult(['mama_save']), 1, 2);
    expect(ack.status).toBe('applied');
  });

  it('should mark failed when mama_save was used but nothing persisted', () => {
    const ack = buildMemoryAuditAckFromAgentResult(createResult(['mama_save']), 1, 1);
    expect(ack.status).toBe('failed');
  });

  it('should mark skipped when no save tool was used', () => {
    const ack = buildMemoryAuditAckFromAgentResult(createResult(['mama_search']), 1, 1);
    expect(ack.status).toBe('skipped');
  });

  it('should mark failed when response contains a codex auth error', () => {
    const ack = buildMemoryAuditAckFromAgentResult(
      createResult(
        ['mama_search'],
        'Failed to refresh token: refresh_token_reused. Please log out and sign in again.'
      ),
      1,
      1
    );

    expect(ack.status).toBe('failed');
    expect(ack.reason).toContain('refresh_token_reused');
  });
});
