import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { bootDaemon, type DaemonHandle } from '../../src/cli/commands/daemon.js';
import { createOwnerRuntime, type OwnerRuntimeOptions } from '../../src/runtime/owner-runtime.js';
import { parseConfig } from '../../src/runtime/config.js';
import { createReportScheduler, type ReportScheduler } from '../../src/runtime/report-scheduler.js';

const telegram = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  setMyCommands: vi.fn(async () => true),
}));
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
vi.mock('@jungjaehoon/mama-core', async (original) => ({
  ...(await original<typeof import('@jungjaehoon/mama-core')>()),
  readMemoryRecordsInScopes: async () => [],
}));
const ipc = createRequire(import.meta.url)('@jungjaehoon/mama-core/client/ipc');
const roots: string[] = [];
const daemons: DaemonHandle[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function boot(
  mode: 'live' | 'replay' = 'live',
  enabled = true,
  restored?: 'pending' | 'dispatching' | 'accepted'
) {
  const root = mkdtempSync(join(tmpdir(), 'scheduled-'));
  roots.push(root);
  vi.stubEnv('HOME', root);
  vi.stubEnv('MAMA_TELEGRAM_TOKEN', 'fixture-token');
  vi.stubEnv('MAMA_DB_PATH', join(root, 'dev.db'));
  // Real owner mailbox, delivery and Telegram ledger; only socket listen and transport are external.
  vi.spyOn(ipc, 'createActionIpcServer').mockResolvedValue({
    socketPath: join(root, 'runtime.sock'),
    close: async () => {},
  });
  telegram.sendMessage.mockReset().mockResolvedValue({ message_id: 101 });
  const prompts: string[] = [];
  const logs: string[] = [];
  const order: string[] = [];
  let scheduler: ReportScheduler | undefined;
  let response = 'Some work needs a check.';
  const config = parseConfig({
    version: 1,
    // The ticks below name Korea-time report hours; fix the zone instead of using the machine's.
    timezone: 'Asia/Seoul',
    agent: { backend: 'codex', model: 'fixture-model', max_turns: 10, timeout: 1000 },
    database: { path: join(root, 'memory.db') },
    logging: { level: 'info', file: join(root, 'daemon.log') },
    telegram: {
      enabled,
      allowed_chats: ['-7'],
      owner_chat_id: '-7',
      polling: false,
    },
  });
  const daemon = await bootDaemon({
    home: root,
    configPath: join(root, 'config.yaml'),
    config,
    mode,
    replay: async () => {},
    logger: { info: (line) => logs.push(line), error: (line) => logs.push(line) },
    dependencies: {
      ensureIsolation: () => {},
      createOwnerRuntime: async (options) => {
        const runtimeOptions: OwnerRuntimeOptions = {
          ...options,
          embedder: { embed: async () => new Float32Array(1024).fill(0.25) },
          nativeSession: {
            stop: async () => {
              order.push('owner:stop');
            },
            runTurn: async (content, request) => {
              content =
                (await request?.prepareSessionContent?.({
                  isNewSession: false,
                  sessionId: 'fixture-session',
                })) ?? content;
              prompts.push(JSON.stringify(content));
              request?.streamCallbacks?.onInputDispatch?.({
                backend: 'codex',
                sessionId: 'fixture-session',
                inputId: request.nativeInputId!,
              });
              request?.streamCallbacks?.onAccepted?.({
                backend: 'codex',
                sessionId: 'fixture-session',
                turnId: `turn-${prompts.length}`,
              });
              return {
                response,
                turns: 1,
                history: [],
                totalUsage: { input_tokens: 0, output_tokens: 0 },
                stopReason: 'end_turn',
                modelRunId: `run:scheduled:${prompts.length}`,
                modelRunProvenance: 'available',
              };
            },
          },
        };
        let owner = await createOwnerRuntime(runtimeOptions);
        if (restored) {
          owner.intake.acceptScheduled({
            id: 'interrupted-report',
            channelKey: 'schedule',
            occurredAt: Date.parse('2026-01-01T04:00:00Z'),
            payload: { report: 'full', hourKey: '2026-01-01:13' },
          });
          if (restored !== 'pending') {
            const mailbox = owner.runtime.mailbox!;
            const row = mailbox.claimNext()!;
            const native = mailbox.nativeInputs.prepare(row.id);
            mailbox.nativeInputs.dispatch(row.id, {
              backend: 'codex',
              sessionId: 'interrupted-session',
              inputId: native.invocationId!,
            });
            if (restored === 'accepted')
              mailbox.nativeInputs.accept(row.id, {
                backend: 'codex',
                sessionId: 'interrupted-session',
                turnId: 'interrupted-turn',
              });
          }
          // No active delivery exists: the boot ready gate is still closed.
          await owner.stop();
          owner = await createOwnerRuntime(runtimeOptions);
        }
        return owner;
      },
      createReportScheduler: (options) => {
        order.push('scheduler:create');
        scheduler = createReportScheduler(options);
        const stop = scheduler.stop;
        scheduler.stop = () => {
          order.push('scheduler:stop');
          stop();
        };
        return scheduler;
      },
      createViewerServer: () => ({ start: async () => {}, stop: async () => {}, port: 0 }) as never,
      startConnectorRuntime: async () => ({ stop: async () => {} }) as never,
    },
  });
  daemons.push(daemon);
  if (daemon.gateway) {
    const stop = daemon.gateway.stop.bind(daemon.gateway);
    daemon.gateway.stop = async () => {
      order.push('telegram:stop');
      await stop();
    };
  }
  const statePath = join(root, 'runtime', 'report-schedule-state.json');
  const rows = () =>
    daemon.owner.database.adapter
      .prepare('SELECT stimulus_id FROM mailbox_inputs WHERE kind = ? ORDER BY id')
      .all('scheduled') as Array<{ stimulus_id: string }>;
  const status = (index: number) =>
    daemon.owner.runtime.mailbox!.readInput(rows()[index]!.stimulus_id, 'owner');
  return {
    root,
    daemon,
    scheduler,
    prompts,
    logs,
    order,
    statePath,
    rows,
    status,
    setResponse: (text: string) => {
      response = text;
    },
  };
}

describe('daemon scheduled reports', () => {
  it.each(['dispatching', 'accepted'] as const)(
    'parks an orphaned %s report after restart and allows the next tick',
    async (state) => {
      const ctx = await boot('live', true, state);
      await ctx.daemon.owner.runtime.drainOnce();
      expect(ctx.status(0)?.nativeDelivery?.state).toBe('uncertain');
      expect(ctx.prompts).toHaveLength(0);
      expect(existsSync(ctx.statePath)).toBe(false);
      ctx.scheduler!.tick(new Date('2026-01-01T04:01:00Z'));
      await vi.waitFor(() => expect(ctx.status(1)?.status).toBe('acked'));
      expect(ctx.prompts).toHaveLength(1);
      expect(ctx.logs.some((line) => line.includes('Scheduled report interrupted'))).toBe(true);
    }
  );

  it('delivers a pending report restored at boot without enqueuing a second one', async () => {
    const ctx = await boot('live', true, 'pending');
    ctx.scheduler!.tick(new Date('2026-01-01T04:01:00Z'));
    expect(ctx.rows()).toHaveLength(1);
    await ctx.daemon.owner.runtime.drainOnce();
    await vi.waitFor(() => expect(ctx.status(0)?.status).toBe('acked'));
    expect(ctx.prompts).toHaveLength(1);
    expect(JSON.parse(readFileSync(ctx.statePath, 'utf8')).lastFullKey).toBe('2026-01-01:13');
  });

  it('runs a full report through the owner and ledger, saves after send, then suppresses the hour', async () => {
    const ctx = await boot();
    expect(ctx.scheduler).toBeDefined();
    expect(ctx.logs.indexOf('boot stage=telegram')).toBeLessThan(
      ctx.logs.indexOf('boot stage=report_scheduler')
    );
    const now = new Date('2026-01-01T04:00:00Z');
    ctx.scheduler!.tick(now);
    await vi.waitFor(() => expect(ctx.status(0)?.status).toBe('acked'));
    expect(telegram.sendMessage).toHaveBeenCalledWith(-7, 'Some work needs a check.');
    const id = ctx.rows()[0]!.stimulus_id;
    expect(ctx.logs).toContain(
      `stimulus delivered kind=scheduled id=${id} model_run_id=run:scheduled:1`
    );
    expect(ctx.logs).toContain(
      `telegram outbound delivered idempotency_key="report:2026-01-01:13:full" message_ids=[101]`
    );
    expect(ctx.prompts[0]).toContain('[scheduled_full_report]');
    expect(JSON.parse(readFileSync(ctx.statePath, 'utf8')).lastFullKey).toBe('2026-01-01:13');
    ctx.scheduler!.tick(now);
    expect(ctx.rows()).toHaveLength(1);
    await ctx.scheduler!.onResult(ctx.status(0)!, { response: 'Some work needs a check.' });
    expect(telegram.sendMessage).toHaveBeenCalledOnce();
  });

  it('recovers a definitely rejected report send from the stored result without another model attempt', async () => {
    const ctx = await boot();
    telegram.sendMessage.mockRejectedValueOnce(
      Object.assign(new Error('send rejected'), { error_code: 429 })
    );
    ctx.scheduler!.tick(new Date('2026-01-01T00:00:00Z'));
    await vi.waitFor(() => expect(ctx.status(0)?.nativeDelivery?.state).toBe('settled'));
    expect(ctx.prompts).toHaveLength(1);
    expect(telegram.sendMessage).toHaveBeenCalledTimes(2);
    expect(telegram.sendMessage).toHaveBeenLastCalledWith(-7, 'Some work needs a check.');
    ctx.scheduler!.tick(new Date('2026-01-01T00:01:00Z'));
    expect(ctx.rows()).toHaveLength(1);
    expect(JSON.parse(readFileSync(ctx.statePath, 'utf8')).lastReminderKey).toBe('2026-01-01:09');
    expect(ctx.logs.some((line) => line.includes('reason=send rejected'))).toBe(true);
  });

  it('keeps an uncertain report send parked in its hour and closes it once a newer full report is sent', async () => {
    const ctx = await boot();
    const ledger = () =>
      (
        JSON.parse(
          readFileSync(join(ctx.root, 'runtime', 'owner-message-ledger.json'), 'utf8')
        ) as {
          entries: Array<{ idempotencyKey?: string; state: string; deliveryUncertain?: boolean }>;
        }
      ).entries.filter((entry) => entry.idempotencyKey === 'report:2026-01-01:13:full');
    const native = (index: number) => ctx.status(index)?.nativeDelivery?.state;
    // No error code: Telegram may have shown the message, so the send is never repeated.
    telegram.sendMessage.mockRejectedValueOnce(new Error('network reset'));
    ctx.scheduler!.tick(new Date('2026-01-01T04:00:00Z'));
    await vi.waitFor(() => expect(native(0)).toBe('uncertain'));
    expect(ledger()).toMatchObject([{ state: 'ready', deliveryUncertain: true }]);
    // Rows shaped like a re-fired hour: the same payload, a new text under the same delivery key.
    const payload = ctx.status(0)!.payload!;
    for (const [index, text] of ['Second wording.', 'Third wording.'].entries()) {
      ctx.setResponse(text);
      ctx.daemon.owner.intake.acceptScheduled({
        id: `report:2026-01-01:13:extra-${index}`,
        channelKey: 'schedule',
        occurredAt: Date.parse('2026-01-01T04:02:00Z'),
        payload,
      });
      await vi.waitFor(() => expect(native(index + 1)).toBe('uncertain'));
    }
    expect(ctx.logs.some((line) => line.includes('delivery binding mismatch'))).toBe(true);
    // The saved result goes back to the send, which stays uncertain: no resend, no new turn.
    const send = ctx.daemon.gateway!.sendToOwner.bind(ctx.daemon.gateway);
    const resent: string[] = [];
    const resend = vi
      .spyOn(ctx.daemon.gateway!, 'sendToOwner')
      .mockImplementation(async (text, key) => {
        resent.push(`${key} ${text}`);
        await send(text, key).catch((error: Error) => {
          resent.push(error.message);
          throw error;
        });
      });
    await ctx.daemon.owner.runtime.drainOnce();
    expect([native(0), native(1), native(2)]).toEqual(['uncertain', 'uncertain', 'uncertain']);
    expect(resent.slice(0, 2)).toEqual([
      'report:2026-01-01:13:full Some work needs a check.',
      'Telegram outbound delivery is uncertain',
    ]);
    resend.mockRestore();
    ctx.scheduler!.tick(new Date('2026-01-01T04:30:00Z'));
    expect(ctx.rows()).toHaveLength(3);
    expect(ctx.prompts).toHaveLength(3);
    expect(telegram.sendMessage).toHaveBeenCalledOnce();
    // Another hour is not held by them.
    ctx.setResponse('The evening report.');
    ctx.scheduler!.tick(new Date('2026-01-01T09:00:00Z'));
    await vi.waitFor(() => expect(ctx.status(3)?.status).toBe('acked'));
    expect(telegram.sendMessage).toHaveBeenLastCalledWith(-7, 'The evening report.');
    const state = readFileSync(ctx.statePath, 'utf8');
    expect(JSON.parse(state).lastFullKey).toBe('2026-01-01:18');
    await vi.waitFor(async () => {
      await ctx.daemon.owner.runtime.drainOnce();
      expect([0, 1, 2].map((index) => ctx.status(index)?.status)).toEqual([
        'acked',
        'acked',
        'acked',
      ]);
    });
    expect([native(0), native(1), native(2)]).toEqual(['settled', 'settled', 'settled']);
    expect(ledger()).toEqual([]);
    expect(readFileSync(ctx.statePath, 'utf8')).toBe(state);
    expect(telegram.sendMessage).toHaveBeenCalledTimes(2);
    expect(ctx.prompts).toHaveLength(4);
    expect(ctx.logs.filter((line) => line.startsWith('scheduled report superseded'))).toHaveLength(
      3
    );
  });

  it('holds one pending report through an hour change and drains its send before Telegram stops', async () => {
    const ctx = await boot();
    expect(ctx.scheduler).toBeDefined();
    let release!: () => void;
    telegram.sendMessage.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { message_id: 101 };
    });
    ctx.scheduler!.tick(new Date('2026-01-01T04:00:00Z'));
    await vi.waitFor(() => expect(telegram.sendMessage).toHaveBeenCalledOnce());
    ctx.scheduler!.tick(new Date('2026-01-01T05:00:00Z'));
    expect(ctx.rows()).toHaveLength(1);
    expect(existsSync(ctx.statePath)).toBe(false);
    const stopping = ctx.daemon.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ctx.order).toContain('scheduler:stop');
    expect(ctx.order).not.toContain('telegram:stop');
    release();
    await stopping;
    expect(existsSync(ctx.statePath)).toBe(true);
    expect(ctx.order.indexOf('scheduler:stop')).toBeLessThan(ctx.order.indexOf('owner:stop'));
    expect(ctx.order.indexOf('owner:stop')).toBeLessThan(ctx.order.indexOf('telegram:stop'));
  });

  it('does not create a scheduler in replay mode', async () => {
    const ctx = await boot('replay', true);
    expect(ctx.scheduler).toBeUndefined();
    expect(ctx.order).not.toContain('scheduler:create');
    expect(ctx.rows()).toHaveLength(0);
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('rejects a disabled default delivery route during live startup', async () => {
    await expect(boot('live', false)).rejects.toThrow(/delivery.reports targets telegram/);
  });
});
