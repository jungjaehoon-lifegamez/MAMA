import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createAccountStore, type AccountStore } from '../../src/runtime/account-store.js';
import { CONNECT_WINDOW_MS, createAccountConnect } from '../../src/runtime/account-connect.js';

let root: string;
let accounts: AccountStore;
let clock: number;
let said: Array<[string, string]>;
let deleted: Array<[string, number]>;
let prompts: Array<[string, string]>;
let logged: string[];
const identify = vi.fn();

function connect() {
  return createAccountConnect({
    accounts,
    identify,
    dmChatOf: (principalId) => `dm-${principalId}`,
    prompt: async (chatId, text) => {
      prompts.push([chatId, text]);
      return 500;
    },
    deleteMessage: async (chatId, messageId) => {
      deleted.push([chatId, messageId]);
    },
    say: async (chatId, text) => {
      said.push([chatId, text]);
    },
    log: (line) => logged.push(line),
    now: () => clock,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mama-connect-'));
  accounts = createAccountStore(root);
  clock = 1_000;
  said = [];
  deleted = [];
  prompts = [];
  logged = [];
  identify.mockReset();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const reply = (principalId: string, text: string, chatId = `dm-${principalId}`) => ({
  chatId,
  principalId,
  messageId: 501,
  text,
});

describe('connecting a person’s account in their Telegram DM (approvals.md, P2)', () => {
  it('asks in that person’s DM only, as a reply prompt', async () => {
    const flow = connect();
    await flow.ask('person-a', 'chatwork');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]![0]).toBe('dm-person-a');
    expect(prompts[0]![1]).toMatch(
      /Reply to this message.*Chatwork API token.*15 minutes.*never reaches the agent/s
    );
  });

  it('takes the next message in that DM as the token: stored, deleted, never a turn', async () => {
    identify.mockResolvedValue({ id: '8', name: 'person-a' });
    const flow = connect();
    await flow.ask('person-a', 'chatwork');
    const completion = flow.claim(reply('person-a', '  fixture-person-token \n'));
    expect(completion).not.toBeNull();
    await completion!();
    expect(identify).toHaveBeenCalledWith('chatwork', 'fixture-person-token');
    expect(accounts.get('person-a', 'chatwork')).toMatchObject({
      token: 'fixture-person-token',
      accountId: '8',
      name: 'person-a',
    });
    expect(deleted).toEqual([['dm-person-a', 501]]);
    expect(said).toEqual([
      ['dm-person-a', expect.stringMatching(/Connected Chatwork as person-a \(8\)/)],
    ]);
    // The token is in no line the host writes.
    expect(JSON.stringify([said, prompts, logged])).not.toContain('fixture-person-token');
  });

  it('works once: a second message goes to the turn as usual', async () => {
    identify.mockResolvedValue({ id: '8', name: 'person-a' });
    const flow = connect();
    await flow.ask('person-a', 'chatwork');
    await flow.claim(reply('person-a', 'token'))!();
    expect(flow.claim(reply('person-a', 'hello again'))).toBeNull();
  });

  it('takes nothing from another person or another chat', async () => {
    const flow = connect();
    await flow.ask('person-a', 'chatwork');
    expect(flow.claim(reply('person-b', 'token', 'dm-person-a'))).toBeNull();
    expect(flow.claim(reply('person-a', 'token', 'group-chat'))).toBeNull();
    expect(flow.claim(reply('person-b', 'token'))).toBeNull();
  });

  it('takes nothing after the window: the prompt has expired', async () => {
    const flow = connect();
    await flow.ask('person-a', 'chatwork');
    clock += CONNECT_WINDOW_MS + 1;
    expect(flow.claim(reply('person-a', 'late'))).toBeNull();
  });

  it('saves nothing when the service refuses the token, and says so', async () => {
    identify.mockRejectedValue(new Error('Chatwork /me answered 401'));
    const flow = connect();
    await flow.ask('person-a', 'chatwork');
    await flow.claim(reply('person-a', 'fixture-bad-token'))!();
    expect(accounts.get('person-a', 'chatwork')).toBeNull();
    expect(deleted).toEqual([['dm-person-a', 501]]);
    expect(said[0]![1]).toMatch(/did not work.*401.*Nothing was saved/);
    expect(JSON.stringify([said, logged])).not.toContain('fixture-bad-token');
  });

  it('refuses a Slack bot token: a DM posts as the person', async () => {
    identify.mockResolvedValue({ id: 'B1', name: 'some-bot', bot: true });
    const flow = connect();
    await flow.ask('person-a', 'slack');
    await flow.claim(reply('person-a', 'xoxb-fixture'))!();
    expect(accounts.get('person-a', 'slack')).toBeNull();
    expect(said[0]![1]).toMatch(/bot token.*your own user token/);
  });

  it('still saves and answers when the message cannot be deleted', async () => {
    identify.mockResolvedValue({ id: '8', name: 'person-a' });
    const flow = createAccountConnect({
      accounts,
      identify,
      dmChatOf: (principalId) => `dm-${principalId}`,
      prompt: async () => 500,
      deleteMessage: async () => {
        throw new Error('message can not be deleted');
      },
      say: async (chatId, text) => {
        said.push([chatId, text]);
      },
      log: (line) => logged.push(line),
      now: () => clock,
    });
    await flow.ask('person-a', 'chatwork');
    await flow.claim(reply('person-a', 'token'))!();
    expect(accounts.get('person-a', 'chatwork')).not.toBeNull();
    expect(said[0]![1]).toMatch(/could not delete your message: delete it yourself/);
  });
});
