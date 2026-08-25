import type { SQLiteDatabase } from '../../sqlite.js';

/**
 * Additive receipt relation for coalesced owner-event Board requests.
 *
 * TaskLedger enables foreign keys before this migration runs. The relation
 * deliberately inherits OwnerEventInbox retention through ON DELETE CASCADE;
 * it has no independent cleanup timer or second retention policy.
 */
export function applyOwnerEventBoardRefreshMigration(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_event_board_refresh_intents (
      batch_id INTEGER PRIMARY KEY REFERENCES owner_event_inbox(id) ON DELETE CASCADE,
      batch_key TEXT NOT NULL UNIQUE,
      repair_generation INTEGER NOT NULL CHECK (repair_generation >= 0),
      workorder_id INTEGER NOT NULL REFERENCES operator_tasks(id),
      applied_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_owner_event_board_refresh_pending
      ON owner_event_board_refresh_intents(repair_generation, batch_id)
      WHERE applied_at IS NULL;
  `);
}
