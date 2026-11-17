import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrincipalRepository } from '@jungjaehoon/mama-core';

const seams = vi.hoisted(() => ({
  api: {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 301 }),
    setMyCommands: vi.fn().mockResolvedValue(true),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    editMessageText: vi.fn().mockResolvedValue(true),
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

afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
  seams.handlers.clear();
  for (const fn of Object.values(seams.api)) fn.mockClear();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function gateway(approvals?: ConstructorParameters<typeof TelegramGateway>[0]['approvals']) {
  const root = mkdtempSync(join(tmpdir(), 'mama-telegram-approvals-'));
  roots.push(root);
  vi.stubEnv('HOME', root);
  const database = await openCoreDatabase({ path: join(root, 'principals.db') });
  databases.push(database);
  const registry = createPrincipalRepository(database.adapter);
  const owner = registry.registerMember({
    connector: 'telegram',
    namespace: 'private',
    externalId: '7101',
    now: 1,
  });
  registry.grantRole({ principalId: owner, role: 'owner', now: 2 });
  const accepted: unknown[] = [];
  const intake: TurnIntake = {
    recordOwnerReply: () => {},
    acceptOwnerMessage: (input) => {
      accepted.push(input);
      return { inputId: 'input-1', state: 'accepted' };
    },
  };
  const active = new TelegramGateway({
    token: 'fixture-token',
    intake,
    registry,
    memberIntake: () => intake,
    principalPaths: () => ({ downloadsDir: join(root, 'downloads') }),
    messageLedgerPath: join(root, 'ledger.json'),
    config: { allowedChats: [COMMON], ownerChatId: COMMON, polling: false },
    hostCommands: {
      status: vi.fn(),
      startOver: vi.fn(),
      stopTurn: vi.fn(),
      update: vi.fn(),
    } as never,
    ...(approvals === undefined ? {} : { approvals }),
  });
  await active.start();
  return { gateway: active, accepted };
}

function press(chatId: number, data = 'apv:a:p1:nonce', userId = 7101) {
  return seams.handlers.get('callback_query:data')!({
    callbackQuery: {
      id: 'query-1',
      data,
      from: { id: userId, is_bot: false },
      message: {
        message_id: 55,
        chat: { id: chatId, type: chatId < 0 ? 'supergroup' : 'private' },
      },
    },
  });
}

describe('Telegram approval cards', () => {
  it('sends a card with two buttons and returns its message id', async () => {
    const { gateway: active } = await gateway();
    const id = await active.sendApprovalCard(COMMON, '<b>card</b>', {
      approve: 'apv:a:p1:n',
      reject: 'apv:r:p1:n',
    });
    expect(id).toBe(301);
    expect(seams.api.sendMessage).toHaveBeenCalledWith(Number(COMMON), '<b>card</b>', {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Approve', callback_data: 'apv:a:p1:n' },
            { text: 'Reject', callback_data: 'apv:r:p1:n' },
          ],
        ],
      },
    });
  });

  it('hands a press to the approvals port and never to a turn', async () => {
    const approvals = { press: vi.fn(async () => ({ answer: 'Approved' })) };
    const { accepted } = await gateway(approvals);
    await press(Number(COMMON));
    expect(approvals.press).toHaveBeenCalledWith({
      data: 'apv:a:p1:nonce',
      chatId: COMMON,
      userId: '7101',
      messageId: 55,
    });
    expect(accepted).toEqual([]);
    expect(seams.api.answerCallbackQuery).toHaveBeenCalledWith('query-1', { text: 'Approved' });
    expect(seams.api.editMessageText).not.toHaveBeenCalled();
  });

  it('edits the card and removes the keyboard when the port returns a card', async () => {
    const approvals = { press: vi.fn(async () => ({ answer: 'Done', card: '<b>done</b>' })) };
    await gateway(approvals);
    await press(Number(COMMON));
    expect(seams.api.editMessageText).toHaveBeenCalledWith(Number(COMMON), 55, '<b>done</b>', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] },
    });
  });

  it('answers a press in a chat that is not allowed without calling the port', async () => {
    const approvals = { press: vi.fn(async () => ({ answer: 'x' })) };
    await gateway(approvals);
    await press(-9999);
    expect(approvals.press).not.toHaveBeenCalled();
    expect(seams.api.answerCallbackQuery).toHaveBeenCalledWith('query-1', {
      text: 'This chat cannot decide approvals.',
    });
  });

  it('answers a press when no approvals port is configured', async () => {
    await gateway();
    await press(Number(COMMON));
    expect(seams.api.answerCallbackQuery).toHaveBeenCalledWith('query-1', {
      text: 'Approvals are not available.',
    });
  });
});
