import { describe, expect, it, vi } from 'vitest';

import { PersistentCLIAdapter } from '../../src/agent/persistent-cli-adapter.js';
import { RunContextRegistry } from '../../src/agent/code-act/run-context-registry.js';
import { HostToolTerminalError } from '../../src/agent/model-runner.js';
import {
  McpCompletedMutationInterruptedError,
  type GatewayToolExecutionContext,
} from '../../src/agent/types.js';

const CONTEXT_KEY = 'A'.repeat(43);

function makeContext(signal?: AbortSignal): GatewayToolExecutionContext {
  return {
    agentId: 'workorder-temporal-9',
    source: 'operator',
    channelId: 'temporal',
    executionSurface: 'model_tool',
    modelRunId: 'model-run-9',
    workorderAttemptId: 9,
    causeEventIds: ['event-9'],
    signal,
  };
}

function installAdapterDependencies(
  adapter: PersistentCLIAdapter,
  process: {
    getRunContextKey: () => string;
    isAlive: () => boolean;
    sendMessage: ReturnType<typeof vi.fn>;
  },
  registry: RunContextRegistry,
  retireProcess = vi.fn().mockReturnValue(true)
): typeof retireProcess {
  const getProcess = vi.fn().mockResolvedValue(process);
  (
    adapter as unknown as {
      processPool: {
        getProcess: typeof getProcess;
        retireProcess: typeof retireProcess;
      };
      contextRegistry: RunContextRegistry;
    }
  ).processPool = { getProcess, retireProcess };
  (
    adapter as unknown as {
      contextRegistry: RunContextRegistry;
    }
  ).contextRegistry = registry;
  return retireProcess;
}

describe('S3 TG-03/TG-04: PersistentCLIAdapter prompt-attempt lease', () => {
  it('registers the exact run context on the acquired process key and closes it on success', async () => {
    const registry = new RunContextRegistry();
    const context = makeContext();
    let acquiredContext: GatewayToolExecutionContext | undefined;
    const process = {
      getRunContextKey: () => CONTEXT_KEY,
      isAlive: () => true,
      sendMessage: vi.fn().mockImplementation(async () => {
        const pin = registry.acquire(CONTEXT_KEY);
        acquiredContext = pin?.context;
        pin?.releasePin();
        return {
          response: 'ok',
          session_id: 'backend-session',
          toolUseBlocks: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }),
    };
    const adapter = new PersistentCLIAdapter({ sessionId: 'route-9' });
    installAdapterDependencies(adapter, process, registry);

    await adapter.prompt('run workorder', undefined, { toolExecutionContext: context });

    expect(acquiredContext).toMatchObject({
      agentId: 'workorder-temporal-9',
      modelRunId: 'model-run-9',
      workorderAttemptId: 9,
      causeEventIds: ['event-9'],
    });
    expect(acquiredContext?.signal).toBeInstanceOf(AbortSignal);
    expect(registry.acquire(CONTEXT_KEY)).toBeNull();
  });

  it('aborts the attempt, closes its lease, and identity-retires the acquired process on error', async () => {
    const registry = new RunContextRegistry();
    const ownerController = new AbortController();
    let attemptSignal: AbortSignal | undefined;
    const failure = new Error('stream disconnected');
    const process = {
      getRunContextKey: () => CONTEXT_KEY,
      isAlive: () => true,
      sendMessage: vi.fn().mockImplementation(async () => {
        const pin = registry.acquire(CONTEXT_KEY);
        attemptSignal = pin?.context.signal;
        pin?.releasePin();
        throw failure;
      }),
    };
    const adapter = new PersistentCLIAdapter({ sessionId: 'route-9' });
    const retireProcess = installAdapterDependencies(adapter, process, registry);

    await expect(
      adapter.prompt('run workorder', undefined, {
        toolExecutionContext: makeContext(ownerController.signal),
      })
    ).rejects.toBe(failure);

    expect(attemptSignal?.aborted).toBe(true);
    expect(registry.acquire(CONTEXT_KEY)).toBeNull();
    expect(retireProcess).toHaveBeenCalledWith('route-9', process);
  });

  it('propagates owner cancellation through the combined attempt signal', async () => {
    const registry = new RunContextRegistry();
    const ownerController = new AbortController();
    let attemptSignal: AbortSignal | undefined;
    const process = {
      getRunContextKey: () => CONTEXT_KEY,
      isAlive: () => true,
      sendMessage: vi.fn().mockImplementation(async () => {
        const pin = registry.acquire(CONTEXT_KEY);
        attemptSignal = pin?.context.signal;
        ownerController.abort(new Error('owner stopped'));
        pin?.releasePin();
        return {
          response: 'stopped',
          session_id: 'backend-session',
          toolUseBlocks: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }),
    };
    const adapter = new PersistentCLIAdapter({ sessionId: 'route-9' });
    installAdapterDependencies(adapter, process, registry);

    await adapter.prompt('run workorder', undefined, {
      toolExecutionContext: makeContext(ownerController.signal),
    });

    expect(attemptSignal?.aborted).toBe(true);
  });

  it('TG-06 rejects an unresolved MCP Code-Act result and retires its process generation', async () => {
    const registry = new RunContextRegistry();
    let attemptSignal: AbortSignal | undefined;
    const process = {
      getRunContextKey: () => CONTEXT_KEY,
      isAlive: () => true,
      sendMessage: vi.fn().mockImplementation(async () => {
        const pin = registry.acquire(CONTEXT_KEY);
        attemptSignal = pin?.context.signal;
        pin?.releasePin();
        return {
          response: '',
          session_id: 'backend-session',
          toolUseBlocks: [
            {
              type: 'tool_use',
              id: 'missing-result-1',
              name: 'mcp__code-act__code_act',
              input: { code: 'mutate()' },
            },
          ],
          completedToolExchanges: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }),
    };
    const adapter = new PersistentCLIAdapter({ sessionId: 'route-9' });
    const retireProcess = installAdapterDependencies(adapter, process, registry);

    await expect(
      adapter.prompt('run workorder', undefined, { toolExecutionContext: makeContext() })
    ).rejects.toMatchObject({
      name: 'McpResultMissingError',
      code: 'MCP_RESULT_MISSING',
      retryable: false,
      toolUseIds: ['missing-result-1'],
    });

    expect(attemptSignal?.aborted).toBe(true);
    expect(registry.acquire(CONTEXT_KEY)).toBeNull();
    expect(retireProcess).toHaveBeenCalledWith('route-9', process);
  });

  it('TG-03/TG-06 prioritizes a paired terminal result over a later missing result', async () => {
    const registry = new RunContextRegistry();
    const process = {
      getRunContextKey: () => CONTEXT_KEY,
      isAlive: () => true,
      sendMessage: vi.fn().mockResolvedValue({
        response: 'The mutation outcome is unknown.',
        session_id: 'backend-session',
        toolUseBlocks: [
          {
            type: 'tool_use',
            id: 'missing-after-terminal',
            name: 'mcp__code-act__code_act',
            input: { code: 'mutate()' },
          },
        ],
        completedToolExchanges: [
          {
            toolUse: {
              type: 'tool_use',
              id: 'terminal-result-1',
              name: 'mcp__code-act__code_act',
              input: { code: 'mutate()' },
            },
            toolResult: {
              type: 'tool_result',
              tool_use_id: 'terminal-result-1',
              content: JSON.stringify({
                protocol: 'mama.code_act.result',
                version: 1,
                success: false,
                hostToolExecutions: [{ name: 'mama_save', success: false }],
                hostToolsInvoked: [],
                payload: {},
                error: {
                  code: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
                  message: 'Mutation may have committed.',
                },
                retryable: false,
                abort: true,
              }),
              is_error: true,
            },
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    };
    const adapter = new PersistentCLIAdapter({ sessionId: 'route-9' });
    const retireProcess = installAdapterDependencies(adapter, process, registry);

    const result = await adapter.prompt('run workorder', undefined, {
      toolExecutionContext: makeContext(),
    });

    expect(result.terminalError).toEqual({
      code: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
      message: 'Mutation may have committed.',
    });
    expect(retireProcess).toHaveBeenCalledWith('route-9', process);
  });

  it('TG-03/TG-05/TG-06 preserves a completed mutation when a later MCP result is missing', async () => {
    const registry = new RunContextRegistry();
    const completedExchange = {
      toolUse: {
        type: 'tool_use' as const,
        id: 'completed-before-missing',
        name: 'mcp__code-act__code_act',
        input: { code: 'mama_save({})' },
      },
      toolResult: {
        type: 'tool_result' as const,
        tool_use_id: 'completed-before-missing',
        content: JSON.stringify({
          protocol: 'mama.code_act.result',
          version: 1,
          success: true,
          hostToolExecutions: [{ name: 'mama_save', success: true }],
          hostToolsInvoked: ['mama_save'],
          payload: { value: { id: 'saved' } },
        }),
      },
    };
    const process = {
      getRunContextKey: () => CONTEXT_KEY,
      isAlive: () => true,
      sendMessage: vi.fn().mockResolvedValue({
        response: '',
        session_id: 'backend-session',
        toolUseBlocks: [
          {
            type: 'tool_use',
            id: 'missing-after-completed',
            name: 'mcp__code-act__code_act',
            input: { code: 'mama_save({})' },
          },
        ],
        completedToolExchanges: [completedExchange],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    };
    const adapter = new PersistentCLIAdapter({ sessionId: 'route-9' });
    const retireProcess = installAdapterDependencies(adapter, process, registry);

    await expect(adapter.prompt('completed mutation then missing result')).rejects.toMatchObject({
      name: 'McpCompletedMutationInterruptedError',
      code: 'MCP_COMPLETED_MUTATION_INTERRUPTED',
      retryable: false,
      completedToolExchanges: [completedExchange],
    });

    expect(retireProcess).toHaveBeenCalledWith('route-9', process);
  });

  it('TG-03/TG-04 does not retire an incumbent prompt when lease registration conflicts', async () => {
    const registry = new RunContextRegistry();
    const incumbent = makeContext();
    registry.register(CONTEXT_KEY, incumbent);
    const process = {
      getRunContextKey: () => CONTEXT_KEY,
      isAlive: () => true,
      sendMessage: vi.fn(),
    };
    const adapter = new PersistentCLIAdapter({ sessionId: 'route-9' });
    const retireProcess = installAdapterDependencies(adapter, process, registry);

    await expect(
      adapter.prompt('concurrent contender', undefined, { toolExecutionContext: makeContext() })
    ).rejects.toMatchObject({ code: 'RUN_CONTEXT_LEASE_CONFLICT' });

    expect(process.sendMessage).not.toHaveBeenCalled();
    expect(retireProcess).not.toHaveBeenCalled();
    expect(registry.acquire(CONTEXT_KEY)?.context).toBe(incumbent);
  });

  it('TG-03/TG-05 retires an interrupted completed-mutation process without a run context', async () => {
    const registry = new RunContextRegistry();
    const process = {
      getRunContextKey: () => CONTEXT_KEY,
      isAlive: () => true,
      sendMessage: vi.fn().mockRejectedValue(new McpCompletedMutationInterruptedError([])),
    };
    const adapter = new PersistentCLIAdapter({ sessionId: 'route-9' });
    const retireProcess = installAdapterDependencies(adapter, process, registry);

    await expect(adapter.prompt('completed mutation then close')).rejects.toMatchObject({
      code: 'MCP_COMPLETED_MUTATION_INTERRUPTED',
      retryable: false,
    });

    expect(retireProcess).toHaveBeenCalledWith('route-9', process);
  });

  it('TG-03/TG-06 retires an interrupted terminal process without a run context', async () => {
    const registry = new RunContextRegistry();
    const process = {
      getRunContextKey: () => CONTEXT_KEY,
      isAlive: () => true,
      sendMessage: vi
        .fn()
        .mockRejectedValue(
          new HostToolTerminalError(
            'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
            'Mutation may have committed.',
            []
          )
        ),
    };
    const adapter = new PersistentCLIAdapter({ sessionId: 'route-9' });
    const retireProcess = installAdapterDependencies(adapter, process, registry);

    await expect(adapter.prompt('terminal result then close')).rejects.toMatchObject({
      terminalCode: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
      retryable: false,
    });

    expect(retireProcess).toHaveBeenCalledWith('route-9', process);
  });

  it('keeps unresolved non-MCP host tools on the existing AgentLoop execution path', async () => {
    const registry = new RunContextRegistry();
    const process = {
      getRunContextKey: () => CONTEXT_KEY,
      isAlive: () => true,
      sendMessage: vi.fn().mockResolvedValue({
        response: '',
        session_id: 'backend-session',
        toolUseBlocks: [
          {
            type: 'tool_use',
            id: 'host-read-1',
            name: 'mama_search',
            input: { query: 'contracts' },
          },
        ],
        completedToolExchanges: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    };
    const adapter = new PersistentCLIAdapter({ sessionId: 'route-9' });
    const retireProcess = installAdapterDependencies(adapter, process, registry);

    const result = await adapter.prompt('search', undefined, {
      toolExecutionContext: makeContext(),
    });

    expect(result.toolUseBlocks).toEqual([
      expect.objectContaining({ id: 'host-read-1', name: 'mama_search' }),
    ]);
    expect(retireProcess).not.toHaveBeenCalled();
  });
});
