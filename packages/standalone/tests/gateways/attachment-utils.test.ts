import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  detectImageType,
  buildContentBlocks,
  compressImage,
} from '../../src/gateways/attachment-utils.js';
import type { MessageAttachment } from '../../src/gateways/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('detectImageType', () => {
  it('detects JPEG from magic bytes', () => {
    const buf = Buffer.alloc(12);
    buf[0] = 0xff;
    buf[1] = 0xd8;
    buf[2] = 0xff;
    expect(detectImageType(buf)).toBe('image/jpeg');
  });

  it('detects PNG from magic bytes', () => {
    const buf = Buffer.alloc(12);
    buf[0] = 0x89;
    buf[1] = 0x50;
    buf[2] = 0x4e;
    buf[3] = 0x47;
    expect(detectImageType(buf)).toBe('image/png');
  });

  it('detects GIF from magic bytes', () => {
    const buf = Buffer.alloc(12);
    buf[0] = 0x47;
    buf[1] = 0x49;
    buf[2] = 0x46;
    buf[3] = 0x38;
    expect(detectImageType(buf)).toBe('image/gif');
  });

  it('detects WebP from magic bytes', () => {
    const buf = Buffer.alloc(12);
    // RIFF
    buf[0] = 0x52;
    buf[1] = 0x49;
    buf[2] = 0x46;
    buf[3] = 0x46;
    // WEBP at offset 8
    buf[8] = 0x57;
    buf[9] = 0x45;
    buf[10] = 0x42;
    buf[11] = 0x50;
    expect(detectImageType(buf)).toBe('image/webp');
  });

  it('returns null for unknown format', () => {
    const buf = Buffer.alloc(12, 0);
    expect(detectImageType(buf)).toBeNull();
  });

  it('returns null for buffer too short', () => {
    const buf = Buffer.alloc(5);
    expect(detectImageType(buf)).toBeNull();
  });
});

describe('buildContentBlocks', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'attachment-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('builds text block for file attachments', async () => {
    const filePath = path.join(tmpDir, 'report.pdf');
    await fs.writeFile(filePath, 'fake pdf content');

    const attachments: MessageAttachment[] = [
      {
        type: 'file',
        url: 'https://example.com/report.pdf',
        localPath: filePath,
        filename: 'report.pdf',
        contentType: 'application/pdf',
        size: 1024,
      },
    ];

    const blocks = await buildContentBlocks(attachments);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toContain('[File: report.pdf');
    expect(blocks[0].text).toContain('application/pdf');
    expect(blocks[0].text).toContain(filePath);
  });

  it('builds image blocks with base64 encoding', async () => {
    // Create a tiny valid PNG (1x1 pixel)
    const pngHeader = Buffer.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a, // PNG signature
      0x00,
      0x00,
      0x00,
      0x0d, // IHDR length
      0x49,
      0x48,
      0x44,
      0x52, // IHDR
    ]);
    const imagePath = path.join(tmpDir, 'test.png');
    // Write enough bytes for detection (12+) with PNG magic
    const fullPng = Buffer.alloc(64);
    pngHeader.copy(fullPng);
    await fs.writeFile(imagePath, fullPng);

    const attachments: MessageAttachment[] = [
      {
        type: 'image',
        url: 'https://example.com/test.png',
        localPath: imagePath,
        filename: 'test.png',
        contentType: 'image/png',
        size: 64,
      },
    ];

    const blocks = await buildContentBlocks(attachments);
    // Should produce text block + image block
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toContain('[Image: test.png');
    expect(blocks[1].type).toBe('image');
    expect(blocks[1].source?.type).toBe('base64');
    expect(blocks[1].source?.media_type).toBe('image/png');
    expect(blocks[1].source?.data).toBeTruthy();
  });

  it('skips attachments without localPath', async () => {
    const attachments: MessageAttachment[] = [
      {
        type: 'file',
        url: 'https://example.com/file.txt',
        filename: 'file.txt',
        contentType: 'text/plain',
      },
    ];

    const blocks = await buildContentBlocks(attachments);
    expect(blocks).toHaveLength(0);
  });

  it('handles mixed attachments', async () => {
    const imagePath = path.join(tmpDir, 'photo.jpg');
    const jpegBuf = Buffer.alloc(64);
    jpegBuf[0] = 0xff;
    jpegBuf[1] = 0xd8;
    jpegBuf[2] = 0xff;
    await fs.writeFile(imagePath, jpegBuf);

    const docPath = path.join(tmpDir, 'doc.txt');
    await fs.writeFile(docPath, 'hello world');

    const attachments: MessageAttachment[] = [
      {
        type: 'image',
        url: 'https://example.com/photo.jpg',
        localPath: imagePath,
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
        size: 64,
      },
      {
        type: 'file',
        url: 'https://example.com/doc.txt',
        localPath: docPath,
        filename: 'doc.txt',
        contentType: 'text/plain',
        size: 11,
      },
    ];

    const blocks = await buildContentBlocks(attachments);
    // image: text + image block, file: text block = 3 total
    expect(blocks).toHaveLength(3);
    expect(blocks[0].type).toBe('text');
    expect(blocks[1].type).toBe('image');
    expect(blocks[2].type).toBe('text');
    expect(blocks[2].text).toContain('[File: doc.txt');
  });
});

describe('compressImage', () => {
  it('returns original buffer when sharp is not available and buffer is small', async () => {
    const smallBuffer = Buffer.alloc(100, 0);
    const result = await compressImage(smallBuffer, 5 * 1024 * 1024);
    // Without sharp, returns the same buffer
    expect(result.length).toBe(100);
  });
});
