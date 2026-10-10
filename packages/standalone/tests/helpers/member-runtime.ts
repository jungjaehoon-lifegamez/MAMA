import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, vi } from 'vitest';
import {
  createPrincipalRepository,
  type ActionResult,
  type JudgmentAccess,
} from '@jungjaehoon/mama-core';
import type { ActionIpcServerOptions } from '@jungjaehoon/mama-core/client/ipc';
import { OwnerMessageLedger } from '../../src/gateways/telegram-message-ledger.js';
import type { IModelRunner } from '@jungjaehoon/mama-core/runtime/drivers/types';
import { SessionPool } from '@jungjaehoon/mama-core/runtime/session-pool';
import { createOwnerRuntime } from '../../src/runtime/owner-runtime.js';
import { createNativeSession } from '../../src/runtime/native-session.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';

const ipc = createRequire(import.meta.url)('@jungjaehoon/mama-core/client/ipc');
const close: Array<() => Promise<void>> = [];
export const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const stop of close.splice(0).reverse()) await stop();
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
  vi.unstubAllEnvs();
});

export async function fixture(
  backend: 'codex' | 'claude' = 'codex',
  withMembers = true,
  suspendedWithoutRoot = false,
  timeZone = 'UTC',
  telegram?: import('../../src/api/member-records.js').MemberRecordsTelegram,
  memberIdentity = 'fixture-member'
) {
  // Only the unavailable socket listener is replaced; dispatcher, sessions and stores are real.
  vi.spyOn(ipc, 'createActionIpcServer').mockImplementation(async (_: ActionIpcServerOptions) => ({
    close: async () => {},
  }));
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'lifecycle-home-')));
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'lifecycle-members-')));
  roots.push(home, root);
  vi.stubEnv('HOME', home);
  vi.stubEnv('MAMA_DB_PATH', join(home, 'state.db'));
  // Fixture records need no vector: partition reads and session resets use real storage/actions.
  vi.stubEnv('MAMA_FORCE_TIER_3', 'true');
  const seed = await openCoreDatabase({ path: join(home, 'state.db') });
  const repo = createPrincipalRepository(seed.adapter);
  repo.ensureOwner({
    principalId: 'owner',
    connector: 'telegram',
    namespace: 'private',
    externalId: 'fixture-owner',
    now: 1,
  });
  repo.bindIdentity('owner', 'telegram', 'private', 'fixture-co-owner', 2);
  const member = withMembers
    ? repo.registerMember({
        connector: 'telegram',
        namespace: 'private',
        externalId: memberIdentity,
        now: 3,
      })
    : 'unused-member';
  if (suspendedWithoutRoot) repo.suspend(member, 4);
  await seed.close();
  const pool = new SessionPool();
  const natives = new Map<string, ReturnType<typeof createNativeSession>>();
  const turns: Array<{
    principal: string;
    session: string;
    fresh: boolean;
    prompt: string;
    standing: string;
    access: JudgmentAccess;
  }> = [];
  const stopped: string[] = [];
  let pendingAction: { action: string; input: unknown } | undefined;
  let actionResult: ActionResult | undefined;
  let memberAction: { action: string; input: unknown } | undefined;
  let memberResult: ActionResult | undefined;
  let finishFailure: 'before_acceptance' | 'after_acceptance' | undefined;
  const ledger = new OwnerMessageLedger(join(home, 'ledger.json'));
  let gate: Promise<void> | undefined;
  let memberGate: Promise<void> | undefined;
  let readIds: string[] = [];
  const reads: ActionResult[][] = [];
  let sequence = 0;
  const runtime = await createOwnerRuntime({
    backend,
    model: 'fixture',
    databasePath: join(home, 'state.db'),
    rawPath: join(home, 'raw'),
    socketPath: join(home, 'socket'),
    credentialPath: join(home, 'runtime', 'credential'),
    runtimeRoot: home,
    workspaceDir: join(home, 'workspace'),
    ...(suspendedWithoutRoot ? {} : { memberRoot: root }),
    ownerPrincipalId: 'owner',
    agentId: 'owner-agent',
    scopes: [],
    connectors: [],
    timeZone: createTimeZoneSetting(timeZone),
    messageLedger: () => ledger,
    memberRecordsTelegram: () => telegram,
    timeout: 1_000,
    maxTurns: 10,
    embedder: { embed: async () => new Float32Array(1024).fill(0.25) },
    ownerPolicyProvider: () => ({
      content: 'FIXTURE_OWNER_POLICY',
      fingerprint: 'fixture',
      loaded: true,
    }),
    memberEnrollment: {
      ownerUserIds: ['fixture-owner', 'fixture-co-owner'],
      requestSelection: async () => {},
    },
    createSession: (options) => {
      const principal = options.principal?.principalId ?? 'owner';
      let session: string | undefined;
      let fresh = true;
      const model: IModelRunner = {
        backendType: backend,
        reportsModelRuns: true,
        supportsNativeSubagents: true,
        prompt: async (content, callbacks, opts) => {
          session ??= `fixture-session-${++sequence}`;
          const failure = principal !== 'owner' ? finishFailure : undefined;
          if (failure) finishFailure = undefined;
          if (failure !== 'before_acceptance')
            callbacks?.onInputDispatch?.({
              backend,
              sessionId: session,
              inputId: opts?.nativeInputId ?? 'fixture-input',
            });
          if (failure !== 'before_acceptance')
            callbacks?.onAccepted?.(
              backend === 'codex'
                ? { backend, sessionId: session, turnId: `fixture-turn-${sequence}` }
                : { backend, sessionId: session, inputId: opts?.nativeInputId ?? 'fixture-input' }
            );
          const prepared = await opts?.preparePrompt?.({ sessionId: session, isNewSession: fresh });
          turns.push({
            principal,
            session,
            fresh,
            prompt: JSON.stringify(prepared ?? content),
            standing: opts?.systemPrompt ?? '',
            access: (opts?.toolExecutionContext as { access: JudgmentAccess }).access,
          });
          fresh = false;
          if (principal === 'owner' && gate) await gate;
          if (principal !== 'owner' && memberGate) await memberGate;
          const call = async (action: string, input: unknown): Promise<ActionResult> => {
            const operationId = `fixture-call-${++sequence}`;
            if (backend === 'codex') {
              const result = await opts!.hostToolBridge!.execute({
                callId: operationId,
                name: action,
                input,
              });
              const parsed = JSON.parse(result.content);
              return parsed.success ? { status: 'completed', data: parsed.data } : parsed;
            }
            return natives
              .get(principal)!
              .callAction(
                { action, input, operationId },
                { session_id: session!, tool_use_id: operationId }
              );
          };
          if (principal === 'owner' && pendingAction) {
            const action = pendingAction;
            pendingAction = undefined;
            actionResult = await call(action.action, action.input);
          } else if (principal !== 'owner') {
            if (memberAction) {
              const action = memberAction;
              memberAction = undefined;
              memberResult = await call(action.action, action.input);
            }
            reads.push(
              await Promise.all(readIds.map((id) => call('memory.read:record', { memory_id: id })))
            );
          }
          if (failure) {
            if (failure === 'before_acceptance') {
              // Exhaust the durable retry budget for this prepared input, so the real core
              // retry/announcer path ends dead. NativeTurn wraps runner exceptions.
              runtime.database.adapter
                .prepare(
                  `UPDATE mailbox_inputs SET attempts=100 WHERE id=(SELECT input_id FROM native_input_deliveries WHERE invocation_id=?)`
                )
                .run(opts!.nativeInputId);
            }
            throw new Error('fixture confirming turn failed');
          }
          return {
            response: 'fixture answer',
            session_id: session,
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
        resetSession: async () => {
          session = undefined;
          fresh = true;
        },
        setSessionId: () => {},
        setSystemPrompt: () => {},
        isHealthy: () => true,
        getMetrics: () => ({
          requestCount: 0,
          failureCount: 0,
          avgLatencyMs: 0,
          lastRequestAt: null,
        }),
        stop: async () => {
          stopped.push(principal);
        },
      };
      const native = createNativeSession({
        ...options,
        sessionPool: pool,
        createAgent: () => model,
      });
      natives.set(principal, native);
      return native;
    },
  });
  close.push(async () => {
    await runtime.stop();
    pool.dispose();
  });
  const message = (principal: string, text = 'fixture input') => {
    const id = `telegram:fixture:message-${++sequence}`;
    (principal === 'owner' ? runtime.intake : runtime.serveMember(principal)).acceptOwnerMessage({
      id,
      channelKey: 'fixture',
      occurredAt: sequence,
      text,
    });
    return id;
  };
  const settled = async (id: string, principal = 'owner') => {
    await vi.waitFor(() =>
      expect(runtime.runtime.mailbox!.readInput(id, principal)?.status).toBe('acked')
    );
  };
  const manage = async (change: string, input: unknown = { principalId: member }) => {
    actionResult = undefined;
    pendingAction = { action: `manage.member.${change}`, input };
    const id = message('owner');
    await settled(id);
    expect(actionResult).toBeDefined();
    return actionResult!;
  };
  return {
    runtime,
    member,
    memberDm: memberIdentity,
    ledger,
    natives,
    finishMemberTurn: (failure: 'before_acceptance' | 'after_acceptance') => {
      finishFailure = failure;
    },
    act: async (action: string, input: unknown = {}) => {
      memberResult = undefined;
      memberAction = { action, input };
      const ref = message(member);
      await vi.waitFor(() => expect(memberResult).toBeDefined());
      return { result: memberResult!, ref };
    },
    home,
    root,
    turns,
    stopped,
    reads,
    message,
    settled,
    manage,
    pool,
    blockOwner: (promise: Promise<void> | undefined) => {
      gate = promise;
    },
    blockMember: (promise: Promise<void> | undefined) => {
      memberGate = promise;
    },
    read: (ids: string[]) => {
      readIds = ids;
    },
  };
}
