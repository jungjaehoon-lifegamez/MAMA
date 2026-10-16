import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrincipalRepository } from '@jungjaehoon/mama-core';
import type { IModelRunner } from '@jungjaehoon/mama-core/runtime/drivers/types';
import { bootDaemon, type DaemonHandle } from '../../src/cli/commands/daemon.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createNativeSession } from '../../src/runtime/native-session.js';
import { createOwnerRuntime } from '../../src/runtime/owner-runtime.js';
import { OwnerMessageLedger } from '../../src/gateways/telegram-message-ledger.js';

const transport = vi.hoisted(() => ({
  setMyCommands: vi.fn(async () => true),
  handler: undefined as ((ctx: unknown) => Promise<void>) | undefined,
  sendMessage: vi.fn(),
  editMessageText: vi.fn(),
}));
vi.mock('grammy', () => ({
  InputFile: vi.fn(),
  Bot: vi.fn(() => ({
    on: (_event: string, handler: (ctx: unknown) => Promise<void>) => {
      transport.handler = handler;
    },
    catch: vi.fn(),
    init: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    api: transport,
  })),
}));
vi.mock('../../src/runtime/egress-proxy.js', () => ({
  startEgressProxy: async () => ({ httpProxyPort: 1, socksProxyPort: 2, close: async () => {} }),
}));

const ipc = createRequire(import.meta.url)('@jungjaehoon/mama-core/client/ipc');
const roots: string[] = [];
const daemons: DaemonHandle[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function boot(
  suspendDuringTurn = false,
  ownerRole = true,
  submit = true,
  interruptedNotice?: string
) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'member-interrupt-home-')));
  const memberRoot = realpathSync(mkdtempSync(join(tmpdir(), 'member-interrupt-root-')));
  roots.push(home, memberRoot);
  vi.stubEnv('HOME', home);
  vi.stubEnv('MAMA_DB_PATH', join(home, 'state.db'));
  vi.stubEnv('MAMA_FORCE_TIER_3', 'true');
  vi.stubEnv('MAMA_TELEGRAM_TOKEN', 'fixture-token');
  // Only socket listeners and the external Telegram/model transport are replaced.
  vi.spyOn(ipc, 'createActionIpcServer').mockResolvedValue({ close: async () => {} } as never);
  transport.sendMessage.mockReset().mockResolvedValue({ message_id: 101 });
  transport.editMessageText.mockReset().mockResolvedValue(true);
  const seed = await openCoreDatabase({ path: join(home, 'state.db') });
  const seedRepo = createPrincipalRepository(seed.adapter);
  seedRepo.ensureOwner({ principalId: 'owner', now: 1 });
  const person = seedRepo.registerMember({
    connector: 'telegram',
    namespace: 'private',
    externalId: '20001',
    now: 2,
  });
  if (ownerRole) seedRepo.grantRole({ principalId: person, role: 'owner', now: 3 });
  const groupSender = seedRepo.registerMember({
    connector: 'telegram',
    namespace: 'private',
    externalId: '20002',
    now: 2,
  });
  seedRepo.grantRole({ principalId: groupSender, role: 'owner', now: 3 });
  await seed.close();
  const logs: string[] = [];
  let runtime!: Awaited<ReturnType<typeof createOwnerRuntime>>;
  let modelCalls = 0;
  let ready = submit;
  const failModel = submit;
  const config: NonNullable<Parameters<typeof bootDaemon>[0]['config']> = {
    version: 1,
    agent: {
      backend: 'codex',
      model: 'fixture-model',
      effort: 'medium',
      max_turns: 10,
      timeout: 1000,
    },
    database: { path: join(home, 'state.db') },
    logging: { level: 'info', file: join(home, 'daemon.log') },
    member_root: memberRoot,
    telegram: { enabled: true, allowed_chats: ['-100'], owner_chat_id: '-100', polling: false },
    ...(interruptedNotice === undefined
      ? {}
      : { delivery: { interrupted_notice: interruptedNotice } }),
  };
  const options: Parameters<typeof bootDaemon>[0] = {
    home,
    configPath: join(home, 'config.yaml'),
    config,
    logger: { info: (line) => logs.push(line), error: (line) => logs.push(line) },
    dependencies: {
      createViewerServer: () => ({ start: async () => {}, stop: async () => {}, port: 0 }) as never,
      createOwnerRuntime: async (options) => {
        runtime = await createOwnerRuntime({
          ...options,
          deliveryReady: () => ready && (options.deliveryReady?.() ?? true),
          embedder: { embed: async () => new Float32Array(1024).fill(0.25) },
          createSession: (sessionOptions) => {
            const model: IModelRunner = {
              backendType: 'codex',
              reportsModelRuns: true,
              supportsNativeSubagents: true,
              prompt: async (_content, callbacks, request) => {
                modelCalls += 1;
                callbacks?.onInputDispatch?.({
                  backend: 'codex',
                  sessionId: 'fixture-session',
                  inputId: request!.nativeInputId!,
                });
                callbacks?.onAccepted?.({
                  backend: 'codex',
                  sessionId: 'fixture-session',
                  turnId: `fixture-turn-${modelCalls}`,
                });
                if (suspendDuringTurn)
                  createPrincipalRepository(runtime.database.adapter).suspend(person, 4);
                if (failModel) throw new Error('fixture model transport failed after acceptance');
                return {
                  response: 'Next personal answer',
                  session_id: 'fixture-session',
                  usage: { input_tokens: 1, output_tokens: 1 },
                };
              },
              resetSession: async () => {},
              setSessionId: () => {},
              setSystemPrompt: () => {},
              isHealthy: () => true,
              getMetrics: () => ({
                requestCount: 0,
                failureCount: 0,
                avgLatencyMs: 0,
                lastRequestAt: null,
              }),
              stop: async () => {},
            };
            return createNativeSession({ ...sessionOptions, createAgent: () => model });
          },
        });
        return runtime;
      },
    },
  };
  let daemon = await bootDaemon(options);
  daemons.push(daemon);
  const ref = 'telegram:20001:11';
  const send = async (messageId = 11, group = false, senderId = group ? 20002 : 20001) =>
    transport.handler!({
      message: {
        message_id: messageId,
        date: 1_700_000_000,
        chat: { id: group ? -100 : 20001, type: group ? 'supergroup' : 'private' },
        from: { id: senderId, is_bot: false },
        text: 'Personal question',
      },
    });
  if (submit) {
    await send();
    await runtime.runtime.drainOnce();
    await vi.waitFor(() =>
      expect(
        logs.some((line) => line.includes('stimulus parked uncertain kind=owner_message'))
      ).toBe(true)
    );
  }
  const ledger = (sourceRef = ref) =>
    new OwnerMessageLedger(daemon.paths.ownerMessageLedgerPath).get(sourceRef);
  const chatRows = (sourceRef = ref) =>
    runtime.database.adapter
      .prepare(
        "SELECT content, author, memory_scope_id, metadata_json FROM connector_event_index WHERE source_connector='chat' AND source_entity_id=?"
      )
      .all(`${sourceRef}:reply`) as Array<{
      content: string;
      author: string;
      memory_scope_id: string;
      metadata_json: string;
    }>;
  return {
    get daemon() {
      return daemon;
    },
    get runtime() {
      return runtime;
    },
    person,
    groupSender,
    ref,
    ledger,
    chatRows,
    logs,
    config,
    send,
    modelCalls: () => modelCalls,
    pause: () => {
      ready = false;
    },
    drain: async () => {
      ready = true;
      await runtime.runtime.drainOnce();
    },
    restart: async () => {
      ready = false;
      await daemon.stop();
      daemon = await bootDaemon(options);
      daemons.push(daemon);
      ready = true;
      await runtime.runtime.drainOnce();
      await runtime.runtime.drainOnce();
    },
  };
}

describe('P10.1 same-process personal DM interruption', () => {
  it('delivers one interruption from the actual daemon uncertainty callback and archives only in the person chat', async () => {
    const f = await boot();
    expect(f.modelCalls()).toBe(1);
    await vi.waitFor(() => expect(f.ledger()?.state).toBe('delivered'));
    expect(transport.editMessageText).toHaveBeenCalledWith(
      20001,
      101,
      expect.stringContaining('was interrupted')
    );
    expect(f.chatRows()).toEqual([
      expect.objectContaining({
        content: expect.stringContaining('was interrupted'),
        memory_scope_id: f.person,
      }),
    ]);
    expect(JSON.parse(f.chatRows()[0]!.metadata_json).deliveryVerified).toBe(true);
    await f.daemon.gateway!.recoverPendingResponses();
    expect(transport.editMessageText).toHaveBeenCalledTimes(1);
    expect(f.chatRows()).toHaveLength(1);
  });

  it('keeps a suspended recipient undelivered and writes no reply', async () => {
    const f = await boot(true);
    expect(f.modelCalls()).toBe(1);
    await f.daemon.gateway!.recoverPendingResponses();
    expect(f.ledger()?.state).toBe('processing');
    expect(transport.editMessageText).not.toHaveBeenCalled();
    expect(f.chatRows()).toEqual([]);
  });
});

describe('P10.3 suspended common-channel sender', () => {
  it('closes the skipped progress message once with a host interruption while another owner still runs', async () => {
    const notice = 'Queued request interrupted. Please send a new message.';
    const f = await boot(false, true, false, notice);
    transport.sendMessage
      .mockResolvedValueOnce({ message_id: 201 })
      .mockResolvedValueOnce({ message_id: 202 });
    const skippedRef = 'telegram:-100:21';
    const activeRef = 'telegram:-100:22';
    await f.send(21, true);
    await f.send(22, true, 20001);
    expect(f.ledger(skippedRef)?.state).toBe('processing');
    expect(f.ledger(activeRef)?.state).toBe('processing');
    expect(f.runtime.runtime.mailbox!.readInput(skippedRef, 'owner')?.status).toBe('pending');
    expect(transport.sendMessage.mock.calls).toEqual([
      [-100, '⏳'],
      [-100, '⏳'],
    ]);
    createPrincipalRepository(f.runtime.database.adapter).suspend(f.groupSender, 4);

    await f.drain();
    await vi.waitFor(() =>
      expect(
        f.runtime.database.adapter
          .prepare('SELECT last_error FROM mailbox_inputs WHERE stimulus_id=?')
          .get(skippedRef)
      ).toEqual({ last_error: 'inactive_owner_sender' })
    );
    expect(f.ledger(skippedRef)?.state).toBe('delivered');
    expect(f.chatRows(skippedRef)).toEqual([
      expect.objectContaining({ content: notice, author: 'host', memory_scope_id: 'owner' }),
    ]);
    expect(JSON.parse(f.chatRows(skippedRef)[0]!.metadata_json).deliveryVerified).toBe(true);
    await f.drain();
    await vi.waitFor(() => expect(f.ledger(activeRef)?.state).toBe('delivered'));
    expect(f.modelCalls()).toBe(1);
    expect(f.chatRows(activeRef)).toEqual([
      expect.objectContaining({
        content: 'Next personal answer',
        author: 'owner-agent',
        memory_scope_id: 'owner',
      }),
    ]);
    expect(transport.editMessageText.mock.calls).toEqual([
      [-100, 201, notice],
      [-100, 202, 'Next personal answer'],
    ]);

    await f.daemon.gateway!.recoverPendingResponses();
    await f.drain();
    expect(transport.editMessageText).toHaveBeenCalledTimes(2);
    expect(transport.sendMessage).toHaveBeenCalledTimes(2);
    expect(f.chatRows(skippedRef)).toHaveLength(1);
    expect(f.modelCalls()).toBe(1);
  });
});

describe('P10.2 personal restart recovery', () => {
  it.each([true, false])(
    'closes recovered personal inputs and runs the next DM (owner role: %s)',
    async (ownerRole) => {
      const f = await boot(false, ownerRole, false);
      const scenarios = ['stored', 'ready', 'answered', 'unanswered', 'processing'] as const;
      for (const [index, state] of scenarios.entries()) {
        const messageId = 20 + index * 2;
        const ref = `telegram:20001:${messageId}`;
        f.pause();
        await f.send(messageId);
        const mailbox = f.runtime.runtime.mailbox!;
        const row = mailbox.claimNext()!;
        expect(row.stimulusId).toBe(ref);
        const native = mailbox.nativeInputs.prepare(row.id);
        mailbox.nativeInputs.dispatch(row.id, {
          backend: 'codex',
          sessionId: 'fixture-session',
          inputId: native.invocationId!,
        });
        mailbox.nativeInputs.accept(row.id, {
          backend: 'codex',
          sessionId: 'fixture-session',
          turnId: `stored-turn-${messageId}`,
        });
        if (state === 'stored')
          mailbox.nativeInputs.storeResult(row.id, {
            response: 'Stored personal answer',
            turns: 1,
            history: [],
            totalUsage: { input_tokens: 0, output_tokens: 0 },
            stopReason: 'end_turn',
            modelRunId: null,
            modelRunProvenance: 'backend_no_run',
          });
        if (state === 'ready')
          new OwnerMessageLedger(f.daemon.paths.ownerMessageLedgerPath).markReady(
            ref,
            'Ready personal answer',
            'html-v1'
          );
        if (state === 'answered')
          await f.daemon.gateway!.deliverResponse(ref, 'Delivered personal answer');
        if (state === 'stored' || state === 'answered' || state === 'unanswered')
          mailbox.nativeInputs.uncertain(row.id, 'fixture restart before closure');
        // The persisted state represents a crash at this boundary; no live model turn owns it.
        expect(f.ledger(ref)?.state).toBe(
          state === 'ready' ? 'ready' : state === 'answered' ? 'delivered' : 'processing'
        );
        const sentBefore = transport.sendMessage.mock.calls.length;
        const editsBefore = transport.editMessageText.mock.calls.length;
        await f.restart();
        await vi.waitFor(() =>
          expect(f.runtime.runtime.mailbox!.readInput(ref, f.person)?.nativeDelivery?.state).toBe(
            'settled'
          )
        );
        expect(f.ledger(ref)?.state).toBe('delivered');
        expect(f.modelCalls()).toBe(index);
        const wanted =
          state === 'stored'
            ? 'Stored personal answer'
            : state === 'ready'
              ? 'Ready personal answer'
              : state === 'answered'
                ? 'Delivered personal answer'
                : expect.stringContaining('was interrupted');
        expect(f.chatRows(ref)).toEqual([
          expect.objectContaining({ content: wanted, memory_scope_id: f.person }),
        ]);
        const metadata = JSON.parse(f.chatRows(ref)[0]!.metadata_json);
        expect(metadata.deliveryVerified).toBe(true);
        expect(transport.sendMessage.mock.calls.slice(sentBefore)).toEqual(
          state === 'answered' ? [] : [[20001, wanted]]
        );
        expect(transport.editMessageText.mock.calls.length).toBe(editsBefore);
        const closed = () =>
          f.logs.filter((line) =>
            line.includes(
              `stimulus closed after uncertain kind=owner_message mailbox_id=${row.id} `
            )
          );
        expect(closed()).toHaveLength(state === 'stored' ? 0 : 1);
        const sentAfter = transport.sendMessage.mock.calls.length;
        await f.daemon.gateway!.recoverPendingResponses();
        await f.restart();
        expect(transport.sendMessage.mock.calls.length).toBe(sentAfter);
        expect(f.chatRows(ref)).toHaveLength(1);
        expect(closed()).toHaveLength(state === 'stored' ? 0 : 1);
        await f.send(messageId + 1);
        await f.drain();
        const next = `telegram:20001:${messageId + 1}`;
        await vi.waitFor(() => expect(f.ledger(next)?.state).toBe('delivered'));
        expect(f.modelCalls()).toBe(index + 1);
        expect(f.chatRows(next)).toEqual([
          expect.objectContaining({ content: 'Next personal answer', memory_scope_id: f.person }),
        ]);
      }
      f.pause();
      await f.send(50, true);
      const mailbox = f.runtime.runtime.mailbox!;
      const group = mailbox.claimNext()!;
      expect(group.principalId).toBe('owner');
      const native = mailbox.nativeInputs.prepare(group.id);
      mailbox.nativeInputs.dispatch(group.id, {
        backend: 'codex',
        sessionId: 'fixture-common',
        inputId: native.invocationId!,
      });
      const sentBefore = transport.sendMessage.mock.calls.length;
      await f.restart();
      await f.restart();
      expect(transport.sendMessage.mock.calls.slice(sentBefore)).toEqual([
        [-100, expect.stringContaining('was interrupted')],
      ]);
      expect(f.chatRows('telegram:-100:50')).toEqual([
        expect.objectContaining({
          content: expect.stringContaining('was interrupted'),
          memory_scope_id: 'owner',
        }),
      ]);
      expect(
        f.runtime.runtime.mailbox!.readInput('telegram:-100:50', 'owner')?.nativeDelivery?.state
      ).toBe('settled');
      expect(f.config.telegram!.allowed_chats).toEqual(['-100']);
    }
  );
});
