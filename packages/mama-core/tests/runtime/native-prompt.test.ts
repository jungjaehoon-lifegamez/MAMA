import { afterEach, describe, expect, it } from 'vitest';
import {
  runNativePrompt,
  type NativePromptCarry,
  type NativePromptContext,
  type NativePromptHost,
} from '../../src/runtime/native-prompt.js';
import { SessionPool } from '../../src/runtime/session-pool.js';
import { NativeEffectReplayBoundary } from '../../src/runtime/native-effect-observer.js';
import type { HostExecutionContext } from '../../src/runtime/drivers/types.js';
import type {
  IModelRunner,
  PromptResult,
  PromptCallbacks,
  NativeInputReceipt,
} from '../../src/runtime/drivers/types.js';

const pools: SessionPool[] = [];
afterEach(() => {
  for (const pool of pools.splice(0)) pool.dispose();
});

function invocation(prompt: IModelRunner['prompt'], onAccepted?: PromptCallbacks['onAccepted']) {
  const pool = new SessionPool();
  pools.push(pool);
  const carry: NativePromptCarry = {
    turn: 0,
    stopReason: 'end_turn',
    budgetTokens: 0,
    resolvedCliSessionId: 'session',
    sessionIsNew: false,
  };
  const context: NativePromptContext<HostExecutionContext> = {
    channelKey: 'test',
    claudeNativeTools: undefined,
    effectiveSessionPolicyFingerprint: 'policy',
    history: [],
    hostToolBridge: undefined,
    isCodex: false,
    isDurableRuntime: false,
    nativeEffects: new NativeEffectReplayBoundary(),
    ownedModelRunId: null,
    standingPolicy: false,
    systemPrompt: undefined,
    reanchor: undefined,
    resumeInstructions: undefined,
    runScope: { streamCallbacks: onAccepted ? { onAccepted } : undefined },
    toolExecutionContext: null,
    totalUsage: { input_tokens: 0, output_tokens: 0 },
    runUsage: {
      input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      output_tokens: null,
      compaction_count: null,
    },
    tracksSessionPolicy: false,
  } as NativePromptContext<HostExecutionContext>;
  let effects = 0;
  const host = {
    agent: { prompt },
    backend: 'claude',
    model: 'native',
    maxTurns: 3,
    isGatewayMode: true,
    runTokenBudget: 0,
    sessionPool: pool,
    preCompactHandler: null,
    stopContinuationHandler: null,
    executeTools: async () => {
      effects++;
      return [];
    },
    formatLastMessageOnly: () => 'request',
    withExecutionSurface: () => null,
  } as unknown as NativePromptHost;
  return {
    carry,
    context,
    run: () => runNativePrompt(carry, context, {}, host),
    effects: () => effects,
  };
}

const result = (response: string): PromptResult => ({
  response,
  session_id: 'native',
  usage: { input_tokens: 1, output_tokens: 1 },
});

describe('v7 W5: the native harness owns model and tool iteration', () => {
  it('never retries an accepted input as a new session when the final result fails', async () => {
    let calls = 0;
    const h = invocation(async (_text, callbacks) => {
      calls++;
      callbacks?.onAccepted?.({ backend: 'claude', sessionId: 'native', inputId: 'accepted' });
      throw new Error('No conversation found with session ID from a later native failure');
    });
    await expect(h.run()).rejects.toMatchObject({ retryable: false });
    expect(calls).toBe(1);
  });

  it('does not reset and resend a dispatched input when its ACK is lost', async () => {
    let calls = 0;
    const h = invocation(async (_text, callbacks) => {
      calls++;
      callbacks?.onInputDispatch?.({
        backend: 'claude',
        sessionId: 'native',
        inputId: 'durable-id',
      });
      throw new Error('No conversation found with session ID after transport loss');
    });
    await expect(h.run()).rejects.toMatchObject({ retryable: false });
    expect(calls).toBe(1);
  });

  it('preserves literal tool syntax as text instead of executing another host turn', async () => {
    const text = '```tool_call\n{"name":"write","input":{"path":"file"}}\n```';
    let calls = 0;
    const h = invocation(async () => result(++calls === 1 ? text : 'second host turn'));
    await h.run();
    expect(calls).toBe(1);
    expect(h.effects()).toBe(0);
    expect(h.context.history.at(-1)?.content).toEqual([{ type: 'text', text }]);
  });

  it('refuses unresolved native tool blocks instead of executing them in a host loop', async () => {
    let calls = 0;
    const h = invocation(async () =>
      ++calls === 1
        ? {
            ...result(''),
            toolUseBlocks: [{ type: 'tool_use', id: 'tool-1', name: 'write', input: {} }],
          }
        : result('second host turn')
    );
    await expect(h.run()).rejects.toThrow(/unresolved native tool/i);
    expect(h.effects()).toBe(0);
    expect(calls).toBe(1);
  });

  it('forwards acceptance before the native result without making a second prompt', async () => {
    const receipt: NativeInputReceipt = {
      backend: 'claude',
      sessionId: 'native',
      inputId: 'input',
    };
    const seen: NativeInputReceipt[] = [];
    let finish!: (value: PromptResult) => void;
    const pending = new Promise<PromptResult>((resolve) => {
      finish = resolve;
    });
    const h = invocation(
      async (_text, callbacks) => {
        callbacks?.onAccepted?.(receipt);
        return pending;
      },
      (accepted) => seen.push(accepted)
    );
    const turn = h.run();
    await Promise.resolve();
    expect(seen).toEqual([receipt]);
    finish(result('done'));
    await turn;
    expect(h.carry.turn).toBe(1);
  });
});
