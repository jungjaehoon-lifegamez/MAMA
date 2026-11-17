import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrincipalRepository } from '@jungjaehoon/mama-core';

const seams = vi.hoisted(() => ({
  api: {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 401 }),
    setMyCommands: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
  },
  handlers: new Map<string, (ctx: unknown) => Promise<void>>(),
}));

vi.mock('grammy', () => ({
  InputFile: vi.fn(),
  Bot: vi.fn().mockImplementation(() => ({
    on: vi.fn((event: string, handler: (ctx: unknown) => Promise<void>) => {
      seams.handlers.set(event, handler);
    }),
    catch: vi.fn(),
    init: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    botInfo: { id: 101, username: 'fixture_bot' },
    api: seams.api,
  })),
}));

import { TelegramGateway } from '../../src/gateways/telegram.js';
import type { TurnIntake } from '../../src/gateways/turn-contract.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';

const roots: string[] = [];
const databases: Array<Awaited<ReturnType<typeof openCoreDatabase>>> = [];
const COMMON = '-7001';
const PERSON = 7101;

afterEach(async () => {
  nextId = 77;
  for (const database of databases.splice(0)) await database.close();
  seams.handlers.clear();
  for (const fn of Object.values(seams.api)) fn.mockClear();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function gateway(
  accountReplies: ConstructorParameters<typeof TelegramGateway>[0]['accountReplies']
) {
  const root = mkdtempSync(join(tmpdir(), 'mama-telegram-accounts-'));
  roots.push(root);
  vi.stubEnv('HOME', root);
  const database = await openCoreDatabase({ path: join(root, 'principals.db') });
  databases.push(database);
  const registry = createPrincipalRepository(database.adapter);
  const person = registry.registerMember({
    connector: 'telegram',
    namespace: 'private',
    externalId: String(PERSON),
    now: 1,
  });
  registry.grantRole({ principalId: person, role: 'owner', now: 2 });
  const accepted: unknown[] = [];
  const intake: TurnIntake = {
    recordOwnerReply: () => {},
    acceptOwnerMessage: (input) => {
      accepted.push(input);
      return { inputId: 'input-1', state: 'accepted' };
    },
  };
  const ledger = join(root, 'ledger.json');
  const active = new TelegramGateway({
    token: 'fixture-token',
    intake,
    registry,
    memberIntake: () => intake,
    principalPaths: () => ({ downloadsDir: join(root, 'downloads') }),
    messageLedgerPath: ledger,
    config: { allowedChats: [COMMON], ownerChatId: COMMON, polling: false },
    hostCommands: {
      status: vi.fn(),
      startOver: vi.fn(),
      stopTurn: vi.fn(),
      update: vi.fn(),
    } as never,
    accountReplies,
  });
  await active.start();
  return { gateway: active, accepted, person, ledger };
}

let nextId = 77;
/** A message; `replyFrom` is who wrote the message it replies to (101 is this bot). */
function message(text: string, chatId = PERSON, replyFrom: number | null = 101, caption = false) {
  return seams.handlers.get('message')!({
    message: {
      message_id: nextId++,
      date: 1,
      ...(caption ? { caption: text, photo: [] } : { text }),
      from: { id: PERSON, is_bot: false },
      chat: { id: chatId, type: chatId < 0 ? 'supergroup' : 'private' },
      ...(replyFrom === null
        ? {}
        : {
            reply_to_message: {
              message_id: 401,
              date: 1,
              text: 'Reply to this message with your Chatwork API token',
              from: { id: replyFrom, is_bot: true },
              chat: { id: chatId, type: 'private' },
            },
          }),
    },
  });
}

describe('Telegram account connect (approvals.md, P2)', () => {
  it('hands the awaited token to the host before anything records it', async () => {
    const completion = vi.fn(async () => {});
    const claim = vi.fn(() => completion);
    const { gateway: active, accepted, person, ledger } = await gateway({ claim });
    await message('fixture-secret-token');
    await active.drain();
    expect(claim).toHaveBeenCalledWith({
      chatId: String(PERSON),
      principalId: person,
      messageId: 77,
      text: 'fixture-secret-token',
      replyTo: { messageId: 401, text: 'Reply to this message with your Chatwork API token' },
    });
    expect(completion).toHaveBeenCalledTimes(1);
    expect(accepted).toEqual([]);
    expect(existsSync(ledger) ? readFileSync(ledger, 'utf8') : '').not.toContain(
      'fixture-secret-token'
    );
  });

  it('lets every other message through as usual', async () => {
    const claim = vi.fn(() => null);
    const { gateway: active, accepted } = await gateway({ claim });
    await message('hello');
    await active.drain();
    expect(accepted).toHaveLength(1);
  });

  it('asks only about replies to this bot, and passes a caption as the text', async () => {
    const claim = vi.fn(() => async () => {});
    const { gateway: active, accepted } = await gateway({ claim });
    await message('not a reply', PERSON, null);
    await message('a reply to someone else', PERSON, 999);
    await active.drain();
    expect(claim).not.toHaveBeenCalled();
    expect(accepted).toHaveLength(2);
    await message('fixture-caption-token', PERSON, 101, true);
    await active.drain();
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ text: 'fixture-caption-token' }));
    expect(accepted).toHaveLength(2);
  });

  it('never claims a group message', async () => {
    const claim = vi.fn(() => async () => {});
    const { gateway: active } = await gateway({ claim });
    await message('fixture-secret-token', Number(COMMON));
    await active.drain();
    expect(claim).not.toHaveBeenCalled();
  });

  it('sends the prompt as a forced reply and deletes a message', async () => {
    const { gateway: active } = await gateway({ claim: () => null });
    expect(await active.sendAccountPrompt(String(PERSON), 'Reply with your token')).toBe(401);
    expect(seams.api.sendMessage).toHaveBeenCalledWith(PERSON, 'Reply with your token', {
      reply_markup: { force_reply: true, input_field_placeholder: 'token' },
    });
    await active.deleteChatMessage(String(PERSON), 77);
    expect(seams.api.deleteMessage).toHaveBeenCalledWith(PERSON, 77);
  });
});
