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
  it('accepts a completed direct owner delivery as durable action', () => {
    expect(
      classifyOwnerEventOutcome({
        history: directToolHistory('telegram_send', { success: true }),
        noUpdateRecorded: false,
      })
    ).toEqual({ status: 'acted', tools: ['telegram_send'] });
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

  it('accepts a successful nested Code-Act owner delivery from the host ledger', () => {
    const history = directToolHistory('mcp__code-act__code_act', {
      protocol: 'mama.code_act.result',
      version: 1,
      success: true,
      hostToolExecutions: [{ name: 'telegram_send', success: true }],
    });

    expect(classifyOwnerEventOutcome({ history, noUpdateRecorded: false })).toEqual({
      status: 'acted',
      tools: ['telegram_send'],
    });
  });

  it('accepts a durable work-order handoff as delegation', () => {
    expect(
      classifyOwnerEventOutcome({
        history: directToolHistory('workorder_request', { success: true, workorder_id: 42 }),
        noUpdateRecorded: false,
      })
    ).toEqual({ status: 'delegated', tools: ['workorder_request'] });
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

  it('does not ACK a read-shaped or non-idempotent tool merely because it returned success', () => {
    for (const tool of ['obsidian', 'mama_save', 'task_create']) {
      expect(
        classifyOwnerEventOutcome({
          history: directToolHistory(tool, { success: true }),
          noUpdateRecorded: false,
        })
      ).toMatchObject({ status: 'retry', tools: [] });
    }
  });
});
