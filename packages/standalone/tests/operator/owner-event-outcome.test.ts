import { describe, expect, it } from 'vitest';
import { classifyOwnerEventOutcome } from '../../src/operator/owner-event-outcome.js';

const directToolHistory = (
  name: string,
  result: Record<string, unknown>,
  input: Record<string, unknown> = {}
) => [
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tool-1', name, input }],
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: JSON.stringify(result),
      },
    ],
  },
];

describe('TG-06 owner-event terminal outcome', () => {
  it('a notification alone is not completion', () => {
    expect(
      classifyOwnerEventOutcome({
        history: directToolHistory('telegram_send', { success: true }),
        noUpdateRecorded: false,
      })
    ).toEqual({ status: 'retry', tools: [], reason: 'notification without a ledger change' });
  });

  it('a notification completes when the turn asked the owner for a decision', () => {
    expect(
      classifyOwnerEventOutcome({
        history: directToolHistory('telegram_send', { success: true }),
        noUpdateRecorded: false,
        ownerDecisionRequested: true,
      })
    ).toEqual({ status: 'acted', tools: ['telegram_send'] });
  });

  it('a ledger change completes the turn and carries the notification beside it', () => {
    const history = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'task_update', input: {} },
          { type: 'tool_use', id: 'tool-2', name: 'telegram_send', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: JSON.stringify({ success: true }),
          },
          {
            type: 'tool_result',
            tool_use_id: 'tool-2',
            content: JSON.stringify({ success: true }),
          },
        ],
      },
    ];
    expect(classifyOwnerEventOutcome({ history, noUpdateRecorded: false })).toEqual({
      status: 'acted',
      tools: ['task_update', 'telegram_send'],
    });
  });

  it('accepts an occurrence-idempotent Drive upload as a durable action', () => {
    expect(
      classifyOwnerEventOutcome({
        history: directToolHistory('drive_upload', {
          success: true,
          result: { fileId: 'uploaded-1', name: 'translated.png' },
        }),
        noUpdateRecorded: false,
      })
    ).toEqual({ status: 'acted', tools: ['drive_upload'] });
  });

  it('a nested Code-Act ledger change from the host ledger completes the turn', () => {
    const history = directToolHistory('mcp__code-act__code_act', {
      protocol: 'mama.code_act.result',
      version: 1,
      success: true,
      hostToolExecutions: [{ name: 'task_update', success: true }],
    });

    expect(classifyOwnerEventOutcome({ history, noUpdateRecorded: false })).toEqual({
      status: 'acted',
      tools: ['task_update'],
    });
  });

  it('a nested Code-Act notification alone is not completion', () => {
    const history = directToolHistory('mcp__code-act__code_act', {
      protocol: 'mama.code_act.result',
      version: 1,
      success: true,
      hostToolExecutions: [{ name: 'telegram_send', success: true }],
    });

    expect(classifyOwnerEventOutcome({ history, noUpdateRecorded: false })).toMatchObject({
      status: 'retry',
      reason: 'notification without a ledger change',
    });
  });

  it('a work-order handoff no longer counts as anything', () => {
    expect(
      classifyOwnerEventOutcome({
        history: directToolHistory('workorder_request', { success: true, workorder_id: 42 }),
        noUpdateRecorded: false,
      })
    ).toEqual({
      status: 'retry',
      tools: [],
      reason: 'no durable action or exact no-update receipt',
    });
  });

  it('accepts only the host-verified exact no-update note', () => {
    expect(classifyOwnerEventOutcome({ history: [], noUpdateRecorded: true })).toEqual({
      status: 'no_update',
      tools: [],
    });
    expect(classifyOwnerEventOutcome({ history: [], noUpdateRecorded: false })).toEqual({
      status: 'retry',
      tools: [],
      reason: 'no durable action or exact no-update receipt',
    });
  });

  it('rejects failed tools and prose-only claims', () => {
    expect(
      classifyOwnerEventOutcome({
        history: directToolHistory('telegram_send', {
          success: false,
          code: 'destination_out_of_scope',
        }),
        noUpdateRecorded: false,
      })
    ).toMatchObject({ status: 'retry', tools: [] });
    expect(
      classifyOwnerEventOutcome({
        history: [{ role: 'assistant', content: 'Delivered.' }],
        noUpdateRecorded: false,
      })
    ).toMatchObject({ status: 'retry', tools: [] });
  });

  it('does not ACK a read-shaped tool merely because it returned success', () => {
    for (const tool of ['obsidian', 'kagemusha_messages', 'board_read', 'context_compile']) {
      expect(
        classifyOwnerEventOutcome({
          history: directToolHistory(tool, { success: true }),
          noUpdateRecorded: false,
        })
      ).toMatchObject({ status: 'retry', tools: [] });
    }
  });
});
