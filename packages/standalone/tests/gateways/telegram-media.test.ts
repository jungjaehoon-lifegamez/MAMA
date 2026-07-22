import { mkdtemp, mkdir, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { downloadTelegramMedia } from '../../src/gateways/telegram-media.js';

const BOT_TOKEN = 'secret-bot-token';

async function tempMediaRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'mama-telegram-media-'));
}

function response(body: BodyInit, init?: ResponseInit): Response {
  return new Response(body, init);
}

describe('TelegramMediaDownloader', () => {
  it('downloads to a private directory without returning an authenticated URL', async () => {
    const mediaRoot = await tempMediaRoot();
    await mkdir(mediaRoot, { recursive: true, mode: 0o755 });
    const fetchImpl = vi.fn(async () => response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])));

    const result = await downloadTelegramMedia({
      botToken: BOT_TOKEN,
      fileId: 'file-id',
      fileUniqueId: 'unique-id',
      filename: '../../portrait.jpg',
      kind: 'photo',
      mediaRoot,
      getFile: async () => ({ file_path: 'photos/portrait.jpg', file_size: 4 }),
      fetchImpl,
    });

    expect(result.filename).toBe('portrait.jpg');
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.sourceRef).toBe('telegram:unique-id');
    expect(JSON.stringify(result)).not.toContain(BOT_TOKEN);
    expect(result.localPath.startsWith(`${mediaRoot}/`)).toBe(true);
    expect((await stat(mediaRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(result.localPath)).mode & 0o777).toBe(0o600);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('creates unique contained names for repeated safe filenames', async () => {
    const mediaRoot = await tempMediaRoot();
    const args = {
      botToken: BOT_TOKEN,
      fileId: 'file-id',
      fileUniqueId: 'unique-id',
      filename: 'same.jpg',
      kind: 'photo' as const,
      mediaRoot,
      getFile: async () => ({ file_path: 'photos/same.jpg', file_size: 4 }),
      fetchImpl: async () => response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])),
    };

    const first = await downloadTelegramMedia(args);
    const second = await downloadTelegramMedia(args);

    expect(first.localPath).not.toBe(second.localPath);
    expect(first.localPath.startsWith(`${mediaRoot}/`)).toBe(true);
    expect(second.localPath.startsWith(`${mediaRoot}/`)).toBe(true);
  });

  it.each(['../secret', '/absolute/file.jpg', 'photos/../../secret'])(
    'rejects invalid Telegram file_path %s before fetching',
    async (filePath) => {
      const mediaRoot = await tempMediaRoot();
      const fetchImpl = vi.fn();

      await expect(
        downloadTelegramMedia({
          botToken: BOT_TOKEN,
          fileId: 'file-id',
          fileUniqueId: 'unique-id',
          kind: 'photo',
          mediaRoot,
          getFile: async () => ({ file_path: filePath }),
          fetchImpl,
        })
      ).rejects.toThrow('Telegram media path is invalid');

      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  it('rejects a missing Telegram file_path without exposing the token', async () => {
    const mediaRoot = await tempMediaRoot();

    const error = await downloadTelegramMedia({
      botToken: BOT_TOKEN,
      fileId: 'file-id',
      fileUniqueId: 'unique-id',
      kind: 'document',
      mediaRoot,
      getFile: async () => ({}),
      fetchImpl: vi.fn(),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Telegram media path is unavailable');
    expect((error as Error).message).not.toContain(BOT_TOKEN);
  });

  it('rejects declared files larger than the hosted Bot API limit before getFile', async () => {
    const mediaRoot = await tempMediaRoot();
    const getFile = vi.fn();

    await expect(
      downloadTelegramMedia({
        botToken: BOT_TOKEN,
        fileId: 'file-id',
        fileUniqueId: 'unique-id',
        declaredSize: 20 * 1024 * 1024 + 1,
        kind: 'document',
        mediaRoot,
        getFile,
        fetchImpl: vi.fn(),
      })
    ).rejects.toThrow('Telegram media exceeds the download limit');

    expect(getFile).not.toHaveBeenCalled();
  });

  it('rejects an oversized Content-Length and leaves no partial file', async () => {
    const mediaRoot = await tempMediaRoot();

    await expect(
      downloadTelegramMedia({
        botToken: BOT_TOKEN,
        fileId: 'file-id',
        fileUniqueId: 'unique-id',
        kind: 'document',
        maxBytes: 4,
        mediaRoot,
        getFile: async () => ({ file_path: 'documents/file.bin' }),
        fetchImpl: async () => response('12345', { headers: { 'content-length': '5' } }),
      })
    ).rejects.toThrow('Telegram media exceeds the download limit');

    expect(await readdir(mediaRoot)).toEqual([]);
  });

  it('enforces the streamed-byte limit and removes a partial file', async () => {
    const mediaRoot = await tempMediaRoot();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    });

    await expect(
      downloadTelegramMedia({
        botToken: BOT_TOKEN,
        fileId: 'file-id',
        fileUniqueId: 'unique-id',
        kind: 'document',
        maxBytes: 5,
        mediaRoot,
        getFile: async () => ({ file_path: 'documents/file.bin' }),
        fetchImpl: async () => response(body),
      })
    ).rejects.toThrow('Telegram media exceeds the download limit');

    expect(await readdir(mediaRoot)).toEqual([]);
  });

  it('removes a partial file when the response stream fails', async () => {
    const mediaRoot = await tempMediaRoot();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.error(new Error(`network failed ${BOT_TOKEN}`));
      },
    });

    const error = await downloadTelegramMedia({
      botToken: BOT_TOKEN,
      fileId: 'file-id',
      fileUniqueId: 'unique-id',
      kind: 'document',
      mediaRoot,
      getFile: async () => ({ file_path: 'documents/file.bin' }),
      fetchImpl: async () => response(body),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Telegram media download failed');
    expect((error as Error).message).not.toContain(BOT_TOKEN);
    expect(await readdir(mediaRoot)).toEqual([]);
  });

  it('uses safe filename and MIME fallbacks for documents', async () => {
    const mediaRoot = await tempMediaRoot();

    const result = await downloadTelegramMedia({
      botToken: BOT_TOKEN,
      fileId: 'file-id',
      fileUniqueId: 'unique-id',
      kind: 'document',
      mediaRoot,
      getFile: async () => ({ file_path: 'documents/opaque', file_size: 2 }),
      fetchImpl: async () => response(new Uint8Array([1, 2])),
    });

    expect(result.filename).toBe('document-unique-id.bin');
    expect(result.mimeType).toBe('application/octet-stream');
  });

  it('turns non-success responses into a stable redacted error', async () => {
    const mediaRoot = await tempMediaRoot();

    const error = await downloadTelegramMedia({
      botToken: BOT_TOKEN,
      fileId: 'file-id',
      fileUniqueId: 'unique-id',
      kind: 'photo',
      mediaRoot,
      getFile: async () => ({ file_path: 'photos/file.jpg' }),
      fetchImpl: async () => response('denied', { status: 403 }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Telegram media download failed');
    expect((error as Error).message).not.toContain(BOT_TOKEN);
  });

  it('times out a stalled response stream and removes the partial file', async () => {
    const mediaRoot = await tempMediaRoot();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
      },
    });

    await expect(
      downloadTelegramMedia({
        botToken: BOT_TOKEN,
        fileId: 'file-id',
        fileUniqueId: 'unique-id',
        kind: 'document',
        mediaRoot,
        timeoutMs: 10,
        getFile: async () => ({ file_path: 'documents/file.bin' }),
        fetchImpl: async () => response(body),
      })
    ).rejects.toThrow('Telegram media download timed out');

    expect(await readdir(mediaRoot)).toEqual([]);
  });

  it('times out a stalled Telegram fetch with a stable error', async () => {
    const mediaRoot = await tempMediaRoot();

    await expect(
      downloadTelegramMedia({
        botToken: BOT_TOKEN,
        fileId: 'file-id',
        fileUniqueId: 'unique-id',
        kind: 'document',
        mediaRoot,
        timeoutMs: 10,
        getFile: async () => ({ file_path: 'documents/file.bin' }),
        fetchImpl: async () => new Promise<Response>(() => {}),
      })
    ).rejects.toThrow('Telegram media download timed out');
  });
});
