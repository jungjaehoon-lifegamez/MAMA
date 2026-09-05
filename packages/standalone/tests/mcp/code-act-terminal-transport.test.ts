import { describe, expect, it } from 'vitest';

import {
  CODE_ACT_MCP_REQUEST_TIMEOUT_MS,
  CodeActPostSendTransportError,
  SerializedCodeActGate,
  SerializedCodeActQueue,
  TerminalMutationLatch,
  codeActMcpResult,
  terminalMcpResult,
  terminalMutationFailure,
} from '../../src/mcp/code-act-terminal-transport.js';
import { DEFAULT_SANDBOX_CONFIG } from '../../src/agent/code-act/types.js';
import {
  completedCodeActMutationWasObserved,
  completedCodeActTerminalError,
} from '../../src/agent/code-act/completed-terminal-result.js';
import type { CompletedToolExchange } from '../../src/agent/types.js';

function mcpExchange(mcpResult: Record<string, unknown>): CompletedToolExchange {
  const text = (mcpResult.content as Array<{ text: string }>)[0].text;
  return {
    toolUse: { type: 'tool_use', id: 'call-1', name: 'mcp__code-act__code_act', input: {} },
    toolResult: { type: 'tool_result', tool_use_id: 'call-1', content: text },
  };
}

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
    if (!failure) {
      throw new Error('Expected terminal mutation failure metadata');
    }
    expect(terminalMcpResult(failure)).toMatchObject({
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

  it('TG-06 preserves successful nested-tool audit in a terminal MCP result', () => {
    const failure = terminalMutationFailure({
      success: false,
      error: 'Mutation outcome is unknown',
      terminalCode: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
      retryable: false,
      abort: true,
      hostToolExecutions: [
        { name: 'task_list', success: true },
        { name: 'mama_save', success: false, code: 'outcome_unknown' },
      ],
    });

    expect(failure).toBeDefined();
    if (!failure) {
      throw new Error('Expected terminal mutation failure metadata');
    }
    const result = terminalMcpResult(failure) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      protocol: 'mama.code_act.result',
      version: 1,
      success: false,
      hostToolExecutions: [
        { name: 'task_list', success: true },
        { name: 'mama_save', success: false, code: 'outcome_unknown' },
      ],
      hostToolsInvoked: ['task_list'],
    });
  });

  it('TG-03/TG-06 fences only the payload and keeps the trusted root machine-readable', () => {
    const sentinel = 'SENTINEL_EXTERNAL_BUSINESS_VALUE';
    const result = codeActMcpResult({
      success: true,
      value: { evidence: sentinel },
      logs: ['log line'],
      metrics: { durationMs: 1, hostCallCount: 1, memoryUsedBytes: 10 },
      hostToolExecutions: [{ name: 'drive_browse', success: true }],
      untrustedExternalEvidence: true,
    });
    const text = (result.content as Array<{ text: string }>)[0].text;
    const root = JSON.parse(text) as Record<string, unknown>;

    expect(root).toMatchObject({
      protocol: 'mama.code_act.result',
      version: 1,
      success: true,
      untrustedExternalEvidence: true,
      hostToolExecutions: [{ name: 'drive_browse', success: true }],
      hostToolsInvoked: ['drive_browse'],
    });
    expect(text.split(sentinel)).toHaveLength(2);
    expect(text).not.toContain('\n  "');
    const payload = root.payload as string;
    expect(payload.startsWith('<<<UNTRUSTED-CONTENT source=external-evidence-code-act>>>')).toBe(
      true
    );
    expect(payload.endsWith('<<<END-UNTRUSTED-CONTENT>>>')).toBe(true);
    const fencedBody = payload.split('\n').at(-2) ?? '';
    expect(JSON.parse(fencedBody)).toEqual({
      value: { evidence: sentinel },
      logs: ['log line'],
      metrics: { durationMs: 1, hostCallCount: 1, memoryUsedBytes: 10 },
    });
    expect(Object.keys(root)).not.toContain('value');
  });

  it('TG-06 host mutation observation survives a fenced external-evidence result', () => {
    const fenced = codeActMcpResult({
      success: true,
      value: { text: 'probe' },
      hostToolExecutions: [
        { name: 'trello_search', success: true },
        { name: 'task_update', success: true },
      ],
      untrustedExternalEvidence: true,
    });
    const plain = codeActMcpResult({
      success: true,
      value: { text: 'probe' },
      hostToolExecutions: [{ name: 'task_update', success: true }],
    });
    const readOnly = codeActMcpResult({
      success: true,
      value: { text: 'probe' },
      hostToolExecutions: [{ name: 'trello_search', success: true }],
      untrustedExternalEvidence: true,
    });

    expect(completedCodeActMutationWasObserved([mcpExchange(fenced)])).toBe(true);
    expect(completedCodeActMutationWasObserved([mcpExchange(plain)])).toBe(true);
    expect(completedCodeActMutationWasObserved([mcpExchange(readOnly)])).toBe(false);
  });

  it('TG-06 terminal codes survive a fenced external-evidence failure', () => {
    const fenced = codeActMcpResult({
      success: false,
      error: 'Mutation may have committed.',
      terminalCode: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
      retryable: false,
      abort: true,
      value: { text: 'probe' },
      hostToolExecutions: [{ name: 'mama_save', success: false, code: 'outcome_unknown' }],
      untrustedExternalEvidence: true,
    });

    expect(fenced.isError).toBe(true);
    expect(completedCodeActTerminalError([mcpExchange(fenced)])).toEqual({
      code: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
      message: 'Mutation may have committed.',
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
