import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { createCatalog, createDispatcher, type ActionContext } from '@jungjaehoon/mama-core';

import {
  messageSendActionRegistrations,
  messageSendCards,
} from '../../src/api/message-send-actions.js';
import { ChatworkConnector } from '../../src/connectors/chatwork/index.js';
import { SlackConnector } from '../../src/connectors/slack/index.js';
import type { ConnectorRegistry } from '../../src/connectors/framework/connector-registry.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

const chatworkConfig: ConnectorConfig = {
  enabled: true,
  pollIntervalMinutes: 5,
  channels: { '111': { role: 'hub', name: 'room-one' } },
  auth: { type: 'token', tokenName: 'MAMA_CHATWORK_TOKEN' },
};
const slackConfig: ConnectorConfig = {
  enabled: true,
  pollIntervalMinutes: 5,
  channels: { C1: { role: 'hub', name: 'channel-one' }, C2: { role: 'ignore', name: 'muted' } },
  auth: { type: 'token', tokenName: 'MAMA_SLACK_TOKEN' },
};

const access: ActionContext['access'] = {
  principalId: 'owner',
  agentId: 'agent',
  actions: ['chatwork.message.send', 'slack.message.send'],
  connectors: ['chatwork', 'slack'],
  scopes: [],
};
const approved: ActionContext['session'] = { approvedProposalId: 'proposal-1' };

let http: ReturnType<typeof vi.fn>;
let postMessage: ReturnType<typeof vi.fn>;
let authTest: ReturnType<typeof vi.fn>;
let registry: ConnectorRegistry;

const ports = () => ({ connectors: () => registry });

function dispatch(
  action: string,
  input: Record<string, unknown>,
  session?: ActionContext['session']
) {
  return createDispatcher(createCatalog(messageSendActionRegistrations(ports())))(
    { action, input, operationId: 'proposal-1' },
    { access, ...(session === undefined ? {} : { session }) }
  );
}

describe('chatwork.message.send and slack.message.send (approvals.md, S1, S2)', () => {
  beforeEach(async () => {
    process.env.MAMA_CHATWORK_TOKEN = 'fixture-chatwork-token';
    process.env.MAMA_SLACK_TOKEN = 'fixture-slack-token';
    http = vi.fn(async (url: string) =>
      String(url).endsWith('/me')
        ? { ok: true, status: 200, json: async () => ({ account_id: 7, name: 'account-a' }) }
        : { ok: true, status: 200, json: async () => ({ message_id: '9001' }) }
    );
    postMessage = vi.fn().mockResolvedValue({ ok: true, channel: 'C1', ts: '1700000000.000100' });
    authTest = vi
      .fn()
      .mockResolvedValue({ ok: true, user: 'mama-bot', user_id: 'U1', bot_id: 'B1' });
    const chatwork = new ChatworkConnector(chatworkConfig, {
      fetch: http as unknown as typeof fetch,
    });
    const slack = new SlackConnector(slackConfig, {
      client: { chat: { postMessage }, auth: { test: authTest } } as unknown as WebClient,
    });
    await chatwork.init();
    await slack.init();
    registry = {
      get: (name: string) => ({ chatwork, slack })[name as 'chatwork' | 'slack'],
    } as unknown as ConnectorRegistry;
  });
  afterEach(() => {
    delete process.env.MAMA_CHATWORK_TOKEN;
    delete process.env.MAMA_SLACK_TOKEN;
  });

  it('refuses a direct call: a send runs only from an approved proposal', async () => {
    const chatwork = await dispatch('chatwork.message.send', { roomId: '111', body: 'hi' });
    const slack = await dispatch('slack.message.send', { channel: 'C1', text: 'hi' });
    for (const result of [chatwork, slack])
      expect(result).toMatchObject({
        status: 'failed',
        error: { kind: 'denied', code: 'approval_required' },
      });
    expect(http).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('posts exactly once to Chatwork when approved', async () => {
    const result = await dispatch(
      'chatwork.message.send',
      { roomId: '111', body: 'hello' },
      approved
    );
    expect(result).toMatchObject({
      status: 'completed',
      data: { roomId: '111', room: 'room-one', messageId: '9001' },
    });
    expect(http).toHaveBeenCalledTimes(1);
    expect(http.mock.calls[0]?.[0]).toBe('https://api.chatwork.com/v2/rooms/111/messages');
  });

  it('posts exactly once to Slack when approved, in the thread given', async () => {
    const result = await dispatch(
      'slack.message.send',
      { channel: 'C1', text: 'hello', threadTs: '1690000000.000200' },
      approved
    );
    expect(result).toMatchObject({
      status: 'completed',
      data: { channel: 'C1', name: 'channel-one', ts: '1700000000.000100' },
    });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({
      channel: 'C1',
      text: 'hello',
      thread_ts: '1690000000.000200',
    });
  });

  it('never posts to a room or channel the source does not read', async () => {
    const room = await dispatch('chatwork.message.send', { roomId: '999', body: 'x' }, approved);
    const ignored = await dispatch('slack.message.send', { channel: 'C2', text: 'x' }, approved);
    expect(room).toMatchObject({
      error: { kind: 'invalid_input', code: 'chatwork_room_not_read' },
    });
    expect(room.error?.message).toMatch(
      /999 is not a room the Chatwork source reads.*111 \(room-one\)/
    );
    expect(ignored).toMatchObject({
      error: { kind: 'invalid_input', code: 'slack_channel_not_read' },
    });
    expect(ignored.error?.message).toMatch(/C2 is not a channel the Slack source reads/);
    expect(http).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('cards show the room by name, the account it posts as and the whole message', async () => {
    const cards = messageSendCards(ports());
    const chatworkInput = { roomId: '111', body: 'line one\nline two' };
    expect([
      ...cards['chatwork.message.send']!.render(chatworkInput),
      ...(await cards['chatwork.message.send']!.context!(chatworkInput)),
    ]).toEqual([
      'Action: post a message in Chatwork',
      'Message: line one\nline two',
      'Room: room-one (111)',
      'Posts as: account-a (Chatwork account 7)',
    ]);
    const slackInput = { channel: 'C1', text: 'hello', threadTs: '1690000000.000200' };
    expect([
      ...cards['slack.message.send']!.render(slackInput),
      ...(await cards['slack.message.send']!.context!(slackInput)),
    ]).toEqual([
      'Action: post a message in Slack',
      'In thread: 1690000000.000200',
      'Message: hello',
      'Channel: #channel-one (C1)',
      'Posts as: mama-bot (the bot)',
    ]);
  });

  it('a card for a room the source does not read is refused, so no proposal is stored', async () => {
    const cards = messageSendCards(ports());
    await expect(
      cards['chatwork.message.send']!.context!({ roomId: '999', body: 'x' })
    ).rejects.toThrow(/999 is not a room the Chatwork source reads/);
    await expect(
      cards['slack.message.send']!.context!({ channel: 'C2', text: 'x' })
    ).rejects.toThrow(/C2 is not a channel the Slack source reads/);
  });

  it('says the source is not running when its connector is off', async () => {
    registry = { get: () => undefined } as unknown as ConnectorRegistry;
    const result = await dispatch('chatwork.message.send', { roomId: '111', body: 'x' }, approved);
    expect(result.error?.message).toMatch(/The Chatwork source is not running/);
  });
});
