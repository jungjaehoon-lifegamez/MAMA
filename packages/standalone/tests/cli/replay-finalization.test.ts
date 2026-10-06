import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IModelRunner } from '@jungjaehoon/mama-core/runtime/drivers/types';
import { SessionPool } from '@jungjaehoon/mama-core/runtime/session-pool';
import { createNativeSession } from '../../src/runtime/native-session.js';
import { createActionSurface } from '../../src/runtime/action-surface.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import { runReplay } from '../../src/cli/commands/replay.js';

const state = vi.hoisted(() => ({
  context: undefined as unknown,
  fence: 1000,
  reached: 1000,
  order: [] as string[],
}));
vi.mock('../../src/cli/commands/daemon.js', () => ({
  bootDaemon: async (options: { replay: (context: unknown) => Promise<void> }) => {
    await options.replay(state.context);
    return {
      stop: async () => {
        state.order.push('stop');
      },
    };
  },
}));
vi.mock('../../src/replay/import-manifest.js', () => ({
  readImportManifest: () => ({ fromMs: 0, untilMs: state.fence }),
}));
vi.mock('../../src/connectors/config-loader.js', () => ({
  loadConnectorConfig: () => ({ ok: true, config: {} }),
}));
vi.mock('../../src/runtime/connectors.js', () => ({
  setLiveConnectorPollCursors: () => {
    state.order.push('fence');
  },
}));
vi.mock('../../src/runtime/owner-policy.js', () => ({
  createOwnerPolicyProvider: () => () => ({ fingerprint: 'test-policy' }),
}));
vi.mock('../../src/replay/replay-source-catalog.js', () => ({
  createReplaySourceCatalog: () => ({}),
}));
vi.mock('../../src/replay/replay-feeder.js', () => ({
  ReplayFeeder: class {
    preflight() {
      return { windows: [], deltas: [] };
    }
    async run() {
      state.order.push('replay');
      return { nextWindowStartMs: state.reached, windows: 1, deltas: 1, settled: 1 };
    }
  },
}));

afterEach(() => {
  state.order = [];
  state.reached = state.fence;
});

describe('replay finalization', () => {
  it.each(['codex', 'claude'] as const)(
    'resets %s before stop so the next live turn receives startup context',
    async (backend) => {
      const pool = new SessionPool();
      const retained = new Set<string>();
      const route = (options: { sessionKey?: string; sessionId?: string }) =>
        (backend === 'codex' ? options.sessionKey : options.sessionId)!;
      const model = {
        backendType: backend,
        reportsModelRuns: false,
        supportsNativeSubagents: false,
        getSessionPolicyStatus: (options) =>
          retained.has(route(options)) ? 'compatible' : 'missing',
        prompt: async (_text, _callbacks, options) => {
          const key = route(options!);
          const text = await options!.preparePrompt!({
            sessionId: key,
            isNewSession: !retained.has(key),
          });
          retained.add(key);
          return { response: text, session_id: key, usage: { input_tokens: 1, output_tokens: 1 } };
        },
        resetSession: (sessionId, sessionKey) => {
          retained.delete(route({ sessionId, sessionKey }));
          state.order.push('reset');
        },
        stop: async () => {},
      } as IModelRunner;
      const session = createNativeSession({
        backend,
        model: 'test-model',
        workspaceDir: '/tmp/replay-session-test',
        runtimeRoot: '/tmp/replay-session-test',
        actionSurface: createActionSurface({
          timeZone: createTimeZoneSetting('UTC'),
          runtimeRoot: '/tmp/mama-test-runtime',
          configPath: '/tmp/mama-test-config.yaml',
          isOwnerMessageTurn: () => true,
          adapter: {} as never,
          knowledge: {} as never,
          ownerPrincipalId: 'owner',
          agentId: 'test-agent',
        }),
        agent: model,
        sessionPool: pool,
        maxTurns: 10,
        timeout: 1000,
      });
      const run = () =>
        session.runTurn([], {
          prepareSessionContent: async ({ isNewSession }) => [
            { type: 'text', text: isNewSession ? 'startup' : 'continuation' },
          ],
        });
      try {
        expect((await run()).response).toBe('startup');
        expect((await run()).response).toBe('continuation');
        state.context = {
          paths: {
            mamaRoot: '/tmp/replay-session-test',
            runtimeRoot: '/tmp/replay-session-test',
            connectorsRoot: '/tmp/replay-session-test',
            connectorsConfigPath: '/tmp/replay-session-test/connectors.json',
          },
          owner: {
            runtime: { nativeSession: session, mailbox: {} },
            database: { adapter: {} },
            intake: {},
          },
          logger: { info: () => {} },
        };
        await runReplay();
        expect(state.order).toEqual(['replay', 'reset', 'fence', 'stop']);
        expect(pool.peekSession('owner:runtime')).toEqual({ busy: false });
        expect((await run()).response).toBe('startup');
        expect((await run()).response).toBe('continuation');
        state.order = [];
        state.reached = 500;
        await expect(runReplay()).rejects.toThrow('before the import fence');
        expect(state.order).toEqual(['replay']);
        expect((await run()).response).toBe('continuation');
      } finally {
        await session.stop();
        pool.dispose();
      }
    }
  );
});
