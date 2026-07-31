import { describe, expect, it, vi } from 'vitest';

import { PersistentCLIAdapter } from '../../src/agent/persistent-cli-adapter.js';
import { RunContextRegistry } from '../../src/agent/code-act/run-context-registry.js';
import type { GatewayToolExecutionContext } from '../../src/agent/types.js';

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
});
