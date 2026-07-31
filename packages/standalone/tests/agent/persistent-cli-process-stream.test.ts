import { describe, expect, it, vi } from 'vitest';

import {
  PersistentClaudeProcess,
  type PromptResult,
  type StreamMessage,
} from '../../src/agent/persistent-cli-process.js';
import type { PromptCallbacks } from '../../src/agent/types.js';

type TestablePersistentProcess = {
  state: 'idle' | 'busy' | 'starting' | 'dead';
  currentResolve: ((result: PromptResult) => void) | null;
  currentReject: ((error: Error) => void) | null;
  currentCallbacks: PromptCallbacks | null;
  processEvent(event: StreamMessage): void;
};

function assistantToolUse(
  id: string,
  input: Record<string, unknown> = { code: 'mutate()' }
): StreamMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'mcp__code-act__code_act', input }],
    },
  };
}

function userToolResult(
  id: string,
  content: string | Array<{ type: string; text?: string }> = '{"ok":true}',
  isError = false
): StreamMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
    },
  };
}

function successResult(): StreamMessage {
  return {
    type: 'result',
    subtype: 'success',
    result: 'done',
    session_id: 'stream-session',
    usage: { input_tokens: 3, output_tokens: 2 },
  };
}

async function drivePrompt(
  events: StreamMessage[],
  callbacks: PromptCallbacks = {}
): Promise<{ process: PersistentClaudeProcess; result: PromptResult }> {
  const process = new PersistentClaudeProcess({ sessionId: 'stream-session' });
  const testable = process as unknown as TestablePersistentProcess;
  testable.state = 'busy';
  testable.currentCallbacks = callbacks;
  const resultPromise = new Promise<PromptResult>((resolve, reject) => {
    testable.currentResolve = resolve;
    testable.currentReject = reject;
  });
  for (const event of events) {
    testable.processEvent(event);
  }
  return { process, result: await resultPromise };
}

async function driveProtocolFailure(events: StreamMessage[]): Promise<Error> {
  const process = new PersistentClaudeProcess({ sessionId: 'stream-session' });
  const testable = process as unknown as TestablePersistentProcess;
  testable.state = 'busy';
  const resultPromise = new Promise<PromptResult>((resolve, reject) => {
    testable.currentResolve = resolve;
    testable.currentReject = reject;
  });
  for (const event of events) {
    testable.processEvent(event);
  }
  return resultPromise.catch((error: unknown) => error as Error);
}

describe('Story S3/TG-03/TG-06: Claude completed MCP exchange stream contract', () => {
  it('pairs a completed MCP result, normalizes text blocks, and leaves no pending host replay', async () => {
    const onToolComplete = vi.fn();

    const { process, result } = await drivePrompt(
      [
        assistantToolUse('mcp-1'),
        userToolResult('mcp-1', [
          { type: 'text', text: '{"version":1,' },
          { type: 'text', text: '"success":true}' },
        ]),
        successResult(),
      ],
      { onToolComplete }
    );

    expect(result.completedToolExchanges).toEqual([
      {
        toolUse: expect.objectContaining({ id: 'mcp-1', name: 'mcp__code-act__code_act' }),
        toolResult: {
          type: 'tool_result',
          tool_use_id: 'mcp-1',
          content: '{"version":1,\n"success":true}',
          is_error: false,
        },
      },
    ]);
    expect(result.toolUseBlocks).toBeUndefined();
    expect(result.hasToolUse).toBe(false);
    expect(process.hasPendingToolUse()).toBe(false);
    expect(onToolComplete).toHaveBeenCalledTimes(1);
    expect(onToolComplete).toHaveBeenCalledWith('mcp__code-act__code_act', 'mcp-1', false);
  });

  it('returns only unresolved tool uses and keeps the process pending', async () => {
    const { process, result } = await drivePrompt([
      assistantToolUse('mcp-unresolved'),
      successResult(),
    ]);

    expect(result.completedToolExchanges).toEqual([]);
    expect(result.toolUseBlocks).toEqual([
      expect.objectContaining({ id: 'mcp-unresolved', name: 'mcp__code-act__code_act' }),
    ]);
    expect(result.hasToolUse).toBe(true);
    expect(process.hasPendingToolUse()).toBe(true);
  });

  it('ignores identical duplicate pending uses and results without duplicate callbacks', async () => {
    const onToolUse = vi.fn();
    const onToolComplete = vi.fn();
    const use = assistantToolUse('mcp-duplicate', { code: '1 + 1', nested: { b: 2, a: 1 } });
    const resultEvent = userToolResult('mcp-duplicate');

    const { result } = await drivePrompt([use, use, resultEvent, resultEvent, successResult()], {
      onToolUse,
      onToolComplete,
    });

    expect(result.completedToolExchanges).toHaveLength(1);
    expect(onToolUse).toHaveBeenCalledTimes(1);
    expect(onToolComplete).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['result-before-use', [userToolResult('unknown')]],
    [
      'conflicting duplicate tool use',
      [assistantToolUse('same', { code: '1' }), assistantToolUse('same', { code: '2' })],
    ],
    [
      'conflicting duplicate result',
      [assistantToolUse('same'), userToolResult('same', 'first'), userToolResult('same', 'second')],
    ],
    [
      'completed id reuse',
      [assistantToolUse('same'), userToolResult('same'), assistantToolUse('same')],
    ],
  ])('fails the prompt on %s', async (_label, events) => {
    const error = await driveProtocolFailure(events as StreamMessage[]);

    expect(error).toMatchObject({
      name: 'ClaudeToolStreamProtocolError',
      code: 'CLAUDE_TOOL_STREAM_PROTOCOL',
    });
  });
});
