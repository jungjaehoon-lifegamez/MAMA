import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrincipalRepository } from '@jungjaehoon/mama-core';
import { Mailbox } from '@jungjaehoon/mama-core/runtime/mailbox';
import { TelegramGateway } from '../../src/gateways/telegram.js';
import { TelegramMessageLedger } from '../../src/gateways/telegram-message-ledger.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
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
  gateway = new TelegramGateway({
    token: 'fixture-token',
    messageLedger: ledger,
    intake: intakes.get(common)!,
    registry: repository,
    memberIntake: (id) => intakes.get(id)!,
    principalPaths: (id) => memberPaths(join(root, 'members'), id),
    downloadsDir: join(root, 'common-downloads'),
    config: { allowedChats: ['-100', '20001'], ownerChatId: '-100', polling: false },
  });
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
    ['without an owner role', -100, false, false],
    ['outside allowed groups', -101, true, false],
    ['with a suspended owner role', -100, true, true],
  ])(
    'drops a group sender %s without a reply or download',
    async (_label, groupId, ownerRole, suspended) => {
      if (ownerRole) repository.grantRole({ principalId: member, role: 'owner', now: 3 });
      if (suspended) repository.suspend(member, 4);
      await send({
        chat: { id: groupId, type: 'supergroup' },
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

  it.each(['20001', '20002'])('recovers ready DM %s under its registered person', async (dm) => {
    const person = dm === '20001' ? member : second;
    const ref = `telegram:${dm}:22`;
    chat(person).saveOwnerMessage({
      id: ref,
      channelKey: dm,
      text: 'Personal question before restart',
      occurredAt: 1_700_000_000_000,
    });
    ledger.claim(ref);
    ledger.markReady(ref, 'Personal answer before restart');
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

  it('refuses a DM response after its recipient is suspended', async () => {
    await send({ chat: { id: 20002, type: 'private' }, from: { id: 20002, is_bot: false } });
    repository.suspend(second, 3);
    await expect(gateway.deliverResponse('telegram:20002:11', 'Must not arrive')).rejects.toThrow(
      /active member/
    );
    expect(transport.edits).toEqual([]);
  });
});
