import { describe, expect, it, vi } from 'vitest';

import { RunContextRegistry } from '../../../src/agent/code-act/run-context-registry.js';
import type { GatewayToolExecutionContext } from '../../../src/agent/types.js';
import { createCodeActExecutor } from '../../../src/cli/runtime/code-act-executor.js';

const CONTEXT_KEY = 'A'.repeat(43);

function makeContext(): GatewayToolExecutionContext {
  return {
    agentId: 'workorder-board',
    source: 'operator',
    channelId: 'worker:board',
    executionSurface: 'model_tool',
    workorderAttemptId: 148,
    causeEventIds: ['event-1'],
  };
}

describe('Story S3/TG-03/TG-04: keyed Code-Act runtime', () => {
  it('uses the exact registered run context and releases its execution pin', async () => {
    const registry = new RunContextRegistry();
    const context = makeContext();
    const leaseId = registry.register(CONTEXT_KEY, context);
    const execute = vi.fn().mockResolvedValue({
      success: true,
      value: { reconciled: true },
      logs: ['done'],
      metrics: { durationMs: 3, hostCallCount: 1, memoryUsedBytes: 20 },
      hostToolExecutions: [{ name: 'task_temporal_reconcile', success: true }],
      hostToolsInvoked: ['task_temporal_reconcile'],
      message: '{"legacy":true}',
    });
    const executeLegacy = vi.fn();
    const executeCodeAct = createCodeActExecutor({
      registry,
      gatewayToolExecutor: { execute },
      executeLegacy,
    });

    const result = await executeCodeAct('task_temporal_reconcile({})', {
      contextKey: CONTEXT_KEY,
      agentId: 'untrusted-http-agent',
      allowedTools: ['task_temporal_reconcile'],
      blockedTools: ['mama_save'],
    });

    expect(execute).toHaveBeenCalledWith(
      'code_act',
      {
        code: 'task_temporal_reconcile({})',
        allowedTools: ['task_temporal_reconcile'],
        blockedTools: ['mama_save'],
      },
      context
    );
    expect(executeLegacy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      value: { reconciled: true },
      hostToolExecutions: [{ name: 'task_temporal_reconcile', success: true }],
      hostToolsInvoked: ['task_temporal_reconcile'],
    });
    expect(registry.close(CONTEXT_KEY, leaseId)).toBe(true);
    expect(registry.has(CONTEXT_KEY)).toBe(false);
  });

  it('TG-06 fails closed before gateway execution when the key has no active lease', async () => {
    const execute = vi.fn();
    const executeLegacy = vi.fn();
    const executeCodeAct = createCodeActExecutor({
      registry: new RunContextRegistry(),
      gatewayToolExecutor: { execute },
      executeLegacy,
    });

    await expect(executeCodeAct('1 + 1', { contextKey: CONTEXT_KEY })).resolves.toEqual({
      success: false,
      error: 'Code-Act run context is unavailable.',
      errorCode: 'CODE_ACT_CONTEXT_UNAVAILABLE',
      retryable: false,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(executeLegacy).not.toHaveBeenCalled();
  });

  it('preserves the existing no-key legacy execution path', async () => {
    const execute = vi.fn();
    const executeLegacy = vi.fn().mockResolvedValue({ success: true, value: 'legacy' });
    const executeCodeAct = createCodeActExecutor({
      registry: new RunContextRegistry(),
      gatewayToolExecutor: { execute },
      executeLegacy,
    });

    await expect(executeCodeAct('legacy()', { agentId: 'dashboard-agent' })).resolves.toEqual({
      success: true,
      value: 'legacy',
    });
    expect(executeLegacy).toHaveBeenCalledWith('legacy()', { agentId: 'dashboard-agent' });
    expect(execute).not.toHaveBeenCalled();
  });
});
