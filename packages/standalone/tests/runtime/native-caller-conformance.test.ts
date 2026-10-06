import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  beginModelRun,
  commitModelRun,
  createKnowledge,
  failModelRun,
} from '@jungjaehoon/mama-core';
import type { Client } from '@jungjaehoon/mama-core/client/client';
import type { IModelRunner } from '@jungjaehoon/mama-core/runtime/drivers/types';
import type { SubagentBridge } from '@jungjaehoon/mama-core/runtime/runtime-process';
import { SessionPool } from '@jungjaehoon/mama-core/runtime/session-pool';
import { createActionSurface } from '../../src/runtime/action-surface.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import {
  createNativeSession,
  type NativeDriverOptions,
  type NativeSession,
} from '../../src/runtime/native-session.js';
import { handleRequest } from '../../src/runtime/action-mcp-server.js';
import { callerHookOutput } from '../../src/runtime/claude-caller-hook.js';

describe('native host contract conformance', () => {
  it.each([
    ['claude', 'completed'],
    ['claude', 'failed'],
    ['codex', 'completed'],
  ] as const)(
    '%s records each write on its parent or distinct child run (%s)',
    async (backend, outcome) => {
      const home = mkdtempSync(join(tmpdir(), 'caller-conformance-'));
      const db = await openCoreDatabase({ path: join(home, 'state.db') });
      const pool = new SessionPool();
      const knowledge = createKnowledge({
        adapter: db.adapter,
        embedder: { embed: async () => new Float32Array(1024).fill(0.25) },
      });
      const surface = createActionSurface({
        timeZone: createTimeZoneSetting('UTC'),
        runtimeRoot: '/tmp/mama-test-runtime',
        configPath: '/tmp/mama-test-config.yaml',
        isOwnerMessageTurn: () => true,
        adapter: db.adapter,
        knowledge,
        ownerPrincipalId: 'owner',
        agentId: 'agent',
      });
      const dispatch = vi.spyOn(surface, 'dispatch');
      const hostCall = vi.spyOn(surface, 'hostToolCall');
      const prepareAccess = vi.fn(async () => ({ ...surface.ownerAccess }));
      let driver: NativeDriverOptions;
      const children: SubagentBridge[] = [];
      let rootRunId: string;
      const model = {
        backendType: backend,
        supportsNativeSubagents: true,
        prompt: async (_content, callbacks, options) => {
          callbacks?.onInputDispatch?.({
            backend,
            sessionId: 'native-session',
            inputId: 'fixture-input',
          });
          const write = async (callId: string, agentId?: string) => {
            const input = {
              topic: callId,
              summary: 'fixture evidence',
              set: { title: callId },
              eventDatetime: 1_000,
            };
            if (backend === 'codex') {
              const bridge = agentId
                ? await driver.createSubagentBridge({
                    sessionKey: 'owner:runtime',
                    parentThreadId: 'native-session',
                    agentThreadId: agentId,
                    agentPath: agentId,
                  })
                : undefined;
              if (bridge) children.push(bridge);
              const result = await (bridge?.bridge ?? options!.hostToolBridge!).execute({
                callId,
                name: 'work.create',
                input,
              });
              expect(result.isError, result.content).not.toBe(true);
            } else {
              const argumentsWithCaller = callerHookOutput({
                session_id: 'native-session',
                tool_use_id: callId,
                tool_input: input,
                ...(agentId ? { agent_id: agentId, agent_type: 'general-purpose' } : {}),
              }).hookSpecificOutput.updatedInput;
              const client = {
                call: (call) =>
                  session.callAction({ ...call, operationId: callId }, call.session!.nativeCaller!),
              } as Client;
              const result = await handleRequest(
                {
                  jsonrpc: '2.0',
                  id: callId,
                  method: 'tools/call',
                  params: { name: 'work.create', arguments: argumentsWithCaller },
                },
                { client }
              );
              expect(result?.result, JSON.stringify(result)).not.toHaveProperty('isError', true);
            }
          };
          await write('parent-write');
          await Promise.all([write('child-write-a', 'child-a'), write('child-write-b', 'child-b')]);
          for (const child of children) await child.release({ status: 'completed' });
          if (outcome === 'failed') throw new Error('fixture parent failure');
          return {
            response: 'done',
            session_id: 'native-session',
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
        stop: vi.fn(),
      } as IModelRunner;
      const session: NativeSession = createNativeSession({
        backend,
        model: 'fixture-model',
        workspaceDir: join(home, 'workspace'),
        runtimeRoot: home,
        actionSurface: surface,
        timeout: 1_000,
        maxTurns: 10,
        sessionPool: pool,
        createAgent: (options) => {
          driver = options;
          return model;
        },
        modelRun: {
          begin: async (request) => {
            const id = beginModelRun(db.adapter, {
              model_id: 'fixture-model',
              model_provider: backend,
              parent_model_run_id: request?.parentModelRunId as string | undefined,
            }).model_run_id;
            if (!request?.parentModelRunId) rootRunId = id;
            return id;
          },
          commit: async (id, summary) => {
            commitModelRun(db.adapter, id, summary);
          },
          fail: async (id, summary) => {
            failModelRun(db.adapter, id, summary);
          },
        },
      });
      try {
        const turn = session.runTurn([{ type: 'text', text: 'fixture' }], {
          sourceMessageRef: 'fixture-source',
          channelId: 'fixture-channel',
          prepareAccess,
          replaySourceEndMs: 1_500,
        });
        if (outcome === 'failed') await expect(turn).rejects.toThrow('reconcile its result');
        else expect((await turn).modelRunId).toBe(rootRunId!);
        const status = outcome === 'completed' ? 'committed' : 'failed';
        const rows = db.adapter
          .prepare(
            `SELECT t.gateway_call_id, t.model_run_id, r.parent_model_run_id, r.status
        FROM tool_traces t JOIN model_runs r USING(model_run_id) ORDER BY t.gateway_call_id`
          )
          .all();
        expect(rows).toEqual([
          {
            gateway_call_id: 'child-write-a',
            model_run_id: expect.any(String),
            parent_model_run_id: rootRunId!,
            status,
          },
          {
            gateway_call_id: 'child-write-b',
            model_run_id: expect.any(String),
            parent_model_run_id: rootRunId!,
            status,
          },
          {
            gateway_call_id: 'parent-write',
            model_run_id: rootRunId!,
            parent_model_run_id: null,
            status,
          },
        ]);
        expect(
          new Set(rows.map((row) => (row as { model_run_id: string }).model_run_id)).size
        ).toBe(3);
        expect(prepareAccess).toHaveBeenCalledTimes(3);
        const expectedFacts = {
          modelRunId: rootRunId!,
          gatewayCallId: 'parent-write',
          sourceMessageRef: 'fixture-source',
          channelId: 'fixture-channel',
          replaySourceEndMs: 1_500,
        };
        if (backend === 'claude')
          expect(dispatch.mock.calls[0][1].session).toMatchObject(expectedFacts);
        else expect(hostCall.mock.calls[0][3]?.session).toMatchObject(expectedFacts);
        const items = await surface.hostToolCall('work.list', {}, 'read-back');
        expect(items.status).toBe('completed');
        expect(JSON.stringify(items.data)).toContain('child-write-a');
        expect(JSON.stringify(items.data)).toContain('child-write-b');
      } finally {
        await session.stop();
        pool.dispose();
        await db.close();
        rmSync(home, { recursive: true, force: true });
      }
    }
  );
});
