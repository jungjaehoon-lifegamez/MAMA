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

// Provider ids are generated from fixture keys, never from live identities.
const id = (key: string) => createHash('sha256').update(key).digest().readUInt32BE(0);
const ownerId = id('receipt-owner');
const selectedId = id('receipt-selected');
const selectionText = 'Member selection for enrollment (Choose member button)';
const roots: string[] = [];
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture(outcome: string) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'enrollment-receipt-home-')));
  const memberRoot = realpathSync(mkdtempSync(join(tmpdir(), 'enrollment-receipt-members-')));
  roots.push(home, memberRoot);
  vi.stubEnv('HOME', home);
  vi.stubEnv('MAMA_DB_PATH', join(home, 'state.db'));
  transport.send.mockReset().mockResolvedValue({ message_id: 1 });
  // The sandbox cannot listen on Unix sockets; storage, catalog and mailbox remain real.
  const ipc = createRequire(import.meta.url)('@jungjaehoon/mama-core/client/ipc');
  vi.spyOn(ipc, 'createActionIpcServer').mockResolvedValue({ close: async () => {} });
  const turns: Array<{ ref: string; content: ContentBlock[] }> = [];
  const owner = await createOwnerRuntime({
    backend: 'codex',
    model: 'fixture',
    runtimeRoot: home,
    workspaceDir: join(home, 'workspace'),
    rawPath: join(home, 'raw'),
    databasePath: join(home, 'state.db'),
    socketPath: join(home, 'runtime.sock'),
    credentialPath: join(home, 'runtime', 'credential'),
    memberRoot,
    memberEnrollment: {
      ownerUserIds:
        outcome === 'refused' ? [String(ownerId), String(selectedId)] : [String(ownerId)],
      requestSelection: (ref) => gateway.requestMemberEnrollment(ref),
    },
    ownerPrincipalId: 'owner',
    agentId: 'owner-agent',
    scopes: [],
    timeZone: createTimeZoneSetting('UTC'),
    maxTurns: 5,
    timeout: 1000,
    lessons: async () => [],
    embedder: { embed: async () => new Float32Array(1024).fill(0.25) },
    createSession: (input) => {
      if (input.principal && outcome === 'failed') throw new Error('fixture activation failure');
      return {
        stop: async () => {},
        runTurn: async (content: ContentBlock[], request: NativeSessionRequest) => {
          turns.push({
            ref: request.sourceMessageRef!,
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
      } as never;
    },
    onOwnerResult: (row, result) => {
      owner.intake.recordOwnerReply({
        messageRef: row.stimulusId,
        text: result.response,
        occurredAt: Date.now(),
        author: 'agent',
        deliveryVerified: true,
      });
    },
  });
  cleanup.push(async () => {
    for (const member of createPrincipalRepository(owner.database.adapter).listMembers()) {
      roots.push(memberClaudeTmpDir(member.principalId));
    }
    await owner.stop();
  });
  createPrincipalRepository(owner.database.adapter).ensureOwner({
    principalId: 'owner',
    connector: 'telegram',
    namespace: 'private',
    externalId: String(ownerId),
    now: 1,
  });
  const gateway = new TelegramGateway({
    token: 'fixture-token',
    intake: owner.intake,
    onMemberSelection: (selection) => {
      if (outcome === 'rejected') throw new Error('fixture completion rejected');
      return owner.completeMemberEnrollment(selection);
    },
    recordMemberSelection: (exchange) => {
      if (outcome === 'record fails') throw new Error('fixture record failure');
      owner.recordHostExchange(exchange);
    },
    messageLedgerPath: join(home, 'ledger.json'),
    config: {
      allowedChats: [String(ownerId)],
      ownerUserIds: [String(ownerId)],
      polling: false,
    },
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
  const sourceRef = await message({ text: 'fixture enrollment request' });
  await vi.waitFor(() =>
    expect(owner.runtime.mailbox!.readInput(sourceRef, 'owner')?.status).toBe('acked')
  );
  const request = (ref = sourceRef) =>
    owner.surface.hostToolCall('manage.member.enroll', {}, 'fixture-request', {
      session: { sourceMessageRef: ref },
    });
  if (outcome !== 'no pending') {
    expect(await request()).toMatchObject({ data: { status: 'pending' } });
  }
  const requestId =
    transport.send.mock.calls.find((call) => call[2]?.reply_markup?.keyboard)?.[2].reply_markup
      .keyboard[0][0].request_users.request_id ?? 1;
  const select = (users = [{ user_id: selectedId }]) =>
    message({ users_shared: { request_id: requestId, users } });
  const exchanges = () =>
    owner.surface.hostToolCall('owner.messages', { since: 2000, before: 3000, chars: 4000 });
  return { owner, message, request, select, turns, sourceRef, exchanges };
}

describe('enrollment receipts in the owner conversation', () => {
  it('wires the gateway receipt port through the daemon without owner intake', async () => {
    const home = mkdtempSync(join(tmpdir(), 'enrollment-receipt-daemon-'));
    roots.push(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('MAMA_TELEGRAM_TOKEN', 'fixture-token');
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
          owner_chat_id: String(ownerId),
          owner_user_ids: [String(ownerId)],
          allowed_chats: [String(ownerId)],
          polling: false,
        },
      },
      logger: { info: () => {}, error: () => {} },
      dependencies: {
        ensureIsolation: () => {},
        createOwnerRuntime: async () =>
          ({
            intake: { acceptOwnerMessage, recordOwnerReply: () => {} },
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
      expect(record).toBeTypeOf('function');
      record!(exchange);
      expect(recordHostExchange).toHaveBeenCalledWith(exchange);
      expect(acceptOwnerMessage).not.toHaveBeenCalled();
    } finally {
      await daemon.stop();
    }
  });

  it.each([
    'created',
    'exists',
    'refused',
    'failed',
    'rejected',
    'no pending',
    'invalid empty',
    'invalid multiple',
    'invalid zero',
    'invalid unsafe',
  ])(
    'records %s once and supplies it to the next owner turn without admitting the selection',
    async (outcome) => {
      const f = await fixture(outcome);
      if (outcome === 'exists') {
        createPrincipalRepository(f.owner.database.adapter).registerMember({
          connector: 'telegram',
          namespace: 'private',
          externalId: String(selectedId),
          now: 1,
        });
      }
      const db = f.owner.database.adapter;
      const mailboxBefore = db.prepare('SELECT * FROM mailbox_inputs').all();
      const invalidUsers: Record<string, Array<{ user_id: number }>> = {
        'invalid empty': [],
        'invalid multiple': [{ user_id: selectedId }, { user_id: selectedId }],
        'invalid zero': [{ user_id: 0 }],
        'invalid unsafe': [{ user_id: Number.MAX_SAFE_INTEGER + 1 }],
      };
      const ref = await f.select(invalidUsers[outcome]);
      expect(db.prepare('SELECT * FROM mailbox_inputs').all()).toEqual(mailboxBefore);
      expect(f.turns).toHaveLength(1);
      const sentText = transport.send.mock.calls.at(-1)![1] as string;
      expect(sentText).toMatch(
        new RegExp(`^Enrollment ${['created', 'exists'].includes(outcome) ? outcome : 'refused'}:`)
      );
      const listed = await f.exchanges();
      expect(listed).toMatchObject({
        status: 'completed',
        data: { total: 1, messages: [{ at: 2000, owner: selectionText, reply: sentText }] },
      });
      const stored = db
        .prepare(
          "SELECT source_id, author, channel, content, source_timestamp_ms, metadata_json, memory_scope_kind, memory_scope_id FROM connector_event_index WHERE source_connector='chat' AND source_entity_id IN (?, ?)"
        )
        .all(ref, `${ref}:reply`);
      expect(stored).toHaveLength(2);
      expect(stored).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source_id: ref,
            author: 'owner',
            channel: `telegram:${ownerId}`,
            source_timestamp_ms: 2000,
            memory_scope_kind: 'user',
            memory_scope_id: 'owner',
          }),
          expect.objectContaining({ source_id: `${ref}:reply`, author: 'host', content: sentText }),
        ])
      );
      const receipt = stored.find((item) => item.source_id === `${ref}:reply`)!;
      expect(JSON.parse(String(receipt.metadata_json))).toMatchObject({ deliveryVerified: true });
      const selected = stored.find((item) => item.source_id === ref)!;
      expect(JSON.parse(String(selected.metadata_json))).toMatchObject({ input: null });
      expect(JSON.stringify([listed, stored])).not.toContain(String(selectedId));
      expect(await f.request(ref)).toMatchObject({ status: 'failed', error: { kind: 'denied' } });
      expect(await f.request('scheduled:fixture')).toMatchObject({
        status: 'failed',
        error: { kind: 'denied' },
      });
      expect(await f.request()).toMatchObject({ data: { status: 'pending' } });
      const nextRef = await f.message({ text: 'fixture next owner question' });
      await vi.waitFor(() =>
        expect(f.owner.runtime.mailbox!.readInput(nextRef, 'owner')?.status).toBe('acked')
      );
      expect(f.turns).toHaveLength(2);
      expect(f.turns[1]!.ref).toBe(nextRef);
      const context = JSON.stringify(f.turns[1]!.content);
      expect(context).toContain('[session_start]');
      expect(context).toContain(selectionText);
      expect(context).toContain(sentText);
      expect(context).toContain('fixture next owner question');
      expect(context).not.toContain(String(selectedId));
      expect(await f.request(nextRef)).toMatchObject({ data: { status: 'pending' } });
    }
  );

  it.each(['no pending', 'created', 'acknowledgment'])(
    'stores a failed %s delivery without presenting it as a delivered exchange',
    async (outcome) => {
      const f = await fixture(outcome);
      if (outcome === 'created') transport.send.mockResolvedValueOnce({ message_id: 1 });
      transport.send.mockRejectedValueOnce(new Error('fixture send failure'));
      await expect(f.select()).rejects.toThrow('fixture send failure');
      expect(await f.exchanges()).toMatchObject({
        data: { total: 1, messages: [{ owner: selectionText, reply: null }] },
      });
      const receipt = f.owner.database.adapter
        .prepare(
          "SELECT author, content, metadata_json FROM connector_event_index WHERE source_connector='chat' AND source_id=?"
        )
        .get(`telegram:${ownerId}:2:reply`)!;
      expect(receipt.author).toBe('host');
      expect(receipt.content).toBe(transport.send.mock.calls.at(-1)![1]);
      expect(JSON.parse(String(receipt.metadata_json))).toMatchObject({ deliveryVerified: false });
      expect(JSON.stringify(receipt)).not.toContain(String(selectedId));
      const nextRef = await f.message({ text: 'fixture next question' });
      await vi.waitFor(() =>
        expect(f.owner.runtime.mailbox!.readInput(nextRef, 'owner')?.status).toBe('acked')
      );
      expect(JSON.stringify(f.turns[1]!.content)).not.toContain(selectionText);
    }
  );

  it('logs a record failure without replacing the delivered receipt or a send error', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await fixture('record fails');
    await f.select();
    expect(transport.send.mock.calls.at(-1)![1]).toMatch(/^Enrollment created:/);
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('enrollment receipt record failed: fixture record failure')
    );
    errors.mockClear();
    expect(await f.request()).toMatchObject({ data: { status: 'pending' } });
    transport.send.mockRejectedValueOnce(new Error('fixture send failure'));
    await expect(f.select()).rejects.toThrow('fixture send failure');
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('enrollment receipt record failed: fixture record failure')
    );
  });
});
