import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WebClient } from '@slack/web-api';

import { connectorSecret } from '../../src/connectors/framework/types.js';
import { ChatworkConnector } from '../../src/connectors/chatwork/index.js';
import { SlackConnector } from '../../src/connectors/slack/index.js';
import { DiscordConnector } from '../../src/connectors/discord/index.js';
import { NotionConnector } from '../../src/connectors/notion/index.js';
import { TrelloConnector } from '../../src/connectors/trello/index.js';
import { TelegramConnector } from '../../src/connectors/telegram/index.js';
import { ICalConnector } from '../../src/connectors/ical/index.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

const INSTALL = 'install-secret';
const PERSON = 'person-secret';
const NAMES = [
  'MAMA_CHATWORK_TOKEN',
  'MAMA_SLACK_TOKEN',
  'MAMA_DISCORD_TOKEN',
  'MAMA_NOTION_TOKEN',
  'MAMA_TRELLO_KEY',
  'MAMA_TRELLO_TOKEN',
  'MAMA_TELEGRAM_SOURCE_TOKEN',
  'MAMA_ICAL_URL_CALENDAR',
];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mama-connector-secrets-'));
  for (const name of NAMES) process.env[name] = INSTALL;
});
afterEach(() => {
  for (const name of NAMES) delete process.env[name];
  rmSync(root, { recursive: true, force: true });
});

const config = (
  tokenName: string | undefined,
  secrets?: Record<string, string>
): ConnectorConfig => ({
  enabled: true,
  pollIntervalMinutes: 5,
  channels: { calendar: { role: 'hub' } },
  auth: { type: 'token', ...(tokenName === undefined ? {} : { tokenName }) },
  ...(secrets === undefined ? {} : { secrets }),
});

describe('connector secrets (personal-connectors.md, C7)', () => {
  it('reads only the given secrets when a config carries them, never the environment', () => {
    expect(
      connectorSecret(config(undefined, { MAMA_CHATWORK_TOKEN: PERSON }), 'MAMA_CHATWORK_TOKEN')
    ).toBe(PERSON);
    expect(connectorSecret(config(undefined, {}), 'MAMA_CHATWORK_TOKEN')).toBeUndefined();
    expect(connectorSecret(config(undefined), 'MAMA_CHATWORK_TOKEN')).toBe(INSTALL);
  });

  it('every collecting connector authenticates with the person’s secret', async () => {
    const seen: string[] = [];
    const http = vi.fn(async (url: string | URL, request?: RequestInit) => {
      seen.push(`${String(url)} ${JSON.stringify(request?.headers ?? {})}`);
      return { ok: true, status: 200, json: async () => [], text: async () => '' } as Response;
    });
    vi.stubGlobal('fetch', http);
    const chatwork = new ChatworkConnector(
      config('MAMA_CHATWORK_TOKEN', { MAMA_CHATWORK_TOKEN: PERSON }),
      { fetch: http as unknown as typeof fetch }
    );
    await chatwork.init();
    await chatwork.account().catch(() => {});
    const factory = vi.fn(() => ({ auth: { test: vi.fn() } }) as unknown as WebClient);
    const slack = new SlackConnector(config('MAMA_SLACK_TOKEN', { MAMA_SLACK_TOKEN: PERSON }), {
      clientFactory: factory,
    });
    await slack.init();
    expect(factory).toHaveBeenCalledWith(PERSON);
    for (const make of [
      () =>
        new DiscordConnector(
          config('MAMA_DISCORD_TOKEN', { MAMA_DISCORD_TOKEN: PERSON }),
          join(root, 'd.json')
        ),
      () => new NotionConnector(config('MAMA_NOTION_TOKEN', { MAMA_NOTION_TOKEN: PERSON })),
      () =>
        new TelegramConnector(
          config('MAMA_TELEGRAM_SOURCE_TOKEN', { MAMA_TELEGRAM_SOURCE_TOKEN: PERSON }),
          join(root, 't.json')
        ),
    ]) {
      const connector = make();
      await connector.init();
      await connector.authenticate().catch(() => false);
    }
    const trello = new TrelloConnector(
      config('MAMA_TRELLO_TOKEN', { MAMA_TRELLO_KEY: PERSON, MAMA_TRELLO_TOKEN: PERSON }),
      http as unknown as typeof fetch
    );
    await trello.init();
    await trello.authenticate().catch(() => false);
    const ical = new ICalConnector(
      config(undefined, { MAMA_ICAL_URL_CALENDAR: `https://calendar.example/${PERSON}.ics` }),
      join(root, 'i.json'),
      createTimeZoneSetting('UTC')
    );
    await ical.init();
    expect(await ical.authenticate()).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    for (const line of seen) expect(line).not.toContain(INSTALL);
    expect(seen.some((line) => line.includes(PERSON))).toBe(true);
    vi.unstubAllGlobals();
  });
});
