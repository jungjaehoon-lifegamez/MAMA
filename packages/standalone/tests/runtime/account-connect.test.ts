import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createAccountStore, type AccountStore } from '../../src/runtime/account-store.js';
import {
  ACCOUNT_PROMPT_PREFIX,
  CONNECT_WINDOW_MS,
  createAccountConnect,
} from '../../src/runtime/account-connect.js';

let root: string;
let accounts: AccountStore;
let clock: number;
let said: Array<[string, string]>;
let deleted: Array<[string, number]>;
let prompts: Array<[string, string]>;
let logged: string[];
let promptId: number;
let allowed: boolean;
const identify = vi.fn();

function connect() {
  return createAccountConnect({
    accounts,
    identify,
    dmChatOf: (principalId) => `dm-${principalId}`,
    prompt: async (chatId, text) => {
      prompts.push([chatId, text]);
      return promptId++;
    },
    deleteMessage: async (chatId, messageId) => {
      deleted.push([chatId, messageId]);
    },
    say: async (chatId, text) => {
      said.push([chatId, text]);
    },
    log: (line) => logged.push(line),
    mayConnect: () => allowed,
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
  promptId = 500;
  allowed = true;
  identify.mockReset();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A reply to prompt `to` (500 is the first prompt); `to: null` is a plain message. */
const reply = (
  principalId: string,
  text: string | undefined,
  chatId = `dm-${principalId}`,
  to: number | null = 500
) => ({
  chatId,
  principalId,
  messageId: 601,
  text,
  ...(to === null
    ? {}
    : { replyTo: { messageId: to, text: `${ACCOUNT_PROMPT_PREFIX}Chatwork API token…` } }),
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

  it('takes the reply to the prompt as the token: stored, deleted, never a turn', async () => {
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
    expect(deleted).toEqual([['dm-person-a', 601]]);
    expect(said).toEqual([
      ['dm-person-a', expect.stringMatching(/Connected Chatwork as person-a \(8\)/)],
    ]);
    // The token is in no line the host writes.
    expect(JSON.stringify([said, prompts, logged])).not.toContain('fixture-person-token');
  });

  it('leaves every message that is not a reply to an account prompt alone', async () => {
    const flow = connect();
    await flow.ask('person-a', 'chatwork');
    expect(flow.claim(reply('person-a', 'where do I find it?', undefined, null))).toBeNull();
    expect(
      flow.claim({
        ...reply('person-a', 'quoting', undefined, null),
        replyTo: { messageId: 500, text: 'some other bot message' },
      })
    ).toBeNull();
    // The prompt still waits for its reply.
    identify.mockResolvedValue({ id: '8', name: 'person-a' });
    await flow.claim(reply('person-a', 'token'))!();
    expect(accounts.get('person-a', 'chatwork')).not.toBeNull();
  });

  it('a late, repeated or unknown reply is deleted and never passed on (#589 review)', async () => {
    const flow = connect();
    await flow.ask('person-a', 'chatwork');
    clock += CONNECT_WINDOW_MS + 1;
    const late = flow.claim(reply('person-a', 'fixture-late-token'));
    expect(late).not.toBeNull();
    await late!();
    // After a restart nothing waits, and a reply to the old prompt is still the host's.
    const restarted = connect();
    await restarted.claim(reply('person-a', 'fixture-late-token'))!();
    expect(identify).not.toHaveBeenCalled();
    expect(accounts.get('person-a', 'chatwork')).toBeNull();
    expect(deleted).toEqual([
      ['dm-person-a', 601],
      ['dm-person-a', 601],
    ]);
    expect(said.map(([, text]) => text)).toEqual([
      expect.stringMatching(/no longer waiting.*ask again/),
      expect.stringMatching(/no longer waiting.*ask again/),
    ]);
    expect(JSON.stringify([said, logged])).not.toContain('fixture-late-token');
  });

  it('a reply with no text (a photo) is deleted, not passed on', async () => {
    const flow = connect();
    await flow.ask('person-a', 'chatwork');
    await flow.claim(reply('person-a', undefined))!();
    expect(identify).not.toHaveBeenCalled();
    expect(deleted).toHaveLength(1);
  });

  it('each prompt keeps its own service: two asks never cross', async () => {
    identify.mockResolvedValue({ id: 'x', name: 'person-a' });
    const flow = connect();
    await flow.ask('person-a', 'chatwork');
    await flow.ask('person-a', 'slack');
    await flow.claim(reply('person-a', 'chatwork-token', undefined, 500))!();
    expect(identify).toHaveBeenLastCalledWith('chatwork', 'chatwork-token');
    await flow.claim(reply('person-a', 'xoxp-token', undefined, 501))!();
    expect(identify).toHaveBeenLastCalledWith('slack', 'xoxp-token');
  });

  it('keeps nothing for someone offboarded while the service answered', async () => {
    identify.mockResolvedValue({ id: '8', name: 'person-a' });
    allowed = false;
    const flow = connect();
    await flow.ask('person-a', 'chatwork');
    await flow.claim(reply('person-a', 'token'))!();
    expect(accounts.get('person-a', 'chatwork')).toBeNull();
  });

  it('takes nothing for another person', async () => {
    const flow = connect();
    await flow.ask('person-a', 'chatwork');
    await flow.claim(reply('person-b', 'token', 'dm-person-a'))!();
    expect(identify).not.toHaveBeenCalled();
    expect(accounts.get('person-b', 'chatwork')).toBeNull();
  });

  it('saves nothing when the service refuses the token, and says so', async () => {
    identify.mockRejectedValue(new Error('Chatwork /me answered 401'));
    const flow = connect();
    await flow.ask('person-a', 'chatwork');
    await flow.claim(reply('person-a', 'fixture-bad-token'))!();
    expect(accounts.get('person-a', 'chatwork')).toBeNull();
    expect(deleted).toEqual([['dm-person-a', 601]]);
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
      mayConnect: () => true,
      now: () => clock,
    });
    await flow.ask('person-a', 'chatwork');
    await flow.claim(reply('person-a', 'token'))!();
    expect(accounts.get('person-a', 'chatwork')).not.toBeNull();
    expect(said[0]![1]).toMatch(/could not delete your message: delete it yourself/);
  });
});
