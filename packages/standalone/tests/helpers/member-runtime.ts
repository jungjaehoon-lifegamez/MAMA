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
import { createOwnerRuntime, type OwnerRuntimeOptions } from '../../src/runtime/owner-runtime.js';
import { createNativeSession, type NativeDriverOptions } from '../../src/runtime/native-session.js';
import type { SourceDelta } from '../../src/connectors/framework/polling-scheduler.js';
import { sourceDeltaStimulusId } from '../../src/runtime/stimulus-delivery.js';
import Database from '../../src/storage-sqlite.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import type { OwnerPolicyProvider } from '../../src/runtime/owner-policy.js';

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
  memberIdentity = 'fixture-member',
  ownerPolicyProvider: OwnerPolicyProvider = () => ({
    content: 'FIXTURE_OWNER_POLICY',
    fingerprint: 'fixture',
    loaded: true,
  }),
  onStimulusFailed?: OwnerRuntimeOptions['onStimulusFailed'],
  connectors: string[] = [],
  toolsRoot?: string
) {
  let socketOptions: ActionIpcServerOptions;
  // Only the unavailable socket listener is replaced; dispatcher, sessions and stores are real.
  vi.spyOn(ipc, 'createActionIpcServer').mockImplementation(
    async (options: ActionIpcServerOptions) => {
      socketOptions = options;
      return { close: async () => {} };
    }
  );
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'lifecycle-home-')));
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'lifecycle-members-')));
  roots.push(home, root);
  if (toolsRoot)
    close.push(async () => {
      const writable = (path: string) => {
        if (
          !fs.existsSync(path) ||
          !fs.lstatSync(path).isDirectory() ||
          fs.lstatSync(path).isSymbolicLink()
        )
          return;
        fs.chmodSync(path, 0o700);
        for (const name of fs.readdirSync(path)) writable(join(path, name));
      };
      writable(toolsRoot);
    });
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
  const managingOwner = repo.registerMember({
    connector: 'telegram',
    namespace: 'private',
    externalId: 'fixture-manager',
    now: 2,
  });
  repo.grantRole({ principalId: managingOwner, role: 'owner', now: 2 });
  const member = withMembers
    ? repo.registerMember({
        connector: 'telegram',
        namespace: 'private',
        externalId: memberIdentity,
        now: 3,
      })
    : 'unused-member';
  if (suspendedWithoutRoot) {
    repo.suspend(member, 4);
    repo.suspend(managingOwner, 4);
  }
  await seed.close();
  const pool = new SessionPool();
  const natives = new Map<string, ReturnType<typeof createNativeSession>>();
  const drivers = new Map<string, NativeDriverOptions>();
  const turns: Array<{
    principal: string;
    session: string;
    fresh: boolean;
    prompt: string;
    standing: string;
    policyFingerprint?: string;
    nativeTools?: string;
    access: JudgmentAccess;
  }> = [];
  const stopped: string[] = [];
  let pendingAction: { action: string; input: unknown } | undefined;
  let actionResult: ActionResult | undefined;
  const commonActions = new Map<string, { action: string; input: unknown }>();
  const commonResults = new Map<string, ActionResult>();
  const memberActions = new Map<string, { action: string; input: unknown }>();
  const memberResults = new Map<string, ActionResult>();
  let finishFailure: 'before_acceptance' | 'after_acceptance' | undefined;
  let ledger = new OwnerMessageLedger(join(home, 'ledger.json'));
  let gate: Promise<void> | undefined;
  let memberGate: Promise<void> | undefined;
  let completionGate: Promise<void> | undefined;
  const completionGates = new Map<string, Promise<void>>();
  const principalGates = new Map<string, Promise<void>>();
  const nativeTools = new Map<string, { name: string; input: Record<string, unknown> }>();
  const outbound: import('../../src/api/security-events.js').OutboundAttemptEvent[] = [];
  let readIds: string[] = [];
  const reads: ActionResult[][] = [];
  let sequence = 0;
  let deltaResponse = false;
  let deliveryReady = true;
  let runtime: Awaited<ReturnType<typeof createOwnerRuntime>>;
  let memberResponse = 'fixture answer';
  const runtimeOptions: OwnerRuntimeOptions = {
    toolsRoot,
    backend,
    deliveryReady: () => deliveryReady,
    model: 'fixture',
    databasePath: join(home, 'state.db'),
    rawPath: join(home, 'raw'),
    socketPath: join(home, 'socket'),
    credentialPath: join(home, 'runtime', 'credential'),
    runtimeRoot: home,
    workspaceDir: join(home, 'workspace'),
    ...(suspendedWithoutRoot ? {} : { memberRoot: root }),
    ownerPrincipalId: 'owner',
    commonChannelId: '-100',
    roomChannels: ['-100', '-101', '-200', 'fixture'],
    agentId: 'owner-agent',
    scopes: [],
    connectors,
    timeZone: createTimeZoneSetting(timeZone),
    messageLedger: () => ledger,
    memberRecordsTelegram: () => telegram,
    onStimulusFailed,
    timeout: 1_000,
    maxTurns: 10,
    embedder: { embed: async () => new Float32Array(1024).fill(0.25) },
    ownerPolicyProvider,
    outboundAttempts: (event) => outbound.push(event),
    memberEnrollment: {
      requestSelection: async () => {},
    },
    createSession: (options) => {
      const principal = options.principal?.principalId ?? 'owner';
      let session: string | undefined;
      let fresh = true;
      let activeFingerprint: string | undefined;
      const contexts = new Map<string, { session: string; fingerprint?: string }>();
      const model: IModelRunner = {
        backendType: backend,
        reportsModelRuns: true,
        supportsNativeSubagents: true,
        prompt: async (content, callbacks, opts) => {
          const key = opts?.sessionKey ?? principal;
          const saved = opts?.resumeSession === false ? undefined : contexts.get(key);
          session = saved?.session;
          fresh = saved === undefined;
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
            policyFingerprint: opts?.sessionPolicyFingerprint,
            nativeTools: typeof opts?.tools === 'string' ? opts.tools : undefined,
            access: (opts?.toolExecutionContext as { access: JudgmentAccess }).access,
          });
          fresh = false;
          activeFingerprint = opts?.sessionPolicyFingerprint;
          contexts.set(key, { session, fingerprint: activeFingerprint });
          const nativeTool = nativeTools.get(principal);
          if (nativeTool) callbacks?.onToolUse?.(nativeTool.name, nativeTool.input);
          if (principal === 'owner' && gate) await gate;
          if (principal !== 'owner' && memberGate) await memberGate;
          await principalGates.get(principal);
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
            return native.callAction(
              { action, input, operationId },
              { session_id: session!, tool_use_id: operationId }
            );
          };
          const ref = (opts?.toolExecutionContext as { sourceMessageRef: string }).sourceMessageRef;
          const commonAction = commonActions.get(ref);
          if (commonAction) {
            commonActions.delete(ref);
            commonResults.set(ref, await call(commonAction.action, commonAction.input));
          } else if (principal === 'owner' && pendingAction) {
            const action = pendingAction;
            pendingAction = undefined;
            actionResult = await call(action.action, action.input);
          } else if (principal !== 'owner') {
            const action = memberActions.get(principal);
            if (action) {
              memberActions.delete(principal);
              memberResults.set(principal, await call(action.action, action.input));
            }
            reads.push(
              await Promise.all(readIds.map((id) => call('memory.read:record', { memory_id: id })))
            );
          }
          if (principal !== 'owner' && completionGate) await completionGate;
          await completionGates.get(principal);
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
            response:
              principal === 'owner' ? (deltaResponse ? '[ack]' : 'fixture answer') : memberResponse,
            session_id: session,
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
        getSessionPolicyStatus: (opts) =>
          !contexts.has(opts.sessionKey ?? principal)
            ? 'missing'
            : contexts.get(opts.sessionKey ?? principal)!.fingerprint ===
                opts.sessionPolicyFingerprint
              ? 'compatible'
              : 'mismatch',
        resetSession: async (_session, key) => {
          if (key) contexts.delete(key);
          else contexts.clear();
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
        createAgent: (driver) => {
          drivers.set(principal, driver);
          return model;
        },
      });
      natives.set(principal, native);
      return native;
    },
  };
  runtime = await createOwnerRuntime(runtimeOptions);
  if (suspendedWithoutRoot)
    createPrincipalRepository(runtime.database.adapter).resume(managingOwner, 5);
  close.push(async () => {
    await runtime.stop();
    pool.dispose();
  });
  const message = (
    principal: string,
    text = 'fixture input',
    senderPrincipalId = managingOwner,
    action?: { action: string; input: unknown }
  ) => {
    const id = `telegram:fixture:message-${++sequence}`;
    if (action) commonActions.set(id, action);
    (principal === 'owner' ? runtime.intake : runtime.memberIntake(principal)).acceptOwnerMessage({
      id,
      channelKey: 'fixture',
      occurredAt: sequence,
      text,
      ...(principal === 'owner' ? { senderPrincipalId } : {}),
    });
    return id;
  };
  const settled = async (id: string, principal = 'owner') => {
    await vi.waitFor(() =>
      expect(runtime.runtime.mailbox!.readInput(id, principal)?.status).toBe('acked')
    );
  };
  const manage = async (
    change: string,
    input: unknown = { principalId: member },
    sender = managingOwner
  ) => {
    const id = message('owner', 'fixture management', sender, {
      action: `manage.member.${change}`,
      input,
    });
    await settled(id);
    expect(commonResults.has(id)).toBe(true);
    const result = commonResults.get(id)!;
    const queued =
      result.status === 'completed'
        ? (result.data as { status?: string; commandId?: string })
        : undefined;
    if (queued?.status !== 'scheduled') return result;
    let final: ActionResult | undefined;
    await vi.waitFor(() => {
      const row = runtime.database.adapter
        .prepare('SELECT content FROM connector_event_index WHERE source_entity_id=?')
        .get(`host:management:${queued.commandId}:reply`) as { content: string } | undefined;
      expect(row).toBeDefined();
      final = JSON.parse(row!.content).result;
    });
    return final!;
  };
  const actAs = async (principal: string, action: string, input: unknown = {}) => {
    memberResults.delete(principal);
    memberActions.set(principal, { action, input });
    const ref = message(principal);
    await vi.waitFor(() => expect(memberResults.has(principal)).toBe(true));
    return { result: memberResults.get(principal)!, ref };
  };
  return {
    get socketOptions() {
      return socketOptions;
    },
    roomMessage: (
      text = 'room input',
      action?: { action: string; input: unknown },
      channel = '-100'
    ) => {
      const id = `telegram:${channel}:message-${++sequence}`;
      if (action) commonActions.set(id, action);
      runtime.memberIntake(member, channel).acceptOwnerMessage({
        id,
        channelKey: channel,
        occurredAt: Date.now(),
        text,
        senderPrincipalId: member,
      });
      return id;
    },
    get runtime() {
      return runtime;
    },
    snapshotCrash: (snapshot: string) => {
      runtime.database.adapter.prepare('VACUUM INTO ?').run(snapshot);
      const raw = new Database(join(home, 'raw', 'chat', 'raw.db'));
      try {
        raw.prepare('VACUUM INTO ?').run(`${snapshot}.chat`);
      } finally {
        raw.close();
      }
    },
    blockDelivery: (blocked: boolean) => {
      deliveryReady = !blocked;
    },
    crashRestart: async (release: () => void = () => {}, savedSnapshot?: string) => {
      // Retain the exact database boundary a killed process would leave, discarding graceful
      // settlement/cleanup writes before reopening. No native CLI is launched in this fixture.
      const snapshot = join(home, 'crash-snapshot.db');
      if (savedSnapshot) fs.copyFileSync(savedSnapshot, snapshot);
      else {
        runtime.database.adapter.prepare('VACUUM INTO ?').run(snapshot);
        const raw = new Database(join(home, 'raw', 'chat', 'raw.db'));
        try {
          raw.prepare('VACUUM INTO ?').run(`${snapshot}.chat`);
        } finally {
          raw.close();
        }
      }
      runtime.beginStop();
      release();
      await runtime.stop();
      fs.copyFileSync(snapshot, join(home, 'state.db'));
      fs.copyFileSync(`${savedSnapshot ?? snapshot}.chat`, join(home, 'raw', 'chat', 'raw.db'));
      fs.rmSync(snapshot);
      if (!savedSnapshot) fs.rmSync(`${snapshot}.chat`);
      ledger = new OwnerMessageLedger(join(home, 'ledger.json'));
      runtime = await createOwnerRuntime(runtimeOptions);
    },
    restart: async () => {
      await runtime.stop();
      ledger = new OwnerMessageLedger(join(home, 'ledger.json'));
      runtime = await createOwnerRuntime(runtimeOptions);
    },
    memberResponse: (text: string) => {
      memberResponse = text;
    },
    managingOwner,
    actAs,
    member,
    memberDm: memberIdentity,
    get ledger() {
      return ledger;
    },
    natives,
    drivers,
    actDelta: async (action: string, input: unknown, delta: SourceDelta) => {
      actionResult = undefined;
      pendingAction = { action, input };
      deltaResponse = true;
      try {
        runtime.acceptSourceDelta(delta);
        await vi.waitFor(() => expect(actionResult).toBeDefined());
        await settled(sourceDeltaStimulusId(delta));
        expect(actionResult).toBeDefined();
        return actionResult!;
      } finally {
        deltaResponse = false;
      }
    },
    actRecordDelta: async (action: string, input: unknown, delta: SourceDelta) => {
      const sourceId = sourceDeltaStimulusId(delta);
      const orderId = `record:${sourceId}:1`;
      commonActions.set(orderId, { action, input });
      deltaResponse = true;
      try {
        runtime.acceptSourceDelta(delta);
        await vi.waitFor(() => expect(commonResults.has(orderId)).toBe(true));
        await settled(sourceId);
        return commonResults.get(orderId)!;
      } finally {
        deltaResponse = false;
      }
    },
    holdPrincipalCompletion: (id: string, gate?: Promise<void>) => {
      if (gate) completionGates.set(id, gate);
      else completionGates.delete(id);
    },
    holdMemberCompletion: (promise: Promise<void> | undefined) => {
      completionGate = promise;
    },
    finishMemberTurn: (failure: 'before_acceptance' | 'after_acceptance') => {
      finishFailure = failure;
    },
    onMemberAction: (action: string, input: unknown) => {
      memberResults.delete(member);
      memberActions.set(member, { action, input });
    },
    memberActionResult: () => memberResults.get(member),
    act: (action: string, input: unknown = {}) => actAs(member, action, input),
    home,
    root,
    turns,
    stopped,
    reads,
    message,
    settled,
    manage,
    resultFor: (ref: string) => commonResults.get(ref),
    actScheduled: async (
      input: import('../../src/runtime/stimulus-delivery.js').ScheduledInput,
      action: string,
      body: unknown
    ) => {
      commonActions.set(input.id, { action, input: body });
      runtime.intake.acceptScheduled(input);
      await vi.waitFor(() => expect(commonResults.has(input.id)).toBe(true));
      return commonResults.get(input.id)!;
    },
    outbound,
    observeNative: (id: string, name: string, input: Record<string, unknown>) => {
      nativeTools.set(id, { name, input });
    },
    pool,
    blockPrincipal: (id: string, promise: Promise<void> | undefined) => {
      if (promise) principalGates.set(id, promise);
      else principalGates.delete(id);
    },
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
