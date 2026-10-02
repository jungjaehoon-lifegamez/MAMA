import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SlackConnector } from '../../src/connectors/slack/index.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

const slack = vi.hoisted(() => ({
  WebClient: vi.fn(),
  authTest: vi.fn(),
  history: vi.fn(),
  replies: vi.fn(),
  usersInfo: vi.fn(),
  filesInfo: vi.fn(),
}));

vi.mock('@slack/web-api', () => ({ WebClient: slack.WebClient }));

const envName = 'SLACK_BOT_TOKEN';
const config: ConnectorConfig = {
  enabled: true,
  pollIntervalMinutes: 5,
  channels: { 'channel-key': { role: 'hub', name: 'channel-display' } },
  auth: { type: 'token', tokenName: envName },
};
const roots: string[] = [];

// A realistic poll time: history is read from 30 days before it.
const SINCE = new Date(Date.UTC(2026, 0, 31));
const SINCE_S = SINCE.getTime() / 1000;
const LOOKBACK_S = 30 * 24 * 60 * 60;
const ts = (offsetSeconds: number): string => (SINCE_S + offsetSeconds).toFixed(6);

describe('SlackConnector', () => {
  beforeEach(() => {
    process.env[envName] = 'fixture-slack-token';
    slack.WebClient.mockImplementation(() => ({
      auth: { test: slack.authTest },
      conversations: { history: slack.history, replies: slack.replies },
      users: { info: slack.usersInfo },
      files: { info: slack.filesInfo },
    }));
    slack.authTest.mockResolvedValue({ ok: true });
    slack.history.mockReset();
    slack.replies.mockReset();
    slack.usersInfo.mockReset();
    slack.filesInfo.mockReset();
  });

  afterEach(() => {
    delete process.env[envName];
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('polls paginated history through the SDK and resolves authors', async () => {
    slack.history
      .mockResolvedValueOnce({
        messages: [{ ts: ts(5), user: 'user-key', text: 'source-content' }],
        response_metadata: { next_cursor: 'next-page' },
      })
      .mockResolvedValueOnce({
        messages: [{ ts: ts(6), user: 'user-key', text: 'second-content' }],
        response_metadata: { next_cursor: '' },
      });
    slack.usersInfo.mockResolvedValue({ user: { real_name: 'actor-a' } });
    const connector = new SlackConnector(config);
    await connector.init();
    expect(slack.WebClient).toHaveBeenCalledWith('fixture-slack-token');
    const items = await connector.poll(SINCE);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      source: 'slack',
      channel: 'channel-display',
      author: 'actor-a',
    });
    expect(slack.history).toHaveBeenNthCalledWith(1, {
      channel: 'channel-key',
      oldest: (SINCE_S - LOOKBACK_S).toFixed(6),
      limit: 200,
    });
    expect(slack.history).toHaveBeenNthCalledWith(2, {
      channel: 'channel-key',
      oldest: (SINCE_S - LOOKBACK_S).toFixed(6),
      limit: 200,
      cursor: 'next-page',
    });
  });

  it('keeps live Slack message file ids in observation metadata', async () => {
    slack.history.mockResolvedValue({
      messages: [
        {
          ts: '20.000',
          user: 'user-key',
          text: 'feedback with a file',
          files: [{ id: 'F-901', name: 'feedback-test.pdf' }],
        },
      ],
      response_metadata: { next_cursor: '' },
    });
    slack.usersInfo.mockResolvedValue({ user: { real_name: 'actor-a' } });
    const connector = new SlackConnector(config);
    await connector.init();

    const [item] = await connector.poll(new Date(15_000));

    expect(item?.metadata).toMatchObject({
      channelId: 'channel-key',
      ts: '20.000',
      slackFileIds: ['F-901'],
      slackFiles: [{ fileId: 'F-901', name: 'feedback-test.pdf' }],
    });
  });

  it('resolves Slack file metadata through files.info and checks the observation channel', async () => {
    slack.filesInfo.mockResolvedValue({
      ok: true,
      file: {
        id: 'F-901',
        name: 'feedback-test.pdf',
        size: 1_234,
        created: 200,
        url_private: 'https://files.slack.com/F-901',
        channels: ['channel-key'],
        groups: [],
      },
    });
    const connector = new SlackConnector(config);
    await connector.init();

    const files = await connector.listAttachments({
      roomId: 'channel-key',
      fileIds: ['F-901'],
      sourceAtMs: 200_000,
    });

    expect(files).toEqual([
      {
        fileId: 'F-901',
        name: 'feedback-test.pdf',
        size: 1_234,
        uploadTime: 200_000,
        matchedBy: 'metadata_file_id',
      },
    ]);
    expect(slack.filesInfo).toHaveBeenCalledWith({ file: 'F-901' });
  });

  it('downloads Slack url_private with the configured bot token and refuses another room', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-slack-download-'));
    roots.push(root);
    const target = join(root, 'files', 'F-901_feedback-test.pdf');
    mkdirSync(join(root, 'files'), { recursive: true });
    slack.filesInfo.mockResolvedValue({
      ok: true,
      file: {
        id: 'F-901',
        name: 'feedback-test.pdf',
        size: 9,
        created: 200,
        url_private: 'https://files.slack.com/F-901',
        channels: ['channel-key'],
        groups: [],
      },
    });
    const http = vi.fn().mockResolvedValue(new Response('file-data'));
    const connector = new SlackConnector(config, { fetch: http });
    await connector.init();

    const result = await connector.downloadAttachment({
      roomId: 'channel-key',
      fileId: 'F-901',
      targetPath: target,
    });

    expect(result.size).toBe(9);
    expect(readFileSync(target, 'utf8')).toBe('file-data');
    expect(http).toHaveBeenCalledWith('https://files.slack.com/F-901', {
      headers: { Authorization: 'Bearer fixture-slack-token' },
      redirect: 'manual',
    });
    await expect(
      connector.listAttachments({ roomId: 'other-channel', fileIds: ['F-901'] })
    ).rejects.toThrow(/does not belong to observation room other-channel/);
  });

  function fileMetadata(url: string) {
    slack.filesInfo.mockResolvedValue({
      ok: true,
      file: {
        id: 'F-901',
        name: 'fixture.pdf',
        size: 9,
        created: 200,
        url_private: url,
        channels: ['channel-key'],
        groups: [],
      },
    });
  }

  it.each([
    ['insecure scheme', 'http://files.slack.com/files-pri/fixture'],
    ['arbitrary host', 'https://untrusted.invalid/fixture'],
    ['suffix attack', 'https://files.slack.com.untrusted.invalid/fixture'],
    ['prefix attack', 'https://untrusted-files.slack.com/fixture'],
    ['user info attack', 'https://files.slack.com@untrusted.invalid/fixture'],
    ['embedded credentials', 'https://fixture:private@files.slack.com/fixture'],
    ['nonstandard port', 'https://files.slack.com:8443/fixture'],
    ['unrelated service host', 'https://slack.com/fixture'],
    ['malformed URL', 'not-a-url'],
  ])('rejects %s before sending a bot token', async (_label, url) => {
    fileMetadata(url);
    const root = mkdtempSync(join(tmpdir(), 'slack-untrusted-'));
    roots.push(root);
    const http = vi.fn().mockResolvedValue(new Response('file-data'));
    const connector = new SlackConnector(config, { fetch: http });
    await connector.init();
    await expect(
      connector.downloadAttachment({
        roomId: 'channel-key',
        fileId: 'F-901',
        targetPath: join(root, 'fixture.pdf'),
      })
    ).rejects.toThrow(/Slack file url_private/);
    expect(http).not.toHaveBeenCalled();
  });

  it('refuses redirects without forwarding credentials or exposing the redirect URL', async () => {
    fileMetadata('https://files.slack.com/files-pri/fixture');
    const root = mkdtempSync(join(tmpdir(), 'slack-redirect-'));
    roots.push(root);
    let cancelled = false;
    const outboundTokens: string[] = [];
    const http = vi.fn(async (_url, options) => {
      if (options?.redirect !== 'manual') {
        outboundTokens.push(new Headers(options?.headers).get('Authorization') ?? '');
        return new Response('untrusted-file');
      }
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        {
          status: 302,
          headers: { location: 'https://untrusted.invalid/private-location' },
        }
      );
    });
    const connector = new SlackConnector(config, { fetch: http });
    await connector.init();
    await expect(
      connector.downloadAttachment({
        roomId: 'channel-key',
        fileId: 'F-901',
        targetPath: join(root, 'fixture.pdf'),
      })
    ).rejects.toThrow(/^Slack file download redirects are not allowed$/);
    expect(outboundTokens).toEqual([]);
    expect(http).toHaveBeenCalledTimes(1);
    expect(cancelled).toBe(true);
  });

  it('does not expose request error details from the authenticated download', async () => {
    fileMetadata('https://files.slack.com/files-pri/fixture');
    const http = vi.fn().mockRejectedValue(new Error('fixture-slack-token private-request-detail'));
    const connector = new SlackConnector(config, { fetch: http });
    await connector.init();
    await expect(
      connector.downloadAttachment({
        roomId: 'channel-key',
        fileId: 'F-901',
        targetPath: '/unused-target',
      })
    ).rejects.toThrow(/^Slack file download request failed$/);
  });

  it('skips bot messages and ignored channels', async () => {
    slack.history.mockResolvedValue({
      messages: [
        { ts: '20.000', user: 'user-key', text: 'bot', bot_id: 'bot-key' },
        { ts: '21.000', user: 'user-key', text: 'human' },
      ],
      response_metadata: { next_cursor: '' },
    });
    const connector = new SlackConnector({
      ...config,
      channels: {
        'channel-key': { role: 'hub' },
        ignored: { role: 'ignore' },
      },
    });
    await connector.init();
    expect(slack.WebClient).toHaveBeenCalledWith('fixture-slack-token');
    const items = await connector.poll(new Date(0));
    expect(items.map((item) => item.content)).toEqual(['human']);
    expect(slack.history.mock.calls.filter(([input]) => input.channel === 'ignored')).toHaveLength(
      0
    );
  });

  it('fails the whole poll when one room fails without advancing poll state', async () => {
    slack.history.mockImplementation(async ({ channel }: { channel: string }) => {
      if (channel === 'failed-channel') throw new Error('room request failed');
      return { messages: [], response_metadata: { next_cursor: '' } };
    });
    const connector = new SlackConnector({
      ...config,
      channels: {
        'working-channel': { role: 'hub' },
        'failed-channel': { role: 'hub' },
      },
    });
    await connector.init();

    await expect(connector.poll(new Date(0))).rejects.toThrow(/one or more configured channels/i);
    expect(await connector.healthCheck()).toMatchObject({
      lastPollTime: null,
      lastPollCount: 0,
      error: 'room request failed',
    });
  });

  it('reads replies posted only in a thread that started before the poll window', async () => {
    const parent = ts(-5 * 24 * 60 * 60);
    slack.history.mockResolvedValue({
      messages: [
        {
          ts: parent,
          user: 'user-key',
          text: 'thread-parent',
          thread_ts: parent,
          reply_count: 3,
          latest_reply: ts(20),
        },
      ],
      response_metadata: { next_cursor: '' },
    });
    slack.replies.mockResolvedValue({
      messages: [
        { ts: parent, user: 'user-key', text: 'thread-parent', thread_ts: parent },
        { ts: ts(-10), user: 'user-key', text: 'reply-before-window', thread_ts: parent },
        { ts: ts(10), user: 'user-key', text: 'thread-reply', thread_ts: parent },
        { ts: ts(20), user: 'user-key', text: 'bot-reply', thread_ts: parent, bot_id: 'bot-key' },
      ],
      response_metadata: { next_cursor: '' },
    });
    slack.usersInfo.mockResolvedValue({ user: { real_name: 'actor-a' } });
    const connector = new SlackConnector(config);
    await connector.init();

    const items = await connector.poll(SINCE);

    expect(slack.history).toHaveBeenCalledWith({
      channel: 'channel-key',
      oldest: (SINCE_S - LOOKBACK_S).toFixed(6),
      limit: 200,
    });
    expect(slack.replies).toHaveBeenCalledWith({
      channel: 'channel-key',
      ts: parent,
      oldest: SINCE_S.toFixed(6),
      limit: 200,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sourceId: `channel-key:${ts(10)}`,
      content: 'thread-reply',
      author: 'actor-a',
      metadata: { channelId: 'channel-key', threadTs: parent },
    });
  });

  it('takes a thread started inside the window once, with its replies', async () => {
    slack.history.mockResolvedValue({
      messages: [
        { ts: ts(5), user: 'user-key', text: 'new-parent', reply_count: 1, latest_reply: ts(8) },
      ],
      response_metadata: { next_cursor: '' },
    });
    slack.replies.mockResolvedValue({
      messages: [
        { ts: ts(5), user: 'user-key', text: 'new-parent', thread_ts: ts(5) },
        { ts: ts(8), user: 'user-key', text: 'new-reply', thread_ts: ts(5) },
      ],
      response_metadata: { next_cursor: '' },
    });
    const connector = new SlackConnector(config);
    await connector.init();

    const items = await connector.poll(SINCE);

    expect(items.map((item) => item.sourceId)).toEqual([
      `channel-key:${ts(5)}`,
      `channel-key:${ts(8)}`,
    ]);
  });

  it('takes a reply also sent to the channel from history once and skips quiet threads', async () => {
    slack.history.mockResolvedValue({
      messages: [
        {
          ts: ts(-20),
          user: 'user-key',
          text: 'quiet-parent',
          reply_count: 1,
          latest_reply: ts(-2),
        },
        {
          ts: ts(-10),
          user: 'user-key',
          text: 'active-parent',
          reply_count: 1,
          latest_reply: ts(30),
        },
        {
          ts: ts(30),
          user: 'user-key',
          text: 'broadcast-reply',
          thread_ts: ts(-10),
          subtype: 'thread_broadcast',
        },
      ],
      response_metadata: { next_cursor: '' },
    });
    slack.replies.mockResolvedValue({
      messages: [
        { ts: ts(-10), user: 'user-key', text: 'active-parent', thread_ts: ts(-10) },
        {
          ts: ts(30),
          user: 'user-key',
          text: 'broadcast-reply',
          thread_ts: ts(-10),
          subtype: 'thread_broadcast',
        },
      ],
      response_metadata: { next_cursor: '' },
    });
    const connector = new SlackConnector(config);
    await connector.init();

    const items = await connector.poll(SINCE);

    expect(items.map((item) => item.content)).toEqual(['broadcast-reply']);
    expect(slack.replies).toHaveBeenCalledTimes(1);
    expect(slack.replies).toHaveBeenCalledWith(expect.objectContaining({ ts: ts(-10) }));
  });

  it("pages through a thread's replies", async () => {
    slack.history.mockResolvedValue({
      messages: [
        { ts: ts(-10), user: 'user-key', text: 'parent', reply_count: 2, latest_reply: ts(12) },
      ],
      response_metadata: { next_cursor: '' },
    });
    slack.replies
      .mockResolvedValueOnce({
        messages: [
          { ts: ts(-10), user: 'user-key', text: 'parent', thread_ts: ts(-10) },
          { ts: ts(11), user: 'user-key', text: 'first-reply', thread_ts: ts(-10) },
        ],
        response_metadata: { next_cursor: 'reply-page' },
      })
      .mockResolvedValueOnce({
        messages: [{ ts: ts(12), user: 'user-key', text: 'second-reply', thread_ts: ts(-10) }],
        response_metadata: { next_cursor: '' },
      });
    const connector = new SlackConnector(config);
    await connector.init();

    const items = await connector.poll(SINCE);

    expect(items.map((item) => item.content)).toEqual(['first-reply', 'second-reply']);
    expect(slack.replies).toHaveBeenNthCalledWith(2, {
      channel: 'channel-key',
      ts: ts(-10),
      oldest: SINCE_S.toFixed(6),
      limit: 200,
      cursor: 'reply-page',
    });
  });

  it('fails the poll when a thread read fails, as a history failure does', async () => {
    slack.history.mockResolvedValue({
      messages: [
        { ts: ts(-10), user: 'user-key', text: 'parent', reply_count: 1, latest_reply: ts(12) },
      ],
      response_metadata: { next_cursor: '' },
    });
    slack.replies.mockRejectedValue(new Error('thread request failed'));
    const connector = new SlackConnector(config);
    await connector.init();

    await expect(connector.poll(SINCE)).rejects.toThrow(/one or more configured channels/i);
    expect(await connector.healthCheck()).toMatchObject({
      lastPollTime: null,
      error: 'thread request failed',
    });
  });
});
