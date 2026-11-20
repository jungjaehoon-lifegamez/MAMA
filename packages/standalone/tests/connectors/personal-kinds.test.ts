import { describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';

import { createPersonalKinds } from '../../src/connectors/personal/kinds.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';

type Route = (url: URL, request: RequestInit) => unknown;
function fakeFetch(routes: Record<string, Route>) {
  return vi.fn(async (input: string | URL, request: RequestInit = {}) => {
    const url = new URL(String(input));
    const key = Object.keys(routes).find((prefix) =>
      `${url.origin}${url.pathname}`.startsWith(prefix)
    );
    if (!key) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    const body = routes[key]!(url, request);
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  });
}

const timeZone = createTimeZoneSetting('UTC');

describe('personal source kinds (personal-connectors.md, C7)', () => {
  it('chatwork: names the account, lists its rooms, builds a connector on the person’s token', async () => {
    const http = fakeFetch({
      'https://api.chatwork.com/v2/me': (_u, r) => {
        expect(r.headers).toMatchObject({ 'X-ChatWorkToken': 'p-token' });
        return { account_id: 7, name: 'person-a' };
      },
      'https://api.chatwork.com/v2/rooms': () => [{ room_id: 111, name: 'room-one' }],
    });
    const kinds = createPersonalKinds({ fetch: http as unknown as typeof fetch, timeZone });
    await expect(kinds.chatwork.identify({ token: 'p-token' })).resolves.toEqual({
      id: '7',
      name: 'person-a',
    });
    await expect(kinds.chatwork.channels({ token: 'p-token' })).resolves.toEqual([
      { id: '111', name: 'room-one' },
    ]);
    const config = kinds.chatwork.config({ token: 'p-token' }, [{ id: '111', name: 'room-one' }]);
    expect(config).toMatchObject({
      pollIntervalMinutes: 5,
      channels: { '111': { role: 'hub', name: 'room-one' } },
      secrets: { MAMA_CHATWORK_TOKEN: 'p-token' },
    });
  });

  it('slack: a person’s token, its channels and DMs', async () => {
    const conversations = vi.fn().mockResolvedValue({
      channels: [
        { id: 'C1', name: 'general' },
        { id: 'D1', is_im: true, user: 'U2' },
      ],
      response_metadata: { next_cursor: '' },
    });
    const client = {
      auth: { test: vi.fn().mockResolvedValue({ ok: true, user: 'person-a', user_id: 'U1' }) },
      users: { conversations },
    } as unknown as WebClient;
    const kinds = createPersonalKinds({ timeZone, slackClient: () => client });
    await expect(kinds.slack.identify({ token: 'xoxp-p' })).resolves.toEqual({
      id: 'U1',
      name: 'person-a',
      bot: false,
    });
    await expect(kinds.slack.channels({ token: 'xoxp-p' })).resolves.toEqual([
      { id: 'C1', name: 'general' },
      { id: 'D1', name: 'DM U2' },
    ]);
    expect(conversations).toHaveBeenCalledWith(
      expect.objectContaining({ types: 'public_channel,private_channel,im,mpim' })
    );
    expect(
      kinds.slack.config({ token: 'xoxp-p' }, [{ id: 'C1', name: 'general' }]).secrets
    ).toEqual({
      MAMA_SLACK_TOKEN: 'xoxp-p',
    });
  });

  it('discord: a bot, its servers’ text channels', async () => {
    const http = fakeFetch({
      'https://discord.com/api/v10/users/@me/guilds': () => [{ id: 'G1', name: 'server' }],
      'https://discord.com/api/v10/users/@me': (_u, r) => {
        expect(r.headers).toMatchObject({ Authorization: 'Bot d-token' });
        return { id: 'B1', username: 'my-bot', bot: true };
      },
      'https://discord.com/api/v10/guilds/G1/channels': () => [
        { id: 'X1', name: 'talk', type: 0 },
        { id: 'X2', name: 'voice', type: 2 },
      ],
    });
    const kinds = createPersonalKinds({ fetch: http as unknown as typeof fetch, timeZone });
    await expect(kinds.discord.identify({ token: 'd-token' })).resolves.toEqual({
      id: 'B1',
      name: 'my-bot',
      bot: true,
    });
    await expect(kinds.discord.channels({ token: 'd-token' })).resolves.toEqual([
      { id: 'X1', name: 'server #talk' },
    ]);
  });

  it('notion, trello, telegram, ical: identity and what can be read', async () => {
    const http = fakeFetch({
      'https://api.notion.com/v1/users/me': () => ({
        id: 'N1',
        name: 'integration',
        type: 'bot',
        bot: { workspace_name: 'my-space' },
      }),
      'https://api.trello.com/1/members/me/boards': (u) => {
        expect(u.searchParams.get('key')).toBe('t-key');
        return [{ id: 'B1', name: 'board' }];
      },
      'https://api.trello.com/1/members/me': () => ({ id: 'M1', username: 'person-a' }),
      'https://api.telegram.org/bott-token/getMe': () => ({
        ok: true,
        result: { id: 9, username: 'src_bot', is_bot: true },
      }),
      'https://api.telegram.org/bott-token/getUpdates': () => ({
        ok: true,
        result: [
          { message: { chat: { id: -100, title: 'group' } } },
          { message: { chat: { id: -100, title: 'group' } } },
        ],
      }),
      'https://calendar.example/secret.ics': () =>
        'BEGIN:VCALENDAR\r\nX-WR-CALNAME:Mine\r\nEND:VCALENDAR\r\n',
    });
    const kinds = createPersonalKinds({ fetch: http as unknown as typeof fetch, timeZone });
    await expect(kinds.notion.identify({ token: 'n' })).resolves.toEqual({
      id: 'N1',
      name: 'integration',
      bot: true,
    });
    await expect(kinds.notion.channels({ token: 'n' })).resolves.toEqual([
      { id: 'workspace', name: 'my-space' },
    ]);
    await expect(kinds.trello.identify({ key: 't-key', token: 't-token' })).resolves.toEqual({
      id: 'M1',
      name: 'person-a',
    });
    await expect(kinds.trello.channels({ key: 't-key', token: 't-token' })).resolves.toEqual([
      { id: 'B1', name: 'board' },
    ]);
    expect(
      kinds.trello.config({ key: 't-key', token: 't-token' }, [{ id: 'B1', name: 'board' }])
    ).toMatchObject({
      channels: { B1: { boardId: 'B1', name: 'board' } },
      secrets: { MAMA_TRELLO_KEY: 't-key', MAMA_TRELLO_TOKEN: 't-token' },
    });
    await expect(kinds.telegram.identify({ token: 't-token' })).resolves.toEqual({
      id: '9',
      name: 'src_bot',
      bot: true,
    });
    await expect(kinds.telegram.channels({ token: 't-token' })).resolves.toEqual([
      { id: '-100', name: 'group' },
    ]);
    const ical = { token: 'https://calendar.example/secret.ics' };
    const who = await kinds.ical.identify(ical);
    expect(who.name).toBe('Mine');
    expect(who.id).not.toContain('secret');
    expect(kinds.ical.config(ical, [{ id: 'calendar', name: 'Mine' }])).toMatchObject({
      pollIntervalMinutes: 30,
      secrets: { MAMA_ICAL_URL_CALENDAR: 'https://calendar.example/secret.ics' },
    });
  });

  it('a refused credential names the status, never the secret', async () => {
    const http = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => '',
    }));
    const kinds = createPersonalKinds({ fetch: http as unknown as typeof fetch, timeZone });
    for (const [kind, secrets] of [
      ['chatwork', { token: 'zz-secret' }],
      ['trello', { key: 'zz-secret', token: 'zz-secret' }],
      ['ical', { token: 'https://calendar.example/zz-secret.ics' }],
    ] as const) {
      const error = await kinds[kind].identify(secrets).catch((e: Error) => e);
      expect(String(error)).toMatch(/401/);
      expect(String(error)).not.toContain('zz-secret');
    }
  });
});
