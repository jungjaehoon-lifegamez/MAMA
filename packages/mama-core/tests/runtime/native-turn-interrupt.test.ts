import { afterEach, expect, it, vi } from 'vitest';
import {
  createNativeSessionRunner,
  type NativeSessionHost,
} from '../../src/runtime/native-turn.js';
import { SessionPool } from '../../src/runtime/session-pool.js';
import {
  NativeTurnStoppedError,
  type HostExecutionContext,
  type IModelRunner,
} from '../../src/runtime/drivers/types.js';

const pools: SessionPool[] = [];
afterEach(() => {
  for (const pool of pools.splice(0)) pool.dispose();
});

function fixture(withInterrupt: boolean, newDurableSession = false) {
  const channelKey = 'fixture:interrupt';
  const pool = new SessionPool();
  pools.push(pool);
  let stop: ((error: Error) => void) | undefined;
  const interrupt = vi.fn(async (_sessionId: string | undefined, _key: string) => {
    if (!stop) return false;
    stop(new NativeTurnStoppedError());
    return true;
  });
  const agent: IModelRunner = {
    backendType: 'claude',
    supportsNativeSubagents: false,
    reportsModelRuns: false,
    prompt: () =>
      new Promise((_resolve, reject) => {
        stop = reject;
      }),
    ...(withInterrupt ? { interrupt } : {}),
    // A standing policy the backend does not hold yet: the turn opens a new durable session.
    ...(newDurableSession ? { getSessionPolicyStatus: () => 'missing' as const } : {}),
    setSessionId: () => {},
    setSystemPrompt: () => {},
    isHealthy: () => true,
    getMetrics: () => ({ requestCount: 0, failureCount: 0, avgLatencyMs: 0, lastRequestAt: null }),
    stop: () => {},
  };
  const host: NativeSessionHost<HostExecutionContext> = {
    agent,
    backend: 'claude',
    model: 'native-test',
    maxTurns: 1,
    isGatewayMode: true,
    runTokenBudget: 0,
    sessionPool: pool,
    turnPolicy: () => ({
      channelKey,
      systemLayers: [],
      ...(newDurableSession ? { standingPolicy: true } : {}),
    }),
    executionContext: () => null,
    hostToolDefinitions: () => [],
    callTool: async () => null,
  };
  // Fail the running turn the way a broken transport would, not on request.
  const fail = (error: Error) => {
    if (!stop) return false;
    stop(error);
    return true;
  };
  return { channelKey, pool, interrupt, fail, runner: createNativeSessionRunner(host) };
}

it('stops the running turn on request and keeps its session (/stop)', async () => {
  const h = fixture(true);
  expect(await h.runner.interrupt(h.channelKey)).toBe(false);
  expect(h.interrupt).not.toHaveBeenCalled();
  const turn = h.runner.runTurn([{ type: 'text', text: 'long request' }], {
    sessionKey: h.channelKey,
  });
  const stopped = expect(turn).rejects.toThrow('Native turn stopped on request');
  await vi.waitFor(() => expect(h.pool.peekSession(h.channelKey).busy).toBe(true));
  const sessionId = h.pool.peekSession(h.channelKey).sessionId;
  expect(await h.runner.interrupt(h.channelKey)).toBe(true);
  expect(h.interrupt).toHaveBeenCalledWith(sessionId, h.channelKey);
  await stopped;
  // Unlike /new, the session stays: the next turn continues it.
  expect(h.pool.peekSession(h.channelKey)).toEqual({ sessionId, busy: false });
});

it('refuses to stop a turn on a runner without an interrupt', async () => {
  const h = fixture(false);
  void h.runner
    .runTurn([{ type: 'text', text: 'long request' }], { sessionKey: h.channelKey })
    .catch(() => {});
  await vi.waitFor(() => expect(h.pool.peekSession(h.channelKey).busy).toBe(true));
  await expect(h.runner.interrupt(h.channelKey)).rejects.toThrow(
    'Native runner does not support interrupting a turn'
  );
  await h.runner.stop();
});

it('keeps a new session whose first turn was stopped, but drops one whose first turn failed', async () => {
  const stoppedCase = fixture(true, true);
  const turn = stoppedCase.runner.runTurn([{ type: 'text', text: 'first request' }], {
    sessionKey: stoppedCase.channelKey,
  });
  const stopped = expect(turn).rejects.toThrow('Native turn stopped on request');
  await vi.waitFor(async () =>
    expect(await stoppedCase.runner.interrupt(stoppedCase.channelKey)).toBe(true)
  );
  await stopped;
  // The backend holds the policy and the stopped request: the next turn continues this session.
  expect(stoppedCase.pool.peekSession(stoppedCase.channelKey).sessionId).toBeDefined();

  const failedCase = fixture(true, true);
  const failed = failedCase.runner.runTurn([{ type: 'text', text: 'first request' }], {
    sessionKey: failedCase.channelKey,
  });
  const rejected = expect(failed).rejects.toThrow('fixture transport broke');
  await vi.waitFor(() =>
    expect(failedCase.pool.peekSession(failedCase.channelKey).busy).toBe(true)
  );
  await vi.waitFor(() => expect(failedCase.fail(new Error('fixture transport broke'))).toBe(true));
  await rejected;
  expect(failedCase.pool.peekSession(failedCase.channelKey).sessionId).toBeUndefined();
});
