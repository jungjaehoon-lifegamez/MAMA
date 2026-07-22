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
  return text.replace(
    /(?:\/[\w.@+-]+)*\/\.mama\/workspace\/media\/inbound\/[^\s]+/g,
    '[attachment]'
  );
}

function sanitizeVisibleText(text: string): string | null {
  const withoutDecoration = stripLeadingReasoningDecoration(text);
  return withoutDecoration === null ? null : redactInboundMediaPaths(withoutDecoration);
}

function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, maxLength));
    remaining = remaining.slice(maxLength);
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

  constructor(adapter: TelegramResponseAdapter, options: TelegramResponsePresenterOptions = {}) {
    this.adapter = adapter;
    this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
    this.maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  }

  async start(): Promise<void> {
    if (this.handle || this.finalized) {
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
        if (this.finalized) {
          return;
        }
        this.accumulatedText += text;
        this.scheduleEdit();
      },
      onToolUse: (name) => {
        if (this.finalized) {
          return;
        }
        this.toolStatus = `🔧 ${name}...`;
        this.scheduleEdit();
      },
      onToolComplete: (name, _toolUseId, isError) => {
        if (this.finalized || this.accumulatedText) {
          return;
        }
        this.toolStatus = `${isError ? '❌' : '✅'} ${name}`;
        this.scheduleEdit();
      },
    };
  }

  async finalize(rawResponse: string): Promise<void> {
    if (this.finalized) {
      return;
    }
    this.finalized = true;
    this.cancelPendingEdit();
    await this.inFlightEdit;

    const sanitized = sanitizeVisibleText(rawResponse);
    const visible = (sanitized ?? '').trim() || EMPTY_RESPONSE_MESSAGE;
    const chunks = splitMessage(visible, this.maxLength);

    if (!this.handle) {
      await this.sendChunks(chunks);
      return;
    }

    const handle = this.handle;
    this.handle = null;
    try {
      await this.adapter.edit(handle, chunks[0]);
    } catch {
      await this.adapter.delete(handle).catch(() => {});
      await this.sendChunks(chunks);
      return;
    }
    await this.sendChunks(chunks.slice(1));
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
    const bounded = visible.length > this.maxLength ? visible.slice(-this.maxLength) : visible;
    await this.adapter.edit(this.handle, bounded).catch(() => {});
  }

  private cancelPendingEdit(): void {
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }
  }

  private async sendChunks(chunks: string[]): Promise<void> {
    for (const chunk of chunks) {
      await this.adapter.send(chunk);
    }
  }
}
