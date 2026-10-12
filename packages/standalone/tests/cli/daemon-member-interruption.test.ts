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

async function boot(suspendDuringTurn = false) {
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
  seedRepo.grantRole({ principalId: person, role: 'owner', now: 3 });
  await seed.close();
  const logs: string[] = [];
  let runtime!: Awaited<ReturnType<typeof createOwnerRuntime>>;
  let modelCalls = 0;
  const daemon = await bootDaemon({
    home,
    configPath: join(home, 'config.yaml'),
    config: {
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
    },
    logger: { info: (line) => logs.push(line), error: (line) => logs.push(line) },
    dependencies: {
      createViewerServer: () => ({ start: async () => {}, stop: async () => {}, port: 0 }) as never,
      createOwnerRuntime: async (options) => {
        runtime = await createOwnerRuntime({
          ...options,
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
                  turnId: 'fixture-turn',
                });
                if (suspendDuringTurn)
                  createPrincipalRepository(runtime.database.adapter).suspend(person, 4);
                throw new Error('fixture model transport failed after acceptance');
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
  });
  daemons.push(daemon);
  const ref = 'telegram:20001:11';
  await transport.handler!({
    message: {
      message_id: 11,
      date: 1_700_000_000,
      chat: { id: 20001, type: 'private' },
      from: { id: 20001, is_bot: false },
      text: 'Personal question',
    },
  });
  await runtime.runtime.drainOnce();
  await vi.waitFor(() =>
    expect(logs.some((line) => line.includes('stimulus parked uncertain kind=owner_message'))).toBe(
      true
    )
  );
  const ledger = () => new OwnerMessageLedger(daemon.paths.ownerMessageLedgerPath).get(ref);
  const chatRows = () =>
    runtime.database.adapter
      .prepare(
        "SELECT content, memory_scope_id, metadata_json FROM connector_event_index WHERE source_connector='chat' AND source_entity_id=?"
      )
      .all(`${ref}:reply`) as Array<{
      content: string;
      memory_scope_id: string;
      metadata_json: string;
    }>;
  return { daemon, runtime, person, ref, ledger, chatRows, modelCalls: () => modelCalls };
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
