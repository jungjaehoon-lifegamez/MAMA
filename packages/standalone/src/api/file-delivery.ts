import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  read,
  readSync,
  realpathSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import type { JudgmentAccess } from '@jungjaehoon/mama-core';

export const OWNER_FILE_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const TELEGRAM_MAX_UPLOAD_BYTES = OWNER_FILE_MAX_UPLOAD_BYTES;
export const TELEGRAM_MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const TELEGRAM_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

export interface OwnerFileDeliveryResult {
  messageId?: number | string;
  sentAs: 'photo' | 'document';
  size: number;
  idempotent?: boolean;
}

export interface OwnerFileSender {
  sendFile(
    path: string,
    caption: string | undefined,
    operationId: string,
    member?: MemberFileDeliveryContext
  ): Promise<TelegramFileDeliveryResult>;
}

/** Telegram-only host authority, resolved per call; never part of action input. */
export interface MemberFileDeliveryContext {
  access: JudgmentAccess;
  filesRoot: string;
}

export type TelegramFileDeliveryResult = OwnerFileDeliveryResult;
export type TelegramFileSender = OwnerFileSender;

export interface ValidatedWorkspaceFile {
  path: string;
  size: number;
  sentAs: 'photo' | 'document';
}

export function validateWorkspaceFile(
  filesRoot: string,
  inputPath: string,
  maxBytes: number,
  singleLink = false
): ValidatedWorkspaceFile {
  const { fd, ...validated } = openWorkspaceFile(filesRoot, inputPath, maxBytes, singleLink);
  closeSync(fd);
  return validated;
}

/**
 * Keep this descriptor open through upload so a later path replacement cannot change its bytes.
 * singleLink: the daemon uploads with its own authority, so a member's file must be held by that
 * one path alone; a hard link could alias a file outside the member's workspace.
 */
export function openWorkspaceFile(
  filesRoot: string,
  inputPath: string,
  maxBytes: number,
  singleLink = false
): ValidatedWorkspaceFile & { fd: number } {
  const rootPath = resolve(filesRoot);
  const rootMetadata = lstatSync(rootPath);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('workspace files root must be a directory, not a symlink');
  }
  const root = realpathSync(rootPath);
  if (root !== join(realpathSync(dirname(rootPath)), basename(rootPath))) {
    throw new Error('workspace files root must resolve to its own directory');
  }
  const resolved = resolve(inputPath);
  const metadata = lstatSync(resolved);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('path must be a regular file, not a symlink or directory');
  }
  const real = realpathSync(resolved);
  if (real === root || !real.startsWith(`${root}${sep}`)) {
    throw new Error('path must stay under the workspace files directory');
  }
  const fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error('path must be a regular file');
    if (singleLink && opened.nlink !== 1) throw new Error('path must not be a hard link');
    const size = opened.size;
    if (size > maxBytes) {
      throw new Error(`file exceeds the upload limit of ${maxBytes} bytes`);
    }
    return {
      fd,
      path: real,
      size,
      sentAs:
        size <= TELEGRAM_MAX_PHOTO_BYTES &&
        TELEGRAM_IMAGE_EXTENSIONS.has(extname(real).toLowerCase())
          ? 'photo'
          : 'document',
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Read the validated descriptor without reopening its mutable pathname. The caller closes it. */
export async function* readWorkspaceFile(fd: number): AsyncGenerator<Buffer> {
  while (true) {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const bytesRead = await new Promise<number>((resolve, reject) => {
      read(fd, buffer, 0, buffer.length, null, (error, size) =>
        error ? reject(error) : resolve(size)
      );
    });
    if (bytesRead === 0) return;
    yield buffer.subarray(0, bytesRead);
  }
}

export function workspaceFileIdentity(fd: number, caption?: string): string {
  const hash = createHash('sha256').update(`caption\0${caption ?? ''}\0`);
  const fileSize = fstatSync(fd).size;
  let position = 0;
  while (position < fileSize) {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const size = readSync(fd, buffer, 0, Math.min(buffer.length, fileSize - position), position);
    if (size === 0) throw new Error('Workspace file changed while calculating its identity');
    position += size;
    hash.update(buffer.subarray(0, size));
  }
  return hash.digest('hex');
}
