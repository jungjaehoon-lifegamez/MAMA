import { describe, expect, it, vi } from 'vitest';
import {
  createNativeSessionRunner,
  type NativeSessionRunner,
} from '../../src/runtime/native-turn.js';
import { SessionPool } from '../../src/runtime/session-pool.js';
import type { HostExecutionContext, IModelRunner } from '../../src/runtime/drivers/types.js';

describe('native caller attribution', () => {
  it.each(['parent', 'child'])(
    'preserves consumer-owned context fields for a %s tool caller',
    async (callerKind) => {
      const pool = new SessionPool();
      const marker = { queue: 'consumer-work' };
      let observed: unknown;
      let runCount = 0;
      const agent = {
        backendType: 'claude',
        stop: async () => {},
        prompt: async (_text, callbacks) => {
          callbacks?.onInputDispatch?.({
            backend: 'claude',
            sessionId: 'consumer-session',
            inputId: 'input',
          });
          observed = await runner.withToolCaller(
            {
              session_id: 'consumer-session',
              tool_use_id: 'read-context',
              ...(callerKind === 'child' ? { agent_id: 'consumer-child' } : {}),
            },
            async (context) => context.backgroundTasks
          );
          return {
            response: 'done',
            session_id: 'consumer-session',
            usage: { input_tokens: 0, output_tokens: 0 },
          };
        },
      } as IModelRunner;
      const runner = createNativeSessionRunner({
        agent,
        backend: 'claude',
        model: 'fixture',
        maxTurns: 10,
        isGatewayMode: false,
        runTokenBudget: 0,
        sessionPool: pool,
        turnPolicy: () => ({ channelKey: 'consumer-lane', systemLayers: [] }),
        executionContext: (request) => ({ ...request, backgroundTasks: marker }),
        hostToolDefinitions: () => [],
        callTool: async () => ({}),
        modelRun: {
          begin: async () => `run-${++runCount}`,
          commit: async () => {},
          fail: async () => {},
        },
      });
      try {
        await runner.runTurn([{ type: 'text', text: 'read the consumer context' }], {
          sessionKey: 'consumer-lane',
          prepareAccess: async () => ({ grant: 'consumer' }),
        });
        expect(observed).toBe(marker);
      } finally {
        pool.dispose();
      }
    }
  );

  it.each(['background-known', 'fixture-agent'])(
    'keeps background children on their originating turn and permits SendMessage resume to %s',
    async (recipient) => {
      const pool = new SessionPool();
      let turn = 0;
      const begin = vi.fn(async () => `run-${begin.mock.calls.length}`);
      const call = (agent_id: string) =>
        runner.withToolCaller(
          {
            session_id: 'persistent-session',
            tool_use_id: `call-${turn}-${agent_id}`,
            agent_id,
          },
          async (context) => ({ parentModelRunId: context.parentModelRunId })
        );
      const agent = {
        backendType: 'claude',
        stop: vi.fn(),
        prompt: async (_text, callbacks) => {
          turn += 1;
          callbacks?.onInputDispatch?.({
            backend: 'claude',
            sessionId: 'persistent-session',
            inputId: `input-${turn}`,
          });
          if (turn === 1) {
            callbacks?.onToolUse?.('Agent', { name: 'fixture-agent', nativeToolUseId: 'spawn-1' });
            callbacks?.onSubagentStart?.({
              agentThreadId: 'background-known',
              agentPath: 'fixture',
              itemId: 'spawn-1',
            });
            callbacks?.onSubagentStart?.({
              agentThreadId: 'background-first-call-late',
              agentPath: 'fixture',
              itemId: 'spawn-2',
            });
            await call('background-known');
          } else {
            await expect(call('background-known')).rejects.toThrow('different turn');
            await expect(call('background-first-call-late')).rejects.toThrow('different turn');
            // The next parent explicitly resumes the old child before its first new tool call.
            callbacks?.onToolUse?.('SendMessage', { to: recipient, message: 'continue' });
            expect(await call('background-known')).toMatchObject({ parentModelRunId: 'run-3' });
          }
          return {
            response: 'done',
            session_id: 'persistent-session',
            usage: { input_tokens: 0, output_tokens: 0 },
          };
        },
      } as IModelRunner;
      const runner = createNativeSessionRunner({
        agent,
        backend: 'claude',
        model: 'fixture',
        maxTurns: 10,
        isGatewayMode: false,
        runTokenBudget: 0,
        sessionPool: pool,
        turnPolicy: () => ({ channelKey: 'owner-lane', systemLayers: [] }),
        executionContext: (request) => ({ ...request }),
        hostToolDefinitions: () => [],
        callTool: async () => ({}),
        modelRun: { begin, commit: vi.fn(async () => {}), fail: vi.fn(async () => {}) },
      });
      try {
        const request = {
          sessionKey: 'owner-lane',
          prepareAccess: async () => ({ grant: 'owner' }),
        };
        await runner.runTurn([{ type: 'text', text: 'first' }], request);
        await runner.runTurn([{ type: 'text', text: 'second' }], request);
        expect(begin).toHaveBeenCalledTimes(4);
      } finally {
        pool.dispose();
      }
    }
  );
  it('drains an in-flight child call before closing either run and refuses late calls', async () => {
    const pool = new SessionPool();
    let unblock!: () => void;
    let ready!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const commit = vi.fn(async () => {});
    const begin = vi.fn(async () => `run-${begin.mock.calls.length}`);
    let pending: Promise<void> | undefined;
    const caller = { session_id: 'native-session', tool_use_id: 'child-call', agent_id: 'child' };
    const agent = {
      backendType: 'claude',
      stop: vi.fn(),
      prompt: async (_text, callbacks) => {
        callbacks?.onInputDispatch?.({
          backend: 'claude',
          sessionId: caller.session_id,
          inputId: 'input',
        });
        pending = runner.withToolCaller(caller, async () => {
          ready();
          await blocked;
        });
        return {
          response: 'done',
          session_id: caller.session_id,
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      },
    } as IModelRunner;
    const runner = createNativeSessionRunner({
      agent,
      backend: 'claude',
      model: 'fixture',
      maxTurns: 10,
      isGatewayMode: false,
      runTokenBudget: 0,
      sessionPool: pool,
      turnPolicy: () => ({ channelKey: 'owner-lane', systemLayers: [] }),
      executionContext: (request) => ({ ...request }),
      hostToolDefinitions: () => [],
      callTool: async () => ({}),
      modelRun: { begin, commit, fail: vi.fn(async () => {}) },
    });
    try {
      const run = runner.runTurn([{ type: 'text', text: 'fixture' }], {
        sessionKey: 'owner-lane',
        prepareAccess: async () => ({ grant: 'owner' }),
      });
      await started;
      expect(commit).not.toHaveBeenCalled();
      await expect(
        runner.withToolCaller({ ...caller, tool_use_id: 'late' }, async () => {})
      ).rejects.toThrow('active turn');
      unblock();
      await pending;
      await run;
      expect(commit.mock.calls.map((call) => call[0])).toEqual(['run-2', 'run-1']);
    } finally {
      unblock();
      pool.dispose();
    }
  });
  it.each(['completed', 'failed'] as const)(
    'settles distinct concurrent children with the parent: %s',
    async (outcome) => {
      const pool = new SessionPool();
      const begin = vi.fn(async () => `run-${begin.mock.calls.length}`);
      const commit = vi.fn(async () => {});
      const fail = vi.fn(async () => {});
      const prepareAccess = vi.fn(async () => ({
        grant: `grant-${prepareAccess.mock.calls.length}`,
      }));
      const seen: HostExecutionContext[] = [];
      const agent = {
        backendType: 'claude',
        prompt: async (_text, callbacks) => {
          callbacks?.onInputDispatch?.({
            backend: 'claude',
            sessionId: 'native-session',
            inputId: 'input-1',
          });
          const caller = { session_id: 'native-session', tool_use_id: 'parent-call' };
          await runner.withToolCaller(caller, async (context) => {
            seen.push(context);
          });
          await expect(
            runner.withToolCaller({ ...caller, session_id: 'stale-session' }, async () => {})
          ).rejects.toThrow('active turn');
          await Promise.all(
            ['child-a', 'child-b', 'child-a'].map((id, index) =>
              runner.withToolCaller(
                { ...caller, agent_id: id, tool_use_id: `child-call-${index}` },
                async (context) => {
                  await Promise.resolve();
                  seen.push(context);
                }
              )
            )
          );
          if (outcome === 'failed') throw new Error('parent failed');
          return {
            response: 'done',
            session_id: 'native-session',
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
        stop: vi.fn(),
      } as IModelRunner;
      const runner: NativeSessionRunner = createNativeSessionRunner({
        agent,
        backend: 'claude',
        model: 'fixture',
        maxTurns: 10,
        isGatewayMode: false,
        runTokenBudget: 0,
        sessionPool: pool,
        turnPolicy: () => ({ channelKey: 'owner-lane', systemLayers: [] }),
        executionContext: (request) => ({ ...request }),
        hostToolDefinitions: () => [],
        callTool: async () => ({}),
        modelRun: { begin, commit, fail },
      });
      try {
        const run = runner.runTurn([{ type: 'text', text: 'fixture' }], {
          sessionKey: 'owner-lane',
          sourceMessageRef: 'fixture-input',
          channelId: 'fixture-channel',
          prepareAccess,
        });
        if (outcome === 'failed') await expect(run).rejects.toThrow('reconcile its result');
        else await run;
        expect(begin).toHaveBeenCalledTimes(3);
        expect(prepareAccess).toHaveBeenCalledTimes(3);
        expect(seen[0]).toMatchObject({
          modelRunId: 'run-1',
          gatewayCallId: 'parent-call',
          sourceMessageRef: 'fixture-input',
          channelId: 'fixture-channel',
        });
        const children = seen.slice(1);
        expect(new Set(children.map((context) => context.modelRunId)).size).toBe(2);
        expect(children.every((context) => context.parentModelRunId === 'run-1')).toBe(true);
        expect(
          children.find((context) => context.gatewayCallId === 'child-call-0')?.modelRunId
        ).toBe(children.find((context) => context.gatewayCallId === 'child-call-2')?.modelRunId);
        expect(outcome === 'completed' ? commit : fail).toHaveBeenCalledTimes(3);
        await expect(
          runner.withToolCaller(
            { session_id: 'native-session', tool_use_id: 'late' },
            async () => {}
          )
        ).rejects.toThrow('active turn');
      } finally {
        pool.dispose();
      }
    }
  );
});
