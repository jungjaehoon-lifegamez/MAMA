import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrincipalRepository } from '@jungjaehoon/mama-core';
import { Mailbox } from '@jungjaehoon/mama-core/runtime/mailbox';
import { TelegramGateway } from '../../src/gateways/telegram.js';
import { TelegramMessageLedger } from '../../src/gateways/telegram-message-ledger.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createPrincipalSessions } from '../../src/runtime/principal-sessions.js';
import { memberPaths } from '../../src/runtime/member-paths.js';
import { createStimulusIntake } from '../../src/runtime/stimulus-delivery.js';
import { RawStore } from '../../src/storage/source-archive.js';
import { ChatSources } from '../../src/storage/chat-sources.js';

const transport = vi.hoisted(() => ({
  handler: undefined as ((ctx: unknown) => Promise<void>) | undefined,
  sent: [] as Array<{ chatId: number; text: string }>,
  edits: [] as Array<{ chatId: number; text: string }>,
  api: {
    getFile: vi.fn(async () => ({ file_path: 'photos/image.jpg', file_size: 4 })),
    sendMessage: vi.fn(async (chatId: number, text: string) => {
      transport.sent.push({ chatId, text });
      return { message_id: transport.sent.length + 100 };
    }),
    editMessageText: vi.fn(async (chatId: number, _messageId: number, text: string) => {
      transport.edits.push({ chatId, text });
    }),
    deleteMessage: vi.fn(async () => {}),
  },
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
    api: transport.api,
  })),
}));

let root: string;
let database: Awaited<ReturnType<typeof openCoreDatabase>>;
let repository: ReturnType<typeof createPrincipalRepository>;
let raw: RawStore;
let mailbox: Mailbox;
let member: string;
let second: string;
let gateway: TelegramGateway;
let ledger: TelegramMessageLedger;
const allowedChats = ['-100', '20001'];
const common = 'common-test';
const channels = new Map<string, ChatSources>();
const intakes = new Map<string, ReturnType<typeof createStimulusIntake>>();

function chat(principalId: string) {
  return channels.get(principalId)!;
}
function rows() {
  return database.adapter
    .prepare(
      "SELECT source_id, author, content, memory_scope_id FROM connector_event_index WHERE source_connector = 'chat' ORDER BY source_id"
    )
    .all();
}
async function send(overrides: Record<string, unknown> = {}) {
  await transport.handler!({
    message: {
      message_id: 11,
      date: 1_700_000_000,
      chat: { id: 20001, type: 'private' },
      from: { id: 20001, is_bot: false },
      text: 'Personal question',
      ...overrides,
    },
  });
}

function createGateway(
  memberIntake: (
    id: string,
    room?: string
  ) =>
    | ReturnType<typeof createStimulusIntake>
    | Promise<ReturnType<typeof createStimulusIntake>> = (id, room) =>
    room
      ? createStimulusIntake(
          { mailbox, accept: (input) => ({ inputId: mailbox.enqueue(input)!, state: 'accepted' }) },
          id,
          new ChatSources(raw, database.adapter, common, `member-agent:${id}`)
        )
      : intakes.get(id)!
) {
  return new TelegramGateway({
    token: 'fixture-token',
    messageLedger: ledger,
    intake: intakes.get(common)!,
    registry: repository,
    memberIntake,
    principalPaths: (id) => memberPaths(join(root, 'members'), id),
    downloadsDir: join(root, 'common-downloads'),
    config: { allowedChats, ownerChatId: '-100', polling: false },
  });
}

async function restartGateway() {
  await gateway.stop();
  ledger = new TelegramMessageLedger(join(root, 'ledger.json'));
  gateway = createGateway();
  await gateway.start();
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'telegram-members-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('MAMA_DB_PATH', join(root, 'core.db'));
  vi.stubEnv('MAMA_FORCE_TIER_3', 'true');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4])))
  );
  database = await openCoreDatabase({ path: join(root, 'core.db') });
  repository = createPrincipalRepository(database.adapter);
  member = repository.registerMember({
    connector: 'telegram',
    namespace: 'private',
    externalId: '20001',
    now: 1,
  });
  second = repository.registerMember({
    connector: 'telegram',
    namespace: 'private',
    externalId: '20002',
    now: 2,
  });
  raw = new RawStore(join(root, 'raw'));
  mailbox = new Mailbox(database.adapter);
  for (const id of [common, member, second]) {
    const sources = new ChatSources(raw, database.adapter, id, `agent:${id}`);
    channels.set(id, sources);
    intakes.set(
      id,
      createStimulusIntake(
        { mailbox, accept: (input) => ({ inputId: mailbox.enqueue(input)!, state: 'accepted' }) },
        id,
        sources
      )
    );
  }
  ledger = new TelegramMessageLedger(join(root, 'ledger.json'));
  gateway = createGateway();
  transport.sent.length = 0;
  transport.edits.length = 0;
  await gateway.start();
});
afterEach(async () => {
  await gateway.stop();
  raw.close();
  await database.close();
  channels.clear();
  intakes.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe('P10.1 Telegram person routing', () => {
  it('recovers every DM acknowledged while its personal intake was still opening', async () => {
    await gateway.stop();
    gateway = createGateway(() => new Promise(() => {}));
    await gateway.start();
    await send({ message_id: 21, text: 'first waiting message' });
    await send({ message_id: 22, text: 'second waiting message' });
    expect(mailbox.readInput('telegram:20001:21', member)).toBeNull();
    expect(mailbox.readInput('telegram:20001:22', member)).toBeNull();
    expect(ledger.get('telegram:20001:21')?.state).toBe('processing');
    expect(ledger.get('telegram:20001:22')?.state).toBe('processing');
    await restartGateway();
    expect(ledger.get('telegram:20001:21')?.state).toBe('delivered');
    expect(ledger.get('telegram:20001:22')?.state).toBe('delivered');
    expect(transport.sent.filter((m) => m.text.includes('interrupted'))).toHaveLength(2);
  });

  it('makes a reply from a finished intake task wait for the current chat queue holder', async () => {
    await gateway.stop();
    let open!: (intake: ReturnType<typeof createStimulusIntake>) => void;
    const opening = new Promise<ReturnType<typeof createStimulusIntake>>((r) => (open = r));
    let reply!: () => void;
    const ready = new Promise<void>((r) => (reply = r));
    let answering: Promise<void> | undefined;
    const intake = intakes.get(member)!;
    let served = false;
    const responding = {
      ...intake,
      acceptOwnerMessage: (input: Parameters<typeof intake.acceptOwnerMessage>[0]) => {
        answering = ready.then(() => gateway.deliverResponse(input.id, 'queued final reply'));
        return intake.acceptOwnerMessage(input);
      },
    };
    gateway = createGateway(() => (served ? responding : opening));
    await gateway.start();
    await send();
    served = true;
    open(responding);
    await vi.waitFor(() => expect(mailbox.readInput('telegram:20001:11', member)).not.toBeNull());
    // Finish the task that scheduled the reply, then occupy the same chat with another send.
    await new Promise<void>((r) => setImmediate(r));
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    transport.api.sendMessage.mockImplementationOnce(async (chatId, text) => {
      await hold;
      transport.sent.push({ chatId, text });
      return { message_id: 999 };
    });
    const sending = gateway.sendMessage('20001', 'queue holder');
    try {
      await new Promise<void>((r) => setImmediate(r));
      reply();
      await new Promise<void>((r) => setImmediate(r));
      expect(transport.edits.some((m) => m.text === 'queued final reply')).toBe(false);
      expect(ledger.get('telegram:20001:11')?.state).toBe('ready');
    } finally {
      release();
      await sending;
      await answering;
    }
    expect(ledger.get('telegram:20001:11')?.state).toBe('delivered');
  });

  it('logs a status recheck drop without exposing the transport identity', async () => {
    await gateway.stop();
    let open!: (intake: ReturnType<typeof createStimulusIntake>) => void;
    gateway = createGateway(() => new Promise((r) => (open = r)));
    await gateway.start();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await send();
    repository.suspend(member, 4);
    open(intakes.get(member)!);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(warn.mock.calls[0][0]).toMatch(/reason=principal_inactive.*chat_hash=.*sender_hash=/);
    expect(warn.mock.calls[0][0]).not.toContain('20001');
    expect(mailbox.readInput('telegram:20001:11', member)).toBeNull();
    warn.mockRestore();
  });

  it('returns during serve-on-demand and accepts other chats while preserving the waiting DM order', async () => {
    await gateway.stop();
    let served!: () => void;
    const serving = new Promise<void>((resolve) => (served = resolve));
    const sessions = createPrincipalSessions(common);
    const longTurn = sessions.turnChain(second)(() => serving);
    let isServed = false;
    gateway = createGateway((id) =>
      id === member && !isServed
        ? sessions.exclusive(async () => {
            isServed = true;
            return intakes.get(id)!;
          })
        : intakes.get(id)!
    );
    await gateway.start();
    let returned = false;
    const first = send({ message_id: 21, text: 'first waiting message' }).then(() => {
      returned = true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(returned).toBe(true);
      await send({ message_id: 21, text: 'first waiting message' });
      await send({ message_id: 22, text: 'second waiting message' });
      await send({
        message_id: 23,
        chat: { id: 20002, type: 'private' },
        from: { id: 20002 },
        text: 'other chat',
      });
      expect(mailbox.readInput('telegram:20002:23', second)).not.toBeNull();
      expect(mailbox.readInput('telegram:20001:21', member)).toBeNull();
      served();
      await vi.waitFor(() => expect(mailbox.readInput('telegram:20001:22', member)).not.toBeNull());
      const inputs = database.adapter
        .prepare('SELECT stimulus_id FROM mailbox_inputs WHERE principal_id=? ORDER BY id')
        .all(member);
      expect(inputs).toEqual([
        { stimulus_id: 'telegram:20001:21' },
        { stimulus_id: 'telegram:20001:22' },
      ]);
      expect(ledger.get('telegram:20001:21')?.state).toBe('processing');
    } finally {
      served();
      await first;
      await longTurn;
      await sessions.idle();
    }
  });

  it('admits a plain member to its room mailbox and recovers and archives its group reply', async () => {
    await send({ chat: { id: -100, type: 'supergroup' }, text: 'Partition correction' });
    expect(mailbox.readInput('telegram:-100:11', member)).not.toBeNull();
    expect(mailbox.readInput('telegram:-100:11', common)).toBeNull();
    expect(ledger.get('telegram:-100:11')).toMatchObject({ principalId: member });
    await restartGateway();
    expect(ledger.get('telegram:-100:11')?.state).toBe('processing');
    await gateway.deliverResponse('telegram:-100:11', 'Partition answer');
    expect([...transport.sent, ...transport.edits]).toContainEqual({
      chatId: -100,
      text: 'Partition answer',
    });
    expect(chat(common).exchanges(0, Date.now())).toEqual([
      { at: 1_700_000_000_000, owner: 'Partition correction', reply: 'Partition answer' },
    ]);
    expect(rows()).toContainEqual({
      source_id: 'telegram:-100:11:reply',
      author: `member-agent:${member}`,
      content: 'Partition answer',
      memory_scope_id: common,
    });
    expect(chat(member).exchanges(0, Date.now())).toEqual([]);
  });

  it('downloads plain member group files to that member directory', async () => {
    await send({
      chat: { id: -100, type: 'supergroup' },
      photo: [{ file_id: 'file', file_unique_id: 'unique', file_size: 4 }],
    });
    expect(
      readFileSync(join(root, 'members', member, 'downloads', 'telegram', '11_photo_unique.jpg'))
    ).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(existsSync(join(root, 'common-downloads', 'telegram'))).toBe(false);
  });

  it('keeps the recorded room intake when a waiting sender gains the owner role', async () => {
    await gateway.stop();
    let open!: (value: ReturnType<typeof createStimulusIntake>) => void;
    const waiting = new Promise<ReturnType<typeof createStimulusIntake>>((resolve) => {
      open = resolve;
    });
    gateway = createGateway(() => waiting);
    await gateway.start();
    await send({ chat: { id: -100, type: 'supergroup' }, text: 'Waiting room request' });
    repository.grantRole({ principalId: member, role: 'owner', now: 4 });
    open(
      createStimulusIntake(
        { mailbox, accept: (input) => ({ inputId: mailbox.enqueue(input)!, state: 'accepted' }) },
        member,
        new ChatSources(raw, database.adapter, common, `member-agent:${member}`),
        '-100'
      )
    );
    await vi.waitFor(() => expect(mailbox.readInput('telegram:-100:11', member)).not.toBeNull());
    expect(mailbox.readInput('telegram:-100:11', common)).toBeNull();
    await gateway.deliverResponse('telegram:-100:11', 'Recorded room reply');
    expect(chat(common).exchanges(0, Date.now()).at(-1)?.reply).toBe('Recorded room reply');
  });

  it('recovers a ready room reply and archives an interruption against the member mailbox', async () => {
    await send({ chat: { id: -100, type: 'supergroup' }, text: 'Room request' });
    ledger.markReady('telegram:-100:11', 'Ready room reply', 'html-v1');
    await restartGateway();
    expect([...transport.sent, ...transport.edits]).toContainEqual({
      chatId: -100,
      text: 'Ready room reply',
    });
    expect(ledger.get('telegram:-100:11')?.state).toBe('delivered');
    await send({
      message_id: 12,
      chat: { id: -100, type: 'supergroup' },
      text: 'Interrupted room request',
    });
    const row = mailbox.claimNext()!;
    // Close both mailbox inputs without a native result; only the second still owes a reply.
    mailbox.ack(row.id);
    const next = mailbox.claimNext()!;
    mailbox.ack(next.id);
    await restartGateway();
    expect(ledger.get('telegram:-100:12')?.state).toBe('delivered');
    expect(chat(common).exchanges(0, Date.now()).at(-1)?.reply).toContain('interrupted');
  });

  it('admits an active owner role in the allowed group and records the sender on common chat', async () => {
    repository.grantRole({ principalId: member, role: 'owner', now: 3 });
    await send({ chat: { id: -100, type: 'supergroup' }, text: 'Common correction' });
    expect(mailbox.readInput('telegram:-100:11', common)).not.toBeNull();
    expect(mailbox.readInput('telegram:-100:11', member)).toBeNull();
    expect(rows()).toEqual([
      {
        source_id: 'telegram:-100:11',
        author: member,
        content: 'Common correction',
        memory_scope_id: common,
      },
    ]);
    await gateway.deliverResponse('telegram:-100:11', 'Common answer');
    expect(chat(common).exchanges(0, Date.now())).toEqual([
      { at: 1_700_000_000_000, owner: 'Common correction', reply: 'Common answer' },
    ]);
    expect(chat(member).exchanges(0, Date.now())).toEqual([]);
  });

  it('keeps owner group attachments in the common downloads directory', async () => {
    repository.grantRole({ principalId: member, role: 'owner', now: 3 });
    await send({
      chat: { id: -100, type: 'supergroup' },
      photo: [{ file_id: 'file', file_unique_id: 'unique', file_size: 4 }],
    });
    const path = join(root, 'common-downloads', 'telegram', '11_photo_unique.jpg');
    expect(readFileSync(path)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(existsSync(join(root, 'members', member, 'downloads', 'telegram'))).toBe(false);
  });

  it.each([
    ['with an unknown sender', -100, false, false],
    ['outside allowed groups', -101, true, false],
    ['with a suspended owner role', -100, true, true],
    ['with a suspended plain member', -100, false, true],
  ])(
    'drops a group sender %s without a reply or download',
    async (_label, groupId, ownerRole, suspended) => {
      if (ownerRole) repository.grantRole({ principalId: member, role: 'owner', now: 3 });
      if (suspended) repository.suspend(member, 4);
      await send({
        chat: { id: groupId, type: 'supergroup' },
        ...(_label === 'with an unknown sender' ? { from: { id: 99999, is_bot: false } } : {}),
        photo: [{ file_id: 'file', file_unique_id: 'unique', file_size: 4 }],
      });
      expect(rows()).toEqual([]);
      expect(transport.sent).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['20001', 20001],
    ['20002', 20002],
  ])(
    'routes active member %s DM to its personal intake regardless of common allowlist',
    async (externalId, id) => {
      const principalId = externalId === '20001' ? member : second;
      await send({ chat: { id, type: 'private' }, from: { id, is_bot: false } });
      const ref = `telegram:${id}:11`;
      expect(mailbox.readInput(ref, principalId)).not.toBeNull();
      expect(mailbox.readInput(ref, common)).toBeNull();
      expect(rows()).toEqual([
        {
          source_id: ref,
          author: principalId,
          content: 'Personal question',
          memory_scope_id: principalId,
        },
      ]);
      expect(chat(common).exchanges(0, Date.now())).toEqual([]);
    }
  );

  it('drops an unenrolled private sender without a reply or attachment download', async () => {
    await send({
      chat: { id: 20003, type: 'private' },
      from: { id: 20003, is_bot: false },
      photo: [{ file_id: 'file', file_unique_id: 'unique', file_size: 4 }],
    });
    expect(rows()).toEqual([]);
    expect(transport.sent).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('drops a suspended member without admitting another input', async () => {
    repository.suspend(member, 3);
    await send();
    expect(rows()).toEqual([]);
    expect(transport.sent).toEqual([]);
  });

  it('downloads a DM image into that person directory before admitting its descriptor', async () => {
    await send({
      text: undefined,
      caption: 'Inspect this image',
      photo: [{ file_id: 'file', file_unique_id: 'unique', file_size: 4 }],
    });
    const path = join(root, 'members', member, 'downloads', 'telegram', '11_photo_unique.jpg');
    expect(readFileSync(path)).toEqual(Buffer.from([1, 2, 3, 4]));
    const stored = raw.getRecent('chat', 10).find((item) => item.sourceId === 'telegram:20001:11')!;
    expect(stored.metadata?.input).toMatchObject({ attachments: [{ path }] });
    expect(existsSync(join(root, 'common-downloads', 'telegram'))).toBe(false);
  });

  it('delivers a non-allowlisted DM reply and archives it in that person chat', async () => {
    await send({ chat: { id: 20002, type: 'private' }, from: { id: 20002, is_bot: false } });
    await gateway.deliverResponse('telegram:20002:11', 'Personal answer');
    expect(transport.edits).toEqual([{ chatId: 20002, text: 'Personal answer' }]);
    expect(chat(second).exchanges(0, Date.now())).toEqual([
      { at: 1_700_000_000_000, owner: 'Personal question', reply: 'Personal answer' },
    ]);
    expect(chat(common).exchanges(0, Date.now())).toEqual([]);
    expect(ledger.get('telegram:20002:11')?.state).toBe('delivered');
  });

  it('archives a same-process interrupted DM notice in the person chat', async () => {
    const personal = intakes.get(second)!;
    vi.spyOn(personal, 'isPending').mockReturnValue(false);
    ledger.claim('telegram:20002:11', {
      deliveryTarget: 'telegram:20002',
      payloadIdentity: 'a'.repeat(64),
    });
    chat(second).saveOwnerMessage({
      id: 'telegram:20002:11',
      channelKey: '20002',
      text: 'Personal question',
      occurredAt: 1_700_000_000_000,
    });
    await send({ chat: { id: 20002, type: 'private' }, from: { id: 20002, is_bot: false } });
    expect(ledger.get('telegram:20002:11')?.state).toBe('delivered');
    expect(chat(second).exchanges(0, Date.now())[0]?.reply).toMatch(/interrupt|stopp/i);
    expect(chat(common).exchanges(0, Date.now())).toEqual([]);
  });

  it.each([
    ['20001', true],
    ['20002', false],
  ])('recovers pending DM %s from the registry without route state', async (dm, ownerRole) => {
    const person = dm === '20001' ? member : second;
    if (ownerRole) repository.grantRole({ principalId: person, role: 'owner', now: 3 });
    const ref = `telegram:${dm}:21`;
    intakes.get(person)!.acceptOwnerMessage({
      id: ref,
      channelKey: dm,
      text: 'Pending personal question',
      occurredAt: 1_700_000_000_000,
    });
    ledger.claim(ref);
    await gateway.recoverPendingResponses();
    expect(ledger.get(ref)?.state).toBe('processing');
    expect(transport.sent).toEqual([]);
    await gateway.deliverResponse(ref, 'Finished personal answer');
    expect(ledger.get(ref)?.state).toBe('delivered');
    expect(chat(person).exchanges(0, Date.now())).toEqual([
      {
        at: 1_700_000_000_000,
        owner: 'Pending personal question',
        reply: 'Finished personal answer',
      },
    ]);
    expect(chat(common).exchanges(0, Date.now())).toEqual([]);
    expect(rows()).toEqual([
      expect.objectContaining({ author: person, memory_scope_id: person }),
      expect.objectContaining({ author: `agent:${person}`, memory_scope_id: person }),
    ]);
  });

  it.each([
    ['20001', true],
    ['20002', false],
  ])('recovers ready DM %s under its registered person', async (dm, ownerRole) => {
    const person = dm === '20001' ? member : second;
    if (ownerRole) repository.grantRole({ principalId: person, role: 'owner', now: 3 });
    const ref = `telegram:${dm}:22`;
    chat(person).saveOwnerMessage({
      id: ref,
      channelKey: dm,
      text: 'Personal question before restart',
      occurredAt: 1_700_000_000_000,
    });
    ledger.claim(ref);
    ledger.markReady(ref, 'Personal answer before restart');
    await restartGateway();
    await gateway.recoverPendingResponses();
    expect(ledger.get(ref)?.state).toBe('delivered');
    expect(transport.sent).toEqual([
      { chatId: Number(dm), text: 'Personal answer before restart' },
    ]);
    expect(chat(person).exchanges(0, Date.now())).toEqual([
      {
        at: 1_700_000_000_000,
        owner: 'Personal question before restart',
        reply: 'Personal answer before restart',
      },
    ]);
    expect(chat(common).exchanges(0, Date.now())).toEqual([]);
    expect(rows()).toEqual([
      expect.objectContaining({ author: person, memory_scope_id: person }),
      expect.objectContaining({ author: `agent:${person}`, memory_scope_id: person }),
    ]);
  });

  it('reads exact outbound member delivery receipts without sending, including after restart', async () => {
    const access = {
      principalId: second,
      agentId: `agent:${second}`,
      scopes: [{ kind: 'user' as const, id: second }],
      destinations: [{ kind: 'telegram' as const, id: '20002' }],
    };
    const key = 'job:fixture-job:1700000000000';
    expect(gateway.memberTextDelivered(access, key)).toBe(false);
    expect(await gateway.sendMemberText(access, 'Delivered result', key)).toBe(true);
    const pendingKey = 'job:fixture-job:1700003600000';
    transport.api.sendMessage.mockRejectedValueOnce(
      Object.assign(new Error('fixture rate limit'), { error_code: 429 })
    );
    await expect(gateway.sendMemberText(access, 'Pending result', pendingKey)).rejects.toThrow();
    const receipt = ledger.listUndelivered().find((entry) => entry.idempotencyKey === pendingKey)!;
    const saved = readFileSync(join(root, 'ledger.json'), 'utf8');
    expect(gateway.memberTextDelivered(access, key)).toBe(true);
    expect(gateway.memberTextDelivered(access, pendingKey)).toBe(false);
    expect(
      gateway.memberTextDelivered(
        { ...access, destinations: [{ kind: 'telegram', id: '20001' }] },
        key
      )
    ).toBe(false);
    expect(readFileSync(join(root, 'ledger.json'), 'utf8')).toBe(saved);
    ledger.markFailed(receipt.key);
    await gateway.stop();
    expect(gateway.memberTextDelivered(access, key)).toBe(true);
    await restartGateway();
    expect(gateway.memberTextDelivered(access, key)).toBe(true);
    expect(gateway.memberTextDelivered(access, pendingKey)).toBe(false);
    expect(transport.sent).toEqual([{ chatId: 20002, text: 'Delivered result' }]);
  });

  it.each([true, false])(
    'recovers a ready non-allowlisted member receipt once (owner role: %s), retaining other destination rules',
    async (ownerRole) => {
      if (ownerRole) repository.grantRole({ principalId: second, role: 'owner', now: 3 });
      const access = {
        principalId: second,
        agentId: `agent:${second}`,
        scopes: [{ kind: 'user' as const, id: second }],
        destinations: [{ kind: 'telegram' as const, id: '20002' }],
      };
      transport.api.sendMessage.mockRejectedValueOnce(
        Object.assign(new Error('fixture rate limit'), { error_code: 429 })
      );
      await expect(
        gateway.sendMemberText(access, 'Personal receipt', 'member-receipt')
      ).rejects.toThrow('fixture rate limit');
      const receipt = ledger
        .listUndelivered()
        .find((entry) => entry.idempotencyKey === 'member-receipt')!;
      expect(receipt).toMatchObject({
        state: 'ready',
        deliveryTarget: 'telegram:20002',
        deliveryUncertain: false,
      });
      const suspended = repository.registerMember({
        connector: 'telegram',
        namespace: 'private',
        externalId: '20003',
        now: 4,
      });
      repository.suspend(suspended, 5);
      const offboarded = repository.registerMember({
        connector: 'telegram',
        namespace: 'private',
        externalId: '20004',
        now: 4,
      });
      repository.offboard(offboarded, 5);
      repository.ensureOwner({
        principalId: common,
        connector: 'telegram',
        namespace: 'private',
        externalId: '20005',
        now: 4,
      });
      for (const dm of ['-100', '-101', '29999', '20003', '20004', '20005']) {
        ledger.claim(`outbound:${dm}`, {
          deliveryTarget: `telegram:${dm}`,
          payloadIdentity: 'a'.repeat(64),
        });
        ledger.markReady(`outbound:${dm}`, `Receipt for ${dm}`, 'html-v1');
      }
      await restartGateway();
      await gateway.recoverPendingResponses();
      await restartGateway();
      expect(transport.sent).toEqual([
        { chatId: 20002, text: 'Personal receipt' },
        { chatId: -100, text: 'Receipt for -100' },
      ]);
      expect(ledger.get(receipt.key)?.state).toBe('delivered');
      expect(ledger.get('outbound:-100')?.state).toBe('delivered');
      for (const dm of ['-101', '29999', '20003', '20004', '20005'])
        expect(ledger.get(`outbound:${dm}`)?.state).toBe('ready');
      expect(allowedChats).toEqual(['-100', '20001']);
      await expect(gateway.sendMessage('20002', 'Not a host receipt')).rejects.toThrow(
        /allowlisted/
      );
      expect(rows()).toEqual([]);
    }
  );

  it('refuses a DM response after its recipient is suspended', async () => {
    await send({ chat: { id: 20002, type: 'private' }, from: { id: 20002, is_bot: false } });
    repository.suspend(second, 3);
    await expect(gateway.deliverResponse('telegram:20002:11', 'Must not arrive')).rejects.toThrow(
      /active member/
    );
    expect(transport.edits).toEqual([]);
  });
});

it('keeps a retired person image as a durable envelope and downloads it only after service returns', async () => {
  await gateway.stop();
  let pending!: import('../../src/gateways/turn-contract.js').OwnerMessageInput;
  gateway = createGateway(() => ({
    ...intakes.get(member)!,
    deferIncoming: () => true,
    acceptOwnerMessage: (input) => {
      pending = input;
      return { inputId: 'fixture-pending', state: 'accepted' };
    },
  }));
  await gateway.start();
  transport.api.getFile.mockClear();
  await send({
    text: undefined,
    caption: 'Inspect the deferred image',
    photo: [{ file_id: 'file', file_unique_id: 'unique', file_size: 4 }],
  });
  expect(transport.api.getFile).not.toHaveBeenCalled();
  expect(pending.payload).toHaveProperty('pendingTelegramMessage');
  expect(rows()).toEqual([]);
  const prepared = await gateway.prepareDeferredMemberInput(member, pending);
  expect(transport.api.getFile).toHaveBeenCalledOnce();
  intakes.get(member)!.acceptOwnerMessage(prepared);
  expect(chat(member).hasOwnerMessage(pending.id)).toBe(true);
  expect(prepared.payload).toHaveProperty('attachments');
  expect(prepared.payload).not.toHaveProperty('pendingTelegramMessage');
});
