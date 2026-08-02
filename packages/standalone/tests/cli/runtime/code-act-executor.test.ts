import { describe, expect, it, vi } from 'vitest';

import { RunContextRegistry } from '../../../src/agent/code-act/run-context-registry.js';
import type { GatewayToolExecutionContext } from '../../../src/agent/types.js';
import { createCodeActExecutor } from '../../../src/cli/runtime/code-act-executor.js';
import { GatewayToolExecutor } from '../../../src/agent/gateway-tool-executor.js';
import type { ConnectorConfigLoadResult } from '../../../src/connectors/config-loader.js';
import { resolvePrivateConnectorPolicy } from '../../../src/connectors/private-connector-policy.js';

const CONTEXT_KEY = 'A'.repeat(43);

function privatePolicy(enabled: boolean) {
  const result: ConnectorConfigLoadResult = {
    ok: true,
    config: {
      kagemusha: {
        enabled,
        pollIntervalMinutes: 60,
        channels: {},
        auth: { type: 'none' },
      },
    },
    enabledNames: enabled ? ['kagemusha'] : [],
  };
  return resolvePrivateConnectorPolicy(result);
}

function makeTrustedContext(roleName: string): GatewayToolExecutionContext {
  return {
    agentId: roleName,
    source:
      roleName.startsWith('workorder-') || roleName === 'operator-report' ? 'operator' : 'telegram',
    channelId: roleName,
    executionSurface: 'model_tool',
    envelope: {
      agent_id: roleName,
      instance_id: `${roleName}:instance`,
      source: 'telegram',
      channel_id: roleName,
      trigger_context: {},
      scope: {
        project_refs: [],
        raw_connectors: ['kagemusha'],
        memory_scopes: [],
        allowed_destinations: [],
      },
      tier: 2,
      budget: { wall_seconds: 60 },
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      envelope_hash: 'trusted-private-test-envelope',
    },
    agentContext: {
      source:
        roleName.startsWith('workorder-') || roleName === 'operator-report'
          ? 'operator'
          : 'telegram',
      platform: 'cli',
      roleName,
      role: { allowedTools: ['code_act', '*'] },
      session: { sessionId: roleName, startedAt: new Date() },
      capabilities: ['code_act'],
      limitations: [],
      tier: 2,
      backend: 'codex',
    },
  };
}

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

  it('TG-03/TG-04 releases the execution pin when gateway execution throws', async () => {
    const registry = new RunContextRegistry();
    const leaseId = registry.register(CONTEXT_KEY, makeContext());
    const execute = vi.fn().mockRejectedValue(new Error('gateway execution failed'));
    const executeCodeAct = createCodeActExecutor({
      registry,
      gatewayToolExecutor: { execute },
      executeLegacy: vi.fn(),
    });

    await expect(executeCodeAct('task_list({})', { contextKey: CONTEXT_KEY })).rejects.toThrow(
      'gateway execution failed'
    );

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

  it.each(['owner_console', 'operator-report'])(
    'TG-04/TG-06 preserves the enabled trusted %s private surface by registry key',
    async (roleName) => {
      const registry = new RunContextRegistry();
      registry.register(CONTEXT_KEY, makeTrustedContext(roleName));
      const executor = new GatewayToolExecutor({
        envelopeIssuanceMode: 'off',
        privateConnectorPolicy: privatePolicy(true),
      });
      const executeCodeAct = createCodeActExecutor({
        registry,
        gatewayToolExecutor: executor,
        executeLegacy: vi.fn(),
      });

      const result = await executeCodeAct('typeof kagemusha_tasks', {
        contextKey: CONTEXT_KEY,
        agentId: 'http-supplied-generic',
      });

      expect(result).toMatchObject({ success: true, value: 'function' });
    }
  );

  it('TG-04 rejects the disabled trusted owner surface and an HTTP role upgrade', async () => {
    const registry = new RunContextRegistry();
    registry.register(CONTEXT_KEY, makeTrustedContext('chat_bot'));
    const executor = new GatewayToolExecutor({
      envelopeIssuanceMode: 'off',
      privateConnectorPolicy: privatePolicy(true),
    });
    const executeCodeAct = createCodeActExecutor({
      registry,
      gatewayToolExecutor: executor,
      executeLegacy: vi.fn(),
    });

    const generic = await executeCodeAct('typeof kagemusha_tasks', {
      contextKey: CONTEXT_KEY,
      agentId: 'owner_console',
    });
    expect(generic).toMatchObject({ success: true, value: 'undefined' });

    const disabledRegistry = new RunContextRegistry();
    disabledRegistry.register(CONTEXT_KEY, makeTrustedContext('owner_console'));
    const disabled = createCodeActExecutor({
      registry: disabledRegistry,
      gatewayToolExecutor: new GatewayToolExecutor({
        envelopeIssuanceMode: 'off',
        privateConnectorPolicy: privatePolicy(false),
      }),
      executeLegacy: vi.fn(),
    });
    await expect(
      disabled('typeof kagemusha_tasks', { contextKey: CONTEXT_KEY })
    ).resolves.toMatchObject({ success: true, value: 'undefined' });
  });
});
