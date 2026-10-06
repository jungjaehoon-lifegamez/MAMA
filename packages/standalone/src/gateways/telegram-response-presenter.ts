import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDefinitiveTelegramRejection } from './telegram-errors.js';

import {
  formatTelegramMessage,
  TELEGRAM_MAX_MESSAGE_LENGTH,
  type TelegramFormattedText,
  type TelegramChunkFormat,
} from './telegram-format.js';

const DEFAULT_MAX_LENGTH = TELEGRAM_MAX_MESSAGE_LENGTH;
const EMPTY_RESPONSE_MESSAGE = 'No response was generated.';
/** The host-written placeholder shown while the answer is still forming. */
const PENDING_PLACEHOLDER = '⏳';

/**
 * The transport seam. Every visible payload crosses it already formatted, so
 * the presenter owns the conversion and the transport owns only delivery.
 */
export interface TelegramResponseAdapter {
  send(message: TelegramFormattedText): Promise<string | null>;
  edit(handle: string, message: TelegramFormattedText): Promise<void>;
  delete(handle: string): Promise<void>;
}

/** A status line the host writes itself; it carries no model markup. */
function plain(text: string): TelegramFormattedText {
  return { text, entities: [] };
}

export interface TelegramResponsePresenterOptions {
  chunkFormat?: TelegramChunkFormat;
  /** Serialize the final multipart batch. */
  withDelivery?: (send: () => Promise<void>) => Promise<void>;
  log?: (line: string) => void;
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

export class TelegramResponsePresenter {
  private readonly chunkFormat: TelegramChunkFormat;
  private readonly adapter: TelegramResponseAdapter;
  private readonly withDelivery: (send: () => Promise<void>) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly maxLength: number;
  private handle: string | null = null;
  private finalized = false;
  private finalText: string | null = null;
  private finalizing = false;
  private readonly chunkRetryCount: number;
  private readonly resumeFromChunk: number;
  private readonly onChunkProgress?: TelegramResponsePresenterOptions['onChunkProgress'];

  constructor(adapter: TelegramResponseAdapter, options: TelegramResponsePresenterOptions = {}) {
    this.chunkFormat = options.chunkFormat ?? 'html-v1';
    this.adapter = adapter;
    this.withDelivery = options.withDelivery ?? ((send) => send());
    this.log = options.log ?? ((line) => console.log(line));
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
      this.handle = await this.adapter.send(plain(PENDING_PLACEHOLDER));
    } catch (error) {
      this.handle = null;
      this.log(
        `telegram placeholder send failed error=${telegramErrorMessage(error).replace(/[\r\n]+/g, ' ')}`
      );
      // Continue the turn: finalize() sends the answer as a new message without a placeholder.
    }
  }

  get deliveredText(): string {
    // A partially sent batch is not a delivered reply.
    if (!this.finalized || this.finalText === null)
      throw new Error('Telegram final text is not delivered');
    return this.finalText;
  }

  async finalize(rawResponse: string): Promise<void> {
    if (this.finalized || this.finalizing) {
      return;
    }
    this.finalizing = true;
    try {
      await this.withDelivery(() => this.deliverFinal(rawResponse));
    } finally {
      this.finalizing = false;
    }
  }

  private async deliverFinal(rawResponse: string): Promise<void> {
    const sanitized = sanitizeVisibleText(rawResponse);
    const visible = (sanitized ?? '').trim() || EMPTY_RESPONSE_MESSAGE;
    const chunks = formatTelegramMessage(visible, this.maxLength, this.chunkFormat);
    this.finalText = chunks.map((chunk) => chunk.text).join('\n');

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
        if (isDefinitiveTelegramRejection(error)) await this.recordChunkProgress(0, false);
        // A timeout/network error may mean the edit was applied remotely.
        // Do not delete and resend an answer that could already be visible.
        throw error;
      }
    }
    await this.recordChunkProgress(1, false);
    await this.sendChunks(chunks.slice(1), 1);
    this.finalized = true;
  }

  /** Stop delivery while the durable input waits for result reconciliation. */
  async suspend(): Promise<void> {
    this.finalized = true;
  }

  async fail(message: string): Promise<void> {
    await this.finalize(message);
  }

  private async sendChunks(chunks: TelegramFormattedText[], startIndex = 0): Promise<void> {
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
          if (isDefinitiveTelegramRejection(error) || isSafeRateLimitRetry(error)) {
            await this.recordChunkProgress(chunkIndex, false);
          }
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
