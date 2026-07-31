import { describe, expect, it, vi } from 'vitest';

import {
  PersistentClaudeProcess,
  type PromptResult,
  type StreamMessage,
} from '../../src/agent/persistent-cli-process.js';
import type { PromptCallbacks } from '../../src/agent/types.js';
import { summarizeReportToolUse } from '../../src/operator/report-run.js';

type TestablePersistentProcess = {
  state: 'idle' | 'busy' | 'starting' | 'dead';
  currentResolve: ((result: PromptResult) => void) | null;
  currentReject: ((error: Error) => void) | null;
  currentCallbacks: PromptCallbacks | null;
  processEvent(event: StreamMessage): void;
  handleClose(code: number | null): void;
  handleTimeout(): void;
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

async function driveProtocolFailure(
  events: StreamMessage[],
  callbacks: PromptCallbacks = {}
): Promise<Error> {
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
  return resultPromise.catch((error: unknown) => error as Error);
}

async function driveMissingResultTerminal(
  terminal: (process: PersistentClaudeProcess, testable: TestablePersistentProcess) => void
): Promise<Error> {
  const process = new PersistentClaudeProcess({ sessionId: 'stream-session' });
  const testable = process as unknown as TestablePersistentProcess;
  testable.state = 'busy';
  const resultPromise = new Promise<PromptResult>((resolve, reject) => {
    testable.currentResolve = resolve;
    testable.currentReject = reject;
  });
  testable.processEvent(assistantToolUse('mcp-missing-terminal'));
  terminal(process, testable);
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

  it('TG-03/TG-06 structurally bounds an oversized success result without losing audit evidence', async () => {
    const body = JSON.stringify({
      protocol: 'mama.code_act.result',
      version: 1,
      success: true,
      hostToolExecutions: [{ name: 'task_list', success: true }],
      hostToolsInvoked: ['task_list'],
      payload: { value: 'x'.repeat(70 * 1024), logs: [], metrics: { calls: 1 } },
    });

    const { result } = await drivePrompt([
      assistantToolUse('mcp-oversized-success'),
      userToolResult('mcp-oversized-success', body),
      successResult(),
    ]);
    const exchange = result.completedToolExchanges?.[0];
    expect(exchange).toBeDefined();
    expect(() => JSON.parse(exchange!.toolResult.content)).not.toThrow();
    expect(JSON.parse(exchange!.toolResult.content)).toMatchObject({
      protocol: 'mama.code_act.result',
      version: 1,
      success: true,
      hostToolExecutions: [{ name: 'task_list', success: true }],
      payload: { truncated: true },
    });

    const audit = summarizeReportToolUse([
      { role: 'assistant', content: [exchange!.toolUse] },
      { role: 'user', content: [exchange!.toolResult] },
    ]);
    expect(audit.gatherTools).toEqual(['task_list']);
  });

  it('TG-06 preserves oversized terminal metadata and never emits a success final callback', async () => {
    const onFinal = vi.fn();
    const onError = vi.fn();
    const body = JSON.stringify({
      protocol: 'mama.code_act.result',
      version: 1,
      success: false,
      hostToolExecutions: [{ name: 'mama_save', success: false, code: 'outcome_unknown' }],
      hostToolsInvoked: [],
      payload: { value: 'x'.repeat(70 * 1024), logs: [], metrics: { calls: 1 } },
      error: {
        code: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
        message: 'Mutation may have committed.',
      },
      retryable: false,
      abort: true,
    });

    const { result } = await drivePrompt(
      [
        assistantToolUse('mcp-oversized-terminal'),
        userToolResult('mcp-oversized-terminal', body, true),
        successResult(),
      ],
      { onFinal, onError }
    );

    expect(result.terminalError).toEqual({
      code: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
      message: 'Mutation may have committed.',
    });
    expect(JSON.parse(result.completedToolExchanges![0].toolResult.content)).toMatchObject({
      error: {
        code: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
        message: 'Mutation may have committed.',
      },
      retryable: false,
      abort: true,
      payload: { truncated: true },
    });
    expect(onFinal).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'HostToolTerminalError',
        terminalCode: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
      })
    );
  });

  it('TG-03/TG-05/TG-06 preserves a completed mutation when the stream closes before result', async () => {
    const process = new PersistentClaudeProcess({ sessionId: 'stream-session' });
    const testable = process as unknown as TestablePersistentProcess;
    testable.state = 'busy';
    const resultPromise = new Promise<PromptResult>((resolve, reject) => {
      testable.currentResolve = resolve;
      testable.currentReject = reject;
    });
    const body = JSON.stringify({
      protocol: 'mama.code_act.result',
      version: 1,
      success: true,
      hostToolExecutions: [{ name: 'mama_save', success: true }],
      hostToolsInvoked: ['mama_save'],
      payload: { value: { id: 'saved' } },
    });

    testable.processEvent(assistantToolUse('mcp-completed-before-close'));
    testable.processEvent(userToolResult('mcp-completed-before-close', body));
    testable.handleClose(1);
    const error = await resultPromise.catch((reason: unknown) => reason as Error);

    expect(error).toMatchObject({
      name: 'McpCompletedMutationInterruptedError',
      code: 'MCP_COMPLETED_MUTATION_INTERRUPTED',
      retryable: false,
      completedToolExchanges: [
        expect.objectContaining({
          toolUse: expect.objectContaining({ id: 'mcp-completed-before-close' }),
        }),
      ],
    });
  });

  it('TG-03/TG-05/TG-06 preserves a completed mutation over a later stream protocol failure', async () => {
    const onError = vi.fn();
    const body = JSON.stringify({
      protocol: 'mama.code_act.result',
      version: 1,
      success: true,
      hostToolExecutions: [{ name: 'mama_save', success: true }],
      hostToolsInvoked: ['mama_save'],
      payload: { value: { id: 'saved' } },
    });
    const error = await driveProtocolFailure(
      [
        assistantToolUse('mcp-completed-before-protocol-error'),
        userToolResult('mcp-completed-before-protocol-error', body),
        userToolResult('unexpected-result'),
      ],
      { onError }
    );

    expect(error).toMatchObject({
      name: 'McpCompletedMutationInterruptedError',
      code: 'MCP_COMPLETED_MUTATION_INTERRUPTED',
      retryable: false,
      completedToolExchanges: [
        expect.objectContaining({
          toolUse: expect.objectContaining({ id: 'mcp-completed-before-protocol-error' }),
        }),
      ],
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error);
  });

  it.each([
    [
      'process close',
      (_process: PersistentClaudeProcess, testable: TestablePersistentProcess) =>
        testable.handleClose(1),
    ],
    [
      'stream error',
      (_process: PersistentClaudeProcess, testable: TestablePersistentProcess) =>
        testable.processEvent({ type: 'error', error: 'stream disconnected' }),
    ],
  ])('TG-03/TG-06 carries a paired terminal exchange through %s', async (_label, terminal) => {
    const process = new PersistentClaudeProcess({ sessionId: 'stream-session' });
    const testable = process as unknown as TestablePersistentProcess;
    testable.state = 'busy';
    const resultPromise = new Promise<PromptResult>((resolve, reject) => {
      testable.currentResolve = resolve;
      testable.currentReject = reject;
    });
    const body = JSON.stringify({
      protocol: 'mama.code_act.result',
      version: 1,
      success: false,
      hostToolExecutions: [{ name: 'mama_save', success: false, code: 'outcome_unknown' }],
      hostToolsInvoked: [],
      payload: {},
      error: {
        code: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
        message: 'Mutation may have committed.',
      },
      retryable: false,
      abort: true,
    });

    testable.processEvent(assistantToolUse('mcp-terminal-before-end'));
    testable.processEvent(userToolResult('mcp-terminal-before-end', body, true));
    terminal(process, testable);
    const error = await resultPromise.catch((reason: unknown) => reason as Error);

    expect(error).toMatchObject({
      name: 'HostToolTerminalError',
      terminalCode: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
      retryable: false,
      completedToolExchanges: [
        expect.objectContaining({
          toolUse: expect.objectContaining({ id: 'mcp-terminal-before-end' }),
          toolResult: expect.objectContaining({ tool_use_id: 'mcp-terminal-before-end' }),
        }),
      ],
    });
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

  it.each([
    [
      'failed result event',
      (_process: PersistentClaudeProcess, testable: TestablePersistentProcess) =>
        testable.processEvent({
          type: 'result',
          subtype: 'error',
          is_error: true,
          error: 'failed',
        }),
    ],
    [
      'stream error event',
      (_process: PersistentClaudeProcess, testable: TestablePersistentProcess) =>
        testable.processEvent({ type: 'error', error: 'stream disconnected' }),
    ],
    [
      'process close',
      (_process: PersistentClaudeProcess, testable: TestablePersistentProcess) =>
        testable.handleClose(1),
    ],
    [
      'request timeout',
      (_process: PersistentClaudeProcess, testable: TestablePersistentProcess) =>
        testable.handleTimeout(),
    ],
    ['explicit stop', (process: PersistentClaudeProcess) => process.stop()],
  ])('TG-06 maps unresolved MCP mutation on %s to MCP_RESULT_MISSING', async (_label, terminal) => {
    const error = await driveMissingResultTerminal(
      terminal as (process: PersistentClaudeProcess, testable: TestablePersistentProcess) => void
    );

    expect(error).toMatchObject({
      name: 'McpResultMissingError',
      code: 'MCP_RESULT_MISSING',
      retryable: false,
      toolUseIds: ['mcp-missing-terminal'],
    });
  });
});
