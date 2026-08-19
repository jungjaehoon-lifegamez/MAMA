import type { OwnerEventEffectAuthority } from '../agent/types.js';
import type { SQLiteDatabase } from '../sqlite.js';
import type { OwnerEventBatch } from './owner-event-inbox.js';

export type OwnerEventEffectKind = 'telegram_send' | 'drive_upload';

export type OwnerEventEffectBeginResult =
  | { state: 'execute'; intent: Record<string, unknown> }
  | { state: 'reconcile'; intent: Record<string, unknown> }
  | { state: 'confirmed'; result: Record<string, unknown> | null };

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
      if (row.status !== 'confirmed') {
        return {
          state: 'reconcile',
          intent: JSON.parse(row.intent_json) as Record<string, unknown>,
        } as const;
      }
      return {
        state: 'confirmed',
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
