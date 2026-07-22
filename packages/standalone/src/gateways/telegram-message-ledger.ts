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

export type TelegramMessageState = 'processing' | 'ready' | 'delivered';

export interface TelegramMessageLedgerEntry {
  key: string;
  state: TelegramMessageState;
  updatedAt: number;
  ownerId: string;
  response?: string;
  nextChunkIndex?: number;
  deliveryUncertain?: boolean;
}

interface LedgerStateV2 {
  version: 2;
  entries: TelegramMessageLedgerEntry[];
}

interface LedgerStateV1 {
  version: 1;
  entries: Array<{ key: string; completedAt: number }>;
}

export interface TelegramMessageLedgerOptions {
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

export class TelegramMessageLedger {
  private readonly entries = new Map<string, TelegramMessageLedgerEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly ownerId: string;

  constructor(
    private readonly path: string,
    options: TelegramMessageLedgerOptions = {}
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.ownerId = options.ownerId ?? randomUUID();
    this.load();
  }

  get(key: string): TelegramMessageLedgerEntry | null {
    this.prune();
    const entry = this.entries.get(key);
    return entry ? { ...entry } : null;
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  listUndelivered(): TelegramMessageLedgerEntry[] {
    this.prune();
    return [...this.entries.values()]
      .filter((entry) => entry.state !== 'delivered')
      .map((entry) => ({ ...entry }));
  }

  isOwnedByCurrentProcess(entry: TelegramMessageLedgerEntry): boolean {
    return entry.ownerId === this.ownerId;
  }

  claim(key: string): { claimed: boolean; entry: TelegramMessageLedgerEntry } {
    this.prune();
    const existing = this.entries.get(key);
    if (existing) return { claimed: false, entry: { ...existing } };
    const entry: TelegramMessageLedgerEntry = {
      key,
      state: 'processing',
      updatedAt: this.now(),
      ownerId: this.ownerId,
    };
    this.commit(() => {
      this.entries.set(key, entry);
      this.enforceEntryLimit();
    });
    return { claimed: true, entry: { ...entry } };
  }

  markReady(key: string, response: string): void {
    if (response.length > MAX_RESPONSE_CHARS) {
      throw new Error('Telegram durable response exceeds its size limit');
    }
    const entry = this.requireEntry(key);
    this.commit(() => {
      this.entries.set(key, {
        ...entry,
        state: 'ready',
        response,
        nextChunkIndex: 0,
        deliveryUncertain: false,
        updatedAt: this.now(),
        ownerId: this.ownerId,
      });
    });
  }

  markDeliveryProgress(key: string, nextChunkIndex: number, deliveryUncertain: boolean): void {
    if (!Number.isSafeInteger(nextChunkIndex) || nextChunkIndex < 0) {
      throw new Error('Telegram delivery progress must be a non-negative integer');
    }
    const entry = this.requireEntry(key);
    if (entry.state !== 'ready' || entry.response === undefined) {
      throw new Error(`Telegram message ${key} is not ready for delivery`);
    }
    this.commit(() => {
      this.entries.set(key, {
        ...entry,
        nextChunkIndex,
        deliveryUncertain,
        updatedAt: this.now(),
        ownerId: this.ownerId,
      });
    });
  }

  markDelivered(key: string): void {
    this.commit(() => {
      this.entries.delete(key);
      this.entries.set(key, {
        key,
        state: 'delivered',
        updatedAt: this.now(),
        ownerId: this.ownerId,
      });
      this.enforceEntryLimit();
    });
  }

  /** Compatibility alias for the original completed-ID ledger API. */
  record(key: string): void {
    this.markDelivered(key);
  }

  private requireEntry(key: string): TelegramMessageLedgerEntry {
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`Telegram message ${key} has not been claimed`);
    return entry;
  }

  private enforceEntryLimit(): void {
    while (this.entries.size > this.maxEntries) {
      if (!this.evictOldestDelivered()) {
        throw new Error('Telegram message ledger entry limit is full of undelivered work');
      }
    }
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    if (statSync(this.path).size > MAX_LEDGER_FILE_BYTES) {
      const error = new Error(`Telegram message ledger exceeds ${MAX_LEDGER_FILE_BYTES} bytes`);
      this.log(`[Telegram] message ledger rejected without modification: ${error.message}`);
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (isLedgerStateV2(parsed, this.maxEntries)) {
        for (const entry of parsed.entries) {
          if (entry.state === 'delivered') {
            const { response: _response, ...delivered } = entry;
            this.entries.set(entry.key, delivered);
          } else {
            this.entries.set(entry.key, entry);
          }
        }
      } else if (isLedgerStateV1(parsed, this.maxEntries)) {
        for (const entry of parsed.entries) {
          this.entries.set(entry.key, {
            key: entry.key,
            state: 'delivered',
            updatedAt: entry.completedAt,
            ownerId: 'legacy',
          });
        }
      } else {
        throw new Error('invalid Telegram message ledger');
      }
      this.prune();
    } catch (error) {
      const quarantinePath = `${this.path}.corrupt-${this.now()}-${process.pid}`;
      renameSync(this.path, quarantinePath);
      this.entries.clear();
      this.log(
        `[Telegram] invalid message ledger quarantined at ${quarantinePath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.state === 'delivered' && entry.updatedAt < cutoff) this.entries.delete(key);
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.tmp`;
    let serialized = this.serialize();
    while (Buffer.byteLength(serialized, 'utf8') > MAX_LEDGER_FILE_BYTES) {
      if (!this.evictOldestDelivered()) {
        throw new Error('Telegram message ledger exceeds its durable size limit');
      }
      serialized = this.serialize();
    }
    writeFileSync(temporaryPath, serialized, { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, this.path);
  }

  private serialize(): string {
    const state: LedgerStateV2 = { version: 2, entries: [...this.entries.values()] };
    return `${JSON.stringify(state)}\n`;
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

function isLedgerStateV1(value: unknown, maxEntries: number): value is LedgerStateV1 {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !Array.isArray(record.entries) ||
    record.entries.length > maxEntries
  ) {
    return false;
  }
  return record.entries.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const item = entry as Record<string, unknown>;
    return isKey(item.key) && isTimestamp(item.completedAt);
  });
}

function isLedgerStateV2(value: unknown, maxEntries: number): value is LedgerStateV2 {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 2 ||
    !Array.isArray(record.entries) ||
    record.entries.length > maxEntries
  ) {
    return false;
  }
  return record.entries.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const item = entry as Record<string, unknown>;
    return (
      isKey(item.key) &&
      (item.state === 'processing' || item.state === 'ready' || item.state === 'delivered') &&
      isTimestamp(item.updatedAt) &&
      typeof item.ownerId === 'string' &&
      item.ownerId.length > 0 &&
      item.ownerId.length <= 128 &&
      (item.response === undefined ||
        (typeof item.response === 'string' && item.response.length <= MAX_RESPONSE_CHARS)) &&
      (item.nextChunkIndex === undefined ||
        (Number.isSafeInteger(item.nextChunkIndex) && (item.nextChunkIndex as number) >= 0)) &&
      (item.deliveryUncertain === undefined || typeof item.deliveryUncertain === 'boolean')
    );
  });
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
