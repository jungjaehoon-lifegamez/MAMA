import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPrincipalRepository } from '@jungjaehoon/mama-core';
import type { ContentBlock } from '@jungjaehoon/mama-core/runtime/drivers/types';
import type { NativeSessionRequest } from '../../src/runtime/native-session.js';
import { bootDaemon } from '../../src/cli/commands/daemon.js';
import { TelegramGateway } from '../../src/gateways/telegram.js';
import { createOwnerRuntime } from '../../src/runtime/owner-runtime.js';
import { memberClaudeTmpDir } from '../../src/runtime/member-paths.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';

const transport = vi.hoisted(() => ({
  send: vi.fn(),
  handler: undefined as undefined | ((ctx: unknown) => Promise<void>),
}));
vi.mock('grammy', async (original) => ({
  InputFile: (await original<typeof import('grammy')>()).InputFile,
  Bot: vi.fn(() => ({
    on: (_event: string, handler: (ctx: unknown) => Promise<void>) => {
      transport.handler = handler;
    },
    catch: () => {},
    init: async () => {},
    stop: async () => {},
    botInfo: { id: 1, username: 'fixture_bot' },
    api: {
      sendMessage: transport.send,
      editMessageText: async () => {},
      deleteMessage: async () => {},
    },
  })),
}));
vi.mock('../../src/runtime/egress-proxy.js', () => ({
  startEgressProxy: async () => ({ httpProxyPort: 1, socksProxyPort: 2, close: async () => {} }),
  startMemberEgressProxy: async () => ({
    httpProxyPort: 1,
    socksProxyPort: 2,
    close: async () => {},
  }),
}));
const id = (key: string) => createHash('sha256').update(key).digest().readUInt32BE(0);
const ownerId = id('receipt-owner');
const selectedId = id('receipt-selected');
const commonRoom = id('receipt-common');
const selectionText = 'Member selection for enrollment (Choose member button)';
const roots: string[] = [];
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture(recordFails = false) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'enrollment-receipt-home-')));
  const memberRoot = realpathSync(mkdtempSync(join(tmpdir(), 'enrollment-receipt-members-')));
  roots.push(home, memberRoot);
  vi.stubEnv('HOME', home);
  vi.stubEnv('MAMA_DB_PATH', join(home, 'state.db'));
  transport.send.mockReset().mockResolvedValue({ message_id: 1 });
  const ipc = createRequire(import.meta.url)('@jungjaehoon/mama-core/client/ipc');
  vi.spyOn(ipc, 'createActionIpcServer').mockResolvedValue({ close: async () => {} });
  const seed = await openCoreDatabase({ path: join(home, 'state.db') });
  const repository = createPrincipalRepository(seed.adapter);
  repository.ensureOwner({ principalId: 'common', now: 1 });
  const person = repository.registerMember({
    connector: 'telegram',
    namespace: 'private',
    externalId: String(ownerId),
    now: 2,
  });
  repository.grantRole({ principalId: person, role: 'owner', now: 3 });
  await seed.close();
  const turns: Array<{ principal: string; content: ContentBlock[] }> = [];
  const runtime = await createOwnerRuntime({
    backend: 'codex',
    model: 'fixture',
    runtimeRoot: home,
    workspaceDir: join(home, 'workspace'),
    rawPath: join(home, 'raw'),
    databasePath: join(home, 'state.db'),
    socketPath: join(home, 'runtime.sock'),
    credentialPath: join(home, 'runtime', 'credential'),
    memberRoot,
    ownerPrincipalId: 'common',
    agentId: 'common-agent',
    scopes: [],
    timeZone: createTimeZoneSetting('UTC'),
    maxTurns: 5,
    timeout: 1000,
    lessons: async () => [],
    embedder: { embed: async () => new Float32Array(1024).fill(0.25) },
    createSession: (input) =>
      ({
        stop: async () => {},
        runTurn: async (content: ContentBlock[], request: NativeSessionRequest) => {
          turns.push({
            principal: input.principal?.principalId ?? 'common',
            content:
              (await request.prepareSessionContent?.({
                sessionId: 'fixture-session',
                isNewSession: true,
              })) ?? content,
          });
          request.streamCallbacks?.onInputDispatch?.({
            backend: 'codex',
            sessionId: 'fixture-session',
            inputId: request.nativeInputId!,
          });
          request.streamCallbacks?.onAccepted?.({
            backend: 'codex',
            sessionId: 'fixture-session',
            turnId: `fixture-turn-${turns.length}`,
          });
          return {
            response: 'fixture answer',
            turns: 1,
            history: [],
            totalUsage: { input_tokens: 0, output_tokens: 0 },
            stopReason: 'end_turn',
            modelRunId: null,
            modelRunProvenance: 'backend_no_run',
          };
        },
      }) as never,
    onMemberResult: (row, result) =>
      runtime.memberIntake(row.principalId).recordOwnerReply({
        messageRef: row.stimulusId,
        text: result.response,
        occurredAt: Date.now(),
        author: 'agent',
        deliveryVerified: true,
      }),
  });
  cleanup.push(async () => {
    roots.push(memberClaudeTmpDir(person));
    await runtime.stop();
  });
  const repo = createPrincipalRepository(runtime.database.adapter);
  const selectionsFinished = new Set<string>();
  const completionErrors: string[] = [];
  const gateway = new TelegramGateway({
    token: 'fixture-token',
    log: (line) => completionErrors.push(line),
    registry: repo,
    intake: runtime.intake,
    memberIntake: (principalId) => runtime.serveMember(principalId),
    principalPaths: (principalId) => runtime.principalPaths(principalId),
    onMemberSelection: (selection) => runtime.completeMemberEnrollment(selection),
    recordMemberSelection: (exchange) => {
      try {
        if (recordFails) throw new Error('fixture record failure');
        runtime.recordHostExchange(exchange);
      } finally {
        selectionsFinished.add(exchange.message.id);
      }
    },
    messageLedgerPath: join(home, 'ledger.json'),
    config: { allowedChats: [String(commonRoom)], ownerChatId: String(commonRoom), polling: false },
  });
  await gateway.start();
  cleanup.push(() => gateway.stop());
  let messageId = 0;
  const message = async (extra: object) => {
    const current = ++messageId;
    await transport.handler!({
      message: {
        message_id: current,
        date: current,
        chat: { id: ownerId, type: 'private' },
        from: { id: ownerId, is_bot: false },
        ...extra,
      },
    });
    return `telegram:${ownerId}:${current}`;
  };
  const settled = async (ref: string) =>
    vi.waitFor(() => expect(runtime.runtime.mailbox!.readInput(ref, person)?.status).toBe('acked'));
  const ref = await message({ text: 'fixture first personal question' });
  await settled(ref);
  transport.send.mockClear();
  const select = async (requestId = 1, users = [{ user_id: selectedId }]) => {
    const ref = await message({ users_shared: { request_id: requestId, users } });
    await vi.waitFor(() => expect(selectionsFinished.has(ref)).toBe(true));
    return ref;
  };
  return {
    home,
    runtime,
    gateway,
    repo,
    person,
    turns,
    message,
    settled,
    select,
    completionErrors,
  };
}

describe('enrollment host receipts remain in the requesting DM and the common record', () => {
  it('wires the receipt port through the daemon without admitting a model turn', async () => {
    const home = mkdtempSync(join(tmpdir(), 'enrollment-receipt-daemon-'));
    roots.push(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('MAMA_TELEGRAM_TOKEN', 'fixture-token');
    const database = await openCoreDatabase({ path: join(home, 'state.db') });
    cleanup.push(() => database.close());
    const recordHostExchange = vi.fn();
    const acceptOwnerMessage = vi.fn();
    let record: import('../../src/gateways/telegram.js').TelegramGatewayOptions['recordMemberSelection'];
    const daemon = await bootDaemon({
      home,
      configPath: join(home, 'config.yaml'),
      config: {
        version: 1,
        agent: {
          backend: 'codex',
          model: 'fixture',
          effort: 'medium',
          max_turns: 5,
          timeout: 1000,
          run_token_budget: 0,
        },
        database: { path: join(home, 'state.db') },
        logging: { level: 'info', file: join(home, 'daemon.log') },
        telegram: {
          enabled: true,
          owner_chat_id: String(commonRoom),
          allowed_chats: [String(commonRoom)],
          polling: false,
        },
      },
      logger: { info: () => {}, error: () => {} },
      dependencies: {
        ensureIsolation: () => {},
        createOwnerRuntime: async () =>
          ({
            database,
            intake: { acceptOwnerMessage, recordOwnerReply: () => {} },
            serveMember: () => ({ acceptOwnerMessage, recordOwnerReply: () => {} }),
            principalPaths: () => ({ downloadsDir: join(home, 'downloads') }),
            recordHostExchange,
            wikiRoot: null,
            surface: { dispatch: () => {}, ownerAccess: { scopes: [] } },
            stop: async () => {},
          }) as never,
        createViewerServer: () =>
          ({ port: 1, start: async () => {}, stop: async () => {} }) as never,
        createReportScheduler: () => ({ start: () => {}, stop: () => {} }) as never,
        startConnectorRuntime: async () => ({ stop: async () => {} }) as never,
        createTelegramGateway: (options) => {
          record = options.recordMemberSelection;
          return { start: async () => {}, stop: async () => {} } as never;
        },
      },
    });
    try {
      const exchange = {
        message: {
          id: 'fixture:selection',
          channelKey: 'fixture',
          occurredAt: 1,
          text: selectionText,
        },
        reply: { text: 'fixture receipt', occurredAt: 2, deliveryVerified: true },
      };
      record!(exchange);
      expect(recordHostExchange).toHaveBeenCalledWith(exchange);
      expect(acceptOwnerMessage).not.toHaveBeenCalled();
    } finally {
      await daemon.stop();
    }
  });

  it.each(['no pending', 'late selection', 'invalid empty', 'invalid multiple', 'invalid zero'])(
    'records a %s refusal personally without registering the selected identity or admitting a turn',
    async (outcome) => {
      const f = await fixture();
      let requestId = 1;
      if (outcome !== 'no pending') {
        // Direct host service characterization; no product action exposes enrollment in P10.1.
        await f.gateway.requestMemberEnrollment(`telegram:${ownerId}:1`, String(ownerId));
        requestId =
          transport.send.mock.calls.at(-1)![2].reply_markup.keyboard[0][0].request_users.request_id;
      }
      const invalid: Record<string, Array<{ user_id: number }>> = {
        'invalid empty': [],
        'invalid multiple': [{ user_id: selectedId }, { user_id: selectedId }],
        'invalid zero': [{ user_id: 0 }],
      };
      const ref = await f.select(requestId, invalid[outcome]);
      expect(f.turns).toHaveLength(1);
      const text = transport.send.mock.calls.at(-1)![1] as string;
      expect(text).toMatch(/^Enrollment refused:/);
      expect(f.repo.resolveByExternal('telegram', 'private', String(selectedId))).toBeNull();
      const rows = f.runtime.database.adapter
        .prepare(
          `SELECT source_id, author, memory_scope_id, content, metadata_json
        FROM connector_event_index WHERE source_connector='chat' AND source_id IN (?, ?)`
        )
        .all(ref, `${ref}:reply`) as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.memory_scope_id === f.person)).toBe(true);
      expect(rows.find((row) => row.source_id === ref)?.author).toBe(f.person);
      expect(JSON.stringify(rows)).not.toContain(String(selectedId));
      const next = await f.message({ text: 'fixture next personal question' });
      await f.settled(next);
      expect(f.turns.at(-1)!.principal).toBe(f.person);
      expect(JSON.stringify(f.turns.at(-1)!.content)).toContain(selectionText);
      expect(JSON.stringify(f.turns.at(-1)!.content)).toContain(text);
      expect(
        f.runtime.database.adapter
          .prepare(
            `SELECT count(*) AS n FROM connector_event_index
        WHERE memory_scope_id='common' AND content=?`
          )
          .get(text)
      ).toEqual({ n: 1 });
    }
  );

  it('stores an undelivered refusal without presenting it in the next personal session context', async () => {
    const f = await fixture();
    transport.send.mockRejectedValueOnce(new Error('fixture send failure'));
    await f.select();
    await vi.waitFor(() =>
      expect(f.completionErrors).toContain(
        'telegram enrollment completion failed error=fixture send failure'
      )
    );
    const row = f.runtime.database.adapter
      .prepare(
        `SELECT metadata_json FROM connector_event_index
      WHERE source_id=?`
      )
      .get(`telegram:${ownerId}:2:reply`) as { metadata_json: string };
    expect(JSON.parse(row.metadata_json)).toMatchObject({ deliveryVerified: false });
    const next = await f.message({ text: 'fixture next personal question' });
    await f.settled(next);
    expect(JSON.stringify(f.turns.at(-1)!.content)).not.toContain(selectionText);
  });

  it('reports a record failure without replacing the delivered refusal or send error', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await fixture(true);
    await f.select();
    expect(transport.send.mock.calls.at(-1)![1]).toMatch(/^Enrollment refused:/);
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('enrollment receipt record failed: fixture record failure')
    );
    transport.send.mockRejectedValueOnce(new Error('fixture send failure'));
    await f.select();
    await vi.waitFor(() =>
      expect(f.completionErrors).toContain(
        'telegram enrollment completion failed error=fixture send failure'
      )
    );
  });
});
