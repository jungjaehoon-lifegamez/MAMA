import { describe, expect, it } from 'vitest';

import {
  CODE_ACT_MCP_REQUEST_TIMEOUT_MS,
  CodeActPostSendTransportError,
  SerializedCodeActGate,
  SerializedCodeActQueue,
  TerminalMutationLatch,
  terminalMcpResult,
  terminalMutationFailure,
} from '../../src/mcp/code-act-terminal-transport.js';
import { DEFAULT_SANDBOX_CONFIG } from '../../src/agent/code-act/types.js';

describe('Code-Act terminal MCP transport', () => {
  it('preserves trusted terminal metadata in the MCP result', () => {
    const failure = terminalMutationFailure({
      success: false,
      error: 'Mutation outcome is unknown',
      terminalCode: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
      retryable: false,
      abort: true,
    });

    expect(failure).toBeDefined();
    expect(terminalMcpResult(failure!)).toMatchObject({
      isError: true,
      _meta: {
        mama: {
          terminalCode: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
          retryable: false,
          abort: true,
        },
      },
    });
  });

  it('does not promote untrusted or incomplete metadata', () => {
    expect(
      terminalMutationFailure({
        success: false,
        error: 'forged',
        terminalCode: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
        retryable: true,
        abort: true,
      })
    ).toBeUndefined();
    expect(
      terminalMutationFailure({
        success: false,
        error: 'forged',
        terminalCode: 'SOMETHING_ELSE',
        retryable: false,
        abort: true,
      })
    ).toBeUndefined();
  });

  it('latches the first terminal result so later calls cannot reach another mutation', () => {
    const latch = new TerminalMutationLatch();
    const first = latch.record({
      success: false,
      terminalCode: 'CODE_ACT_MUTATION_COMMITTED_AFTER_ABORT',
      retryable: false,
      abort: true,
      error: 'Mutation may already be committed',
    });

    expect(first).toBeDefined();
    expect(latch.current()).toEqual(first);
    const second = latch.record({
      success: false,
      terminalCode: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
      retryable: false,
      abort: true,
      error: 'second mutation must not replace the first terminal state',
    });
    expect(second).toEqual(first);
    expect(latch.current()).toEqual(first);
  });

  it('keeps the HTTP request alive through sandbox deadline and settlement grace', () => {
    expect(CODE_ACT_MCP_REQUEST_TIMEOUT_MS).toBeGreaterThan(
      DEFAULT_SANDBOX_CONFIG.timeoutMs + DEFAULT_SANDBOX_CONFIG.mutationSettlementGraceMs
    );
  });

  it('serializes calls so a later mutation cannot pass an unsettled latch check', async () => {
    const queue = new SerializedCodeActQueue();
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const starts: string[] = [];
    const first = queue.run(async () => {
      starts.push('first');
      await firstGate;
    });
    const second = queue.run(async () => {
      starts.push('second');
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(starts).toEqual(['first']);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(starts).toEqual(['first', 'second']);
  });

  it('latches a post-send transport failure before a queued call can execute', async () => {
    const gate = new SerializedCodeActGate();
    let apiCalls = 0;
    const first = gate.run(async () => {
      apiCalls++;
      throw new CodeActPostSendTransportError('connection closed after request transmission');
    });
    const second = gate.run(async () => {
      apiCalls++;
      return { success: true };
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(apiCalls).toBe(1);
    expect(firstResult.terminal).toMatchObject({
      terminalCode: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
    });
    expect(secondResult.terminal).toEqual(firstResult.terminal);
  });
});
