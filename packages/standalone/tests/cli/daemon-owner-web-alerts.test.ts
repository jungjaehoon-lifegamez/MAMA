import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrincipalRepository } from '@jungjaehoon/mama-core';
import type { IModelRunner } from '@jungjaehoon/mama-core/runtime/drivers/types';
import { bootDaemon, type DaemonHandle } from '../../src/cli/commands/daemon.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createOwnerRuntime, type OwnerRuntimeOptions } from '../../src/runtime/owner-runtime.js';
import { createNativeSession } from '../../src/runtime/native-session.js';
import type { MemberConnectionEvent, OutboundAttemptEvent } from '../../src/api/security-events.js';

const transport = vi.hoisted(() => ({
  handler: undefined as ((context: unknown) => Promise<void>) | undefined,
  sendMessage: vi.fn(),
  editMessageText: vi.fn(),
}));
vi.mock('grammy', () => ({
  InputFile: vi.fn(),
  Bot: vi.fn(() => ({
    on: (_event: string, handler: (context: unknown) => Promise<void>) => {
      transport.handler = handler;
    },
    catch: vi.fn(),
    init: async () => {},
    stop: async () => {},
    api: transport,
  })),
}));
// Replace listeners only; the runtime observer, role lookup, recorder and registry DM send are real.
const proxies = vi.hoisted(() => ({
  members: new Map<string, (event: MemberConnectionEvent) => void>(),
}));
vi.mock('../../src/runtime/egress-proxy.js', () => ({
  startEgressProxy: async () => ({ httpProxyPort: 1, socksProxyPort: 2, close: async () => {} }),
  startMemberEgressProxy: async (
    principalId: string,
    ownerRole: boolean,
    report: (event: MemberConnectionEvent | OutboundAttemptEvent) => void
  ) => {
    proxies.members.set(principalId, (event) =>
      report(
        ownerRole
          ? {
              principalId,
              time: event.time,
              class: 'outbound_connect',
              tool: 'sandbox proxy',
              summary: `CONNECT ${event.host} (http proxy)`,
              sendsData: null,
              modelRunId: null,
              callId: null,
            }
          : event
      )
    );
    return { httpProxyPort: 3, socksProxyPort: 4, close: async () => {} };
  },
}));
const ipc = createRequire(import.meta.url)('@jungjaehoon/mama-core/client/ipc');
const roots: string[] = [];
const daemons: DaemonHandle[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  proxies.members.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function boot() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'owner-web-home-')));
  const memberRoot = realpathSync(mkdtempSync(join(tmpdir(), 'owner-web-members-')));
  roots.push(home, memberRoot);
  vi.stubEnv('HOME', home);
  vi.stubEnv('MAMA_DB_PATH', join(home, 'state.db'));
  vi.stubEnv('MAMA_FORCE_TIER_3', 'true');
  vi.stubEnv('MAMA_TELEGRAM_TOKEN', 'fixture-token');
  vi.spyOn(ipc, 'createActionIpcServer').mockResolvedValue({ close: async () => {} } as never);
  let messageId = 100;
  transport.sendMessage.mockReset().mockImplementation(async () => ({ message_id: ++messageId }));
  transport.editMessageText.mockReset().mockResolvedValue(true);
  const seed = await openCoreDatabase({ path: join(home, 'state.db') });
  const repo = createPrincipalRepository(seed.adapter);
  repo.ensureOwner({ principalId: 'owner', now: 1 });
  const people = ['20001', '20002', '20003'].map((externalId) =>
    repo.registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId,
      now: 2,
    })
  );
  for (const principalId of people.slice(0, 2))
    repo.grantRole({ principalId, role: 'owner', now: 3 });
  await seed.close();
  let runtime!: Awaited<ReturnType<typeof createOwnerRuntime>>;
  let report!: NonNullable<OwnerRuntimeOptions['outboundAttempts']>;
  let fetchUrl: string | undefined;
  let call = 0;
  const daemon = await bootDaemon({
    home,
    configPath: join(home, 'config.yaml'),
    config: {
      version: 1,
      agent: {
        backend: 'claude',
        model: 'fixture',
        effort: 'medium',
        max_turns: 10,
        timeout: 1000,
      },
      database: { path: join(home, 'state.db') },
      logging: { level: 'info', file: join(home, 'daemon.log') },
      member_root: memberRoot,
      telegram: { enabled: true, allowed_chats: ['-100'], owner_chat_id: '-100', polling: false },
    },
    logger: { info: () => {}, error: () => {} },
    dependencies: {
      createViewerServer: () => ({ start: async () => {}, stop: async () => {}, port: 0 }) as never,
      createOwnerRuntime: async (options) => {
        report = options.outboundAttempts!;
        runtime = await createOwnerRuntime({
          ...options,
          embedder: { embed: async () => new Float32Array(1024).fill(0.25) },
          createSession: (sessionOptions) => {
            const model: IModelRunner = {
              backendType: 'claude',
              reportsModelRuns: true,
              supportsNativeSubagents: true,
              prompt: async (_content, callbacks, request) => {
                const sessionId = `fixture-session-${++call}`;
                callbacks?.onInputDispatch?.({
                  backend: 'claude',
                  sessionId,
                  inputId: request!.nativeInputId!,
                });
                callbacks?.onAccepted?.({
                  backend: 'claude',
                  sessionId,
                  inputId: request!.nativeInputId!,
                });
                if (fetchUrl)
                  callbacks?.onToolUse?.('WebFetch', {
                    url: fetchUrl,
                    nativeToolUseId: `fetch-${call}`,
                  });
                return {
                  response: 'fixture answer',
                  session_id: sessionId,
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
  });
  daemons.push(daemon);
  let turn = 0;
  const run = async (principalId: string, url?: string) => {
    fetchUrl = url;
    const chatId = Number(['20001', '20002', '20003'][people.indexOf(principalId)]);
    const messageId = ++turn;
    const id = `telegram:${chatId}:${messageId}`;
    await transport.handler!({
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'private' },
        from: { id: chatId, is_bot: false },
        text: 'fixture request',
      },
    });
    await runtime.runtime.drainOnce();
    await vi.waitFor(() => expect(runtime.memberIntake(principalId).isPending!(id)).toBe(false));
  };
  const alerts = () =>
    transport.sendMessage.mock.calls.filter((args) =>
      /^(Agent |Member connection)/.test(args[1] as string)
    );
  const events = () =>
    readFileSync(join(daemon.paths.mamaRoot, 'logs', 'security-events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  return { people, runtime, report, run, alerts, events };
}

describe('owner-role personal web and connection alerts', () => {
  it('observes WebFetch in an owner DM and sends its URL only to that registry DM, grouped per person and host', async () => {
    const f = await boot();
    const [person, other] = f.people;
    await f.run(person, 'https://rates.example/private-one');
    await f.run(person, 'https://rates.example/private-two');
    await f.run(other, 'https://rates.example/other-person');
    expect(f.alerts().map((args) => args[0])).toEqual([20001, 20002]);
    expect(f.alerts()[0][1]).toContain('URL: https://rates.example/private-one');
    expect(f.alerts()[1][1]).toContain('URL: https://rates.example/other-person');
    expect(f.alerts().some((args) => args[0] === -100)).toBe(false);
    expect(f.events().map((event) => event.principalId)).toEqual([person, person, other]);
    expect(f.events()[1].suppressedSinceLastAlert).toBe(1);
    for (const event of f.events())
      expect(Object.keys(event).sort()).toEqual([
        'class',
        'eventId',
        'principalId',
        'suppressedSinceLastAlert',
        'time',
      ]);
    expect(JSON.stringify(f.events())).not.toContain('rates.example');
    const trace = f.runtime.database.adapter
      .prepare("SELECT tool_name FROM tool_traces WHERE tool_name='WebFetch'")
      .all();
    expect(trace).toHaveLength(3);
  });

  it('does not send a personal alert to the common channel when its DM delivery rejects', async () => {
    const f = await boot();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    transport.sendMessage.mockImplementation(async (_chatId, text) => {
      if (/^Agent web fetch/.test(text)) throw new Error('fixture DM rejected');
      return { message_id: 999 };
    });
    await f.run(f.people[0], 'https://private.example/DM_FAILURE_DETAIL');
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith('[agent] security_alert_failed'));
    expect(f.alerts()).toHaveLength(1);
    expect(f.alerts()[0][0]).toBe(20001);
    expect(f.alerts()[0][1]).toContain('DM_FAILURE_DETAIL');
    expect(f.alerts().some((args) => args[0] === -100)).toBe(false);
    expect(JSON.stringify(f.events())).not.toContain('DM_FAILURE_DETAIL');
  });

  it('rebinds proxy routing when an existing plain member receives the owner role', async () => {
    const f = await boot();
    const plain = f.people[2];
    await f.run(plain);
    const before = proxies.members.get(plain)!;
    before({ principalId: plain, host: 'before.example:443', time: new Date().toISOString() });
    await vi.waitFor(() => expect(f.alerts()).toHaveLength(1));
    expect(f.alerts()[0][0]).toBe(-100);
    createPrincipalRepository(f.runtime.database.adapter).grantRole({
      principalId: plain,
      role: 'owner',
      now: 4,
    });
    await f.run(plain);
    const after = proxies.members.get(plain)!;
    expect(after).not.toBe(before);
    after({ principalId: plain, host: 'after.example:443', time: new Date().toISOString() });
    await vi.waitFor(() => expect(f.alerts()).toHaveLength(2));
    expect(f.alerts()[1][0]).toBe(20003);
    expect(f.alerts()[1][1]).toContain('after.example:443');
    expect(f.events()[0]).toMatchObject({ principalId: plain, host: 'before.example:443' });
    expect(f.events()[1]).toMatchObject({ principalId: plain, class: 'outbound_connect' });
    expect(JSON.stringify(f.events()[1])).not.toContain('after.example');
  });

  it('routes an owner proxy refusal privately and keeps a plain member refusal minimal in the common channel', async () => {
    const f = await boot();
    const [person, , plain] = f.people;
    for (const principalId of [person, plain]) await f.run(principalId);
    for (const principalId of [person, plain]) {
      const refusal = {
        principalId,
        host: 'upload.example:443',
        time: new Date().toISOString(),
        class: 'outbound_connect' as const,
        summary: 'MEMBER_CONTENT_SENTINEL',
        url: 'https://upload.example/MEMBER_CONTENT_SENTINEL',
      };
      proxies.members.get(principalId)!(refusal);
      proxies.members.get(principalId)!(refusal);
    }
    await vi.waitFor(() => expect(f.alerts()).toHaveLength(2));
    expect(f.alerts().map((args) => args[0])).toEqual([20001, -100]);
    expect(f.alerts()[0][1]).toContain('Agent outbound connection (refused by the sandbox proxy)');
    expect(f.alerts()[0][1]).toContain('upload.example:443');
    expect(f.alerts()[1][1]).toMatch(
      new RegExp(`Member: ${plain}\\nHost: upload\\.example:443\\nTime:`)
    );
    expect(f.alerts()[1][1]).not.toContain(person);
    for (const event of f.events())
      expect(Object.keys(event).sort()).toEqual(
        event.principalId === person
          ? ['class', 'eventId', 'principalId', 'suppressedSinceLastAlert', 'time']
          : ['host', 'principalId', 'time']
      );
    expect(JSON.stringify(f.events()) + JSON.stringify(f.alerts())).not.toContain(
      'MEMBER_CONTENT_SENTINEL'
    );
    expect(f.events().map((event) => event.principalId)).toEqual([person, person, plain, plain]);
  });
});

it('retries serving an active registered member when its next Telegram DM arrives', async () => {
  const f = await boot();
  const repo = createPrincipalRepository(f.runtime.database.adapter);
  const id = repo.registerMember({
    connector: 'telegram',
    namespace: 'private',
    externalId: '20004',
    now: 5,
  });
  vi.spyOn(f.runtime.runtime, 'servePrincipal').mockImplementationOnce(() => {
    throw new Error('fixture serve failure');
  });
  await expect(f.runtime.serveMember(id)).rejects.toThrow('fixture serve failure');
  expect(f.runtime.runtime.servesPrincipal(id)).toBe(false);
  await transport.handler!({
    message: {
      message_id: 101,
      date: 5,
      chat: { id: 20004, type: 'private' },
      from: { id: 20004, is_bot: false },
      text: 'fixture recovery request',
    },
  });
  await vi.waitFor(() =>
    expect(f.runtime.runtime.mailbox!.readInput('telegram:20004:101', id)?.status).toBe('acked')
  );
  expect(f.runtime.runtime.servesPrincipal(id)).toBe(true);
  expect(
    transport.sendMessage.mock.calls.some(
      ([chat, text]) => chat === 20004 && typeof text === 'string'
    )
  ).toBe(true);
});
