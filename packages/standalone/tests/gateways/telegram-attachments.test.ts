import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bot = vi.hoisted(() => ({
  handler: undefined as ((ctx: unknown) => Promise<void>) | undefined,
  getFile: vi.fn(),
}));
vi.mock('grammy', () => ({
  InputFile: vi.fn(),
  Bot: vi.fn(() => ({
    on: (_event: string, handler: (ctx: unknown) => Promise<void>) => {
      bot.handler = handler;
    },
    catch: vi.fn(),
    init: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    api: { getFile: bot.getFile, sendMessage: vi.fn(async () => ({ message_id: 101 })) },
  })),
}));

import { TelegramGateway } from '../../src/gateways/telegram.js';
import type { OwnerMessageInput } from '../../src/gateways/turn-contract.js';

let root: string;
let gateway: TelegramGateway;
let received: OwnerMessageInput[];
let download: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'telegram-attachment-')));
  received = [];
  bot.getFile.mockReset().mockResolvedValue({ file_path: 'documents/file.bin', file_size: 4 });
  download = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4])));
  vi.stubGlobal('fetch', download);
  gateway = new TelegramGateway({
    token: 'fixture-token',
    messageLedgerPath: join(root, 'ledger.json'),
    downloadsDir: join(root, 'downloads'),
    config: { allowedChats: ['7'], ownerUserIds: ['9'], polling: false },
    intake: {
      recordOwnerReply: () => {},
      acceptOwnerMessage: (input) => {
        received.push(input);
        return { inputId: input.id, state: 'accepted' };
      },
    },
  });
  await gateway.start();
});
afterEach(async () => {
  await gateway.stop();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

async function send(media: Record<string, unknown>, caption?: string) {
  await bot.handler!({
    message: {
      message_id: 11,
      date: 1_700_000_000,
      chat: { id: 7, type: 'private' },
      from: { id: 9, is_bot: false },
      ...media,
      ...(caption === undefined ? {} : { caption }),
    },
  });
}

function attachment() {
  return (received[0]?.payload as { attachments?: unknown[] })?.attachments?.[0];
}
const file = { file_id: 'file-id', file_unique_id: 'unique', file_size: 4 };

describe('owner Telegram attachments', () => {
  it('downloads the document and retains caption formatting with its local descriptor', async () => {
    await send(
      {
        document: {
          ...file,
          file_name: '書式.xlsx',
          mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
        caption_entities: [{ type: 'bold', offset: 0, length: 3 }],
      },
      'use this existing file as the reference'
    );
    expect(received[0]?.text).toBe('use this existing file as the reference');
    const path = join(root, 'downloads/telegram/11_書式.xlsx');
    expect(attachment()).toEqual({
      path,
      name: '書式.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: 4,
    });
    expect(readFileSync(path)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(received[0]?.payload).toHaveProperty('telegramFormatting');
    expect(bot.getFile).toHaveBeenCalledWith('file-id');
    expect(download).toHaveBeenCalledWith(
      'https://api.telegram.org/file/botfixture-token/documents/file.bin',
      expect.anything()
    );
  });

  it('downloads the animation only when Telegram also supplies its document alias', async () => {
    await send({
      animation: { ...file, file_name: 'clip.gif', mime_type: 'image/gif' },
      document: { ...file, file_name: 'clip.gif', mime_type: 'image/gif' },
    });
    expect(received[0]?.payload).toHaveProperty('attachments', [attachment()]);
    expect(download).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(root, 'downloads/telegram/11_clip.gif'))).toHaveLength(4);
  });

  it('ignores a symlink in the former workspace attachment directory', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'telegram-outside-'));
    mkdirSync(join(root, 'workspace', 'files'), { recursive: true });
    symlinkSync(outside, join(root, 'workspace', 'files', 'telegram'));
    try {
      await send({ document: { ...file, file_name: 'sample.bin' } });
      expect(attachment()).toMatchObject({
        path: join(root, 'downloads', 'telegram', '11_sample.bin'),
        size: 4,
      });
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('replaces a target symlink without writing through it', async () => {
    const outside = join(root, 'outside.bin');
    writeFileSync(outside, 'unchanged');
    mkdirSync(join(root, 'downloads', 'telegram'), { recursive: true });
    symlinkSync(outside, join(root, 'downloads', 'telegram', '11_sample.bin'));
    await send({ document: { ...file, file_name: 'sample.bin' } });
    expect(readFileSync(outside, 'utf8')).toBe('unchanged');
    expect(readFileSync(join(root, 'downloads', 'telegram', '11_sample.bin'))).toHaveLength(4);
  });

  it('selects the largest photo even when sizes arrive out of order', async () => {
    await send({
      photo: [
        { ...file, file_id: 'largest', file_unique_id: 'large', width: 1200, height: 900 },
        { ...file, file_id: 'small', width: 90, height: 60 },
      ],
    });
    expect(bot.getFile).toHaveBeenCalledWith('largest');
    expect(attachment()).toEqual({
      path: join(root, 'downloads/telegram/11_photo_large.jpg'),
      name: 'photo_large.jpg',
      mimeType: 'image/jpeg',
      size: 4,
    });
  });

  it.each([
    ['video', { mime_type: 'video/mp4' }, 'video_unique.mp4'],
    ['animation', { mime_type: 'image/gif' }, 'animation_unique.gif'],
    ['audio', { mime_type: 'audio/mpeg' }, 'audio_unique.mp3'],
    ['voice', { mime_type: 'audio/ogg' }, 'voice_unique.ogg'],
    ['video_note', {}, 'video_note_unique.mp4'],
    ['sticker', { is_animated: false, is_video: false }, 'sticker_unique.webp'],
    ['sticker', { is_animated: true, is_video: false }, 'sticker_unique.tgs'],
    ['sticker', { is_animated: false, is_video: true }, 'sticker_unique.webm'],
  ])(
    'downloads %s with a generated name and accepts a file-only message',
    async (kind, extra, name) => {
      await send({ [kind]: { ...file, ...extra } });
      expect(received[0]?.text).toBe(`[file: ${name}]`);
      expect(attachment()).toMatchObject({
        name,
        path: join(root, `downloads/telegram/11_${name}`),
        size: 4,
      });
      expect(readFileSync(join(root, `downloads/telegram/11_${name}`))).toHaveLength(4);
    }
  );

  it('accepts a document with no caption', async () => {
    await send({ document: { ...file, file_name: 'template.xlsx' } });
    expect(received[0]?.text).toBe('[file: template.xlsx]');
  });

  it('keeps Unicode and punctuation readable and removes path separators and controls', async () => {
    await send({ document: { ...file, file_name: '../書式\\資料:様式\u0000\u007f.xlsx' } });
    expect(attachment()).toMatchObject({ name: '.._書式_資料:様式__.xlsx' });
    expect(readdirSync(join(root, 'downloads/telegram'))).toEqual(['11_.._書式_資料:様式__.xlsx']);
  });

  it('reports an invalid filename without losing the caption', async () => {
    await send({ document: { ...file, file_name: '..' } }, 'read this');
    expect(received[0]?.text).toBe('read this');
    expect(attachment()).toEqual({ name: '..', error: 'Attachment filename is empty' });
  });

  it('reports the 20 MB limit before requesting an oversized file', async () => {
    await send({ document: { ...file, file_name: 'large.zip', file_size: 20 * 1024 * 1024 + 1 } });
    expect(attachment()).toEqual({ name: 'large.zip', error: expect.stringContaining('20 MB') });
    expect(bot.getFile).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('checks getFile size too when the message omits it', async () => {
    bot.getFile.mockResolvedValue({ file_path: 'file.bin', file_size: 21 * 1024 * 1024 });
    await send({
      document: { file_id: 'file-id', file_unique_id: 'unique', file_name: 'large.zip' },
    });
    expect(attachment()).toEqual({ name: 'large.zip', error: expect.stringContaining('20 MB') });
    expect(download).not.toHaveBeenCalled();
  });

  it('stops a response that exceeds the limit without leaving a partial input file', async () => {
    download.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(20 * 1024 * 1024));
            controller.enqueue(new Uint8Array(1));
            controller.close();
          },
        })
      )
    );
    await send({ document: { ...file, file_name: 'large.zip' } });
    expect(attachment()).toEqual({ name: 'large.zip', error: expect.stringContaining('20 MB') });
    expect(readdirSync(root)).not.toContain('files');
  });

  it('reports the limit when getFile refuses a file whose size was not supplied', async () => {
    bot.getFile.mockRejectedValue(new Error('Bad Request: file is too big'));
    await send({
      document: { file_id: 'file-id', file_unique_id: 'unique', file_name: 'large.zip' },
    });
    expect(attachment()).toEqual({ name: 'large.zip', error: expect.stringContaining('20 MB') });
  });

  it('cancels an oversized response header before reading any attachment bytes', async () => {
    let pulled = false;
    let cancelled = false;
    download.mockResolvedValue(
      new Response(
        new ReadableStream(
          {
            pull() {
              pulled = true;
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 }
        ),
        { headers: { 'content-length': '20971521' } }
      )
    );
    await send({ document: { ...file, file_name: 'large.zip' } });
    expect(attachment()).toEqual({ name: 'large.zip', error: expect.stringContaining('20 MB') });
    expect(pulled).toBe(false);
    expect(cancelled).toBe(true);
    expect(readdirSync(root)).not.toContain('files');
  });

  it('cancels an underreported stream at the Telegram limit without writing a partial file', async () => {
    let chunks = 0;
    let cancelled = false;
    download.mockResolvedValue(
      new Response(
        new ReadableStream(
          {
            pull(controller) {
              if (chunks++ === 0) controller.enqueue(new Uint8Array(20 * 1024 * 1024));
              else if (chunks === 2) controller.enqueue(new Uint8Array(1));
              else controller.close();
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 }
        ),
        { headers: { 'content-length': '1' } }
      )
    );
    await send({ document: { ...file, file_name: 'large.zip' } });
    expect(attachment()).toEqual({ name: 'large.zip', error: expect.stringContaining('20 MB') });
    expect(cancelled).toBe(true);
    expect(readdirSync(root)).not.toContain('files');
  });

  it('redacts a bot token from download errors passed to the owner agent', async () => {
    download.mockRejectedValue(
      new Error('request failed at https://api.telegram.org/file/botfixture-token/file.bin')
    );
    await send({ document: { ...file, file_name: 'template.xlsx' } });
    expect(attachment()).toMatchObject({
      name: 'template.xlsx',
      error: expect.stringContaining('[redacted]'),
    });
    expect(JSON.stringify(attachment())).not.toContain('fixture-token');
  });

  it('deduplicates an owner attachment before downloading it again', async () => {
    const document = { ...file, file_name: 'template.xlsx' };
    await send({ document });
    await send({ document });
    expect(received).toHaveLength(1);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it.each(['metadata', 'download'])('carries a %s failure to the owner input', async (phase) => {
    if (phase === 'metadata') bot.getFile.mockRejectedValue(new Error('getFile unavailable'));
    else download.mockResolvedValue(new Response('unavailable', { status: 503 }));
    await send({ document: { ...file, file_name: 'template.xlsx' } });
    expect(received[0]?.text).toBe('[file: template.xlsx]');
    expect(attachment()).toEqual({
      name: 'template.xlsx',
      error: expect.stringMatching(phase === 'metadata' ? /getFile unavailable/ : /503/),
    });
    expect(attachment()).not.toHaveProperty('path');
  });

  it('never downloads a non-owner attachment', async () => {
    await send({ from: { id: 10, is_bot: false }, document: { ...file, file_name: 'file.pdf' } });
    expect(received).toEqual([]);
    expect(bot.getFile).not.toHaveBeenCalled();
  });
});
