import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import type { NativeTurnResult } from '@jungjaehoon/mama-core/runtime/native-turn';
import type { SourceDelta } from '../../src/connectors/framework/polling-scheduler.js';
import { bootDaemon, type DaemonHandle } from '../../src/cli/commands/daemon.js';
import { createOwnerRuntime, type OwnerRuntimeOptions } from '../../src/runtime/owner-runtime.js';
import { sourceDeltaStimulusId } from '../../src/runtime/stimulus-delivery.js';

const telegram = vi.hoisted(() => ({ sendMessage: vi.fn(), editMessageText: vi.fn() }));
vi.mock('grammy', () => ({
  Bot: vi.fn(() => ({
    on: vi.fn(),
    catch: vi.fn(),
    init: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(async () => {}),
    botInfo: { id: 101, username: 'fixture_bot' },
    api: telegram,
  })),
}));
vi.mock('@jungjaehoon/mama-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@jungjaehoon/mama-core')>()),
  readMemoryRecordsInScopes: async () => [],
}));

const roots: string[] = [];
const daemons: DaemonHandle[] = [];
const ipc = createRequire(import.meta.url)(
  '@jungjaehoon/mama-core/client/ipc'
) as typeof import('@jungjaehoon/mama-core/client/ipc');
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function delta(): SourceDelta {
  return {
    kind: 'source_delta',
    collector: 'slack',
    channel: 'slack:fixture-room',
    coalesceKey: 'slack:fixture-room',
    preview: ['The revised file arrived.'],
    refs: [
      {
        connector: 'slack',
        observationRef: 'fixture-observation',
        sourceId: 'fixture-source',
        sourceEntityId: 'fixture-entity',
        sourceAt: new Date(Date.now() - 60_000).toISOString(),
        observedAt: new Date(Date.now() - 59_000).toISOString(),
        contentHash: null,
        author: 'fixture-author',
        contentPreview: 'The revised file arrived.',
      },
    ],
  };
}

async function boot(
  response: string,
  mode: 'live' | 'replay' = 'live',
  earlyDelta = false,
  failTurn = false,
  messenger: 'telegram' | 'discord' = 'telegram'
) {
  const root = mkdtempSync(join(tmpdir(), 'delta-'));
  roots.push(root);
  vi.stubEnv('HOME', root);
  vi.stubEnv('MAMA_TELEGRAM_TOKEN', 'fixture-token');
  vi.stubEnv('MAMA_DISCORD_TOKEN', 'fixture-token');
  vi.stubEnv('MAMA_DB_PATH', join(root, 'development-memory.db'));
  // This test exercises delivery, not the socket transport (listen is sandbox-restricted).
  vi.spyOn(ipc, 'createActionIpcServer').mockResolvedValue({
    socketPath: join(root, 'runtime.sock'),
    close: async () => {},
  } as never);
  telegram.sendMessage.mockReset().mockResolvedValue({ message_id: 101 });
  const logs: string[] = [];
  const prompts: Array<{ source: string | undefined; text: string }> = [];
  const records: string[] = [];
  const failures = vi.fn();
  let ownerOptions!: OwnerRuntimeOptions;
  let ownerRuntime!: Awaited<ReturnType<typeof createOwnerRuntime>>;
  let promptsBeforeGatewayStart = 0;
  const daemon = await bootDaemon({
    home: root,
    configPath: join(root, 'config.yaml'),
    mode,
    replay: async () => {},
    config: {
      version: 1,
      agent: {
        backend: 'codex',
        model: 'fixture-model',
        effort: 'medium',
        max_turns: 10,
        timeout: 1000,
      },
      database: { path: join(root, 'memory.db') },
      logging: { level: 'info', file: join(root, 'daemon.log') },
      delivery:
        messenger === 'discord'
          ? { reports: 'discord', notifications: 'discord', security_alerts: 'discord' }
          : undefined,
      telegram: {
        enabled: messenger === 'telegram',
        allowed_chats: ['8', '7'],
        owner_chat_id: '7',
        owner_user_ids: ['9'],
        polling: false,
      },
      discord:
        messenger === 'discord'
          ? {
              enabled: true,
              allowed_channels: ['channel_test'],
              owner_channel_id: 'channel_test',
              owner_user_ids: ['user_owner'],
            }
          : undefined,
    },
    logger: { info: (line) => logs.push(line), error: (line) => logs.push(line) },
    dependencies: {
      ensureIsolation: () => {},
      createOwnerRuntime: async (options) => {
        ownerOptions = options;
        ownerRuntime = await createOwnerRuntime({
          ...options,
          embedder: { embed: async () => new Float32Array(1024).fill(0.25) },
          lessons: async () => [],
          onStimulusFailed: (row, reason, modelRunId) => {
            failures(row, reason, modelRunId);
            return options.onStimulusFailed?.(row, reason, modelRunId);
          },
          nativeSession: {
            stop: async () => {},
            runTurn: async (content, request) => {
              content =
                (await request?.prepareSessionContent?.({
                  sessionId: 'fixture-session',
                  isNewSession: false,
                })) ?? content;
              const text = JSON.stringify(content);
              // Record orders follow each live delta; these tests count the delta turns.
              if (text.includes('[delta_record]')) records.push(text);
              else prompts.push({ source: request?.source, text });
              const turn = prompts.length + records.length;
              request?.onModelRunStarted?.(`run:${turn}`);
              request?.streamCallbacks?.onInputDispatch?.({
                backend: 'codex',
                sessionId: 'fixture-session',
                inputId: request.nativeInputId!,
              });
              request?.streamCallbacks?.onAccepted?.({
                backend: 'codex',
                sessionId: 'fixture-session',
                turnId: `turn-${turn}`,
              });
              if (failTurn) throw new Error('native model failed');
              return {
                response: request?.source === 'source_delta' ? response : '[ack]',
                turns: 1,
                history: [],
                totalUsage: { input_tokens: 0, output_tokens: 0 },
                stopReason: 'end_turn',
                modelRunId: `run:${turn}`,
                modelRunProvenance: 'available',
              } as NativeTurnResult;
            },
          },
        });
        return ownerRuntime;
      },
      createViewerServer: () => ({ start: async () => {}, stop: async () => {}, port: 0 }) as never,
      startConnectorRuntime: async () => {
        if (earlyDelta) {
          ownerRuntime.acceptSourceDelta(delta());
          await ownerRuntime.runtime.drainOnce();
          promptsBeforeGatewayStart = prompts.length;
        }
        return { stop: async () => {} } as never;
      },
      ...(messenger === 'discord'
        ? {
            createDiscordGateway: () => ({
              sendToOwner: telegram.sendMessage,
              sendFile: async () => ({ sentAs: 'file', size: 0 }),
              deliverResponse: async () => {},
              recoverPendingResponses: async () => {},
              recentDeliveredMessageRefs: () => [],
              answered: () => false,
              start: async () => {},
              stop: async () => {},
            }),
          }
        : {}),
    },
  });
  daemons.push(daemon);
  return {
    root,
    daemon,
    logs,
    prompts,
    records,
    failures,
    ownerOptions,
    promptsBeforeGatewayStart,
  };
}

describe('live delta reports', () => {
  it('routes notifications through Discord when Telegram is disabled', async () => {
    const { daemon } = await boot('[notify] Route this', 'live', false, false, 'discord');
    daemon.owner.acceptSourceDelta(delta());
    await vi.waitFor(() =>
      expect(telegram.sendMessage).toHaveBeenCalledWith('Route this', expect.any(String))
    );
  });
  it('delivers the interrupted notice when an accepted owner turn fails without restarting', async () => {
    const { daemon } = await boot('[ack]', 'live', false, true);
    telegram.editMessageText.mockResolvedValue(true);
    const { Bot } = await import('grammy');
    const bot = vi.mocked(Bot).mock.results.at(-1)!.value;
    const handler = bot.on.mock.calls.find(([name]: [string]) => name === 'message')![1];
    await handler({
      message: {
        message_id: 99,
        date: 1,
        chat: { id: 7, type: 'private' },
        from: { id: 9, is_bot: false, first_name: 'Fixture' },
        text: 'Owner request',
      },
    });
    await vi.waitFor(() =>
      expect(telegram.editMessageText).toHaveBeenCalledWith(
        7,
        101,
        expect.stringContaining('was interrupted')
      )
    );
    expect(daemon.owner.intake.isPending!('telegram:7:99')).toBe(false);
  });

  it('logs the run id even when the native turn throws before producing a result', async () => {
    const { daemon, logs } = await boot('[notify] unused', 'live', false, true);
    const id = sourceDeltaStimulusId(delta());
    daemon.owner.acceptSourceDelta(delta());
    await vi.waitFor(() =>
      expect(logs).toContain(
        `stimulus failed kind=source_delta id=${id} model_run_id=run:1 reason=native model failed`
      )
    );
    await vi.waitFor(() =>
      expect(logs).toContain('stimulus parked uncertain kind=source_delta mailbox_id=1')
    );
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('holds boot-time deltas until the Telegram gateway is ready', async () => {
    const { daemon, promptsBeforeGatewayStart } = await boot(
      '[notify] startup update',
      'live',
      true
    );
    expect(promptsBeforeGatewayStart).toBe(0);
    await daemon.owner.runtime.drainOnce();
    const id = sourceDeltaStimulusId(delta());
    await vi.waitFor(() =>
      expect(daemon.owner.runtime.mailbox?.readInput(id, 'owner')?.status).toBe('acked')
    );
    expect(telegram.sendMessage).toHaveBeenCalledOnce();
    expect(telegram.sendMessage).toHaveBeenCalledWith(7, 'startup update');
  });

  it('finishes an in-flight delta send before closing Telegram on shutdown', async () => {
    const { daemon, failures } = await boot(`[notify] ${'x'.repeat(5000)}`);
    let releaseChunk!: () => void;
    const chunk = new Promise<void>((resolve) => {
      releaseChunk = resolve;
    });
    telegram.sendMessage.mockImplementationOnce(async () => {
      await chunk;
      return { message_id: 101 };
    });
    daemon.owner.acceptSourceDelta(delta());
    await vi.waitFor(() => expect(telegram.sendMessage).toHaveBeenCalledOnce());
    const stopping = daemon.stop();
    // Let teardown reach the active outbox writer before the first chunk finishes.
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseChunk();
    await stopping;
    expect(telegram.sendMessage).toHaveBeenCalledTimes(2);
    expect(failures.mock.calls.filter(([row]) => row.kind === 'source_delta')).toEqual([]);
  });
  it.each([
    ['notify', '[notify] The file arrived.', 'The file arrived.', 'notify'],
    ['ack', '[ack] recorded', null, 'ack'],
    ['untagged', 'The file arrived.', null, 'untagged'],
    ['tag mid-text', 'Working notes\n[notify] The file arrived.', 'The file arrived.', 'notify'],
    ['last ack wins', '[notify] earlier\n[ack] quiet', null, 'ack'],
    ['last notify wins', '[ack] earlier\n[notify] final', 'final', 'notify'],
    ['last repeated notify wins', '[notify] earlier\n[notify] final', 'final', 'notify'],
    ['empty notify', '[notify]  ', null, 'notify'],
  ])('routes %s without queuing a second board pass', async (_name, response, sent, route) => {
    const { root, daemon, logs, prompts, ownerOptions } = await boot(response!);
    const input = delta();
    const id = sourceDeltaStimulusId(input);
    daemon.owner.acceptSourceDelta(input);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts.map((prompt) => prompt.source)).toEqual(['source_delta']);
    // The marker rule is standing text; the turn states that its result is delivered.
    expect(prompts[0]!.text).toContain('[delta slack');
    expect(logs).toContain(`delta report route=${route} id=${id}`);
    expect(logs).toContain(`stimulus delivered kind=source_delta id=${id} model_run_id=run:1`);
    expect(logs).not.toContain(expect.stringContaining(`delta-board:${id}`));
    if (sent === null) expect(telegram.sendMessage).not.toHaveBeenCalled();
    else {
      expect(telegram.sendMessage).toHaveBeenCalledOnce();
      expect(telegram.sendMessage).toHaveBeenCalledWith(7, sent);
      expect(
        JSON.parse(readFileSync(join(root, 'runtime', 'owner-message-ledger.json'), 'utf8')).entries
      ).toEqual([
        expect.objectContaining({ state: 'delivered', idempotencyKey: id, messageIds: [101] }),
      ]);
      expect(logs.filter((line) => line.startsWith('telegram outbound delivered'))).toEqual([
        `telegram outbound delivered idempotency_key="${id}" message_ids=[101]`,
      ]);
    }

    // Same result callback cannot enqueue another board turn or resend the text.
    const row = daemon.owner.runtime.mailbox!.readInput(id, 'owner')!;
    await ownerOptions.onSourceResult!(row, { response } as NativeTurnResult);
    await daemon.owner.runtime.drainOnce();
    expect(prompts).toHaveLength(1);
    expect(telegram.sendMessage).toHaveBeenCalledTimes(sent === null ? 0 : 1);
  });

  it('keeps a failed send uncertain and reports a bounded reason', async () => {
    const { daemon, prompts, logs, failures } = await boot('[notify] The file arrived.');
    telegram.sendMessage.mockRejectedValue(new Error(`send failed\n${'x'.repeat(900)}`));
    const id = sourceDeltaStimulusId(delta());
    daemon.owner.acceptSourceDelta(delta());
    await vi.waitFor(() =>
      expect(daemon.owner.runtime.mailbox?.readInput(id, 'owner')?.nativeDelivery?.state).toBe(
        'uncertain'
      )
    );
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(failures).toHaveBeenCalledOnce();
    const reason = failures.mock.calls[0]![1];
    expect(typeof reason).toBe('string');
    expect(reason).toMatch(/^send failed /);
    expect(reason.length).toBeLessThanOrEqual(500);
    expect(reason).not.toContain('\n');
    expect(logs).toContain(
      `stimulus failed kind=source_delta id=${id} model_run_id=run:1 reason=${reason}`
    );
    await daemon.owner.runtime.drainOnce();
    expect(telegram.sendMessage).toHaveBeenCalledOnce();
    expect(prompts).toHaveLength(1);
    expect(daemon.owner.runtime.mailbox?.readInput(id, 'owner')?.status).toBe('claimed');
    // Restarting Telegram must not recover an outbound delta as an owner reply.
    await daemon.gateway!.stop();
    await daemon.gateway!.start();
    expect(telegram.sendMessage).toHaveBeenCalledOnce();
  });

  it('delivers each distinct delta once without queuing board events', async () => {
    const { daemon, prompts } = await boot('[ack]');
    const first = delta();
    daemon.owner.acceptSourceDelta(first);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    const second = delta();
    second.refs = [
      { ...second.refs[0]!, observationRef: 'next-observation', sourceId: 'next-source' },
    ];
    daemon.owner.acceptSourceDelta(second);
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    expect(prompts.map((prompt) => prompt.source)).toEqual(['source_delta', 'source_delta']);
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it.each(['replay daemon', 'replay payload'])(
    'does not route a live notification for %s',
    async (replayCase) => {
      const { daemon, prompts, logs } = await boot(
        '[notify] historical update',
        replayCase === 'replay daemon' ? 'replay' : 'live'
      );
      const input = delta();
      input.replay = {
        runId: 'fixture-run',
        windowId: 'fixture-window',
        windowStartMs: 0,
        windowEndMs: 1000,
      };
      const id = sourceDeltaStimulusId(input);
      daemon.owner.acceptSourceDelta(input);
      await vi.waitFor(() =>
        expect(daemon.owner.runtime.mailbox?.readInput(id, 'owner')?.status).toBe('acked')
      );
      await daemon.owner.runtime.drainOnce();
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.text).toContain('delivery: replay window, not delivered to the owner');
      expect(prompts[0]!.text).not.toContain('delivery: live');
      expect(telegram.sendMessage).not.toHaveBeenCalled();
      expect(logs.some((line) => line.startsWith('delta report'))).toBe(false);
    }
  );
});
