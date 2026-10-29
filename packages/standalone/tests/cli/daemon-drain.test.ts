import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrincipalRepository } from '@jungjaehoon/mama-core';
import type { IModelRunner } from '@jungjaehoon/mama-core/runtime/drivers/types';
import { runStop } from '../../src/cli/commands/control.js';
import { bootDaemon, type DaemonHandle } from '../../src/cli/commands/daemon.js';
import {
  daemonControlPaths,
  drainDaemon,
  type DrainProgress,
} from '../../src/cli/runtime/daemon-control.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createNativeSession } from '../../src/runtime/native-session.js';
import { createOwnerRuntime } from '../../src/runtime/owner-runtime.js';

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

/**
 * A real daemon: the owner runtime, mailbox, native session and Telegram gateway are the product's
 * own; only the model transport and Telegram's API are replaced. Each model turn waits until the
 * test lets it answer.
 */
async function boot(extra: Partial<Parameters<typeof bootDaemon>[0]> = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mama-drain-home-')));
  const memberRoot = realpathSync(mkdtempSync(join(tmpdir(), 'mama-drain-members-')));
  roots.push(home, memberRoot);
  vi.stubEnv('HOME', home);
  vi.stubEnv('MAMA_DB_PATH', join(home, 'state.db'));
  vi.stubEnv('MAMA_FORCE_TIER_3', 'true');
  vi.stubEnv('MAMA_TELEGRAM_TOKEN', 'fixture-token');
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
  const turns: Array<{ text: string; answer: () => void; fail: (error: Error) => void }> = [];
  const config: NonNullable<Parameters<typeof bootDaemon>[0]['config']> = {
    version: 1,
    agent: {
      backend: 'codex',
      model: 'fixture-model',
      effort: 'medium',
      max_turns: 10,
      timeout: 1000,
      max_turn_ms: 3_600_000,
    },
    database: { path: join(home, 'state.db') },
    logging: { level: 'info', file: join(home, 'daemon.log') },
    member_root: memberRoot,
    telegram: { enabled: true, allowed_chats: ['-100'], owner_chat_id: '-100', polling: false },
  } as never;
  const options: Parameters<typeof bootDaemon>[0] = {
    home,
    configPath: join(home, 'config.yaml'),
    config,
    logger: { info: (line) => logs.push(line), error: (line) => logs.push(line) },
    dependencies: {
      createViewerServer: () => ({ start: async () => {}, stop: async () => {}, port: 0 }) as never,
      createOwnerRuntime: async (ownerOptions) => {
        runtime = await createOwnerRuntime({
          ...ownerOptions,
          embedder: { embed: async () => new Float32Array(1024).fill(0.25) },
          createSession: (sessionOptions) => {
            const model: IModelRunner = {
              backendType: 'codex',
              reportsModelRuns: true,
              supportsNativeSubagents: true,
              prompt: async (content, callbacks, request) => {
                const index = turns.length + 1;
                callbacks?.onInputDispatch?.({
                  backend: 'codex',
                  sessionId: 'fixture-session',
                  inputId: request!.nativeInputId!,
                });
                callbacks?.onAccepted?.({
                  backend: 'codex',
                  sessionId: 'fixture-session',
                  turnId: `fixture-turn-${index}`,
                });
                await new Promise<void>((answer, fail) => {
                  turns.push({ text: JSON.stringify(content), answer: () => answer(), fail });
                });
                return {
                  response: `Answer ${index}`,
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
    ...extra,
  };
  let daemon = await bootDaemon(options);
  daemons.push(daemon);
  const send = async (messageId: number, text = `Question ${messageId}`) =>
    transport.handler!({
      message: {
        message_id: messageId,
        date: 1_700_000_000,
        chat: { id: 20001, type: 'private' },
        from: { id: 20001, is_bot: false },
        text,
      },
    });
  const input = (messageId: number) =>
    runtime.runtime.mailbox!.readInput(`telegram:20001:${messageId}`, person);
  const status = (messageId: number) => input(messageId)?.status;
  const progress: DrainProgress[] = [];
  return {
    home,
    logs,
    turns,
    send,
    input,
    status,
    progress,
    get daemon() {
      return daemon;
    },
    get runtime() {
      return runtime;
    },
    hold: () =>
      drainDaemon(daemonControlPaths(home), (line) => {
        progress.push(line);
      }),
    /** The service manager's stop and start: the same install, a new process's boot. */
    restart: async () => {
      daemons.splice(daemons.indexOf(daemon), 1);
      await daemon.stop();
      daemon = await bootDaemon(options);
      daemons.push(daemon);
    },
  };
}

/** Texts sent to Telegram: replies edited into their progress message, or sent anew. */
function delivered(): string[] {
  return [
    ...transport.editMessageText.mock.calls.map((call) => String(call[2])),
    ...transport.sendMessage.mock.calls.map((call) => String(call[1])),
  ];
}

describe('drain', { timeout: 30_000 }, () => {
  it('lets the running turn finish and deliver while new inputs wait, and runs them after the restart', async () => {
    const f = await boot();
    await f.send(11);
    await vi.waitFor(() => expect(f.turns).toHaveLength(1));
    expect(f.status(11)).toBe('claimed');

    const drain = (await f.hold())!;
    await vi.waitFor(() => expect(f.progress[0]).toBeDefined());
    // One model run running and its claimed input; each may take a whole turn, plus a minute.
    expect(f.progress[0]).toEqual({
      running: 1,
      claimed: 1,
      bound: 2 * 3_600_000 + 60_000,
      idle: false,
    });
    expect(f.logs).toContainEqual('drain: claims held running=1 claimed=1');

    // Accepting goes on while held: the message is kept, and nothing claims it.
    await f.send(12);
    await f.runtime.runtime.drainOnce();
    expect(f.status(12)).toBe('pending');
    expect(f.turns).toHaveLength(1);

    // The turn running at the hold finishes; its reply is delivered and its input acked.
    f.turns[0]!.answer();
    expect(await drain.outcome).toEqual({ kind: 'idle' });
    expect(f.status(11)).toBe('acked');
    expect(delivered()).toContain('Answer 1');
    expect(f.status(12)).toBe('pending');
    expect(f.turns).toHaveLength(1);

    // The stop comes while the drain still holds; nothing ran in between, nothing was interrupted.
    await f.restart();
    drain.release();
    // The new process's drain tick (every five seconds live) claims what waited.
    // Not awaited: a drain waits for the turns it starts.
    void f.runtime.runtime.drainOnce();
    await vi.waitFor(() => expect(f.turns).toHaveLength(2));
    expect(f.turns[1]!.text).toContain('Question 12');
    f.turns[1]!.answer();
    await vi.waitFor(() => expect(f.status(12)).toBe('acked'));
    expect(delivered()).toContain('Answer 2');
    const log = f.logs.join('\n');
    expect(log).not.toMatch(/interrupted/);
  });

  it('ends the hold when its client lets go, and claims again', async () => {
    const f = await boot();
    const drain = (await f.hold())!;
    expect(await drain.outcome).toEqual({ kind: 'idle' });
    await f.send(21);
    await f.runtime.runtime.drainOnce();
    expect(f.status(21)).toBe('pending');

    drain.release();
    await vi.waitFor(() => expect(f.logs).toContainEqual('drain: claims released'));
    // Not awaited: a drain waits for the turns it starts.
    void f.runtime.runtime.drainOnce();
    await vi.waitFor(() => expect(f.turns).toHaveLength(1));
    f.turns[0]!.answer();
    await vi.waitFor(() => expect(f.status(21)).toBe('acked'));
  });

  it('does not requeue a live claim held past its lease', async () => {
    const f = await boot();
    await f.send(31);
    await vi.waitFor(() => expect(f.turns).toHaveLength(1));
    await f.send(32);
    // Not awaited: a drain waits for the turns it starts.
    void f.runtime.runtime.drainOnce();
    const before = f.input(32);
    expect(before?.status).toBe('claimed');
    // It waits for the serial slot with no native dispatch yet: the kind stale replay requeues.
    expect(f.runtime.runtime.mailbox!.nativeInputs.get(before!.id)).toBeNull();

    const drain = (await f.hold())!;
    await vi.waitFor(() => expect(f.progress[0]?.claimed).toBe(2));
    // Eleven minutes pass under the hold: a ten-minute lease would have expired twice over.
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 11 * 60_000);
    await f.runtime.runtime.drainOnce();
    expect(f.input(32)?.status).toBe('claimed');
    expect(f.input(32)?.attempts).toBe(before?.attempts);

    // Let go without a stop: the next drain renews the live claims before it looks for stale ones.
    drain.release();
    await vi.waitFor(() => expect(f.logs).toContainEqual('drain: claims released'));
    await f.runtime.runtime.drainOnce();
    expect(f.input(32)?.status).toBe('claimed');
    expect(f.input(32)?.attempts).toBe(before?.attempts);

    f.turns[0]!.answer();
    await vi.waitFor(() => expect(f.turns).toHaveLength(2));
    f.turns[1]!.answer();
    await vi.waitFor(() => expect(f.status(32)).toBe('acked'));
    expect(f.status(31)).toBe('acked');
    // Each message ran once.
    expect(f.turns).toHaveLength(2);
  });

  it('shows the hold in status', async () => {
    const f = await boot();
    const drain = (await f.hold())!;
    await drain.outcome;
    const { askDaemon } = await import('../../src/cli/commands/daemon.js');
    const reply = await askDaemon('status', { configPath: join(f.home, 'config.yaml') });
    expect(reply.state === 'running' && reply.reply.status).toEqual(
      expect.objectContaining({ drain: { holds: 1, since: expect.any(Number) } })
    );
    drain.release();
    await vi.waitFor(async () => {
      const after = await askDaemon('status', { configPath: join(f.home, 'config.yaml') });
      expect(after.state === 'running' && after.reply.status).toEqual(
        expect.objectContaining({ drain: null })
      );
    });
  });

  it('does not wait for an input parked uncertain: nothing runs for it until reconciliation', async () => {
    const f = await boot();
    const first = (await f.hold())!;
    expect(await first.outcome).toEqual({ kind: 'idle' });
    // An input whose dispatch became uncertain earlier in this boot (as a turn that failed after
    // the model accepted it): it stays claimed until reconciliation, which the hold suspends.
    await f.send(41);
    const mailbox = f.runtime.runtime.mailbox!;
    const row = mailbox.claimNext()!;
    const native = mailbox.nativeInputs.prepare(row.id);
    mailbox.nativeInputs.dispatch(row.id, {
      backend: 'codex',
      sessionId: 'fixture-session',
      inputId: native.invocationId!,
    });
    mailbox.nativeInputs.accept(row.id, {
      backend: 'codex',
      sessionId: 'fixture-session',
      turnId: 'fixture-turn-parked',
    });
    mailbox.nativeInputs.uncertain(row.id, 'fixture transport failed after acceptance');
    expect(f.status(41)).toBe('claimed');

    f.progress.length = 0;
    const second = (await f.hold())!;
    expect(await second.outcome).toEqual({ kind: 'idle' });
    expect(f.progress).toEqual([{ running: 0, claimed: 0, bound: 60_000, idle: true }]);
    expect(f.turns).toHaveLength(0);
    second.release();
    first.release();
  });

  it('mama stop drains a real daemon: the running turn is answered before the stop', async () => {
    // launchd and systemd stay out of it: on this platform value neither is asked.
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      let stopped: Promise<void> | undefined;
      // The control socket's stop, as `mama daemon` wires it: the daemon stops itself.
      const f = await boot({
        requestStop: () => {
          stopped = f.daemon.stop();
        },
      });
      const handle = f.daemon;
      await f.send(51);
      await vi.waitFor(() => expect(f.turns).toHaveLength(1));
      const lines: string[] = [];
      const stopping = runStop([], {
        configPath: join(f.home, 'config.yaml'),
        home: f.home,
        write: (line) => lines.push(line),
        pollMs: 10,
        settleMs: 5,
        run: () => {
          throw new Error('no service manager in this test');
        },
      });
      await vi.waitFor(() =>
        expect(lines).toContain(
          'draining: new inputs wait; waiting for 1 turn running, 1 input claimed (at most 121 min)'
        )
      );
      // A message during the drain waits for the next start.
      await f.send(52);
      f.turns[0]!.answer();
      expect(await stopping).toBe(0);
      await stopped;
      daemons.splice(daemons.indexOf(handle), 1);
      expect(lines.slice(-3)).toEqual(['drained: nothing runs; stopping', 'stopping', 'stopped']);
      expect(delivered()).toContain('Answer 1');
      expect(f.turns).toHaveLength(1);
      expect(f.logs.join('\n')).not.toMatch(/interrupted/);
    } finally {
      Object.defineProperty(process, 'platform', { value: platform });
    }
  });
});
