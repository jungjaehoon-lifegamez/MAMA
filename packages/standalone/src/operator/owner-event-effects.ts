import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';

import type { OwnerEventEffectAuthority } from '../agent/types.js';
import type { SQLiteDatabase } from '../sqlite.js';
import type { OwnerEventBatch } from './owner-event-inbox.js';

export type OwnerEventEffectKind = 'telegram_send' | 'drive_upload';

export type OwnerEventTelegramVariant = 'text' | 'file' | 'image' | 'sticker';

export interface OwnerEventTelegramIntentV1 extends Record<string, unknown> {
  version: 1;
  chatId: string;
  variant: OwnerEventTelegramVariant;
  deliveryId: string;
  message: string | null;
  filePath: string | null;
  stickerEmotion: string | null;
}

export interface OwnerEventTelegramReceiptV1 extends Record<string, unknown> {
  version: 1;
  deliveryId: string;
  variant: OwnerEventTelegramVariant;
  state: 'delivered';
  payloadIdentity: string;
  confirmedAt: number;
}

export interface OwnerEventTelegramIntentInput {
  chatId: string;
  deliveryId: string;
  message?: string;
  filePath?: string;
  stickerEmotion?: string;
}

const TELEGRAM_PHOTO_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

export function resolvePrivateWorkspaceFile(filePath: string): string {
  const root = resolve(process.env.MAMA_WORKSPACE || join(homedir(), '.mama', 'workspace'));
  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('Outbound file must be a regular file, not a symlink');
  }
  const realPath = realpathSync(filePath);
  const realRoot = realpathSync(root);
  if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${sep}`)) {
    throw new Error(`Outbound file must stay under the private MAMA workspace: ${realRoot}`);
  }
  return realPath;
}

/** Canonicalize exactly the payload Telegram will receive, before reserving the effect. */
export function buildOwnerEventTelegramIntent(
  input: OwnerEventTelegramIntentInput,
  trustedExisting?: OwnerEventTelegramIntentV1
): OwnerEventTelegramIntentV1 {
  if (!input.chatId) throw new Error('chat_id is required');
  if (!input.deliveryId) throw new Error('owner-event Telegram delivery ID is required');

  const stickerEmotion = input.stickerEmotion?.trim().toLowerCase();
  if (stickerEmotion) {
    return {
      version: 1,
      chatId: input.chatId,
      variant: 'sticker',
      deliveryId: input.deliveryId,
      message: null,
      filePath: null,
      stickerEmotion,
    };
  }

  if (input.filePath) {
    const filePath =
      input.filePath === trustedExisting?.filePath
        ? trustedExisting.filePath
        : resolvePrivateWorkspaceFile(input.filePath);
    return {
      version: 1,
      chatId: input.chatId,
      variant: TELEGRAM_PHOTO_EXTENSIONS.has(extname(filePath).toLowerCase()) ? 'image' : 'file',
      deliveryId: input.deliveryId,
      message: input.message ?? null,
      filePath,
      stickerEmotion: null,
    };
  }

  if (input.message !== undefined) {
    if (!input.message.trim()) throw new Error('Telegram text message must not be blank');
    return {
      version: 1,
      chatId: input.chatId,
      variant: 'text',
      deliveryId: input.deliveryId,
      message: input.message,
      filePath: null,
      stickerEmotion: null,
    };
  }

  throw new Error('Either message, file_path, or sticker_emotion is required');
}

export function isOwnerEventTelegramIntentV1(
  value: Record<string, unknown>
): value is OwnerEventTelegramIntentV1 {
  return (
    value.version === 1 &&
    typeof value.chatId === 'string' &&
    (value.variant === 'text' ||
      value.variant === 'file' ||
      value.variant === 'image' ||
      value.variant === 'sticker') &&
    typeof value.deliveryId === 'string' &&
    (typeof value.message === 'string' || value.message === null) &&
    (typeof value.filePath === 'string' || value.filePath === null) &&
    (typeof value.stickerEmotion === 'string' || value.stickerEmotion === null)
  );
}

export function ownerEventTelegramIntentsEqual(
  left: OwnerEventTelegramIntentV1,
  right: OwnerEventTelegramIntentV1
): boolean {
  return (
    left.chatId === right.chatId &&
    left.variant === right.variant &&
    left.deliveryId === right.deliveryId &&
    left.message === right.message &&
    left.filePath === right.filePath &&
    left.stickerEmotion === right.stickerEmotion
  );
}

export type OwnerEventEffectBeginResult =
  | { state: 'execute'; intent: Record<string, unknown> }
  | { state: 'reconcile'; intent: Record<string, unknown> }
  | {
      state: 'confirmed';
      intent: Record<string, unknown>;
      result: Record<string, unknown> | null;
    };

interface StoredEffectRow {
  effect_kind: string;
  status: 'transmitting' | 'unknown' | 'confirmed';
  intent_json: string;
  result_json: string | null;
}

/** Derive one retry-stable host identity per external effect kind and event batch. */
export function buildOwnerEventEffectAuthority(batch: OwnerEventBatch): OwnerEventEffectAuthority {
  return {
    batchId: batch.id,
    effectKeys: {
      telegram_send: 'telegram-delivery',
      drive_upload: 'drive-upload',
    },
  };
}

/**
 * Durable host ledger for external effects selected by an owner-event turn.
 *
 * `begin` writes `transmitting` before any remote call. A second caller never
 * receives `execute`; it must reconcile the original occurrence. This closes
 * both same-process Code-Act concurrency and crash-after-transmit replay.
 */
export class OwnerEventEffectLedger {
  constructor(
    private readonly db: SQLiteDatabase,
    private readonly clock: () => number = () => Date.now()
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS owner_event_effects (
        batch_id INTEGER NOT NULL,
        action_key TEXT NOT NULL,
        effect_kind TEXT NOT NULL CHECK (effect_kind IN ('telegram_send','drive_upload')),
        status TEXT NOT NULL CHECK (status IN ('transmitting','unknown','confirmed')),
        intent_json TEXT NOT NULL,
        result_json TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (batch_id, action_key)
      );
    `);
    const inboxTable = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'owner_event_inbox'`)
      .get();
    if (inboxTable) {
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_owner_event_effects_cleanup
        AFTER DELETE ON owner_event_inbox
        BEGIN
          DELETE FROM owner_event_effects WHERE batch_id = OLD.id;
        END;
      `);
    }
  }

  begin(
    batchId: number,
    actionKey: string,
    effectKind: OwnerEventEffectKind,
    intent: Record<string, unknown> = {}
  ): OwnerEventEffectBeginResult {
    const run = this.db.transaction(() => {
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO owner_event_effects
             (batch_id, action_key, effect_kind, status, intent_json, created_at, updated_at)
           VALUES (?, ?, ?, 'transmitting', ?, ?, ?)`
        )
        .run(batchId, actionKey, effectKind, JSON.stringify(intent), this.clock(), this.clock());
      if (inserted.changes === 1) return { state: 'execute', intent } as const;

      const row = this.db
        .prepare(
          `SELECT effect_kind, status, intent_json, result_json
             FROM owner_event_effects WHERE batch_id = ? AND action_key = ?`
        )
        .get(batchId, actionKey) as StoredEffectRow | undefined;
      if (!row) throw new Error('Owner-event effect reservation disappeared');
      if (row.effect_kind !== effectKind) {
        throw new Error(`Owner-event action ${actionKey} is already bound to ${row.effect_kind}`);
      }
      const storedIntent = JSON.parse(row.intent_json) as Record<string, unknown>;
      if (
        effectKind === 'telegram_send' &&
        isOwnerEventTelegramIntentV1(storedIntent) &&
        (!isOwnerEventTelegramIntentV1(intent) ||
          !ownerEventTelegramIntentsEqual(storedIntent, intent))
      ) {
        throw new Error('Owner-event Telegram intent mismatch for the host-issued delivery key');
      }
      if (row.status !== 'confirmed') {
        return {
          state: 'reconcile',
          intent: storedIntent,
        } as const;
      }
      return {
        state: 'confirmed',
        intent: storedIntent,
        result: row.result_json ? (JSON.parse(row.result_json) as Record<string, unknown>) : null,
      } as const;
    });
    return run();
  }

  inspect(
    batchId: number,
    actionKey: string,
    effectKind: OwnerEventEffectKind
  ): OwnerEventEffectBeginResult | null {
    const row = this.db
      .prepare(
        `SELECT effect_kind, status, intent_json, result_json
           FROM owner_event_effects WHERE batch_id = ? AND action_key = ?`
      )
      .get(batchId, actionKey) as StoredEffectRow | undefined;
    if (!row) return null;
    if (row.effect_kind !== effectKind) {
      throw new Error(`Owner-event action ${actionKey} is already bound to ${row.effect_kind}`);
    }
    if (row.status !== 'confirmed') {
      return {
        state: 'reconcile',
        intent: JSON.parse(row.intent_json) as Record<string, unknown>,
      };
    }
    return {
      state: 'confirmed',
      intent: JSON.parse(row.intent_json) as Record<string, unknown>,
      result: row.result_json ? (JSON.parse(row.result_json) as Record<string, unknown>) : null,
    };
  }

  confirmedKinds(batchId: number): OwnerEventEffectKind[] {
    return (
      this.db
        .prepare(
          `SELECT effect_kind FROM owner_event_effects
            WHERE batch_id = ? AND status = 'confirmed' ORDER BY effect_kind ASC`
        )
        .all(batchId) as Array<{ effect_kind: OwnerEventEffectKind }>
    ).map((row) => row.effect_kind);
  }

  confirm(
    batchId: number,
    actionKey: string,
    effectKind: OwnerEventEffectKind,
    result: Record<string, unknown> | null
  ): void {
    const updated = this.db
      .prepare(
        `UPDATE owner_event_effects
            SET status = 'confirmed', result_json = ?, last_error = NULL, updated_at = ?
          WHERE batch_id = ? AND action_key = ? AND effect_kind = ?`
      )
      .run(JSON.stringify(result), this.clock(), batchId, actionKey, effectKind);
    if (updated.changes !== 1) throw new Error('Owner-event effect confirmation was not reserved');
  }

  markUnknown(
    batchId: number,
    actionKey: string,
    effectKind: OwnerEventEffectKind,
    error: string
  ): void {
    this.db
      .prepare(
        `UPDATE owner_event_effects
            SET status = 'unknown', last_error = ?, updated_at = ?
          WHERE batch_id = ? AND action_key = ? AND effect_kind = ? AND status != 'confirmed'`
      )
      .run(error.slice(0, 2_000), this.clock(), batchId, actionKey, effectKind);
  }
}
