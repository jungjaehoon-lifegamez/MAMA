import { homedir } from 'node:os';
import { join } from 'node:path';

import type { StreamCallbacks } from '../agent/types.js';

const DEFAULT_THROTTLE_MS = 800;
const DEFAULT_MAX_LENGTH = 4096;
const EMPTY_RESPONSE_MESSAGE = 'No response was generated.';

export interface TelegramResponseAdapter {
  send(text: string): Promise<string | null>;
  edit(handle: string, text: string): Promise<void>;
  delete(handle: string): Promise<void>;
}

export interface TelegramResponsePresenterOptions {
  throttleMs?: number;
  maxLength?: number;
  chunkRetryCount?: number;
  resumeFromChunk?: number;
  onChunkProgress?: (nextIndex: number, uncertain: boolean) => void | Promise<void>;
}

function stripLeadingReasoningDecoration(text: string): string | null {
  if (!text.startsWith('||')) {
    return text;
  }
  const closing = text.indexOf('||', 2);
  if (closing < 0) {
    return null;
  }
  return text.slice(closing + 2).replace(/^\s+/, '');
}

function redactInboundMediaPaths(text: string): string {
  let redacted = text.replace(
    /(?:\/[\w.@+-]+)*\/\.mama\/workspace\/media\/inbound\/[^\s]+/g,
    '[attachment]'
  );
  const workspaces = new Set([process.env.MAMA_WORKSPACE, join(homedir(), '.mama', 'workspace')]);
  for (const workspace of workspaces) {
    if (!workspace) continue;
    const inboundRoot = join(workspace, 'media', 'inbound');
    const escapedRoot = inboundRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    redacted = redacted.replace(new RegExp(`${escapedRoot}(?:/[^\\s]+)+`, 'g'), '[attachment]');
  }
  return redacted;
}

function sanitizeVisibleText(text: string): string | null {
  const withoutDecoration = stripLeadingReasoningDecoration(text);
  return withoutDecoration === null ? null : redactInboundMediaPaths(withoutDecoration);
}

function telegramErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSafeRateLimitRetry(error: unknown): boolean {
  if (error && typeof error === 'object' && 'error_code' in error && error.error_code === 429) {
    return true;
  }
  return /(?:^|\b)429\b|too many requests/i.test(telegramErrorMessage(error));
}

export function splitTelegramMessage(text: string, maxLength: number): string[] {
  const codePoints = Array.from(text);
  if (codePoints.length <= maxLength) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = codePoints;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining.join(''));
      break;
    }
    const candidate = remaining.slice(0, maxLength);
    const newline = candidate.lastIndexOf('\n');
    const splitAt = newline > maxLength * 0.3 ? newline + 1 : maxLength;
    chunks.push(remaining.slice(0, splitAt).join(''));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

export class TelegramResponsePresenter {
  private readonly adapter: TelegramResponseAdapter;
  private readonly throttleMs: number;
  private readonly maxLength: number;
  private handle: string | null = null;
  private accumulatedText = '';
  private toolStatus = '';
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlightEdit: Promise<void> = Promise.resolve();
  private finalized = false;
  private finalizing = false;
  private readonly chunkRetryCount: number;
  private readonly resumeFromChunk: number;
  private readonly onChunkProgress?: TelegramResponsePresenterOptions['onChunkProgress'];

  constructor(adapter: TelegramResponseAdapter, options: TelegramResponsePresenterOptions = {}) {
    this.adapter = adapter;
    this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
    this.maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
    this.chunkRetryCount = Math.max(1, options.chunkRetryCount ?? 3);
    this.resumeFromChunk = Math.max(0, options.resumeFromChunk ?? 0);
    this.onChunkProgress = options.onChunkProgress;
  }

  async start(): Promise<void> {
    if (this.handle || this.finalized || this.finalizing) {
      return;
    }
    try {
      this.handle = await this.adapter.send('⏳');
    } catch {
      this.handle = null;
    }
  }

  callbacks(): StreamCallbacks {
    return {
      onDelta: (text) => {
        if (this.finalized || this.finalizing) {
          return;
        }
        this.accumulatedText += text;
        this.scheduleEdit();
      },
      onToolUse: (name) => {
        if (this.finalized || this.finalizing) {
          return;
        }
        this.toolStatus = `🔧 ${name}...`;
        this.scheduleEdit();
      },
      onToolComplete: (name, _toolUseId, isError) => {
        if (this.finalized || this.finalizing || this.accumulatedText) {
          return;
        }
        this.toolStatus = `${isError ? '❌' : '✅'} ${name}`;
        this.scheduleEdit();
      },
    };
  }

  markQueued(): void {
    if (this.finalized || this.finalizing) {
      return;
    }
    this.toolStatus = '⏳ Waiting for the earlier task to finish.';
    this.scheduleEdit();
  }

  async finalize(rawResponse: string): Promise<void> {
    if (this.finalized || this.finalizing) {
      return;
    }
    this.finalizing = true;
    this.cancelPendingEdit();
    try {
      await this.inFlightEdit;

      const sanitized = sanitizeVisibleText(rawResponse);
      const visible = (sanitized ?? '').trim() || EMPTY_RESPONSE_MESSAGE;
      const chunks = splitTelegramMessage(visible, this.maxLength);

      if (this.resumeFromChunk >= chunks.length) {
        this.finalized = true;
        return;
      }

      if (!this.handle || this.resumeFromChunk > 0) {
        if (this.handle) {
          const staleHandle = this.handle;
          this.handle = null;
          await this.adapter.delete(staleHandle).catch(() => {});
        }
        await this.sendChunks(chunks.slice(this.resumeFromChunk), this.resumeFromChunk);
        this.finalized = true;
        return;
      }

      const handle = this.handle;
      this.handle = null;
      try {
        await this.recordChunkProgress(0, true);
        await this.adapter.edit(handle, chunks[0]);
      } catch (error) {
        const message = telegramErrorMessage(error);
        if (/message is not modified/i.test(message)) {
          // Telegram already has the desired text. Treat this as committed.
        } else if (/message to edit not found/i.test(message)) {
          await this.adapter.delete(handle).catch(() => {});
          await this.sendChunks(chunks);
          this.finalized = true;
          return;
        } else {
          // A timeout/network error may mean the edit was applied remotely.
          // Do not delete and resend an answer that could already be visible.
          throw error;
        }
      }
      await this.recordChunkProgress(1, false);
      await this.sendChunks(chunks.slice(1), 1);
      this.finalized = true;
    } finally {
      this.finalizing = false;
    }
  }

  async fail(message: string): Promise<void> {
    await this.finalize(message);
  }

  private scheduleEdit(): void {
    if (this.editTimer || this.finalized) {
      return;
    }
    this.editTimer = setTimeout(() => {
      this.editTimer = null;
      this.inFlightEdit = this.inFlightEdit.then(() => this.flushStreamingEdit());
    }, this.throttleMs);
  }

  private async flushStreamingEdit(): Promise<void> {
    if (this.finalized || !this.handle) {
      return;
    }
    const sanitized = sanitizeVisibleText(this.accumulatedText);
    if (sanitized === null) {
      return;
    }
    const visible = sanitized.trim() || this.toolStatus;
    if (!visible) {
      return;
    }
    const visibleCodePoints = Array.from(visible);
    const bounded =
      visibleCodePoints.length > this.maxLength
        ? visibleCodePoints.slice(-this.maxLength).join('')
        : visible;
    await this.adapter.edit(this.handle, bounded).catch(() => {});
  }

  private cancelPendingEdit(): void {
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }
  }

  private async sendChunks(chunks: string[], startIndex = 0): Promise<void> {
    for (let offset = 0; offset < chunks.length; offset += 1) {
      const chunk = chunks[offset];
      const chunkIndex = startIndex + offset;
      let lastError: unknown;
      for (let attempt = 1; attempt <= this.chunkRetryCount; attempt += 1) {
        try {
          await this.recordChunkProgress(chunkIndex, true);
          await this.adapter.send(chunk);
          await this.recordChunkProgress(chunkIndex + 1, false);
          lastError = undefined;
          break;
        } catch (error) {
          if (!isSafeRateLimitRetry(error)) throw error;
          lastError = error;
        }
      }
      if (lastError) throw lastError;
    }
  }

  private async recordChunkProgress(nextIndex: number, uncertain: boolean): Promise<void> {
    await this.onChunkProgress?.(nextIndex, uncertain);
  }
}
