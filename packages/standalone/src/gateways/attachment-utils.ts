/**
 * Shared attachment utilities for downloading, compressing, and building content blocks.
 * Used by Discord and Slack gateways.
 */

import type { MessageAttachment, ContentBlock } from './types.js';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';

const { DebugLogger } = debugLogger as unknown as {
  DebugLogger: new (context?: string) => {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};
const logger = new DebugLogger('AttachmentUtils');

/**
 * Download a file from URL to local inbound media directory.
 *
 * @param url - File URL to download
 * @param filename - Original filename
 * @param authHeaders - Optional auth headers (e.g., Slack Bearer token)
 * @returns Local file path
 */
export async function downloadFile(
  url: string,
  filename: string,
  authHeaders?: Record<string, string>
): Promise<string> {
  const fs = await import('fs/promises');
  const path = await import('path');

  const mediaDir = path.join(process.env.HOME || '', '.mama', 'workspace', 'media', 'inbound');
  await fs.mkdir(mediaDir, { recursive: true });

  const timestamp = Date.now();
  const localPath = path.join(mediaDir, `${timestamp}-${filename.replace(/[^a-zA-Z0-9.-]/g, '_')}`);

  const headers: Record<string, string> = { ...authHeaders };
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(localPath, buffer);

  return localPath;
}

/**
 * Compress an image buffer using sharp (progressive JPEG downscaling).
 */
export async function compressImage(buffer: Buffer, maxSizeBytes: number): Promise<Buffer> {
  try {
    const sharp = (await import('sharp')).default;

    let compressed = await sharp(buffer)
      .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    if (compressed.length > maxSizeBytes) {
      compressed = await sharp(buffer)
        .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 75 })
        .toBuffer();
    }

    if (compressed.length > maxSizeBytes) {
      compressed = await sharp(buffer)
        .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toBuffer();
    }

    return compressed;
  } catch (err) {
    logger.warn(`sharp not available, cannot compress: ${err}`);
    return buffer;
  }
}

/**
 * Detect actual image media type from magic bytes.
 */
export function detectImageType(buffer: Buffer): string | null {
  if (buffer.length < 12) {
    return null;
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  // GIF: 47 49 46 38
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return 'image/gif';
  }
  // WebP: RIFF....WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

const SUPPORTED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/**
 * Build content blocks from attachments.
 * Images are base64-encoded for Claude Vision; documents are referenced by path.
 */
export async function buildContentBlocks(
  attachments: MessageAttachment[]
): Promise<ContentBlock[]> {
  const contentBlocks: ContentBlock[] = [];

  for (const attachment of attachments) {
    if (!attachment.localPath) continue;

    try {
      if (attachment.type === 'image') {
        const fs = await import('fs/promises');
        let imageBuffer = await fs.readFile(attachment.localPath);
        let wasCompressed = false;

        const MAX_RAW_SIZE = 5 * 1024 * 1024;
        if (imageBuffer.length > MAX_RAW_SIZE) {
          logger.info(
            `Image too large (${(imageBuffer.length / 1024 / 1024).toFixed(2)}MB), compressing...`
          );
          const compressed = await compressImage(imageBuffer, MAX_RAW_SIZE);
          imageBuffer = Buffer.from(compressed);
          wasCompressed = true;
          logger.info(`Compressed to ${(imageBuffer.length / 1024 / 1024).toFixed(2)}MB`);
        }

        const base64Data = imageBuffer.toString('base64');
        const detectedType = detectImageType(imageBuffer);
        let mediaType = wasCompressed
          ? 'image/jpeg'
          : detectedType || attachment.contentType || 'image/png';

        if (!SUPPORTED_MEDIA_TYPES.includes(mediaType)) {
          if (mediaType.startsWith('image/')) {
            mediaType = detectedType || 'image/png';
          } else {
            logger.warn(`Unsupported media type: ${mediaType}, skipping`);
            continue;
          }
        }

        contentBlocks.push({
          type: 'text',
          text: `[Image: ${attachment.filename}, saved at: ${attachment.localPath}]`,
        });

        contentBlocks.push({
          type: 'image',
          localPath: attachment.localPath,
          source: {
            type: 'base64',
            media_type: mediaType,
            data: base64Data,
          },
        });
      } else {
        contentBlocks.push({
          type: 'text',
          text: `[File: ${attachment.filename}, type: ${attachment.contentType}, saved at: ${attachment.localPath}]`,
        });
      }
    } catch (err) {
      logger.error(`Failed to build content block: ${err}`);
    }
  }

  return contentBlocks;
}
