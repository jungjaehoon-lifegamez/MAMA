import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ChatworkConnector } from '../../src/connectors/chatwork/index.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

const envName = 'CHATWORK_API_TOKEN';
const config: ConnectorConfig = {
  enabled: true,
  pollIntervalMinutes: 5,
  channels: { 'room-key': { role: 'hub', name: 'room-display' } },
  auth: { type: 'token', tokenName: envName },
};
const roots: string[] = [];

describe('ChatworkConnector', () => {
  beforeEach(() => {
    process.env[envName] = 'fixture-chatwork-token';
  });

  afterEach(() => {
    delete process.env[envName];
    vi.unstubAllGlobals();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('reads the token from the daemon environment and filters by source time', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          message_id: 'old',
          account: { account_id: 1, name: 'actor-old', avatar_image_url: '' },
          body: 'old-content',
          send_time: 10,
          update_time: 10,
        },
        {
          message_id: 'new',
          account: { account_id: 2, name: 'actor-new', avatar_image_url: '' },
          body: 'new-content',
          send_time: 20,
          update_time: 20,
        },
      ],
    });
    vi.stubGlobal('fetch', fetchMock);
    const connector = new ChatworkConnector(config);
    await connector.init();
    const items = await connector.poll(new Date(15_000));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source: 'chatwork',
      sourceId: 'room-key:new',
      channel: 'room-display',
    });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'X-ChatWorkToken': 'fixture-chatwork-token' },
    });
  });

  it('names the cause of a failed fetch, which Node puts outside the message', async () => {
    const connector = new ChatworkConnector(config, {
      fetch: async () => {
        throw new TypeError('fetch failed', { cause: new Error('other side closed') });
      },
    });
    await connector.init();
    await expect(connector.poll(new Date(0))).rejects.toThrow(
      'last error: Room room-key: fetch failed: other side closed'
    );
    await connector.dispose();
  });

  it('retries earlier room messages when a later room fails', async () => {
    let failSecondRoom = true;
    const connector = new ChatworkConnector(
      {
        ...config,
        channels: {
          first: { role: 'hub' },
          second: { role: 'hub' },
        },
      },
      {
        fetch: async (url) => {
          if (String(url).includes('/second/'))
            return new Response('[]', { status: failSecondRoom ? 503 : 200 });
          return new Response(
            JSON.stringify([
              {
                message_id: '101',
                account: { account_id: 1, name: 'actor', avatar_image_url: '' },
                body: 'retained',
                send_time: 20,
                update_time: 20,
              },
            ])
          );
        },
      }
    );
    await connector.init();
    await expect(connector.poll(new Date(0))).rejects.toThrow(
      'Chatwork poll failed for 1 of 2 configured rooms; last error: Room second: HTTP 503'
    );
    failSecondRoom = false;
    expect((await connector.poll(new Date(0))).map((item) => item.sourceId)).toEqual(['first:101']);
    await connector.dispose();
  });

  it('retries messages when the scheduler aborts the source handoff', async () => {
    const connector = new ChatworkConnector(config, {
      fetch: async () =>
        new Response(
          JSON.stringify([
            {
              message_id: '101',
              account: { account_id: 1, name: 'actor', avatar_image_url: '' },
              body: 'retained',
              send_time: 20,
              update_time: 20,
            },
          ])
        ),
    });
    await connector.init();
    const handoff = connector as import('../../src/connectors/framework/types.js').IConnector;
    handoff.beginPollHandoff?.();
    expect(await connector.poll(new Date(0))).toHaveLength(1);
    handoff.abortPollHandoff?.();
    expect(await connector.poll(new Date(0))).toHaveLength(1);
    expect(await connector.poll(new Date(0))).toHaveLength(0);
    await connector.dispose();
  });

  it('keeps Chatwork download ids in live observation metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          message_id: 'message-attachment',
          account: { account_id: 3, name: 'actor-attachment', avatar_image_url: '' },
          body: '[download:901] feedback-test.zip',
          send_time: 30,
          update_time: 30,
        },
      ],
    });
    const connector = new ChatworkConnector(config, { fetch: fetchMock });
    await connector.init();

    const [item] = await connector.poll(new Date(0));

    expect(item?.metadata).toMatchObject({
      roomId: 'room-key',
      messageId: 'message-attachment',
      chatworkFileIds: ['901'],
      chatworkFiles: [{ fileId: '901', name: 'feedback-test.zip' }],
    });
  });

  it('matches Chatwork files by message id when the observation has one', async () => {
    const http = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          file_id: 901,
          message_id: 'message-attachment',
          filename: 'feedback-test.zip',
          filesize: 1_234,
          upload_time: 200,
        },
        {
          file_id: 902,
          message_id: 'other-message',
          filename: 'other-test.zip',
          filesize: 2_345,
          upload_time: 200,
        },
      ],
    });
    const connector = new ChatworkConnector(config, { fetch: http });
    await connector.init();

    const files = await connector.listAttachments({
      roomId: 'room-key',
      accountId: '3',
      messageId: 'message-attachment',
      sourceAtMs: 200_000,
    });

    expect(files).toEqual([
      {
        fileId: '901',
        name: 'feedback-test.zip',
        size: 1_234,
        uploadTime: 200_000,
        matchedBy: 'message_id',
      },
    ]);
    expect(http).toHaveBeenCalledWith(
      'https://api.chatwork.com/v2/rooms/room-key/files?account_id=3',
      expect.objectContaining({ headers: { 'X-ChatWorkToken': 'fixture-chatwork-token' } })
    );
  });

  it('matches Chatwork files by bounded upload time when no message id exists', async () => {
    const http = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          file_id: 901,
          filename: 'near-test.pdf',
          filesize: 1_234,
          upload_time: 590,
        },
        {
          file_id: 902,
          filename: 'far-test.pdf',
          filesize: 2_345,
          upload_time: 1,
        },
      ],
    });
    const connector = new ChatworkConnector(config, { fetch: http });
    await connector.init();

    const files = await connector.listAttachments({
      roomId: 'room-key',
      accountId: '3',
      sourceAtMs: 600_000,
    });

    expect(files).toEqual([
      {
        fileId: '901',
        name: 'near-test.pdf',
        size: 1_234,
        uploadTime: 590_000,
        matchedBy: 'upload_time',
      },
    ]);
    expect(http.mock.calls.map(([url]) => url)).toEqual([
      'https://api.chatwork.com/v2/rooms/room-key/files?account_id=3',
    ]);
  });

  it('fetches every known file id directly without needing uploader or time metadata', async () => {
    const http = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const id = url.match(/\/rooms\/room-key\/files\/(901|902)$/)?.[1];
      if (!id) throw new Error(`Unexpected URL: ${url}`);
      return Response.json({
        file_id: Number(id),
        filename: `fixture-${id}.pdf`,
        filesize: 12,
        upload_time: 600,
      });
    });
    const connector = new ChatworkConnector(config, { fetch: http });
    await connector.init();

    const files = await connector.listAttachments({
      roomId: 'room-key',
      fileIds: ['901', '902', '901'],
      fileIdRule: 'text_marker',
    });

    expect(files).toEqual([
      {
        fileId: '901',
        name: 'fixture-901.pdf',
        size: 12,
        uploadTime: 600_000,
        matchedBy: 'text_marker',
      },
      {
        fileId: '902',
        name: 'fixture-902.pdf',
        size: 12,
        uploadTime: 600_000,
        matchedBy: 'text_marker',
      },
    ]);
    expect(http.mock.calls.map(([url]) => url)).toEqual([
      'https://api.chatwork.com/v2/rooms/room-key/files/901',
      'https://api.chatwork.com/v2/rooms/room-key/files/902',
    ]);
  });

  it('uses the upload window when the filtered API file omits message_id', async () => {
    const http = vi.fn().mockResolvedValue(
      Response.json([
        { file_id: 901, filename: 'near-test.pdf', filesize: 12, upload_time: 300 },
        {
          file_id: 902,
          filename: 'other-test.pdf',
          filesize: 12,
          upload_time: 600,
          message_id: 'other-message',
        },
        { file_id: 903, filename: 'far-test.pdf', filesize: 12, upload_time: 901 },
      ])
    );
    const connector = new ChatworkConnector(config, { fetch: http });
    await connector.init();

    const files = await connector.listAttachments({
      roomId: 'room-key',
      accountId: '3',
      messageId: 'message-attachment',
      sourceAtMs: 600_000,
    });

    expect(files).toEqual([
      {
        fileId: '901',
        name: 'near-test.pdf',
        size: 12,
        uploadTime: 300_000,
        matchedBy: 'upload_time',
      },
    ]);
    expect(http.mock.calls.map(([url]) => url)).toEqual([
      'https://api.chatwork.com/v2/rooms/room-key/files?account_id=3',
    ]);
  });

  it('surfaces a direct lookup 404 instead of returning an empty attachment list', async () => {
    const http = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const connector = new ChatworkConnector(config, { fetch: http });
    await connector.init();

    await expect(
      connector.listAttachments({ roomId: 'other-room', fileIds: ['901'] })
    ).rejects.toThrow(/file 901.*not available in room other-room.*404/);
    expect(http.mock.calls.map(([url]) => url)).toEqual([
      'https://api.chatwork.com/v2/rooms/other-room/files/901',
    ]);
  });

  it('rejects a direct lookup response for a different file', async () => {
    const http = vi.fn().mockResolvedValue(
      Response.json({
        file_id: 902,
        filename: 'other-test.pdf',
        filesize: 12,
        upload_time: 600,
      })
    );
    const connector = new ChatworkConnector(config, { fetch: http });
    await connector.init();

    await expect(
      connector.listAttachments({ roomId: 'room-key', fileIds: ['901'] })
    ).rejects.toThrow(/does not match requested file 901/);
  });

  it('resolves the exact member name before listing that uploader files', async () => {
    const http = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/rooms/room-key/members')) {
        return Response.json([
          { account_id: 4, name: 'actor-imported-extra' },
          { account_id: 3, name: 'actor-imported' },
        ]);
      }
      if (url.endsWith('/rooms/room-key/files?account_id=3')) {
        return Response.json([
          { file_id: 901, filename: 'near-test.pdf', filesize: 12, upload_time: 598 },
          { file_id: 902, filename: 'far-test.pdf', filesize: 12, upload_time: 299 },
        ]);
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const connector = new ChatworkConnector(config, { fetch: http });
    await connector.init();

    const files = await connector.listAttachments({
      roomId: 'room-key',
      author: 'actor-imported',
      sourceAtMs: 600_000,
    });

    expect(files).toEqual([
      {
        fileId: '901',
        name: 'near-test.pdf',
        size: 12,
        uploadTime: 598_000,
        matchedBy: 'upload_time',
      },
    ]);
    expect(http.mock.calls.map(([url]) => url)).toEqual([
      'https://api.chatwork.com/v2/rooms/room-key/members',
      'https://api.chatwork.com/v2/rooms/room-key/files?account_id=3',
    ]);
  });

  it('names an unmatched author and never tries the unfiltered file list', async () => {
    const http = vi.fn().mockResolvedValue(
      Response.json([
        { account_id: 4, name: 'actor-imported-extra' },
        { account_id: 5, name: 'Actor-imported' },
      ])
    );
    const connector = new ChatworkConnector(config, { fetch: http });
    await connector.init();

    await expect(
      connector.listAttachments({
        roomId: 'room-key',
        author: 'actor-imported',
        sourceAtMs: 600_000,
      })
    ).rejects.toThrow(/No Chatwork room member.*actor-imported/);
    expect(http.mock.calls.map(([url]) => url)).toEqual([
      'https://api.chatwork.com/v2/rooms/room-key/members',
    ]);
  });

  it('fails without uploader information instead of listing the room files', async () => {
    const http = vi.fn();
    const connector = new ChatworkConnector(config, { fetch: http });
    await connector.init();

    await expect(
      connector.listAttachments({ roomId: 'room-key', sourceAtMs: 600_000 })
    ).rejects.toThrow(/requires.*accountId.*author/);
    expect(http).not.toHaveBeenCalled();
  });

  it('downloads a room file through the signed URL without exposing the token', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-chatwork-download-'));
    roots.push(root);
    const target = join(root, 'files', '901_feedback-test.zip');
    mkdirSync(join(root, 'files'), { recursive: true });
    const http = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          file_id: 901,
          filename: 'feedback-test.zip',
          filesize: 8,
          upload_time: 200,
          download_url: 'https://download.example.test/file-901',
        }),
      })
      .mockResolvedValueOnce(new Response('file-data'));
    const connector = new ChatworkConnector(config, { fetch: http });
    await connector.init();

    const result = await connector.downloadAttachment({
      roomId: 'room-key',
      fileId: '901',
      targetPath: target,
    });

    expect(result.size).toBe(9);
    expect(readFileSync(target, 'utf8')).toBe('file-data');
    expect(http.mock.calls.map(([url]) => url)).toEqual([
      'https://api.chatwork.com/v2/rooms/room-key/files/901?create_download_url=1',
      'https://download.example.test/file-901',
    ]);
    expect(http.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'X-ChatWorkToken': 'fixture-chatwork-token' },
    });
    expect(http.mock.calls[1]?.[1]).toBeUndefined();
  });

  it('refuses a Chatwork file response that is not available in the observation room', async () => {
    const http = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const connector = new ChatworkConnector(config, { fetch: http });
    await connector.init();

    await expect(
      connector.downloadAttachment({
        roomId: 'other-room',
        fileId: '901',
        targetPath: '/tmp/unused',
      })
    ).rejects.toThrow(/not available in room other-room.*404/);
    expect(http.mock.calls.map(([url]) => url)).toEqual([
      'https://api.chatwork.com/v2/rooms/other-room/files/901?create_download_url=1',
    ]);
  });

  it('does not poll ignored rooms', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal('fetch', fetchMock);
    const connector = new ChatworkConnector({
      ...config,
      channels: { ignored: { role: 'ignore' } },
    });
    await connector.init();
    await connector.poll(new Date(0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a batch when a configured room fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const connector = new ChatworkConnector(config);
    await connector.init();
    await expect(connector.poll(new Date(0))).rejects.toThrow(/poll failed/i);
  });
});
