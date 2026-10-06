import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { TelegramChunkFormat } from './telegram-format.js';

/**
 * Told to the owner when a turn on their message was cut off. The turn is not rerun, since its
 * effects cannot be proven safe to repeat; `delivery.interrupted_notice` gives it in the owner's words.
 */
export const DEFAULT_INTERRUPTED_NOTICE =
  'The previous processing attempt was interrupted. It was not rerun because its external ' +
  'side effects could not be proven safe to repeat. Please send a new message if you want to ' +
  'retry it.';

export type OwnerMessageState = 'processing' | 'ready' | 'delivered' | 'failed';

export interface OwnerMessageLedgerEntry {
  key: string;
  state: OwnerMessageState;
  updatedAt: number;
  ownerId: string;
  response?: string;
  responseAuthor?: 'agent' | 'host';
  nextChunkIndex?: number;
  deliveryUncertain?: boolean;
  /** Missing on pre-formatting receipts, whose original chunk boundaries must survive. */
  chunkFormat?: TelegramChunkFormat;
  deliveryTarget?: string;
  payloadIdentity?: string;
  /** Readable producer identity and confirmed Telegram receipts; absent on older entries. */
  idempotencyKey?: string;
  messageIds?: Array<number | string>;
  /** This inbound input shares the final reply owned by another input in the same chat. */
  sharedReplyKey?: string;
}

export interface OwnerDeliveryBinding {
  deliveryTarget: string;
  payloadIdentity: string;
  idempotencyKey?: string;
  keepDeliveredOnPayloadChange?: boolean;
}

interface LedgerStateV3 {
  version: 3;
  entries: OwnerMessageLedgerEntry[];
}

export interface OwnerMessageLedgerOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
  log?: (line: string) => void;
  ownerId?: string;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_MAX_ENTRIES = 10_000;
const MAX_RESPONSE_CHARS = 1_000_000;
const MAX_LEDGER_FILE_BYTES = 8 * 1024 * 1024;

export class OwnerMessageLedger {
  private readonly entries = new Map<string, OwnerMessageLedgerEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly ownerId: string;

  constructor(
    private readonly path: string,
    options: OwnerMessageLedgerOptions = {}
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.ownerId = options.ownerId ?? randomUUID();
    this.load();
  }

  get(key: string): OwnerMessageLedgerEntry | null {
    this.prune();
    const entry = this.entries.get(key);
    return entry ? { ...entry } : null;
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  listUndelivered(): OwnerMessageLedgerEntry[] {
    this.prune();
    return [...this.entries.values()]
      .filter((entry) => entry.state !== 'delivered')
      .map((entry) => ({ ...entry }));
  }

  isOwnedByCurrentProcess(entry: OwnerMessageLedgerEntry): boolean {
    return entry.ownerId === this.ownerId;
  }

  claim(
    key: string,
    binding?: OwnerDeliveryBinding
  ): { claimed: boolean; entry: OwnerMessageLedgerEntry } {
    this.prune();
    const existing = this.entries.get(key);
    if (existing) {
      if (
        binding &&
        (existing.deliveryTarget !== binding.deliveryTarget ||
          existing.payloadIdentity !== binding.payloadIdentity)
      ) {
        // A regenerated report reuses its delivered key with new wording; the first copy stands.
        if (
          binding.keepDeliveredOnPayloadChange === true &&
          existing.state === 'delivered' &&
          existing.deliveryTarget === binding.deliveryTarget
        ) {
          this.log(`telegram delivered payload identity differs key=${key}`);
          return { claimed: false, entry: { ...existing } };
        }
        throw new Error(`Owner message delivery binding mismatch for ${key}`);
      }
      if (binding?.idempotencyKey !== undefined && existing.idempotencyKey === undefined) {
        const entry = { ...existing, idempotencyKey: binding.idempotencyKey };
        this.commit(() => this.entries.set(key, entry));
        return { claimed: false, entry: { ...entry } };
      }
      return { claimed: false, entry: { ...existing } };
    }
    if (binding && !isDeliveryBinding(binding)) {
      throw new Error(`Owner message delivery binding is invalid for ${key}`);
    }
    const entry: OwnerMessageLedgerEntry = {
      key,
      state: 'processing',
      updatedAt: this.now(),
      ownerId: this.ownerId,
      ...(binding && {
        deliveryTarget: binding.deliveryTarget,
        payloadIdentity: binding.payloadIdentity,
        idempotencyKey: binding.idempotencyKey,
      }),
    };
    this.commit(() => {
      this.entries.set(key, entry);
      this.enforceEntryLimit();
    });
    return { claimed: true, entry: { ...entry } };
  }

  markReady(key: string, response: string, chunkFormat: TelegramChunkFormat = 'plain-v1'): void {
    this.prepareResponse(key, response, chunkFormat, 'agent');
  }

  markInterrupted(
    key: string,
    response: string,
    chunkFormat: TelegramChunkFormat = 'plain-v1'
  ): void {
    this.prepareResponse(key, response, chunkFormat, 'host');
  }

  private prepareResponse(
    key: string,
    response: string,
    chunkFormat: TelegramChunkFormat,
    responseAuthor: 'agent' | 'host'
  ): void {
    if (response.length > MAX_RESPONSE_CHARS) {
      throw new Error('Owner message durable response exceeds its size limit');
    }
    const entry = this.requireEntry(key);
    if (entry.sharedReplyKey) {
      throw new Error('Owner message shared reply cannot prepare a second response');
    }
    this.commit(() => {
      this.entries.set(key, {
        ...entry,
        state: 'ready',
        response,
        responseAuthor,
        chunkFormat,
        nextChunkIndex: 0,
        deliveryUncertain: false,
        updatedAt: this.now(),
        ownerId: this.ownerId,
      });
    });
  }

  markDeliveryProgress(
    key: string,
    nextChunkIndex: number,
    deliveryUncertain: boolean,
    messageId?: number | string
  ): void {
    if (!Number.isSafeInteger(nextChunkIndex) || nextChunkIndex < 0) {
      throw new Error('Owner message delivery progress must be a non-negative integer');
    }
    const entry = this.requireEntry(key);
    if (entry.state !== 'ready' || entry.response === undefined) {
      throw new Error(`Owner message ${key} is not ready for delivery`);
    }
    this.commit(() => {
      this.entries.set(key, {
        ...entry,
        nextChunkIndex,
        deliveryUncertain,
        ...(messageId === undefined
          ? {}
          : { messageIds: [...(entry.messageIds ?? []), messageId] }),
        updatedAt: this.now(),
        ownerId: this.ownerId,
      });
    });
  }

  /** A transport failure can leave remote delivery unknown; never keep it as active work. */
  markFailed(key: string): void {
    const entry = this.requireEntry(key);
    this.commit(() => {
      this.entries.set(key, {
        ...entry,
        state: 'failed',
        deliveryUncertain: true,
        updatedAt: this.now(),
        ownerId: this.ownerId,
      });
    });
  }

  markDelivered(key: string): void {
    this.commit(() => {
      const existing = this.entries.get(key);
      this.entries.delete(key);
      this.entries.set(key, {
        key,
        state: 'delivered',
        updatedAt: this.now(),
        ownerId: this.ownerId,
        ...(existing?.deliveryTarget ? { deliveryTarget: existing.deliveryTarget } : {}),
        ...(existing?.payloadIdentity ? { payloadIdentity: existing.payloadIdentity } : {}),
        ...(existing?.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: existing.idempotencyKey }),
        ...(existing?.messageIds === undefined ? {} : { messageIds: existing.messageIds }),
        ...(existing?.sharedReplyKey ? { sharedReplyKey: existing.sharedReplyKey } : {}),
      });
      this.enforceEntryLimit();
    });
  }

  /** A second accepted input points to the one inbound key that owns the visible reply. */
  markSharedReply(key: string, replyKey: string): void {
    const chat = (value: string): string => value.slice(0, value.lastIndexOf(':'));
    if (
      key === replyKey ||
      key.startsWith('outbound:') ||
      replyKey.startsWith('outbound:') ||
      !chat(key) ||
      chat(key) !== chat(replyKey)
    ) {
      throw new Error('Owner message shared reply must stay in the same chat');
    }
    const entry = this.requireEntry(key);
    const target = this.requireEntry(replyKey);
    if (target.sharedReplyKey)
      throw new Error('Owner message shared reply target is not a reply owner');
    if (entry.state === 'delivered' && entry.sharedReplyKey === replyKey) return;
    if (entry.state !== 'processing') {
      throw new Error('Owner message shared reply conflicts with existing delivery');
    }
    this.commit(() => {
      this.entries.set(key, {
        key,
        state: 'delivered',
        sharedReplyKey: replyKey,
        updatedAt: this.now(),
        ownerId: this.ownerId,
      });
      this.enforceEntryLimit();
    });
  }

  private requireEntry(key: string): OwnerMessageLedgerEntry {
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`Owner message ${key} has not been claimed`);
    return entry;
  }

  private enforceEntryLimit(): void {
    while (this.entries.size > this.maxEntries) {
      if (!this.evictOldestDelivered()) {
        throw new Error('Owner message ledger entry limit is full of undelivered work');
      }
    }
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    if (statSync(this.path).size > MAX_LEDGER_FILE_BYTES) {
      const error = new Error(`Owner message ledger exceeds ${MAX_LEDGER_FILE_BYTES} bytes`);
      this.log(`[owner-message] message ledger rejected without modification: ${error.message}`);
      throw error;
    }
    let serialized: string;
    try {
      serialized = readFileSync(this.path, 'utf8');
    } catch (error) {
      this.log(
        `[owner-message] message ledger read failed without modification: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(serialized);
      if (isLedgerStateV3(parsed, this.maxEntries)) {
        for (const entry of parsed.entries) {
          this.loadEntry(entry);
        }
      } else {
        throw new Error('invalid Owner message ledger');
      }
      this.prune();
    } catch (error) {
      const quarantinePath = `${this.path}.corrupt-${this.now()}-${process.pid}`;
      renameSync(this.path, quarantinePath);
      this.entries.clear();
      this.log(
        `[owner-message] invalid message ledger quarantined at ${quarantinePath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      throw new Error('Owner message ledger is corrupt; delivery cannot continue', {
        cause: error,
      });
    }
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.state === 'delivered' && entry.updatedAt < cutoff) {
        this.entries.delete(key);
      }
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.tmp`;
    let serialized = this.serialize();
    while (Buffer.byteLength(serialized, 'utf8') > MAX_LEDGER_FILE_BYTES) {
      if (!this.evictOldestDelivered()) {
        throw new Error('Owner message ledger exceeds its durable size limit');
      }
      serialized = this.serialize();
    }
    writeFileSync(temporaryPath, serialized, { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, this.path);
  }

  private serialize(): string {
    const state: LedgerStateV3 = { version: 3, entries: [...this.entries.values()] };
    return `${JSON.stringify(state)}\n`;
  }

  private loadEntry(entry: OwnerMessageLedgerEntry): void {
    if (entry.state === 'delivered') {
      const { response: _response, ...delivered } = entry;
      this.entries.set(entry.key, delivered);
      return;
    }
    this.entries.set(entry.key, entry);
  }

  private evictOldestDelivered(): boolean {
    for (const [key, entry] of this.entries) {
      if (entry.state === 'delivered') {
        this.entries.delete(key);
        return true;
      }
    }
    return false;
  }

  private commit(change: () => void): void {
    const snapshot = new Map(this.entries);
    try {
      change();
      this.save();
    } catch (error) {
      this.entries.clear();
      for (const [key, entry] of snapshot) this.entries.set(key, entry);
      throw error;
    }
  }
}

function isLedgerStateV3(value: unknown, maxEntries: number): value is LedgerStateV3 {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 3 ||
    !Array.isArray(record.entries) ||
    record.entries.length > maxEntries
  ) {
    return false;
  }
  return record.entries.every((entry) => {
    return (
      isLedgerEntry(entry) &&
      (!entry.key.startsWith('outbound:') ||
        isDeliveryBinding({
          deliveryTarget: entry.deliveryTarget,
          payloadIdentity: entry.payloadIdentity,
        }))
    );
  });
}

function isLedgerEntry(value: unknown): value is OwnerMessageLedgerEntry {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    isKey(item.key) &&
    (item.state === 'processing' ||
      item.state === 'ready' ||
      item.state === 'delivered' ||
      item.state === 'failed') &&
    isTimestamp(item.updatedAt) &&
    typeof item.ownerId === 'string' &&
    item.ownerId.length > 0 &&
    item.ownerId.length <= 128 &&
    (item.response === undefined ||
      (typeof item.response === 'string' && item.response.length <= MAX_RESPONSE_CHARS)) &&
    (item.responseAuthor === undefined ||
      item.responseAuthor === 'agent' ||
      item.responseAuthor === 'host') &&
    (item.nextChunkIndex === undefined ||
      (Number.isSafeInteger(item.nextChunkIndex) && (item.nextChunkIndex as number) >= 0)) &&
    (item.deliveryUncertain === undefined || typeof item.deliveryUncertain === 'boolean') &&
    (item.idempotencyKey === undefined || typeof item.idempotencyKey === 'string') &&
    (item.messageIds === undefined ||
      (Array.isArray(item.messageIds) &&
        item.messageIds.every((id) =>
          typeof id === 'string'
            ? id.length > 0 && id.length <= 256
            : Number.isSafeInteger(id) && id > 0
        ))) &&
    (item.sharedReplyKey === undefined ||
      (typeof item.sharedReplyKey === 'string' &&
        item.state === 'delivered' &&
        !item.key.startsWith('outbound:') &&
        !item.sharedReplyKey.startsWith('outbound:') &&
        item.key !== item.sharedReplyKey &&
        item.key.slice(0, item.key.lastIndexOf(':')) ===
          item.sharedReplyKey.slice(0, item.sharedReplyKey.lastIndexOf(':')))) &&
    (item.chunkFormat === undefined ||
      item.chunkFormat === 'plain-v1' ||
      item.chunkFormat === 'html-v1') &&
    ((item.deliveryTarget === undefined && item.payloadIdentity === undefined) ||
      isDeliveryBinding({
        deliveryTarget: item.deliveryTarget,
        payloadIdentity: item.payloadIdentity,
      }))
  );
}

function isDeliveryBinding(value: {
  deliveryTarget: unknown;
  payloadIdentity: unknown;
}): value is OwnerDeliveryBinding {
  return (
    typeof value.deliveryTarget === 'string' &&
    value.deliveryTarget.length > 0 &&
    value.deliveryTarget.length <= 1_024 &&
    typeof value.payloadIdentity === 'string' &&
    /^[a-f0-9]{64}$/.test(value.payloadIdentity)
  );
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// Existing receipts stay byte-for-byte compatible; Telegram callers keep their established names.
export { OwnerMessageLedger as TelegramMessageLedger };
export type TelegramMessageLedgerEntry = OwnerMessageLedgerEntry;
export type TelegramMessageLedgerOptions = OwnerMessageLedgerOptions;
export type TelegramDeliveryBinding = OwnerDeliveryBinding;
export type TelegramMessageState = OwnerMessageState;
