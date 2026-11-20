/**
 * Kind adapters for personal sources (personal-connectors.md, C7). Each says whose credential it
 * is, what that credential can read, and how the kind's existing connector class is configured to
 * collect the channels a person bound, on that person's credential (ConnectorConfig.secrets: the
 * environment is never read). Errors name the service's status, never a secret: a Trello key and
 * token and an iCal address are secrets.
 */
import { createHash } from 'node:crypto';
import type { WebClient } from '@slack/web-api';

import type { ConnectorConfig, IConnector } from '../framework/types.js';
import type { PersonalChannel, PersonalSourceKind } from '../../runtime/personal-source-store.js';
import type { TimeZoneSetting } from '../../runtime/timezone.js';

export type Secrets = Readonly<Record<string, string>>;

export interface PersonalKindAdapter {
  kind: PersonalSourceKind;
  identify(secrets: Secrets): Promise<{ id: string; name: string; bot?: boolean }>;
  /** What the credential can read: the channels a person may bind. */
  channels(secrets: Secrets): Promise<PersonalChannel[]>;
  /** The kind's connector configuration for the bound channels, on the person's credential. */
  config(secrets: Secrets, channels: PersonalChannel[]): ConnectorConfig;
  build(config: ConnectorConfig, statePath: string): Promise<IConnector>;
}

export interface PersonalKindDeps {
  fetch?: typeof fetch;
  slackClient?: (token: string) => WebClient | Promise<WebClient>;
  timeZone: TimeZoneSetting;
  /**
   * MAMA's own Telegram bots (the messenger and the install's source), by bot id: a second
   * getUpdates poller on one of them takes its updates (#final review I5).
   */
  reservedTelegramBots?: () => readonly string[];
}

/**
 * The kinds as the daemon reaches them: built after the owner runtime, used by the connect flow
 * and the actions only once they exist.
 */
export function personalKindRouter(
  get: () => Record<PersonalSourceKind, PersonalKindAdapter> | undefined
) {
  const adapters = () => {
    const found = get();
    if (!found) throw new Error('Personal sources are not running yet; try again in a minute.');
    return found;
  };
  return {
    identify: async (kind: PersonalSourceKind, secrets: Secrets) =>
      adapters()[kind].identify(secrets),
    channels: async (kind: PersonalSourceKind, secrets: Secrets) =>
      adapters()[kind].channels(secrets),
  };
}

const TIMEOUT_MS = 30_000;

function config(
  minutes: number,
  tokenName: string | undefined,
  channels: ConnectorConfig['channels'],
  secrets: Record<string, string>
): ConnectorConfig {
  return {
    enabled: true,
    pollIntervalMinutes: minutes,
    channels,
    auth: { type: 'token', ...(tokenName === undefined ? {} : { tokenName }) },
    secrets,
  };
}

const hubs = (channels: PersonalChannel[], extra: (id: string) => object = () => ({})) =>
  Object.fromEntries(
    channels.map((channel) => [
      channel.id,
      {
        role: 'hub' as const,
        ...(channel.name === null ? {} : { name: channel.name }),
        ...extra(channel.id),
      },
    ])
  );

export function createPersonalKinds(
  deps: PersonalKindDeps
): Record<PersonalSourceKind, PersonalKindAdapter> {
  const http = deps.fetch ?? fetch;
  const call = async (service: string, url: string, init: RequestInit = {}): Promise<Response> => {
    let res: Response;
    try {
      res = await http(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      // A fetch error can repeat the address, and an address can be the secret (iCal, Trello).
      throw new Error(
        `${service} could not be reached (${error instanceof Error ? error.name : 'error'})`
      );
    }
    if (!res.ok) throw new Error(`${service} answered ${res.status}`);
    return res;
  };
  const json = async <T>(service: string, url: string, init?: RequestInit) =>
    (await (await call(service, url, init)).json()) as T;
  const slack = async (token: string): Promise<WebClient> => {
    if (deps.slackClient) return deps.slackClient(token);
    const { WebClient } = await import('@slack/web-api');
    return new WebClient(token, { retryConfig: { retries: 0 }, timeout: TIMEOUT_MS });
  };
  const discord = (token: string) => ({ headers: { Authorization: `Bot ${token}` } });
  const notion = (token: string) => ({
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' },
  });
  const trello = (path: string, s: Secrets, query = '') =>
    `https://api.trello.com/1/${path}?key=${encodeURIComponent(s.key!)}&token=${encodeURIComponent(s.token!)}${query}`;
  const telegram = (s: Secrets, method: string) =>
    `https://api.telegram.org/bot${s.token}/${method}`;

  return {
    chatwork: {
      kind: 'chatwork',
      async identify(s) {
        const me = await json<{ account_id: number; name: string }>(
          'Chatwork',
          'https://api.chatwork.com/v2/me',
          { headers: { 'X-ChatWorkToken': s.token! } }
        );
        return { id: String(me.account_id), name: me.name };
      },
      async channels(s) {
        const rooms = await json<Array<{ room_id: number; name: string }>>(
          'Chatwork',
          'https://api.chatwork.com/v2/rooms',
          { headers: { 'X-ChatWorkToken': s.token! } }
        );
        return rooms.map((room) => ({ id: String(room.room_id), name: room.name }));
      },
      config: (s, channels) =>
        config(5, 'MAMA_CHATWORK_TOKEN', hubs(channels), { MAMA_CHATWORK_TOKEN: s.token! }),
      build: async (c) =>
        new (await import('../chatwork/index.js')).ChatworkConnector(c, { fetch: http }),
    },
    slack: {
      kind: 'slack',
      async identify(s) {
        const me = await (await slack(s.token!)).auth.test();
        return {
          id: String(me.user_id ?? ''),
          name: String(me.user ?? ''),
          bot: me.bot_id !== undefined,
        };
      },
      async channels(s) {
        const client = await slack(s.token!);
        const found: PersonalChannel[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.users.conversations({
            types: 'public_channel,private_channel,im,mpim',
            exclude_archived: true,
            limit: 200,
            ...(cursor ? { cursor } : {}),
          });
          for (const channel of page.channels ?? [])
            found.push({
              id: String(channel.id),
              name: channel.is_im ? `DM ${String(channel.user)}` : (channel.name ?? null),
            });
          cursor = page.response_metadata?.next_cursor || undefined;
        } while (cursor);
        return found;
      },
      config: (s, channels) =>
        config(5, 'MAMA_SLACK_TOKEN', hubs(channels), { MAMA_SLACK_TOKEN: s.token! }),
      // The client is resolved first: the connector takes a client, not a promise of one.
      build: async (c) => {
        const { SlackConnector } = await import('../slack/index.js');
        return deps.slackClient
          ? new SlackConnector(c, {
              client: await deps.slackClient(c.secrets!.MAMA_SLACK_TOKEN!),
              fetch: http,
            })
          : new SlackConnector(c, { fetch: http });
      },
    },
    discord: {
      kind: 'discord',
      async identify(s) {
        const me = await json<{ id: string; username: string; bot?: boolean }>(
          'Discord',
          'https://discord.com/api/v10/users/@me',
          discord(s.token!)
        );
        return { id: me.id, name: me.username, bot: me.bot === true };
      },
      async channels(s) {
        const guilds = await json<Array<{ id: string; name: string }>>(
          'Discord',
          'https://discord.com/api/v10/users/@me/guilds',
          discord(s.token!)
        );
        const found: PersonalChannel[] = [];
        for (const guild of guilds) {
          const channels = await json<Array<{ id: string; name: string; type: number }>>(
            'Discord',
            `https://discord.com/api/v10/guilds/${guild.id}/channels`,
            discord(s.token!)
          );
          // Text and announcement channels; voice, categories and forums hold no messages to poll.
          for (const channel of channels)
            if (channel.type === 0 || channel.type === 5)
              found.push({ id: channel.id, name: `${guild.name} #${channel.name}` });
        }
        return found;
      },
      config: (s, channels) =>
        config(5, 'MAMA_DISCORD_TOKEN', hubs(channels), { MAMA_DISCORD_TOKEN: s.token! }),
      build: async (c, statePath) =>
        new (await import('../discord/index.js')).DiscordConnector(c, statePath),
    },
    notion: {
      kind: 'notion',
      async identify(s) {
        const me = await json<{ id: string; name?: string; type: string }>(
          'Notion',
          'https://api.notion.com/v1/users/me',
          notion(s.token!)
        );
        return { id: me.id, name: me.name ?? 'integration', bot: me.type === 'bot' };
      },
      // The integration reads every page shared with it: one workspace channel.
      async channels(s) {
        const me = await json<{ bot?: { workspace_name?: string } }>(
          'Notion',
          'https://api.notion.com/v1/users/me',
          notion(s.token!)
        );
        return [{ id: 'workspace', name: me.bot?.workspace_name ?? null }];
      },
      config: (s, channels) =>
        config(15, 'MAMA_NOTION_TOKEN', hubs(channels), { MAMA_NOTION_TOKEN: s.token! }),
      build: async (c) => new (await import('../notion/index.js')).NotionConnector(c),
    },
    trello: {
      kind: 'trello',
      async identify(s) {
        const me = await json<{ id: string; username: string }>('Trello', trello('members/me', s));
        return { id: me.id, name: me.username };
      },
      async channels(s) {
        const boards = await json<Array<{ id: string; name: string }>>(
          'Trello',
          trello('members/me/boards', s, '&filter=open&fields=name')
        );
        return boards.map((board) => ({ id: board.id, name: board.name }));
      },
      config: (s, channels) =>
        config(
          5,
          'MAMA_TRELLO_TOKEN',
          hubs(channels, (id) => ({ boardId: id })),
          { MAMA_TRELLO_KEY: s.key!, MAMA_TRELLO_TOKEN: s.token! }
        ),
      build: async (c) => new (await import('../trello/index.js')).TrelloConnector(c, http),
    },
    telegram: {
      kind: 'telegram',
      async identify(s) {
        const me = await json<{ result: { id: number; username?: string; is_bot: boolean } }>(
          'Telegram',
          telegram(s, 'getMe')
        );
        if ((deps.reservedTelegramBots?.() ?? []).includes(String(me.result.id)))
          throw new Error(
            "That is MAMA's own bot: create a bot of your own with BotFather for your source"
          );
        return {
          id: String(me.result.id),
          name: me.result.username ?? String(me.result.id),
          bot: me.result.is_bot,
        };
      },
      // A bot sees only chats it was added to, through its updates.
      async channels(s) {
        const updates = await json<{
          result: Array<{ message?: { chat: { id: number; title?: string; username?: string } } }>;
        }>('Telegram', telegram(s, 'getUpdates'));
        const chats = new Map<string, string | null>();
        for (const update of updates.result) {
          const chat = update.message?.chat;
          if (chat) chats.set(String(chat.id), chat.title ?? chat.username ?? null);
        }
        return [...chats].map(([id, name]) => ({ id, name }));
      },
      config: (s, channels) =>
        config(5, 'MAMA_TELEGRAM_SOURCE_TOKEN', hubs(channels), {
          MAMA_TELEGRAM_SOURCE_TOKEN: s.token!,
        }),
      build: async (c, statePath) =>
        new (await import('../telegram/index.js')).TelegramConnector(c, statePath),
    },
    ical: {
      kind: 'ical',
      async identify(s) {
        const body = await (await call('iCal', s.token!)).text();
        if (!body.includes('BEGIN:VCALENDAR'))
          throw new Error('iCal address did not return a calendar');
        const name = /^X-WR-CALNAME:(.+)$/m.exec(body)?.[1]?.trim() ?? 'calendar';
        // The address is the secret: the id is a hash of it.
        return { id: createHash('sha256').update(s.token!).digest('hex').slice(0, 12), name };
      },
      async channels(s) {
        return [{ id: 'calendar', name: (await this.identify(s)).name }];
      },
      config: (s, channels) =>
        config(30, undefined, hubs(channels), { MAMA_ICAL_URL_CALENDAR: s.token! }),
      build: async (c, statePath) =>
        new (await import('../ical/index.js')).ICalConnector(c, statePath, deps.timeZone),
    },
  };
}
