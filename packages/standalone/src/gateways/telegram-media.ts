import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, extname, resolve, sep } from 'node:path';

const TELEGRAM_HOSTED_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
const DEFAULT_ATTACHMENT_LIMIT_BYTES = 25 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;

export interface TelegramFileMetadata {
  file_path?: string;
  file_size?: number;
}

export interface TelegramMediaDownloadRequest {
  botToken: string;
  fileId: string;
  fileUniqueId: string;
  filename?: string;
  mimeType?: string;
  declaredSize?: number;
  kind: 'photo' | 'document';
  mediaRoot: string;
  maxBytes?: number;
  timeoutMs?: number;
  getFile: (fileId: string) => Promise<TelegramFileMetadata>;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export interface TelegramMediaDownloadResult {
  localPath: string;
  sourceRef: string;
  filename: string;
  mimeType: string;
  size: number;
  kind: 'photo' | 'document';
}

class TelegramMediaError extends Error {}

async function withDownloadTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new TelegramMediaError('Telegram media download timed out')),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function configuredAttachmentLimit(): number {
  const configured = Number(process.env.MAMA_ATTACHMENT_MAX_DOWNLOAD_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_ATTACHMENT_LIMIT_BYTES;
}

function effectiveLimit(requested?: number): number {
  const base = requested && requested > 0 ? requested : configuredAttachmentLimit();
  return Math.min(base, TELEGRAM_HOSTED_DOWNLOAD_LIMIT_BYTES);
}

function safeOpaqueId(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  return sanitized || randomUUID();
}

function safeFilename(request: TelegramMediaDownloadRequest): string {
  const opaqueId = safeOpaqueId(request.fileUniqueId);
  const fallback = request.kind === 'photo' ? `photo-${opaqueId}.jpg` : `document-${opaqueId}.bin`;
  const raw = request.filename ? basename(request.filename.replace(/\\/g, '/')) : fallback;
  const sanitized = raw.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
  if (!sanitized) {
    return fallback;
  }
  if (request.kind === 'photo' && !extname(sanitized)) {
    return `${sanitized}.jpg`;
  }
  if (request.kind === 'document' && !extname(sanitized)) {
    return `${sanitized}.bin`;
  }
  return sanitized;
}

function assertSafeTelegramPath(filePath: string | undefined): string {
  if (!filePath) {
    throw new TelegramMediaError('Telegram media path is unavailable');
  }
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (
    normalized.startsWith('/') ||
    normalized.includes('\0') ||
    segments.some((segment) => segment === '..' || segment === '')
  ) {
    throw new TelegramMediaError('Telegram media path is invalid');
  }
  return normalized;
}

function assertWithinRoot(root: string, candidate: string): void {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (!resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)) {
    throw new TelegramMediaError('Telegram media storage path is invalid');
  }
}

function downloadUrl(botToken: string, filePath: string): string {
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  return `https://api.telegram.org/file/bot${botToken}/${encodedPath}`;
}

export async function downloadTelegramMedia(
  request: TelegramMediaDownloadRequest
): Promise<TelegramMediaDownloadResult> {
  const limit = effectiveLimit(request.maxBytes);
  const timeoutMs =
    request.timeoutMs && request.timeoutMs > 0 ? request.timeoutMs : DEFAULT_DOWNLOAD_TIMEOUT_MS;
  if (request.declaredSize !== undefined && request.declaredSize > limit) {
    throw new TelegramMediaError('Telegram media exceeds the download limit');
  }

  const metadata = await withDownloadTimeout(request.getFile(request.fileId), timeoutMs);
  if (metadata.file_size !== undefined && metadata.file_size > limit) {
    throw new TelegramMediaError('Telegram media exceeds the download limit');
  }
  const filePath = assertSafeTelegramPath(metadata.file_path);

  const root = resolve(request.mediaRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);

  const fetchImpl = request.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await withDownloadTimeout(
      fetchImpl(downloadUrl(request.botToken, filePath), {
        signal: AbortSignal.timeout(timeoutMs),
      }),
      timeoutMs
    );
  } catch (error) {
    if (error instanceof TelegramMediaError) {
      throw error;
    }
    throw new TelegramMediaError('Telegram media download failed');
  }
  if (!response.ok || !response.body) {
    throw new TelegramMediaError('Telegram media download failed');
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw new TelegramMediaError('Telegram media exceeds the download limit');
  }

  const filename = safeFilename(request);
  const id = randomUUID();
  const tempPath = resolve(root, `.${id}.part`);
  const finalPath = resolve(root, `${id}-${filename}`);
  assertWithinRoot(root, tempPath);
  assertWithinRoot(root, finalPath);

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let totalBytes = 0;
  try {
    handle = await open(tempPath, 'wx', 0o600);
    const reader = response.body.getReader();
    let streamComplete = false;
    while (!streamComplete) {
      const { done, value } = await withDownloadTimeout(reader.read(), timeoutMs);
      if (done) {
        streamComplete = true;
        continue;
      }
      totalBytes += value.byteLength;
      if (totalBytes > limit) {
        await reader.cancel();
        throw new TelegramMediaError('Telegram media exceeds the download limit');
      }
      await handle.write(value);
    }
    await handle.close();
    handle = null;
    await chmod(tempPath, 0o600);
    await rename(tempPath, finalPath);
    await chmod(finalPath, 0o600);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await unlink(tempPath).catch(() => {});
    if (error instanceof TelegramMediaError) {
      throw error;
    }
    throw new TelegramMediaError('Telegram media download failed');
  }

  return {
    localPath: finalPath,
    sourceRef: `telegram:${safeOpaqueId(request.fileUniqueId)}`,
    filename,
    mimeType:
      request.mimeType || (request.kind === 'photo' ? 'image/jpeg' : 'application/octet-stream'),
    size: totalBytes,
    kind: request.kind,
  };
}
